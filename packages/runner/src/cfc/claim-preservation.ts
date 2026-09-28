/**
 * Whether the envelope a write is about to persist keeps every write-side
 * claim the document's stored envelope makes.
 *
 * The persisted envelope is the merge of the stored one and the writer's
 * candidate, and the merge is shape-driven: a reference, a combinator arm or a
 * sibling can each change which declaration a path resolves to. A claim the
 * merge loses stops binding every later writer. This check reads the claims
 * from both envelopes by logical path, independently of how the merge built
 * the second, so a merge that loses one refuses the write instead of storing
 * the loss.
 */

import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { type CfcConfClause, normalizeClause } from "./clause.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./schema-refs.ts";

type Ifc = Record<string, unknown>;

// The claims that bind a writer of the path, each with what keeping it means.
// A claim describing the stored value rather than its writers (`integrity`,
// `addIntegrity`, `observes`) may legitimately change and is not listed.
const CLAIMS: Readonly<
  Record<string, (stored: unknown, merged: unknown) => boolean>
> = {
  uiContract: (stored, merged) => deepEqual(stored, merged),
  exactCopyOf: (stored, merged) => deepEqual(stored, merged),
  projection: (stored, merged) => deepEqual(stored, merged),
  ownerPrincipal: (stored, merged) => deepEqual(stored, merged),
  writeAuthorizedBy: (stored, merged) => keepsWriterClaim(stored, merged),
  // A floor may rise, never fall.
  requiredIntegrity: (stored, merged) => containsAll(merged, stored),
  // A ceiling may narrow, never widen.
  maxConfidentiality: (stored, merged) => containsAll(stored, merged),
  // The declared label may gain clauses, never lose one.
  confidentiality: (stored, merged) =>
    containsAll(normalizedClauses(merged), normalizedClauses(stored)),
};

const containsAll = (superset: unknown, subset: unknown): boolean =>
  Array.isArray(superset) && Array.isArray(subset) &&
  subset.every((item) => superset.some((other) => deepEqual(other, item)));

const normalizedClauses = (clauses: unknown): unknown =>
  Array.isArray(clauses)
    ? clauses.map((clause) => normalizeClause(clause as CfcConfClause))
    : clauses;

const WRITER_STAMP_KEYS = ["bundleId", "moduleIdentity"] as const;

// A builtin list may narrow to fewer writers. A binding keeps its meaning
// (everything but the resolver-dependent file spelling and the stamp), and a
// stamp, once stored, is kept: the merge adopts a first stamp but never
// replaces one.
const keepsWriterClaim = (stored: unknown, merged: unknown): boolean => {
  if (Array.isArray(stored)) return containsAll(stored, merged);
  if (
    !isObjectNotArray(stored) || !isObjectNotArray(merged) ||
    !isObjectNotArray(stored.__ctWriterIdentityOf) ||
    !isObjectNotArray(merged.__ctWriterIdentityOf)
  ) {
    return deepEqual(stored, merged);
  }
  const storedBinding = stored.__ctWriterIdentityOf;
  const mergedBinding = merged.__ctWriterIdentityOf;
  const meaning = (claim: Record<string, unknown>, binding: Ifc) => {
    const rest: Ifc = { ...binding };
    for (const key of WRITER_STAMP_KEYS) delete rest[key];
    delete rest.file;
    return { ...claim, __ctWriterIdentityOf: rest };
  };
  return deepEqual(
    meaning(stored, storedBinding),
    meaning(merged, mergedBinding),
  ) &&
    WRITER_STAMP_KEYS.every((key) =>
      storedBinding[key] === undefined ||
      storedBinding[key] === mergedBinding[key]
    );
};

/** A schema node and the document root its local references resolve in. */
type Located = { readonly schema: JSONSchema; readonly root: JSONSchema };

// The node a schema position stands for, with every reference on the way
// followed, or `undefined` when a reference does not resolve.
const resolveLocated = (at: Located): Located | undefined => {
  let { schema, root } = at;
  const seen = new Set<unknown>();
  while (isObjectNotArray(schema) && typeof schema.$ref === "string") {
    if (seen.has(schema)) return undefined;
    seen.add(schema);
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema, root);
    if (resolved === undefined) return undefined;
    root = cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, root),
    );
    schema = resolved;
  }
  return { schema, root };
};

const EMPTY: Located = { schema: {}, root: {} };

const IN_PROGRESS = Symbol("in progress");

const child = (
  parent: Located,
  schema: JSONSchema | undefined,
): Located => schema === undefined ? EMPTY : { schema, root: parent.root };

// The branches of every `anyOf` and `oneOf` on a node: both keywords may sit
// on one node, and each constrains the value on its own.
const arms = (schema: JSONSchemaObj): readonly JSONSchema[] => [
  ...(schema.anyOf ?? []),
  ...(schema.oneOf ?? []),
];

/**
 * Where the claims a document's schema describes beneath a position belong to
 * another document: a position holding links, whose linked documents' own
 * envelopes enforce them.
 */
export interface ForeignPositions {
  /** Whether the claims beneath `path` (a logical path, `*` for items) belong elsewhere. */
  holdsForeign(path: readonly string[]): boolean;

  /**
   * Whether the answer can differ anywhere at or below `path`. Past every
   * position that decides it, the walk compares a pair of positions once,
   * which is what ends it in a recursive definition.
   */
  variesBelow(path: readonly string[]): boolean;
}

const NO_FOREIGN_POSITIONS: ForeignPositions = {
  holdsForeign: () => false,
  variesBelow: () => false,
};

