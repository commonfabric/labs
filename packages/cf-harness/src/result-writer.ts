/**
 * The agent result writer: the trusted host routine that puts a run's
 * structured result into the fabric and returns a link to it.
 *
 * The harness is what knows what the model observed and what each handle in
 * the answer stands for, so the harness writes the result itself, from its
 * host-side fabric session, and nothing downstream re-labels or re-validates
 * it. Every handle the result names at a value position becomes a link,
 * `asCell` position or not; a property name is held to the same ownership
 * rule and stays the text it is, since a name cannot hold a link. A
 * handle to a cell becomes a link to that cell, so a consumer's read resolves
 * the cell's own label; a handle to a referent that is not a cell — a Loom
 * row, a SQLite row — becomes a document holding that content under the
 * label the tool reported, and a link to it. A handle the run does not hold
 * fails the write before anything is written (AH-REF-2). What the model
 * authored stays inline, and its label is the join the writing transaction
 * DERIVES: before the write, the host reads every cell the run observed
 * through that transaction, so the runtime's own flow derivation stamps the
 * real consumed set. The write is attributed to the `agent` builtin so the
 * result carries the runtime-minted `LlmDerived` family a pattern cannot
 * forge.
 *
 * This is not a model tool. It runs on the trusted host over the session's
 * runtime, after a run reaches its structured result, and every runtime gate
 * applies to its write (AH-TOOL-7).
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { mapSubschemas } from "@commonfabric/data-model-schema/schema-walk";
import type { Cell, MemorySpace, Runtime } from "@commonfabric/runner";
import {
  atomsOutsideCeiling,
  type CfcConfClause,
  cfcLabelViewForCellFailClosedWithStatus,
  type CfcObservationMaxConfidentiality,
  cfcOpaqueLinkForPath,
  type CfcRefusalDetail,
  type IFCLabel,
  meetCfcObservationCeilings,
  resolveSchemaForValidation,
  uniqueCfcAtoms,
  validateAgainstSchema,
  withLlmDerivedStamp,
} from "@commonfabric/runner/cfc";
import {
  type NormalizedFullLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  ANY_HANDLE_TOKEN_PATTERN,
  type HarnessHandleEntry,
  type HarnessHandleTable,
} from "./contracts/handle-table.ts";
import type { HarnessFabricSession } from "./fabric-session.ts";
import {
  handleRefAddressKey,
  resolveHandleRef,
  resolveHandleToken,
} from "./handle-table.ts";
import { validateStructuredResultValue } from "./structured-result.ts";

/** The builtin the result write is attributed to. */
export const AGENT_RESULT_BUILTIN_ID = "agent";

/** A cell the run observed, named by the handle the run's table holds for it. */
export interface AgentObservedCellHandle {
  kind: "cell";
  token: string;
}

/**
 * A referent the run observed that is not a cell: a Loom row, a SQLite row.
 * The host step that observed it recorded the content and the label the tool
 * reported, and the token it stood for in model context. When the result names
 * the token, the writer mints a document under that label and links it from the
 * result. When the result does not name the token, the writer admits the
 * content through an isolated, aborted external-content observation and joins
 * its opaque receipt into the result instead. In either case, the runtime does
 * not have to take the host-reported label on trust.
 */
export interface AgentObservedDocumentReferent {
  kind: "document";
  token: string;

  /** The content as the tool reported it, JSON. */
  value: unknown;

  /** The label the tool reported for the row. */
  label: IFCLabel;

  /** The row's shape, when the tool reported one. */
  schema?: JSONSchema;
}

export type AgentObservedHandle =
  | AgentObservedCellHandle
  | AgentObservedDocumentReferent;

/**
 * Everything a run's handle table says the run observed: each general
 * address handle as a cell, and each held referent as a document carrying
 * the content and label it was admitted under. A handle held for one purpose
 * only — a `skill-context` one — is not an observation.
 */
export const agentObservedHandlesOfTable = (
  table: HarnessHandleTable,
): AgentObservedHandle[] => [
  ...table.entries.filter((entry) => entry.capability === undefined).map((
    entry,
  ): AgentObservedHandle => ({ kind: "cell", token: entry.token })),
  ...(table.referents ?? []).map((referent): AgentObservedHandle => ({
    kind: "document",
    token: referent.token,
    value: referent.value,
    label: referent.label,
  })),
];

export interface WriteAgentResultOptions {
  session: HarnessFabricSession;

  /** The run's handle table, the only source of a cell handle's address. */
  handleTable: HarnessHandleTable;

  /** The model's structured result, as it finished the run. */
  structuredResult: unknown;

  /** The schema the result was requested against. */
  resultSchema: JSONSchema;

  /** Everything the run observed, cells and non-cell referents alike. */
  observedHandles: readonly AgentObservedHandle[];

  /**
   * The run's observation ceiling, declared as the result document's store
   * policy. The runtime measures the join it derives against this at the
   * commit boundary: a run under this ceiling observed only values fitting
   * it, so a join that does not fit is a defect the boundary refuses rather
   * than one this writer papers over.
   */
  maxConfidentiality: readonly CfcConfClause[];

  /** The result document's cause; a fresh identifier when absent. */
  cause?: unknown;

  /** The handle id sealed positions are addressed under. */
  opaqueHandleId?: string;
}

/** A document the writer minted for a non-cell referent. */
export interface AgentResultMintedDocument {
  token: string;
  link: NormalizedFullLink;
}

export interface WrittenAgentResult {
  link: NormalizedFullLink;

  /**
   * The label the result document carries at its root once written: the
   * declared ceiling joined with what the transaction derived beyond it, and
   * the integrity the builtin identity minted.
   */
  joinLabel: IFCLabel;

  /** Durable documents minted for non-cell referents the result cites. */
  mintedDocuments: readonly AgentResultMintedDocument[];

  /** The positions sealed for exceeding the ceiling their position declares. */
  sealedPaths: readonly (readonly (string | number)[])[];
}

/**
 * Why a write failed. `cfc_commit_refused` is the commit boundary's own
 * decision, reported the way `run_pattern` reports one: the code and the
 * structured refusals ride on the error for the artifact, and the message
 * carries no label detail.
 */
export type AgentResultWriteFailureCode =
  | "invalid_result"
  | "unheld_handle"
  | "unresolvable_handle"
  | "cfc_commit_refused"
  | "commit_failed";

/** A failed write, typed by what refused it. */
export class AgentResultWriteError extends Error {
  readonly code: AgentResultWriteFailureCode;

  /** The boundary's structured refusals, for the run's artifact. */
  readonly refusals?: readonly CfcRefusalDetail[];

  /** The storage error's own text, for the run's artifact. */
  readonly rawCauseMessage?: string;

  /** A failure with `code`, the caller-facing `message`, and artifact detail. */
  constructor(
    code: AgentResultWriteFailureCode,
    message: string,
    detail: {
      refusals?: readonly CfcRefusalDetail[];
      rawCauseMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = "AgentResultWriteError";
    this.code = code;
    if (detail.refusals !== undefined) this.refusals = detail.refusals;
    if (detail.rawCauseMessage !== undefined) {
      this.rawCauseMessage = detail.rawCauseMessage;
    }
  }
}

/** The cause of the document minted for a non-cell referent of one result. */
export const agentResultReferentCause = (
  resultCause: unknown,
  token: string,
): unknown => ({
  type: "cf-harness.agent-result-referent",
  result: resultCause,
  token,
});

/** A position in the result value: object keys and array indices from the root. */
type Path = readonly (string | number)[];

/** What one position of the result resolved to. */
type Reference =
  | {
    kind: "cell";
    path: Path;
    entry: HarnessHandleEntry;
    link: NormalizedFullLink;
  }
  | { kind: "document"; path: Path; referent: AgentObservedDocumentReferent };

/** A reference, or the seal that stands where the position's ceiling refused one. */
type Placement =
  | Reference
  | { kind: "sealed"; path: Path };

// Tokens of either kind: an address handle, or a held non-cell referent.
const tokenPattern = (): RegExp =>
  new RegExp(ANY_HANDLE_TOKEN_PATTERN.source, "g");

const wholeTokenPattern = new RegExp(`^${ANY_HANDLE_TOKEN_PATTERN.source}$`);

/**
 * `schema` with every `asCell` position replaced by the schema that accepts
 * anything. A position marked `asCell` accepts an opaque reference, and the
 * model writes a reference as a handle token; what the referent holds is not
 * the result schema's to validate, so validation is asked about everything
 * but those positions. A caller that validates a result before handing it to
 * the writer — the run's own structured-result validation — validates
 * against this, so the two agree on what a result may hold.
 */
export const relaxAsCellPositions = (schema: JSONSchema): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  if (schema.asCell !== undefined) return true;
  return mapSubschemas(
    schema,
    relaxAsCellPositions,
    { includeDefs: true, includeUnused: true },
  );
};