/**
 * The first write-side claim `stored` makes that `merged` does not keep, as a
 * refusal reason naming it and its path, or `undefined` when every one is
 * kept.
 *
 * The two schemas are walked together, position by position, following
 * references on each side, so a claim is compared wherever both reach the
 * same logical path, however each spells it. A pair of positions is compared
 * once, which is what ends the walk through a recursive definition while
 * still reaching the depth where the merge could have replaced it. Each arm of a stored `anyOf` or `oneOf` must be kept by
 * the merged position itself or by one of its arms, and a position the merged
 * schema no longer describes loses every claim beneath it. A stored reference
 * that does not resolve cannot be shown kept, so it counts as dropped.
 */
export const droppedStoredClaim = (
  stored: JSONSchema,
  merged: JSONSchema,
  // Positions whose own claims are kept but whose claims beneath belong to
  // another document, so the walk does not descend there.
  foreign: ForeignPositions = NO_FOREIGN_POSITIONS,
): string | undefined => {
  // Each pair of positions compared, and what comparing it found. A pair
  // still being compared further up the walk is a recursive definition
  // meeting itself; its claims are the ones being compared there.
  const compared = new Map<
    unknown,
    Map<unknown, Map<string, string | undefined | typeof IN_PROGRESS>>
  >();
  const walk = (
    storedAt: Located,
    mergedAt: Located,
    path: readonly string[],
  ): string | undefined => {
    // Positions are keyed as written, before their references resolve:
    // resolving can build a fresh node every time, while the position a
    // recursive definition returns to is the same object each time.
    // Where a foreign position can lie at or below the path, what the walk
    // finds depends on the path, so the pair is compared once per such path;
    // past them it is compared once, which is what ends the walk through a
    // recursive definition.
    const storedKey = storedAt.schema;
    const mergedKey = mergedAt.schema;
    if (!isObjectNotArray(storedKey)) return undefined;
    const valueKey = foreign.variesBelow(path) ? JSON.stringify(path) : "";
    let results = compared.get(storedKey);
    if (results === undefined) compared.set(storedKey, results = new Map());
    let byValue = results.get(mergedKey);
    if (byValue === undefined) results.set(mergedKey, byValue = new Map());
    if (byValue.has(valueKey)) {
      const result = byValue.get(valueKey);
      return result === IN_PROGRESS ? undefined : result;
    }
    byValue.set(valueKey, IN_PROGRESS);
    const storedNode = resolveLocated(storedAt);
    const result = storedNode === undefined
      ? `a stored schema reference does not resolve at /${path.join("/")}`
      : isObjectNotArray(storedNode.schema)
      ? compare(storedNode, resolveLocated(mergedAt) ?? EMPTY, path)
      : undefined;
    byValue.set(valueKey, result);
    return result;
  };
  const compare = (
    storedNode: Located,
    mergedNode: Located,
    path: readonly string[],
  ): string | undefined => {
    const where = `/${path.join("/")}`;
    const s = storedNode.schema as JSONSchemaObj;
    const m = mergedNode.schema;
    const mObject: JSONSchemaObj = isObjectNotArray(m) ? m : {};

    const storedArms = arms(s);
    if (storedArms.length > 0) {
      const targets = [
        mergedNode,
        ...arms(mObject).map((arm) => child(mergedNode, arm)),
      ];
      for (const arm of storedArms) {
        const armAt = child(storedNode, arm);
        if (
          targets.every((target) => walk(armAt, target, path) !== undefined)
        ) {
          return walk(armAt, mergedNode, path);
        }
      }
    }
    for (const member of s.allOf ?? []) {
      const failure = walk(child(storedNode, member), mergedNode, path);
      if (failure !== undefined) return failure;
    }

    if (isObjectNotArray(s.ifc)) {
      const storedIfc = s.ifc as Ifc;
      const mergedIfc = isObjectNotArray(mObject.ifc) ? mObject.ifc as Ifc : {};
      for (const [claim, keeps] of Object.entries(CLAIMS)) {
        const value = storedIfc[claim];
        if (value === undefined) continue;
        if (
          mergedIfc[claim] === undefined || !keeps(value, mergedIfc[claim])
        ) {
          return `the merged schema drops the stored ${claim} at ${where}`;
        }
      }
    }

    if (foreign.holdsForeign(path)) return undefined;

    const mergedRest = isObjectNotArray(mObject.additionalProperties)
      ? mObject.additionalProperties
      : undefined;
    for (const [key, property] of Object.entries(s.properties ?? {})) {
      const failure = walk(
        child(storedNode, property),
        child(mergedNode, mObject.properties?.[key] ?? mergedRest),
        [...path, key],
      );
      if (failure !== undefined) return failure;
    }
    if (isObjectNotArray(s.additionalProperties)) {
      const failure = walk(
        child(storedNode, s.additionalProperties),
        child(mergedNode, mergedRest),
        [...path, "*"],
      );
      if (failure !== undefined) return failure;
    }
    for (const [index, slot] of (s.prefixItems ?? []).entries()) {
      const failure = walk(
        child(storedNode, slot),
        child(mergedNode, mObject.prefixItems?.[index] ?? mObject.items),
        [...path, String(index)],
      );
      if (failure !== undefined) return failure;
    }
    if (s.items !== undefined) {
      const failure = walk(
        child(storedNode, s.items),
        child(mergedNode, mObject.items),
        [...path, "*"],
      );
      if (failure !== undefined) return failure;
    }
    return undefined;
  };
  return walk(
    { schema: stored, root: stored },
    { schema: merged, root: merged },
    [],
  );
};