/**
 * `schema` with every position's `ifc.maxConfidentiality` removed. The writer
 * applies a position's ceiling itself, to the referent placed there (see
 * {@link positionCeiling}); the runtime would apply the same declaration to
 * the whole transaction's join, which for this transaction is everything the
 * run observed, and would refuse every position narrower than that join
 * whatever was placed there.
 */
const withoutPositionCeilings = (schema: JSONSchema): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  let node: JSONSchemaObj = schema;
  if (isObjectOrArray(node.ifc) && "maxConfidentiality" in node.ifc) {
    const { maxConfidentiality: _ceiling, ...ifc } = node.ifc;
    node = Object.keys(ifc).length === 0
      ? Object.fromEntries(
        Object.entries(node).filter(([key]) => key !== "ifc"),
      ) as JSONSchemaObj
      : { ...node, ifc };
  }
  return mapSubschemas(node, withoutPositionCeilings, {
    includeDefs: true,
    includeUnused: true,
  });
};

/**
 * `schema` with `clauses` joined into every node's `ifc.confidentiality`,
 * `$defs` targets included. A schema's `ifc` entry is a store policy the
 * runtime applies where the written value satisfies that node, and a value
 * written through a schema can split into documents of its own — an object
 * inside an array lands in a document the array links to — each written
 * through its own node. Declaring the ceiling on every node is what puts it
 * on every document the write creates. A clause a node already declares is
 * kept: the position is at least as confidential as its author said.
 */
const withDeclaredConfidentiality = (
  schema: JSONSchema,
  clauses: readonly CfcConfClause[],
): JSONSchema => {
  const declare = (node: JSONSchemaObj): JSONSchema => {
    const ifc = isObjectOrArray(node.ifc) ? node.ifc : {};
    const declared = Array.isArray(ifc.confidentiality)
      ? ifc.confidentiality
      : [];
    return mapSubschemas(
      {
        ...node,
        ifc: {
          ...ifc,
          confidentiality: uniqueCfcAtoms([...declared, ...clauses]),
        },
      },
      (child) => (isObjectOrArray(child) ? declare(child) : child),
      { includeDefs: true, includeUnused: true },
    );
  };
  return declare(isObjectOrArray(schema) ? schema : {});
};

/** The schema used to admit one external referent through the CFC boundary. */
const referentWriteSchema = (
  referent: AgentObservedDocumentReferent,
): JSONSchema => {
  const declared = withDeclaredConfidentiality(
    isObjectOrArray(referent.schema) ? referent.schema : {},
    referent.label.confidentiality ?? [],
  ) as JSONSchemaObj;
  const integrity = referent.label.integrity ?? [];
  return integrity.length === 0 ? declared : {
    ...declared,
    ifc: { ...declared.ifc, addIntegrity: integrity },
  } as JSONSchema;
};

/**
 * `schema` with the node at each of `paths` reduced to its `asCell` marker
 * and its `ifc`. A store policy applies where the written value satisfies
 * the node's value constraints, and a link satisfies none written for the
 * content it points at: a slot typed `string` holding a link would leave the
 * whole enclosing declaration inapplicable, and the document undeclared. The
 * positions that receive a link are known before the write, so their value
 * constraints are dropped and their policy kept. A `$ref` on the way is
 * inlined so the reduction lands on a node of this schema rather than on a
 * shared definition.
 */
const relaxedAt = (
  schema: JSONSchema,
  paths: readonly Path[],
  full: JSONSchema,
): JSONSchema => {
  const relax = (node: JSONSchema, remaining: readonly Path[]): JSONSchema => {
    if (remaining.length === 0) return node;
    const resolved = resolveSchemaForValidation(node, full);
    if (!isObjectOrArray(resolved)) return resolved;
    if (remaining.some((path) => path.length === 0)) {
      return {
        ...(resolved.asCell !== undefined ? { asCell: resolved.asCell } : {}),
        ...(resolved.ifc !== undefined ? { ifc: resolved.ifc } : {}),
      } as JSONSchema;
    }
    const result: Record<string, unknown> = { ...resolved };
    const byHead = new Map<string | number, Path[]>();
    for (const path of remaining) {
      const head = path[0];
      byHead.set(head, [...(byHead.get(head) ?? []), path.slice(1)]);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = result[keyword];
      if (Array.isArray(branches)) {
        result[keyword] = branches.map((branch) =>
          relax(branch as JSONSchema, remaining)
        );
      }
    }
    const properties: Record<string, unknown> | undefined =
      isObjectOrArray(resolved.properties)
        ? { ...resolved.properties }
        : undefined;
    const prefixItems: unknown[] | undefined = Array.isArray(
        resolved.prefixItems,
      )
      ? [...resolved.prefixItems]
      : undefined;
    for (const [head, tails] of byHead) {
      if (typeof head === "string") {
        if (properties !== undefined && properties[head] !== undefined) {
          properties[head] = relax(properties[head] as JSONSchema, tails);
        } else if (result.additionalProperties !== undefined) {
          result.additionalProperties = relax(
            result.additionalProperties as JSONSchema,
            tails,
          );
        }
        continue;
      }
      if (prefixItems !== undefined && head < prefixItems.length) {
        prefixItems[head] = relax(prefixItems[head] as JSONSchema, tails);
      } else if (result.items !== undefined) {
        result.items = relax(result.items as JSONSchema, tails);
      }
    }
    if (properties !== undefined) result.properties = properties;
    if (prefixItems !== undefined) result.prefixItems = prefixItems;
    return result as JSONSchema;
  };
  return relax(schema, paths);
};

/**
 * The subschema governing `value` at `schema`: the node with its `$ref`
 * resolved and, where the node branches, the first branch `value` satisfies.
 * Branch choice follows the validator's own reading of the relaxed schema, so
 * a position holding a handle token is measured by the branch that accepted
 * it.
 */
const governingSchema = (
  schema: JSONSchema,
  value: unknown,
  full: JSONSchema,
): JSONSchema => {
  const resolved = resolveSchemaForValidation(schema, full);
  if (!isObjectOrArray(resolved)) return resolved;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = resolved[keyword];
    if (!Array.isArray(branches)) continue;
    const relaxedFull = relaxAsCellPositions(full);
    const branch = branches.find((candidate) =>
      validateAgainstSchema(
        relaxAsCellPositions(candidate as JSONSchema),
        value,
        relaxedFull,
      ) === undefined
    );
    if (branch !== undefined) {
      return governingSchema(branch as JSONSchema, value, full);
    }
  }
  return resolved;
};

/** One schema from several: the lone one, or their `allOf`. */
const combined = (schemas: readonly JSONSchema[]): JSONSchema =>
  schemas.length === 0 ? true : schemas.length === 1 ? schemas[0] : {
    allOf: [...schemas],
  };

/**
 * The subschema of `schema` governing the member `key` of an object value:
 * the node's own declaration for it joined with every `allOf` branch's, so a
 * ceiling one branch declares is not lost behind a shape another declares.
 */
const childSchemaForKey = (
  schema: JSONSchema,
  key: string,
  full: JSONSchema,
): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  const children: JSONSchema[] = [];
  if (
    isObjectOrArray(schema.properties) && schema.properties[key] !== undefined
  ) {
    children.push(schema.properties[key] as JSONSchema);
  } else if (schema.additionalProperties !== undefined) {
    children.push(schema.additionalProperties as JSONSchema);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const child = childSchemaForKey(
        resolveSchemaForValidation(branch as JSONSchema, full),
        key,
        full,
      );
      if (child !== true) children.push(child);
    }
  }
  return combined(children);
};

/**
 * The subschema of `schema` governing the item at `index` of an array value,
 * joined across `allOf` branches the way {@link childSchemaForKey} joins.
 */
const childSchemaForIndex = (
  schema: JSONSchema,
  index: number,
  full: JSONSchema,
): JSONSchema => {
  if (!isObjectOrArray(schema)) return schema;
  const children: JSONSchema[] = [];
  if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) {
    children.push(schema.prefixItems[index] as JSONSchema);
  } else if (schema.items !== undefined) {
    children.push(schema.items as JSONSchema);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const child = childSchemaForIndex(
        resolveSchemaForValidation(branch as JSONSchema, full),
        index,
        full,
      );
      if (child !== true) children.push(child);
    }
  }
  return combined(children);
};

/**
 * The ceiling a position declares for what is placed there, or `undefined`
 * where it declares none: the `ifc.maxConfidentiality` of the node governing
 * `value` met with whatever each `allOf` branch declares, so a referent must
 * fit every declaration that reaches the position. Each branch is narrowed to
 * the alternative `value` satisfies before it is read, so a ceiling declared
 * inside an `anyOf` or `oneOf` beneath an `allOf` is measured too.
 */
const positionCeiling = (
  schema: JSONSchema,
  value: unknown,
  full: JSONSchema,
): readonly CfcConfClause[] | undefined => {
  const node = governingSchema(schema, value, full);
  if (!isObjectOrArray(node)) return undefined;
  let ceiling: CfcObservationMaxConfidentiality = undefined;
  if (isObjectOrArray(node.ifc)) {
    const own = node.ifc.maxConfidentiality;
    if (Array.isArray(own)) ceiling = own as CfcConfClause[];
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      ceiling = meetCfcObservationCeilings(
        ceiling,
        positionCeiling(branch as JSONSchema, value, full),
      );
    }
  }
  return ceiling;
};

/** The text a position holds as a reference, when it holds one whole. */
const referenceText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (
    isObjectNotArray(value) && Object.keys(value).length === 1 &&
    typeof value["@link"] === "string"
  ) {
    return value["@link"];
  }
  return undefined;
};

/**
 * Resolves references throughout `value`, walking it beside `schema`, and
 * returns what each referencing position resolved to. A whole-position token
 * or canonical link string resolves against the run's table or its recorded
 * non-cell referents; a well-formed token the run does not hold, wherever it
 * sits in a string, fails the walk, as does a whole-position address the
 * table does not hold. Text that is neither is the model's own and stays.
 */
const resolveReferences = (
  value: unknown,
  schema: JSONSchema,
  full: JSONSchema,
  path: Path,
  resolve: (text: string, path: Path) => Reference | undefined,
  out: {
    reference: Reference;
    ceiling: readonly CfcConfClause[] | undefined;
  }[],
): void => {
  const node = governingSchema(schema, value, full);
  const text = referenceText(value);
  if (text !== undefined) {
    const reference = resolve(text, path);
    if (reference !== undefined) {
      out.push({ reference, ceiling: positionCeiling(node, value, full) });
      return;
    }
    // Not a reference as a whole; a token inside it is checked below.
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(tokenPattern())) {
      // Held tokens inside prose are left as the inert text they are; only
      // an unheld one is a defect, and `resolve` reports it by throwing.
      resolve(match[0], path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      resolveReferences(
        item,
        childSchemaForIndex(node, index, full),
        full,
        [...path, index],
        resolve,
        out,
      )
    );
    return;
  }
  if (isObjectNotArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      // A property name is text the model wrote, and the inbound swap
      // restores tokens in names as it does in values, so a name is held to
      // the same rule: an unheld handle anywhere in it fails the write. A
      // held one stays as the text it is, since a name cannot hold a link.
      if (referenceText(key) !== undefined) resolve(key, [...path, key]);
      for (const match of key.matchAll(tokenPattern())) {
        resolve(match[0], [...path, key]);
      }
      resolveReferences(
        item,
        childSchemaForKey(node, key, full),
        full,
        [...path, key],
        resolve,
        out,
      );
    }
  }
};

/** `value` with each placement's position replaced by `replace(placement)`. */
const placeReferences = (
  value: unknown,
  placements: readonly Placement[],
  replace: (placement: Placement) => unknown,
): unknown => {
  const byPath = new Map<string, Placement>();
  for (const placement of placements) {
    byPath.set(JSON.stringify(placement.path), placement);
  }
  const walk = (node: unknown, path: Path): unknown => {
    const placement = byPath.get(JSON.stringify(path));
    if (placement !== undefined) return replace(placement);
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, [...path, index]));
    }
    if (isObjectNotArray(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => [
          key,
          walk(item, [...path, key]),
        ]),
      );
    }
    return node;
  };
  return walk(value, []);
};

/** The confidentiality a referent carries, or `undefined` where it could not be read. */
const referentConfidentiality = (
  reference: Reference,
  runtime: Runtime,
): readonly CfcConfClause[] | undefined => {
  if (reference.kind === "document") {
    return reference.referent.label.confidentiality ?? [];
  }
  const cell = runtime.getCellFromLink(reference.link);
  const { view, readFailed } = cfcLabelViewForCellFailClosedWithStatus(cell);
  if (readFailed) return undefined;
  return uniqueCfcAtoms(
    (view?.entries ?? []).flatMap((entry) => entry.label.confidentiality ?? []),
  ) as CfcConfClause[];
};

/**
 * Whether the referent at a position fits the ceiling that position declares.
 * No declared ceiling admits anything; a label that could not be read fits
 * nothing, so the position is sealed rather than linked on a poisoned
 * measurement.
 */
const fitsPositionCeiling = (
  reference: Reference,
  ceiling: readonly CfcConfClause[] | undefined,
  runtime: Runtime,
): boolean => {
  if (ceiling === undefined) return true;
  const confidentiality = referentConfidentiality(reference, runtime);
  return confidentiality !== undefined &&
    atomsOutsideCeiling(confidentiality, ceiling).length === 0;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Maps a failed commit to the writer's typed failure: a
 * `CfcCommitRefusalError` is the boundary's decision and becomes
 * `cfc_commit_refused` carrying its structured refusals; any other storage
 * error becomes `commit_failed`. Either way the message names `what` was being
 * written and nothing the error itself said, which is kept as
 * `rawCauseMessage` for the artifact.
 */
export const agentResultCommitFailure = (
  error: { name?: string; message?: string; refusals?: unknown },
  what: string,
): AgentResultWriteError => {
  if (error.name === "CfcCommitRefusalError") {
    return new AgentResultWriteError(
      "cfc_commit_refused",
      `the space's policy refused to commit ${what}`,
      {
        refusals: Array.isArray(error.refusals)
          ? error.refusals as CfcRefusalDetail[]
          : [],
        rawCauseMessage: error.message,
      },
    );
  }
  return new AgentResultWriteError(
    "commit_failed",
    `writing ${what} failed`,
    { rawCauseMessage: error.message },
  );
};

/** Commits `tx`, throwing the writer's failure for `what` when it does not land. */
const commitOrThrow = async (
  tx: { commit(): Promise<{ error?: { name?: string; message?: string } }> },
  what: string,
): Promise<void> => {
  const outcome = await tx.commit();
  if (outcome.error !== undefined) {
    throw agentResultCommitFailure(outcome.error, what);
  }
};

/** The label a synced cell carries at its root, as the runtime reports it. */
const labelOf = (cell: Cell<unknown>): IFCLabel => {
  const { view } = cfcLabelViewForCellFailClosedWithStatus(cell);
  const entries = view?.entries ?? [];
  return {
    confidentiality: uniqueCfcAtoms(
      entries.flatMap((entry) => entry.label.confidentiality ?? []),
    ) as CfcConfClause[],
    integrity: uniqueCfcAtoms(
      entries.flatMap((entry) => entry.label.integrity ?? []),
    ),
  };
};

/**
 * Writes `structuredResult` into the session's space and returns a link to
 * the document, the label it carries, and the documents minted on the way.
 *
 * One or two transactions are committed. The optional first transaction
 * mints a document for every
 * non-cell referent the result cites, under the label the tool reported and
 * with no read beside it, so the declaration is the whole of what the
 * document carries. Each uncited referent passes the same write admission in
 * an isolated transaction that is then aborted; an opaque runtime receipt
 * carries the canonical content observation into the second transaction.
 * That transaction reads every observed cell and minted document, consumes
 * the receipts, is attributed to the `agent` builtin, and writes the result
 * through the result schema with the `LlmDerived` stamp on every node and
 * `maxConfidentiality` declared as the store's policy at its root. Minting in
 * the same transaction as the reads would put the join on the cited documents
 * too, and a row's document should carry the row's label alone.
 *
 * Every reference is resolved, and every position ceiling measured, before
 * the first transaction opens, so a result naming a handle the run does not
 * hold writes nothing.
 *
 * @throws AgentResultWriteError naming what refused the write.
 */
export const writeAgentResult = async (
  options: WriteAgentResultOptions,
): Promise<WrittenAgentResult> => {
  const { session, handleTable, resultSchema, observedHandles } = options;
  const runtime = session.pieces.runtime;
  const space: MemorySpace = session.pieces.getSpace();
  const resultCause = options.cause ??
    { type: "cf-harness.agent-result", id: crypto.randomUUID() };
  const opaqueHandleId = options.opaqueHandleId ?? "agent-result";

  try {
    validateStructuredResultValue({
      schema: relaxAsCellPositions(resultSchema),
      value: options.structuredResult,
    });
  } catch (error) {
    throw new AgentResultWriteError(
      "invalid_result",
      `the structured result does not satisfy the result schema: ${
        errorMessage(error)
      }`,
    );
  }

  const documentReferents = new Map<string, AgentObservedDocumentReferent>();
  for (const observed of observedHandles) {
    if (observed.kind === "document") {
      documentReferents.set(observed.token, observed);
    }
  }

  /** Resolves one reference text, refusing whatever the run does not hold. */
  const resolve = (text: string, path: Path): Reference | undefined => {
    const document = documentReferents.get(text);
    if (document !== undefined) {
      return { kind: "document", path, referent: document };
    }
    const entry = wholeTokenPattern.test(text)
      ? resolveHandleToken(handleTable, text)
      : resolveHandleRef(handleTable, text);
    if (entry === undefined) {
      if (
        wholeTokenPattern.test(text) || handleRefAddressKey(text) !== undefined
      ) {
        throw new AgentResultWriteError(
          "unheld_handle",
          "the result names a handle this run does not hold",
        );
      }
      return undefined;
    }
    if (entry.capability !== undefined) {
      throw new AgentResultWriteError(
        "unheld_handle",
        "the result names a handle this run holds for another purpose only",
      );
    }
    let link: NormalizedFullLink;
    try {
      link = parseLLMFriendlyLink(entry.ref, space);
    } catch (error) {
      throw new AgentResultWriteError(
        "unresolvable_handle",
        `a handle's address does not parse: ${errorMessage(error)}`,
      );
    }
    if (link.space !== space) {
      throw new AgentResultWriteError(
        "unresolvable_handle",
        "a handle names a cell outside the session's space",
      );
    }
    return { kind: "cell", path, entry, link };
  };

  const resolved: {
    reference: Reference;
    ceiling: readonly CfcConfClause[] | undefined;
  }[] = [];
  resolveReferences(
    options.structuredResult,
    resultSchema,
    resultSchema,
    [],
    resolve,
    resolved,
  );

  const placements: Placement[] = resolved.map(({ reference, ceiling }) =>
    fitsPositionCeiling(reference, ceiling, runtime)
      ? reference
      : { kind: "sealed", path: reference.path }
  );
  const sealedPaths = placements.flatMap((placement) =>
    placement.kind === "sealed" ? [placement.path] : []
  );
  const referencedDocumentTokens = new Set(
    placements.flatMap((placement) =>
      placement.kind === "document" ? [placement.referent.token] : []
    ),
  );
  // Cells the run observed, read through the writing transaction below so
  // the runtime's flow derivation consumes their labels.
  const observedCells: NormalizedFullLink[] = [];
  const seenCells = new Set<string>();
  for (const observed of observedHandles) {
    if (observed.kind !== "cell") continue;
    const reference = resolve(observed.token, []);
    if (reference?.kind !== "cell") {
      throw new AgentResultWriteError(
        "unheld_handle",
        "an observed handle is not one this run holds",
      );
    }
    if (seenCells.has(reference.entry.addressKey)) continue;
    seenCells.add(reference.entry.addressKey);
    observedCells.push(reference.link);
  }
  const hasUnreferencedDocument = documentReferents.size >
    referencedDocumentTokens.size;
  const tx = runtime.edit();
  const enforcing = runtime.cfcEnforcementMode !== "disabled";
  if (enforcing || hasUnreferencedDocument) {
    tx.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_RESULT_BUILTIN_ID,
    });
  }

  try {
    // An unreferenced external value contributes through an opaque observation
    // receipt. Each probe is isolated and aborted after ordinary CFC
    // preparation and a full content read, so no durable referent exists
    // merely because the model observed a row.
    const externalObservationReceipts: object[] = [];
    for (const referent of documentReferents.values()) {
      if (referencedDocumentTokens.has(referent.token)) continue;
      try {
        externalObservationReceipts.push(
          await runtime.prepareExternalContentObservation({
            targetTx: tx,
            space,
            cause: agentResultReferentCause(resultCause, referent.token),
            schema: referentWriteSchema(referent),
            value: referent.value,
            producer: AGENT_RESULT_BUILTIN_ID,
          }),
        );
      } catch (error) {
        throw agentResultCommitFailure(
          error as { name?: string; message?: string; refusals?: unknown },
          "an external observation for the result",
        );
      }
    }

    // Validate and attach every opaque observation before a cited document is
    // made durable. A refused receipt must not leave a document behind for a
    // result that never committed.
    for (const receipt of externalObservationReceipts) {
      try {
        runtime.recordExternalContentObservation(tx, receipt, {
          space,
          producer: AGENT_RESULT_BUILTIN_ID,
        });
      } catch (error) {
        throw agentResultCommitFailure(
          error as { name?: string; message?: string; refusals?: unknown },
          "an external observation for the result",
        );
      }
    }

    // A document is minted only for a referent the result names. The transaction
    // reads nothing, so each durable citation carries its own admitted label.
    const minted = new Map<string, Cell<unknown>>();
    const mintedDocuments: AgentResultMintedDocument[] = [];
    if (referencedDocumentTokens.size > 0) {
      const mintTx = runtime.edit();
      try {
        for (const referent of documentReferents.values()) {
          if (!referencedDocumentTokens.has(referent.token)) continue;
          const cell = runtime.getCell<unknown>(
            space,
            agentResultReferentCause(resultCause, referent.token),
            referentWriteSchema(referent),
            mintTx,
          );
          cell.set(referent.value);
          minted.set(referent.token, cell);
          mintedDocuments.push({
            token: referent.token,
            link: cell.getAsNormalizedFullLink(),
          });
        }
        await commitOrThrow(mintTx, "the documents minted for the result");
      } catch (error) {
        if (mintTx.status().status === "ready") mintTx.abort(error);
        throw error;
      }
    }

    // An observed cell's value can reach through links into documents this
    // session has not loaded, and a read of an unloaded document records an
    // absence the commit then finds untrue. Pulling each cell first loads what
    // its value reaches, so the transaction below reads what is stored.
    for (const link of observedCells) {
      const cell = runtime.getCellFromLink<unknown>(link);
      await cell.sync();
      await cell.pull();
    }
    for (const link of observedCells) {
      runtime.getCellFromLink<unknown>(link).withTx(tx).get();
    }
    for (const cell of minted.values()) {
      await cell.sync();
      cell.withTx(tx).get();
    }
    const value = placeReferences(
      options.structuredResult,
      placements,
      (placement) =>
        placement.kind === "sealed"
          ? cfcOpaqueLinkForPath(opaqueHandleId, placement.path)
          : placement.kind === "document"
          ? minted.get(placement.referent.token)
          : runtime.getCellFromLink(placement.link, undefined, tx),
    );
    const linkPaths = placements.flatMap((placement) =>
      placement.kind === "sealed" ? [] : [placement.path]
    );
    const storeSchema = withDeclaredConfidentiality(
      relaxedAt(
        withoutPositionCeilings(resultSchema),
        linkPaths,
        withoutPositionCeilings(resultSchema),
      ),
      options.maxConfidentiality,
    );
    const resultCell = runtime.getCell<unknown>(
      space,
      resultCause,
      enforcing ? withLlmDerivedStamp(storeSchema) : storeSchema,
      tx,
    );
    resultCell.set(value);
    await commitOrThrow(tx, "the agent result");

    const link = resultCell.getAsNormalizedFullLink();
    const written = runtime.getCellFromLink<unknown>(link);
    await written.sync();
    return {
      link,
      joinLabel: labelOf(written),
      mintedDocuments,
      sealedPaths,
    };
  } catch (error) {
    if (tx.status().status === "ready") {
      tx.abort(error);
    }
    throw error;
  }
};
