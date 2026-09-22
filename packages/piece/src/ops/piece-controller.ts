import type { CellKind, LinkScope } from "@commonfabric/api";
import { fabricAwareEqual, taggedHashStringOf } from "@commonfabric/data-model";
import { schemaWithProperties } from "@commonfabric/data-model-schema";
import { getLogger } from "@commonfabric/utils/logger";
import {
  acceptsOpaqueCellOrUnresolvedLink,
  applyPieceSourceTransition,
  Cell,
  type CellPath,
  cellWithScopedLinkRequiredsRelaxed,
  ContextualFlowControl,
  deepEqual,
  extractDefaultValues,
  formatFabricRef,
  getCellOrThrow,
  getMetaLink,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  getValueAtPath,
  type IExtendedStorageTransaction,
  isCell,
  isCellResultForDereferencing,
  isLink,
  isStream,
  type JSONSchema,
  KeepAsCell,
  type MemorySpace,
  mergeSchemaDefaults,
  NAME,
  type NormalizedLink,
  overlayUnreadableLinkPlaceholders,
  parseFabricRef,
  parseLinkOrThrow,
  type Pattern,
  type PatternSetupCommitReceipt,
  PatternSetupPostCommitError,
  PIECE_SOURCE_MOVED,
  type PieceReconciliation,
  type PieceSourceRevision,
  type PieceSourceSnapshot,
  type PieceSourceTransition,
  type PieceSourceTransitionBaseline,
  preparePieceSourceTransitionBaseline,
  readResultSchemaMeta,
  resolveCellPath,
  resolveLink,
  type RuntimeProgram,
  sanitizeSchemaForLinks,
  schemaAcceptsOpaqueCellValue,
  schemaPathSelection,
  setPieceReconciliation,
} from "@commonfabric/runner";
import { storedArgumentRefusalDetail } from "@commonfabric/runner/shared";
import {
  cfcSchemaResolvedRoot,
  loadStoredCfcEnvelope,
  type MergeCfcSchemaEnvelopeOptions,
  resolveCfcSchemaRefRoot,
  resolveCfcSchemaRefs,
  storedCfcEnvelopeMergeIssue,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { nameSchema } from "@commonfabric/runner/schemas";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { pieceId } from "../piece-id.ts";
import {
  assertPatternSchemasBackwardCompatible,
  assertSchemaSubset,
  PATTERN_SCHEMAS_INCOMPATIBLE,
  schemasHaveSameContract,
} from "../schema-compatibility.ts";
import {
  cloneInternalManifest,
  pinCloneSnapshotCells,
} from "./clone-data-guards.ts";
import {
  preloadCloneValue,
  snapshotCloneValue,
} from "./clone-data-snapshot.ts";
import { isCfcMigrationRejection } from "./cfc-migration-rejection.ts";
import { assertPieceInputPath } from "./piece-input-path.ts";
import {
  acceptEnteredOrigin,
  qualifyFabricOrigin,
  readPieceOrigin,
  resolvePieceOriginSource,
} from "./piece-origin.ts";
import type { PiecesController } from "./pieces-controller.ts";
import { commitFailure, compileProgram } from "./utils.ts";

const pieceUpdateLogger = getLogger("piece.update", {
  enabled: true,
  level: "warn",
});

interface PieceCellIo {
  get(path?: CellPath): Promise<unknown>;
  set(value: unknown, path?: CellPath): Promise<void>;
  edit(
    produce: (stored: unknown) => { value: unknown } | undefined,
    path?: CellPath,
  ): Promise<{ wrote: boolean }>;
  getCell(path?: CellPath): Promise<Cell<unknown>>;
}

interface CloneInternalSnapshot {
  partialCause: unknown;
  kind?: unknown;
  value: unknown;
}

/** Read the input and stateful internal cells from one storage version. */
async function snapshotCloneData(
  piece: Cell<unknown>,
  inputCell: Cell<unknown>,
  expectedSource: PieceSourceSnapshot,
): Promise<{ input: unknown; internals: CloneInternalSnapshot[] }> {
  const preloadedCells = new Map<string, Cell<unknown>>();
  await preloadCloneValue(inputCell, undefined, preloadedCells);
  const initialManifest = cloneInternalManifest(piece);
  for (const entry of initialManifest) {
    if (entry.kind === "computed") continue;
    const internal = piece.runtime.getCellFromLink(
      parseLinkOrThrow(entry.link, piece),
    );
    if (!isStream(internal)) {
      await preloadCloneValue(internal, undefined, preloadedCells);
    }
  }

  const tx = piece.runtime.edit();
  let commitStarted = false;
  try {
    const txPiece = piece.withTx(tx);
    const currentSource = getPieceSourceSnapshot(txPiece);
    if (
      currentSource === undefined ||
      !samePieceSourceSnapshot(expectedSource, currentSource)
    ) {
      throw new Error("piece source changed while it was being cloned");
    }

    const snapshotCells = new Map<string, Cell<unknown>>();
    const txInput = inputCell.withTx(tx);
    const input = snapshotCloneValue(
      txInput.get(),
      txInput,
      new WeakMap(),
      snapshotCells,
      preloadedCells,
    );
    const internals: CloneInternalSnapshot[] = [];
    const manifest = cloneInternalManifest(txPiece);
    if (!deepEqual(initialManifest, manifest)) {
      throw new Error("piece data changed while it was being cloned");
    }
    for (const entry of manifest) {
      if (entry.kind === "computed") continue;
      const link = parseLinkOrThrow(entry.link, txPiece);
      const internal = piece.runtime.getCellFromLink(link, undefined, tx);
      if (isStream(internal)) continue;
      internals.push({
        partialCause: entry.partialCause,
        kind: entry.kind,
        value: snapshotCloneValue(
          internal.get(),
          internal,
          new WeakMap(),
          snapshotCells,
          preloadedCells,
        ),
      });
    }

    pinCloneSnapshotCells(tx, snapshotCells.values());
    piece.runtime.prepareTxForCommit(tx);
    commitStarted = true;
    const { error } = await tx.commit();
    if (error) throw commitFailure(error);
    return { input, internals };
  } catch (error) {
    if (!commitStarted) tx.abort(error);
    throw error;
  }
}

/** Restore stateful internal-cell snapshots into a newly created piece. */
async function restoreCloneInternals(
  piece: Cell<unknown>,
  snapshots: readonly CloneInternalSnapshot[],
): Promise<void> {
  const tx = piece.runtime.edit();
  let commitStarted = false;
  try {
    const txPiece = piece.withTx(tx);
    const manifest = cloneInternalManifest(txPiece);
    for (const snapshot of snapshots) {
      const entry = manifest.find((candidate) =>
        candidate.kind === snapshot.kind &&
        deepEqual(candidate.partialCause, snapshot.partialCause)
      );
      if (entry === undefined) {
        throw new Error("cloned piece is missing a source data cell");
      }
      const link = parseLinkOrThrow(entry.link, txPiece);
      piece.runtime.getCellFromLink(link, undefined, tx).set(snapshot.value);
    }
    piece.runtime.prepareTxForCommit(tx);
    commitStarted = true;
    const { error } = await tx.commit();
    if (error) throw commitFailure(error);
  } catch (error) {
    if (!commitStarted) tx.abort(error);
    throw error;
  }
  await piece.runtime.idle();
}

type PiecePropIoType = "result" | "input";

/**
 * Copy only a materialized value's path spine and replace its leaf.
 *
 * TODO(danfuzz): a spine node that is neither an array nor plain-prototyped
 * — a `FabricInstance`, whose contents live behind its codec — is rebuilt
 * here as a bare `{}`/`[]` carrying only the addressed child, and everything
 * else it held is discarded; the result reaches durable writes. (The same
 * clone selector appears in `replaceMaterializedCellValueAtPath` below.)
 */
function replaceMaterializedValueAtPath(
  current: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  if (path.length === 0) return value;

  const [segment, ...remaining] = path;
  const prototype = isObjectOrArray(current)
    ? Object.getPrototypeOf(current)
    : undefined;
  const clone: Record<PropertyKey, unknown> | unknown[] = Array.isArray(current)
    ? current.slice()
    : prototype === Object.prototype || prototype === null
    ? Object.assign(Object.create(prototype), current)
    : typeof segment === "number"
    ? []
    : {};
  const child = isObjectOrArray(current)
    ? (current as Record<PropertyKey, unknown>)[segment]
    : undefined;
  Object.defineProperty(clone, segment, {
    value: replaceMaterializedValueAtPath(child, remaining, value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return clone;
}

/**
 * Whether a proper prefix of `path` holds a link in `raw`, so that a write at
 * `path` resolves through that link into another document.
 */
function writePathCrossesLink(
  raw: unknown,
  path: readonly (string | number)[],
): boolean {
  let current = raw;
  for (const segment of path.slice(0, -1)) {
    current = isObjectOrArray(current)
      ? (current as Record<PropertyKey, unknown>)[segment]
      : undefined;
    if (isLink(current)) return true;
  }
  return false;
}

/** Replace a schema-aware snapshot path, reading through Cell ancestors. */
function replaceMaterializedCellValueAtPath(
  current: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  while (isCell(current) && !isStream(current)) {
    const next = current.get();
    if (next === current) break;
    current = next;
  }
  if (path.length === 0) return value;

  const [segment, ...remaining] = path;
  const prototype = isObjectOrArray(current)
    ? Object.getPrototypeOf(current)
    : undefined;
  const clone: Record<PropertyKey, unknown> | unknown[] = Array.isArray(current)
    ? current.slice()
    : prototype === Object.prototype || prototype === null
    ? Object.assign(Object.create(prototype), current)
    : typeof segment === "number"
    ? []
    : {};
  const child = isObjectOrArray(current)
    ? (current as Record<PropertyKey, unknown>)[segment]
    : undefined;
  Object.defineProperty(clone, segment, {
    value: replaceMaterializedCellValueAtPath(child, remaining, value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return clone;
}

interface SuppliedLink {
  path: (string | number)[];
  value: unknown;
}

interface OuterCellContract {
  kind: NonNullable<ReturnType<typeof ContextualFlowControl.getAsCellKind>>;
  payloadSchema: JSONSchema;
}

interface PathSchemaContract {
  schema: JSONSchema;
  root: JSONSchema;

  /** A valid producer value can omit an ancestor on the localized path. */
  mayBeMissing?: boolean;
}

interface DurableSchemaPath {
  root: JSONSchema;
  path: (string | number)[];

  /** Producer-document path corresponding to `path[schemaBaseDepth]`. */
  rawBasePath: (string | number)[];

  /** Projection ancestors in `path` that do not exist in the producer doc. */
  schemaBaseDepth: number;

  /** Materialized schema root used to validate the complete staged value. */
  validationCell: Cell<unknown>;

  /** Path within `validationCell` changed by the producer write. */
  validationPath: (string | number)[];
}

interface DurableSourceContract {
  schemas: DurableSchemaPath[];
}

interface StreamEventLocalization {
  contract: PathSchemaContract;
  consumedStream: boolean;
  issue?: string;
}

interface OuterCellShape {
  kind: CellKind;
  scope: ReturnType<typeof ContextualFlowControl.getAsCellScope>;
}

interface OuterCellLocalization {
  contract: PathSchemaContract;
  outer?: OuterCellShape;
  issue?: string;
}

interface StoredCellTopology {
  value: unknown;
  opaqueHandle: boolean;
}

/** Tooling-facing source locator for a running pattern. */
export interface PiecePatternSourceRef {
  /** Immutable in-fabric reference to the verified source closure. */
  ref: string;

  /** Optional caller-supplied repository associated with the source tree. */
  repository?: string;

  /** Authored entry path within the program's compilation root. */
  entry?: string;

  /** Optional mutable/update provenance carried by `patternSource`. */
  origin?: string;
}

/**
 * Tooling-facing reference to the pattern currently running a piece.
 *
 * `identity` is the prefix-free module hash stored in `patternIdentity`;
 * `identity` + `symbol` are the authoritative executable pointer. `source.ref`
 * names the immutable source closure; optional repository, entry, and origin
 * fields aid discovery without changing that identity.
 */
export interface PiecePatternRef {
  identity: string;
  symbol: string;
  source: PiecePatternSourceRef;
}

/**
 * A source change refused because the piece is no longer on the reference
 * its caller proved it was on.
 *
 * Its own class because the callers that pin a reference are the ones that
 * have to tell this apart from an operational failure: a piece something
 * else moved is a row to refuse, not a write that broke.
 */
export class PieceSourceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PieceSourceChangedError";
  }
}

/**
 * Translate the transition layer's stale-source failure into the refusal a
 * pinned caller can act on, and leave every other error alone.
 *
 * A pinned change is guarded twice: once against the snapshot this call
 * reads, and again inside the transaction that commits it. Only the first
 * throws {@link PieceSourceChangedError} on its own; the second is the
 * runtime's generic error, which a caller would otherwise read as an
 * operational failure of unknown state rather than as a row to refuse. The
 * message is matched against the runner's own exported constant, so the two
 * cannot drift into disagreeing about what this is.
 *
 * @internal Exported for a focused contract test; not part of the Piece API.
 */
export function pinnedSourceMoved(
  error: unknown,
  pinned: { identity: string; symbol: string } | undefined,
): unknown {
  if (pinned === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(PIECE_SOURCE_MOVED)) return error;
  return new PieceSourceChangedError(
    `The piece moved off ${pinned.identity}#${pinned.symbol} before the ` +
      `change proved against it could commit.`,
  );
}

export type PieceSourceAction =
  | { kind: "detach" }
  | { kind: "restore"; revisionId: string }
  | { kind: "follow"; revisionId: string }
  | { kind: "repoint"; url: string }
  | { kind: "adopt" };

/** What one {@link PieceController.setPattern} write did beyond landing. */
export interface PieceSourceSetResult {
  /**
   * The origin the write detached, and null when the piece was already
   * detached.
   *
   * Taken from the snapshot the transition committed against, not from a
   * read beside the call. `applyPieceSourceTransition` refuses inside the
   * write transaction unless the piece's live origin still equals that
   * snapshot's, so a write that committed detached exactly this — while a
   * value any caller read before the call is a value the write may have
   * moved off. A caller that records what it detached, so an operator can
   * re-attach by hand, is right only with this one.
   */
  detachedOrigin: string | null;
}

export interface PreparedPieceSourceChange {
  action: PieceSourceAction;
  expected: PieceSourceSnapshot;
  candidate: { identity: string; symbol: string };
  origin: string | null;
  operation: PieceSourceTransition["operation"];
  baseline: PieceSourceTransitionBaseline;
  selectedRevisionId?: string;
  review?: {
    argumentEvidence: string;
    issues: PieceSourceCompatibilityIssues;
  };
}

export interface PieceSourceCompatibilityIssues {
  schema?: string;
  argument?: string;
  retainedLinks?: string;

  /**
   * The CFC schema envelope stored on the piece's argument document cannot
   * merge with the candidate's argument schema, or the one stored on the
   * piece's own document cannot merge with its result schema — or either
   * cannot be read at all. Distinct from `schema` and `argument`, which reason
   * about DECLARED types: this one reasons about what is physically at rest.
   */
  cfc?: string;
}

/**
 * The verdict `checkPattern()` returns: can this source replace the piece's
 * current one, and if not, every reason at once.
 *
 * "Every reason at once" is the point. Applying a source that cannot migrate
 * the piece's documents surfaces whichever low-level rejection happens to fire
 * first — a schema-subset assertion, a retained-link proof, an argument
 * validation failure, or a CFC schema-envelope rejection at the setup-commit
 * boundary — so a caller fixes one and meets the next.
 *
 * Preflight uses the same contract checks and stored-argument validator as
 * setup. Unreadable documents and linked slots defer to reactive reads, so a
 * compatible verdict does not establish that every input value has loaded.
 * Apply enforces the rules in the setup transaction and may format its
 * refusal differently from this report.
 *
 * It is a point-in-time answer. The piece's argument, its current source, or
 * the candidate file can all move between the check and a later apply, so a
 * clear verdict is not a promise about a future `setPattern` — the apply path
 * revalidates independently, which is what keeps that fail-safe.
 */
export interface PatternCompatibilityReport {
  compatible: boolean;
  issues: PieceSourceCompatibilityIssues;

  /** Every issue joined, or `undefined` when compatible. */
  message?: string;

  candidate: { identity: string; symbol: string };
}

/** What {@link PieceController.setPattern} takes beside the candidate. */
export interface PatternUpdateOptions {
  /** Repository locator written atomically with the setup. */
  repository?: string;

  /**
   * Replace the source even when compatibility cannot be proven, or when
   * the current pattern cannot be loaded at all.
   */
  dangerouslyAllowIncompatibleSchema?: boolean;

  /** The pattern the update was proved against; a piece on another refuses. */
  expectedPattern?: { identity: string; symbol: string };

  /**
   * The update as a serving runtime performs it on `actingUser`'s behalf
   * (docs/features/server-pattern-lifecycle.md): the setup transaction
   * carries that principal's trust snapshot and commits directly to the
   * store rather than sealing into the serving wave, the piece is not
   * started here, and no post-commit refresh runs. The loop's own swap
   * watcher replaces a running piece's graph, and its demand pass runs an
   * unrun one; the receipt's `refresh` is `deferred`.
   */
  served?: { actingUser: string };
}

/** Result of a pattern update accepted by the setup transaction. */
export interface PatternUpdateReceipt extends PieceSourceSetResult {
  /** Stable outcome code for a successful setup transaction. */
  status: "committed";
  /** Content-addressed pattern pointer written by the transaction. */
  ref: { identity: string; symbol: string };
  /** The space whose commit log accepted the setup transaction. */
  space: MemorySpace;
  /**
   * Position in `space`'s commit log at which the transaction was accepted:
   * the seq `cf inspect value-at --seq` and `diff --from/--to` read.
   */
  seq: number;
  /** Source-history revision written atomically with `.ref`. */
  revisionId: string;
  /**
   * Outcome of work which refreshes the running piece after commit;
   * `deferred` when this call ran none, leaving the piece to its runtime's
   * own means — a serving runtime's swap watcher, or its demand pass.
   */
  refresh:
    | { status: "completed" }
    | { status: "deferred" }
    | { status: "failed"; warning: string };
}

/**
 * The verdict {@link PieceController.changeSource} returns: `applied` when
 * storage accepted the transaction carrying the source transition, and
 * `incompatible` when the candidate cannot run over the piece's retained
 * state, with the prepared change a caller may confirm to apply anyway. An
 * update that finds its active origin already current makes no transition;
 * it reports `applied` after recording that finding.
 *
 * A transition's `applied` is its transaction's own outcome, never a read of
 * the piece beside the call — a read answers what the piece points at now,
 * which a concurrent later change may have moved, and it resolves from local
 * cache over a provider failure. `executionWarning` reports a failure in the work
 * that refreshes the running piece after its transition committed; such a
 * failure does not undo the accepted transition, the same split
 * {@link PatternUpdateReceipt}'s `refresh` arm reports for a direct edit.
 */
export type PieceSourceActionResult =
  | { status: "applied"; executionWarning?: string }
  | {
    status: "incompatible";
    message: string;
    prepared: PreparedPieceSourceChange;
  };

function storedCellTopology(
  value: unknown,
  cell: Cell<unknown>,
): StoredCellTopology {
  if (!isLink(value)) return { value, opaqueHandle: false };
  try {
    return {
      value,
      // A write redirect is an ordinary projection alias. A non-redirecting
      // link is a first-class Cell handle whose wrapper capability applies.
      opaqueHandle: parseLinkOrThrow(value, cell).overwrite !== "redirect",
    };
  } catch {
    // Malformed links fail later during normal resolution/validation; do not
    // grant them an ordinary-value branch for capability checks.
    return { value, opaqueHandle: true };
  }
}

const LINK_PATH_SAFE_ANCESTOR_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "asCell",
  "default",
  "definitions",
  "description",
  "examples",
  "ifc",
  "items",
  "maxItems",
  "minItems",
  "patternProperties",
  "prefixItems",
  "properties",
  "readOnly",
  "required",
  "scope",
  "tags",
  "title",
  "type",
  "writeOnly",
]);

const SCHEMA_ANNOTATION_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "description",
  "examples",
  "title",
]);

function asCellShapesMatch(left: JSONSchema | undefined, right: JSONSchema) {
  const leftEntries = ContextualFlowControl.getAsCellValues(left);
  const rightEntries = ContextualFlowControl.getAsCellValues(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every((entry, index) =>
      ContextualFlowControl.getAsCellKind(entry) ===
        ContextualFlowControl.getAsCellKind(rightEntries[index]) &&
      ContextualFlowControl.getAsCellScope(entry) ===
        ContextualFlowControl.getAsCellScope(rightEntries[index])
    );
}

function resolvePathSchemaContract(
  contract: PathSchemaContract,
): PathSchemaContract {
  const schema = contract.schema;
  const schemaRoot = contract.root;
  if (
    !isObjectOrArray(schema) ||
    typeof schema.$ref !== "string"
  ) {
    return { ...contract, schema, root: schemaRoot };
  }
  const resolved = resolveCfcSchemaRefs(schema, schemaRoot);
  if (resolved === undefined) {
    throw new Error("cannot resolve a local schema reference on a link path");
  }
  const owningRoot = resolveCfcSchemaRefRoot(schema, schemaRoot);
  return {
    ...contract,
    schema: resolved,
    root: cfcSchemaResolvedRoot(resolved, owningRoot),
  };
}

function isUnconditionallyType(
  schema: Exclude<JSONSchema, boolean>,
  type: string,
): boolean {
  return schema.type === type ||
    Array.isArray(schema.type) && schema.type.length > 0 &&
      schema.type.every((entry) => entry === type);
}

function linkPathAncestorIssue(
  schema: Exclude<JSONSchema, boolean>,
): string | undefined {
  const key = Object.keys(schema).find((candidate) =>
    !LINK_PATH_SAFE_ANCESTOR_KEYS.has(candidate)
  );
  return key === undefined
    ? undefined
    : `${key} correlates the linked field with its parent value`;
}

/**
 * Derive every schema conjunct that applies at a durable link target.
 *
 * `schemaAtPath()` intentionally returns a convenient approximation and loses
 * pattern-property intersections and parent/field correlations. A future-value
 * link proof needs the actual conjuncts, and must fail closed when an ancestor
 * constraint cannot be localized to the linked slot.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function linkPathContracts(
  initial: readonly PathSchemaContract[],
  path: readonly (string | number)[],
  options: {
    trackSourcePresence?: boolean;
    preserveMissingFlag?: boolean;
  } = {},
): PathSchemaContract[] {
  let contracts = [...initial];
  for (const segment of path) {
    const part = String(segment);
    const next: PathSchemaContract[] = [];
    for (const unresolved of contracts) {
      const contract = resolvePathSchemaContract(unresolved);
      const { schema, root } = contract;
      if (schema === false) {
        next.push(contract);
        continue;
      }
      if (schema === true) {
        next.push(contract);
        continue;
      }
      const ancestorIssue = linkPathAncestorIssue(schema);
      if (ancestorIssue !== undefined) throw new Error(ancestorIssue);

      const objectShaped = schema.type === "object" ||
        schema.properties !== undefined ||
        schema.patternProperties !== undefined ||
        schema.additionalProperties !== undefined;
      const arrayShaped = schema.type === "array" ||
        schema.items !== undefined ||
        schema.prefixItems !== undefined;
      if (objectShaped && arrayShaped) {
        throw new Error(
          "an ambiguous object/array ancestor cannot prove a link path",
        );
      }
      if (objectShaped) {
        const mayBeMissing = contract.mayBeMissing === true ||
          options.trackSourcePresence === true &&
            (!isUnconditionallyType(schema, "object") ||
              !schema.required?.includes(part));
        const applicable: JSONSchema[] = [];
        if (
          schema.properties !== undefined &&
          Object.hasOwn(schema.properties, part)
        ) {
          applicable.push(schema.properties[part]!);
        }
        for (
          const [source, patternSchema] of Object.entries(
            schema.patternProperties ?? {},
          )
        ) {
          if (new RegExp(source).test(part)) applicable.push(patternSchema);
        }
        if (applicable.length === 0) {
          applicable.push(schema.additionalProperties ?? true);
        }
        next.push(...applicable.map((child) => ({
          schema: child,
          root: root,
          mayBeMissing,
        })));
        continue;
      }
      if (arrayShaped) {
        if (!/^(0|[1-9][0-9]*)$/.test(part)) {
          throw new Error(`array link path contains non-index segment ${part}`);
        }
        const index = Number(part);
        // A `FabricArray` preserves sparse holes. `minItems` constrains length,
        // not own-property presence, so every indexed source path can still
        // yield Fabric `undefined` even for an unconditionally shaped array.
        const mayBeMissing = contract.mayBeMissing === true ||
          options.trackSourcePresence === true;
        const child = Array.isArray(schema.prefixItems) &&
            index < schema.prefixItems.length
          ? schema.prefixItems[index]!
          : schema.items ?? true;
        next.push({
          schema: child,
          root: root,
          mayBeMissing,
        });
        continue;
      }
      // An unconstrained schema object is the object form of `true`.
      if (Object.keys(schema).every((key) => key === "$defs")) {
        next.push({ schema: true, root });
        continue;
      }
      throw new Error(`schema does not describe a container at ${part}`);
    }
    contracts = next;
  }
  return contracts.map(resolvePathSchemaContract).map((contract) =>
    options.trackSourcePresence === true && contract.mayBeMissing === true &&
      options.preserveMissingFlag !== true
      ? {
        schema: {
          anyOf: [contract.schema, { type: "undefined" }],
        },
        root: contract.root,
      }
      : contract
  );
}

/** @internal Exported for focused correlated-write contract tests. */
export function materializedValueAtPath(
  root: unknown,
  path: readonly (string | number)[],
): unknown {
  let current = root;
  const followCell = (): void => {
    while (isCell(current) && !isStream(current)) {
      const next = current.get();
      if (next === current) break;
      current = next;
    }
  };
  for (const segment of path) {
    followCell();
    if (!isObjectOrArray(current)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  followCell();
  return current;
}

const ARRAY_ONLY_SCHEMA_KEYS = [
  "contains",
  "items",
  "maxContains",
  "maxItems",
  "minContains",
  "minItems",
  "prefixItems",
  "unevaluatedItems",
  "uniqueItems",
] as const;

const OBJECT_ONLY_SCHEMA_KEYS = [
  "additionalProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "maxProperties",
  "minProperties",
  "patternProperties",
  "properties",
  "propertyNames",
  "required",
  "unevaluatedProperties",
] as const;

const NUMBER_ONLY_SCHEMA_KEYS = [
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
] as const;

const STRING_ONLY_SCHEMA_KEYS = [
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "format",
  "maxLength",
  "minLength",
  "pattern",
] as const;

const OBJECT_WHOLE_VALUE_SCHEMA_KEYS = [
  "dependentRequired",
  "maxProperties",
  "minProperties",
  "propertyNames",
] as const;

const ARRAY_WHOLE_VALUE_SCHEMA_KEYS = ["uniqueItems"] as const;

const LINK_PATH_NEUTRAL_ANCESTOR_KEYS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "default",
  "definitions",
  "description",
  "examples",
  "ifc",
  "readOnly",
  "scope",
  "tags",
  "title",
  "writeOnly",
]);

/** @internal Exported for focused correlated-write contract tests. */
export function selectCurrentContainerSchema(
  schema: Exclude<JSONSchema, boolean>,
  currentValue: unknown,
): JSONSchema {
  const currentType = Array.isArray(currentValue)
    ? "array"
    : isObjectOrArray(currentValue) &&
        !isCell(currentValue) && !isStream(currentValue)
    ? "object"
    : undefined;
  if (currentType === undefined) return schema;

  const declaredTypes = schema.type === undefined
    ? undefined
    : Array.isArray(schema.type)
    ? schema.type
    : [schema.type];
  if (declaredTypes !== undefined && !declaredTypes.includes(currentType)) {
    throw new Error(
      `current producer value is not accepted as an ${currentType} container`,
    );
  }

  const keysToRemove = currentType === "object"
    ? [
      ...ARRAY_ONLY_SCHEMA_KEYS,
      ...NUMBER_ONLY_SCHEMA_KEYS,
      ...OBJECT_WHOLE_VALUE_SCHEMA_KEYS,
      ...STRING_ONLY_SCHEMA_KEYS,
    ]
    : [
      ...ARRAY_WHOLE_VALUE_SCHEMA_KEYS,
      ...OBJECT_ONLY_SCHEMA_KEYS,
      ...NUMBER_ONLY_SCHEMA_KEYS,
      ...STRING_ONLY_SCHEMA_KEYS,
    ];
  const needsSelection = schema.type !== currentType ||
    keysToRemove.some((key) => Object.hasOwn(schema, key));
  if (!needsSelection) return schema;

  const selected = { ...schema } as Record<string, unknown>;
  for (const key of keysToRemove) delete selected[key];
  selected.type = currentType;
  return selected as JSONSchema;
}

/**
 * Localize a child against the producer's current complete ancestor.
 *
 * This is deliberately a current-value proof, not a future-value link proof:
 * every currently matching anyOf branch remains a separate conjunct so an
 * overlapping ordinary alternative cannot erase a restricted Cell capability.
 *
 * @internal Exported for focused correlated-write contract tests.
 */
export function currentValuePathContracts(
  unresolved: PathSchemaContract,
  segment: string | number,
  currentValue: unknown,
  candidateValue: unknown,
  active = new WeakSet<object>(),
): PathSchemaContract[] {
  const contract = resolvePathSchemaContract(unresolved);
  try {
    return linkPathContracts([contract], [segment]);
  } catch (originalError) {
    const { schema, root } = contract;
    if (!isObjectOrArray(schema)) throw originalError;
    if (active.has(schema)) {
      throw new Error("recursive correlated write schema cannot be localized");
    }
    active.add(schema);
    try {
      const selectedContainer = selectCurrentContainerSchema(
        schema,
        candidateValue,
      );
      if (selectedContainer !== schema) {
        return currentValuePathContracts(
          {
            ...contract,
            schema: selectedContainer,
            root: root,
          },
          segment,
          currentValue,
          candidateValue,
          active,
        );
      }

      const hasComposition = Array.isArray(schema.anyOf) ||
        Array.isArray(schema.oneOf) || Array.isArray(schema.allOf);
      if (!hasComposition) throw originalError;

      const {
        anyOf: _anyOf,
        oneOf: _oneOf,
        allOf: _allOf,
        ...base
      } = schema;
      const contracts: PathSchemaContract[] = [];
      const baseObjectShaped = base.type === "object" ||
        base.properties !== undefined ||
        base.patternProperties !== undefined ||
        base.additionalProperties !== undefined;
      const baseArrayShaped = base.type === "array" ||
        base.items !== undefined || base.prefixItems !== undefined;
      if (baseObjectShaped || baseArrayShaped) {
        contracts.push(...currentValuePathContracts(
          {
            ...contract,
            schema: base,
            root: root,
          },
          segment,
          currentValue,
          candidateValue,
          active,
        ));
      } else if (
        Object.keys(base).some((key) =>
          !LINK_PATH_NEUTRAL_ANCESTOR_KEYS.has(key)
        )
      ) {
        throw originalError;
      }

      const branchContract = (branch: JSONSchema): PathSchemaContract => ({
        ...contract,
        schema: branch,
        root: root,
      });
      const branchMatches = (branch: JSONSchema, value: unknown): boolean => {
        const branchRoot = root;
        return validateSchemaValue(
          branch,
          value,
          branchRoot,
          { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
        ) === undefined;
      };
      for (const key of ["anyOf", "oneOf"] as const) {
        const alternatives = schema[key];
        if (!Array.isArray(alternatives)) continue;
        const candidateMatches = alternatives.filter((branch) =>
          branchMatches(branch, candidateValue)
        );
        if (
          candidateMatches.length === 0 ||
          key === "oneOf" && candidateMatches.length !== 1
        ) {
          throw new Error(
            `staged producer value does not select a valid ${key} write contract`,
          );
        }
        const currentMatches = alternatives.filter((branch) =>
          branchMatches(branch, currentValue)
        );
        const selected = [
          ...new Set([
            ...candidateMatches,
            ...(key === "anyOf" || currentMatches.length === 1
              ? currentMatches
              : []),
          ]),
        ];
        for (const branch of selected) {
          contracts.push(...currentValuePathContracts(
            branchContract(branch),
            segment,
            currentValue,
            candidateValue,
            active,
          ));
        }
      }
      if (Array.isArray(schema.allOf)) {
        for (const branch of schema.allOf) {
          if (!branchMatches(branch, candidateValue)) {
            throw new Error(
              "current producer value does not satisfy an allOf write contract",
            );
          }
          contracts.push(...currentValuePathContracts(
            branchContract(branch),
            segment,
            currentValue,
            candidateValue,
            active,
          ));
        }
      }
      if (contracts.length === 0) throw originalError;
      return contracts;
    } finally {
      active.delete(schema);
    }
  }
}

function withoutTopLevelScope(schema: JSONSchema): JSONSchema {
  if (
    !isObjectOrArray(schema) || schema.scope === undefined
  ) {
    return schema;
  }
  const { scope: _scope, ...payload } = schema;
  return payload;
}

/**
 * Consume exactly one wrapper, retaining any nested Cell contract.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function consumeOuterCellContract(
  schema: JSONSchema,
): OuterCellContract {
  const entries = ContextualFlowControl.getAsCellValues(schema);
  if (entries.length === 0 || !isObjectOrArray(schema)) {
    return { kind: "cell", payloadSchema: schema };
  }
  const kind = ContextualFlowControl.getAsCellKind(entries[0]);
  if (kind === undefined) throw new Error("invalid outer Cell kind");
  const { asCell: _asCell, ...payloadSchema } = schema;
  return {
    kind,
    payloadSchema: entries.length === 1
      ? payloadSchema
      : { ...payloadSchema, asCell: entries.slice(1) },
  };
}

function outerCellShapesMatch(
  left: OuterCellShape,
  right: OuterCellShape,
): boolean {
  return left.kind === right.kind && left.scope === right.scope;
}

/**
 * Consume a uniform outer Cell wrapper through refs and compositions.
 *
 * @internal Exported for focused Cell-capability contract tests.
 */
export function localizeOuterCellContract(
  unresolved: PathSchemaContract,
  stored: StoredCellTopology | undefined = undefined,
  active = new WeakSet<object>(),
): OuterCellLocalization {
  const contract = resolvePathSchemaContract(unresolved);
  const { schema, root } = contract;
  if (!isObjectOrArray(schema)) return { contract };
  if (active.has(schema)) {
    return { contract, issue: "recursive Cell schema cannot be localized" };
  }
  active.add(schema);
  try {
    const entries = ContextualFlowControl.getAsCellValues(schema);
    if (entries.length > 0) {
      const consumed = consumeOuterCellContract(schema);
      return {
        contract: { ...contract, schema: consumed.payloadSchema, root },
        outer: {
          kind: consumed.kind,
          scope: ContextualFlowControl.getAsCellScope(entries[0]),
        },
      };
    }

    let changed = false;
    let outer: OuterCellShape | undefined;
    const result = { ...schema };
    const mergeOuter = (
      candidate: OuterCellShape,
    ): string | undefined => {
      if (outer !== undefined && !outerCellShapesMatch(outer, candidate)) {
        return "Cell alternatives expose incompatible outer capabilities";
      }
      outer = candidate;
      return undefined;
    };

    for (const key of ["anyOf", "oneOf"] as const) {
      const alternatives = schema[key];
      if (!Array.isArray(alternatives)) continue;
      const localized = alternatives.map((alternative) =>
        localizeOuterCellContract(
          {
            schema: alternative,
            root: root,
          },
          stored,
          active,
        )
      );
      const invalid = localized.find((entry) => entry.issue !== undefined);
      if (invalid !== undefined) return invalid;
      const wrapped = localized.filter((entry) => entry.outer !== undefined);
      if (wrapped.length === 0) continue;
      if (wrapped.length !== localized.length) {
        if (stored !== undefined && !stored.opaqueHandle) {
          const unwrapped = localized.filter((entry) =>
            entry.outer === undefined
          );
          if (
            unwrapped.length === 1 &&
            Object.keys(schema).every((schemaKey) =>
              schemaKey === key || SCHEMA_ANNOTATION_KEYS.has(schemaKey)
            )
          ) {
            // Once raw topology selects the sole ordinary alternative, a
            // singleton union with annotations is exactly that branch. Return
            // it directly so descendant localization does not mistake the
            // already-resolved union for a parent/child correlation.
            return unwrapped[0];
          }
          result[key] = unwrapped.map((entry) => entry.contract.schema);
          changed = true;
          continue;
        }
        const opaqueProbe = Symbol("opaque Cell schema probe");
        const ambiguous = localized.some((entry) =>
          entry.outer === undefined &&
          validateSchemaValue(
              entry.contract.schema,
              opaqueProbe,
              entry.contract.root,
              {
                acceptOpaqueValue: (_value, candidateSchema) =>
                  ContextualFlowControl.getAsCellValues(candidateSchema)
                    .length > 0,
              },
            ) === undefined
        );
        if (ambiguous) {
          const onlyStreams = wrapped.every((entry) =>
            entry.outer?.kind === "stream"
          );
          return {
            contract,
            issue: onlyStreams
              ? `stream event schema has mixed stream and non-stream ${key} alternatives`
              : `Cell schema has ambiguous wrapped and unwrapped ${key} alternatives`,
          };
        }
      }
      for (const entry of wrapped) {
        const issue = mergeOuter(entry.outer!);
        if (issue !== undefined) return { contract, issue };
      }
      // The concrete value is an opaque Cell handle, so unwrapped alternatives
      // that cannot accept that handle were not selected. Source-path absence
      // is tracked separately on the contract and restored after localization.
      result[key] = wrapped.map((entry) => entry.contract.schema);
      changed = true;
    }

    if (Array.isArray(schema.allOf)) {
      const localized = schema.allOf.map((alternative) =>
        localizeOuterCellContract(
          {
            schema: alternative,
            root: root,
          },
          stored,
          active,
        )
      );
      const invalid = localized.find((entry) => entry.issue !== undefined);
      if (invalid !== undefined) return invalid;
      const wrapped = localized.filter((entry) => entry.outer !== undefined);
      for (const entry of wrapped) {
        const issue = mergeOuter(entry.outer!);
        if (issue !== undefined) return { contract, issue };
      }
      if (wrapped.length > 0) {
        result.allOf = localized.map((entry, index) =>
          entry.outer === undefined
            ? schema.allOf![index]
            : entry.contract.schema
        );
        changed = true;
      }
    }
    return {
      contract: { ...contract, schema: changed ? result : schema, root },
      outer,
    };
  } finally {
    active.delete(schema);
  }
}

/** @internal Exported for exhaustive authority-lattice tests. */
export function cellCapabilityCanNarrow(
  source: CellKind,
  target: CellKind,
): boolean {
  if (source === target) return true;
  if (source === "cell") {
    return target === "readonly" || target === "writeonly" ||
      target === "opaque" || target === "comparable";
  }
  if (source === "readonly") {
    return target === "comparable" || target === "opaque";
  }
  return false;
}

const cellKindCanWrite = (kind: CellKind): boolean =>
  kind === "cell" || kind === "writeonly" || kind === "stream";

/** @internal Exported for focused Cell-capability contract tests. */
export function assertWritablePiecePath(
  schema: JSONSchema,
  path: readonly (string | number)[],
  bindingAtTerminal: boolean,
  writesThroughTerminal: boolean,
  baseCell: Cell<unknown>,
): void {
  let contracts: PathSchemaContract[] = [{ schema, root: schema }];
  const rawRoot = baseCell.getRawUntyped({ lastNode: "top" });
  for (let index = 0; index <= path.length; index++) {
    const terminal = index === path.length;
    // A terminal replacement/initialization does not exercise a Cell
    // capability. If it resolves through an existing link, however, it is a
    // write against that producer and the wrapper must authorize it.
    if (terminal && (bindingAtTerminal || !writesThroughTerminal)) return;
    const prefix = path.slice(0, index);
    const storedValue = rawValueAtPath(rawRoot, prefix);
    let prefixCell = baseCell;
    for (const segment of prefix) {
      prefixCell = prefixCell.key(segment as keyof unknown) as Cell<unknown>;
    }
    const stored = storedCellTopology(storedValue.value, prefixCell);
    const localized = contracts.map((contract) =>
      localizeOuterCellContract(contract, stored)
    );
    const invalid = localized.find((entry) => entry.issue !== undefined);
    if (invalid?.issue !== undefined) throw new Error(invalid.issue);
    for (const entry of localized) {
      if (
        entry.outer !== undefined &&
        (!cellKindCanWrite(entry.outer.kind) ||
          !terminal && entry.outer.kind === "stream")
      ) {
        throw new Error(
          `${entry.outer.kind} Cell path is not writable`,
        );
      }
    }
    // Once a durable link is encountered, the resolved producer contract is
    // checked independently below. Continuing through the caller schema would
    // inspect payload branches without the producer's raw topology and can
    // mistake an ordinary union alternative for a restricted Cell handle.
    if (isLink(stored.value) && writesThroughTerminal) return;
    if (terminal) return;
    const localizedContracts = localized.map((entry) => entry.contract);
    try {
      contracts = linkPathContracts(localizedContracts, [path[index]!]);
    } catch {
      // Capability checks need only the wrapper shape at the next slot. The
      // ordinary write validator below still handles parent correlations, so
      // use CFC's conservative path projection when exact link localization
      // deliberately fails closed for a correlated schema.
      contracts = localizedContracts.map((contract) => {
        const child = ContextualFlowControl.schemaAtPath(contract.schema, [
          String(path[index]!),
        ]);
        return {
          schema: child,
          root: contract.root,
        };
      });
    }
  }
}

/**
 * Localize a schema from a stream handle to its event payload.
 *
 * A union can describe both stream and non-stream durable values. Every union
 * branch must expose the same outer stream wrapper before it can be consumed;
 * mixed unions fail closed because an unwrapped branch may also accept an
 * opaque stream handle. Intersections retain unwrapped sibling constraints on
 * the payload, while an explicit non-stream Cell wrapper is contradictory.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function localizeStreamEventContract(
  unresolved: PathSchemaContract,
  active = new WeakSet<object>(),
): StreamEventLocalization {
  const contract = resolvePathSchemaContract(unresolved);
  const { schema, root } = contract;
  if (!isObjectOrArray(schema)) {
    return { contract, consumedStream: false };
  }
  if (active.has(schema)) {
    throw new Error("recursive stream event schema cannot be localized");
  }
  active.add(schema);
  try {
    const entries = ContextualFlowControl.getAsCellValues(schema);
    if (entries.length > 0) {
      const consumed = consumeOuterCellContract(schema);
      if (consumed.kind !== "stream") {
        return {
          contract,
          consumedStream: false,
          issue: `stream event schema uses ${consumed.kind} wrapper`,
        };
      }
      return {
        contract: { schema: consumed.payloadSchema, root },
        consumedStream: true,
      };
    }

    let changed = false;
    let consumedStream = false;
    const result = { ...schema };
    for (const key of ["anyOf", "oneOf"] as const) {
      const alternatives = schema[key];
      if (!Array.isArray(alternatives)) continue;
      const localized = alternatives.map((alternative) =>
        localizeStreamEventContract(
          {
            schema: alternative,
            root: root,
          },
          active,
        )
      );
      const streamAlternatives = localized.filter((alternative) =>
        alternative.consumedStream
      );
      if (streamAlternatives.length > 0) {
        if (streamAlternatives.length !== localized.length) {
          return {
            contract,
            consumedStream: false,
            issue:
              `stream event schema has mixed stream and non-stream ${key} alternatives`,
          };
        }
        result[key] = streamAlternatives.map((alternative) =>
          alternative.contract.schema
        );
        consumedStream = true;
        changed = true;
      } else {
        const invalid = localized.find((alternative) =>
          alternative.issue !== undefined
        );
        if (invalid !== undefined) return invalid;
      }
    }

    if (Array.isArray(schema.allOf)) {
      const localized = schema.allOf.map((alternative) =>
        localizeStreamEventContract(
          {
            schema: alternative,
            root: root,
          },
          active,
        )
      );
      const invalid = localized.find((alternative) =>
        alternative.issue !== undefined
      );
      if (invalid !== undefined) return invalid;
      if (localized.some((alternative) => alternative.consumedStream)) {
        result.allOf = localized.map((alternative, index) =>
          alternative.consumedStream
            ? alternative.contract.schema
            : schema.allOf![index]
        );
        consumedStream = true;
        changed = true;
      }
    }
    return {
      contract: { schema: changed ? result : schema, root },
      consumedStream,
    };
  } finally {
    active.delete(schema);
  }
}

/**
 * Consume exactly one stream wrapper from the applicable event contract.
 *
 * @internal Exported for focused contract tests; not part of the Piece API.
 */
export function consumeStreamEventContract(
  contract: PathSchemaContract,
): PathSchemaContract {
  const localized = localizeStreamEventContract(contract);
  if (localized.issue !== undefined) throw new Error(localized.issue);
  if (!localized.consumedStream) {
    throw new Error("stream event schema has no stream-bearing alternative");
  }
  return localized.contract;
}

function canFollowSourceScope(
  schema: JSONSchema,
  sourceScope: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>["scope"],
): boolean {
  const cap = ContextualFlowControl.getSchemaScopeCap(schema);
  if (cap === undefined || cap === "any") return true;
  const rank = { space: 0, user: 1, session: 2 } as const;
  return rank[sourceScope] <= rank[cap];
}

/**
 * Recover a producer contract from durable Piece metadata, ignoring any schema
 * carried by the supplied alias. A caller can narrow a Cell view before
 * serializing it, so the envelope itself is not evidence about future writes.
 *
 * @internal Exported for focused producer-topology contract tests.
 */
export function durableSourceContract(
  linkedCell: Cell<unknown>,
  pieces: PiecesController,
): DurableSourceContract | undefined {
  const rawSourceLink = linkedCell.getAsNormalizedFullLink();
  // Producer-owned metadata (`schema`, and the `result` backlink) is
  // scope-partitioned. A scoped *result* cell carries its own metadata in its
  // scope partition, but a scoped *input* redirect (a `PerUser`/`PerSession`
  // input) points at a base-scoped producer document whose metadata lives only
  // in the base ("space") partition — the redirect's own partition holds just
  // the scoped value. Recover at whichever partition actually holds the
  // metadata: prefer the link's own scope, then fall back to base. Reading only
  // the redirect's scope makes a scoped input look contract-less, which rejects
  // even an identical-source `setsrc`; reading only base would strip a scoped
  // result cell of its legitimate contract.
  const metaScope = ((): LinkScope | undefined => {
    if (rawSourceLink.scope === "space") return rawSourceLink.scope;
    const scopedRoot = pieces.runtime.getCellFromLink(
      { ...rawSourceLink, path: [], schema: undefined },
      undefined,
      linkedCell.tx,
    );
    const hasScopedMeta = scopedRoot.getMetaRaw("schema") !== undefined ||
      scopedRoot.getMetaRaw("result") !== undefined;
    return hasScopedMeta ? rawSourceLink.scope : undefined;
  })();
  const sourceLink = { ...rawSourceLink, scope: metaScope };
  const sourceRoot = pieces.runtime.getCellFromLink(
    { ...sourceLink, path: [], schema: undefined },
    undefined,
    linkedCell.tx,
  );

  const resultSchema = readResultSchemaMeta(sourceRoot);
  if (resultSchema !== undefined) {
    return {
      schemas: [{
        root: resultSchema,
        path: [...sourceLink.path],
        rawBasePath: [],
        schemaBaseDepth: 0,
        validationCell: sourceRoot,
        validationPath: [...sourceLink.path],
      }],
    };
  }

  // Argument and derived-internal documents carry a producer-owned backlink
  // to their Piece result. Recover their schemas from that result's metadata;
  // the schema on `sourceLink` itself is caller-carried and can be forged with
  // asSchema().
  const resultLink = getMetaLink(sourceRoot, "result");
  if (resultLink === undefined) return undefined;
  const ownerResult = pieces.runtime.getCellFromLink(
    { ...resultLink, schema: undefined },
    undefined,
    linkedCell.tx,
  );
  const relativePath = (
    producerLink: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
    matchScope: LinkScope | undefined = sourceLink.scope,
  ): (string | number)[] | undefined => {
    if (
      producerLink.space !== sourceLink.space ||
      producerLink.id !== sourceLink.id ||
      (producerLink.scope ?? "space") !== (matchScope ?? "space") ||
      producerLink.path.length > sourceLink.path.length ||
      producerLink.path.some((segment, index) =>
        segment !== sourceLink.path[index]
      )
    ) return undefined;
    return [...sourceLink.path.slice(producerLink.path.length)];
  };

  const schemas: DurableSchemaPath[] = [];
  let ownedArgument = false;
  const argumentLink = getMetaLink(ownerResult, "argument");
  if (argumentLink?.schema !== undefined) {
    const path = relativePath(argumentLink);
    if (path !== undefined) {
      ownedArgument = true;
      schemas.push({
        root: argumentLink.schema,
        path,
        rawBasePath: [...argumentLink.path],
        schemaBaseDepth: 0,
        validationCell: pieces.runtime.getCellFromLink(
          { ...argumentLink, schema: undefined },
          undefined,
          linkedCell.tx,
        ),
        validationPath: path,
      });
    }
  }

  const internal = ownerResult.getMetaRaw("internal");
  let ownedInternal = false;
  if (!ownedArgument && Array.isArray(internal)) {
    for (const descriptor of internal) {
      if (
        !isObjectOrArray(descriptor) ||
        !("link" in descriptor)
      ) continue;
      try {
        const parsedInternalLink = parseLinkOrThrow(
          (descriptor as { link: unknown }).link,
          ownerResult,
        );
        const internalLink = pieces.runtime.getCellFromLink(
          parsedInternalLink,
          parsedInternalLink.schema,
          linkedCell.tx,
        ).getAsNormalizedFullLink();
        const path = relativePath(internalLink);
        if (path === undefined) continue;
        ownedInternal = true;
        if (internalLink.schema !== undefined) {
          schemas.push({
            root: internalLink.schema,
            path,
            rawBasePath: [...internalLink.path],
            schemaBaseDepth: 0,
            validationCell: pieces.runtime.getCellFromLink(
              { ...internalLink, schema: undefined },
              undefined,
              linkedCell.tx,
            ),
            validationPath: path,
          });
        }
        break;
      } catch {
        // A malformed manifest entry is not evidence for a writable contract.
      }
    }
  }
  if (!ownedArgument && !ownedInternal) return undefined;

  // Argument and internal values may also be exposed through one or more
  // public result projections. Every current projection is an additional
  // producer-owned constraint: a write must preserve the argument/internal
  // contract and all public result contracts simultaneously.
  const ownerSchema = readResultSchemaMeta(ownerResult);
  const projected: DurableSchemaPath[] = [];
  if (ownerSchema !== undefined) {
    const rawResult = ownerResult.getRawUntyped({ lastNode: "top" });
    const seen = new WeakSet<object>();
    const visit = (
      value: unknown,
      projectionPath: (string | number)[],
      projectionCell: Cell<unknown>,
    ): void => {
      if (isLink(value)) {
        try {
          const parsed = parseLinkOrThrow(value, projectionCell);
          const target = pieces.runtime.getCellFromLink(
            parsed,
            parsed.schema,
            linkedCell.tx,
          ).getAsNormalizedFullLink();
          // A projection is matched at the instance the link names. A result
          // alias reading a scoped input addresses the input's base slot and
          // reaches the scoped value through its redirect, so it is not
          // collected for a scoped source; the argument contract above
          // governs that value.
          const suffix = relativePath(target, rawSourceLink.scope);
          if (suffix !== undefined) {
            projected.push({
              root: ownerSchema,
              path: [...projectionPath, ...suffix],
              rawBasePath: [...target.path],
              schemaBaseDepth: projectionPath.length,
              validationCell: ownerResult,
              validationPath: [...projectionPath, ...suffix],
            });
          }
        } catch {
          // Malformed aliases are rejected by ordinary Piece validation.
        }
        return;
      }
      if (!isObjectOrArray(value) || seen.has(value)) {
        return;
      }
      seen.add(value);
      // TODO(danfuzz): a `FabricInstance` passes the `typeof` gate with zero
      // `Object.keys`, so an alias nested in its codec contents is never
      // projected and the durable-source contract silently omits it.
      for (const key of Object.keys(value)) {
        const segment = Array.isArray(value) ? Number(key) : key;
        visit(
          (value as Record<PropertyKey, unknown>)[key],
          [...projectionPath, segment],
          projectionCell.key(segment as keyof unknown) as Cell<unknown>,
        );
      }
      seen.delete(value);
    };
    visit(rawResult, [], ownerResult);
  }
  if (projected.length > 0) {
    const unique = new Map(
      projected.map((entry) => [JSON.stringify(entry.path), entry]),
    );
    schemas.push(...unique.values());
  }
  return schemas.length === 0 ? undefined : { schemas };
}

/**
 * Record raw links supplied anywhere in a Piece API value. Default merging
 * operates on their transaction-local materializations; the exact envelopes
 * are restored before the final durable write.
 */
function suppliedLinks(
  value: unknown,
  path: (string | number)[] = [],
  seen = new WeakSet<object>(),
): SuppliedLink[] {
  if (isLink(value)) return [{ path, value }];
  if (!isObjectOrArray(value) || seen.has(value)) return [];

  const prototype = Object.getPrototypeOf(value);
  // TODO(danfuzz): the prototype gate treats a `FabricInstance` as a leaf,
  // so a link envelope inside one is never recorded here — it then skips
  // `assertSuppliedLinkSchemasCompatible` entirely and flows to the durable
  // write as an unchecked raw envelope.
  if (
    !Array.isArray(value) && prototype !== Object.prototype &&
    prototype !== null
  ) {
    return [];
  }
  seen.add(value);

  const links: SuppliedLink[] = [];
  for (const key of Object.keys(value)) {
    links.push(...suppliedLinks(
      (value as Record<string, unknown>)[key],
      [...path, key],
      seen,
    ));
  }
  seen.delete(value);
  return links;
}

/**
 * Prove that every value the source contracts admit is accepted by every
 * target contract.
 *
 * The source and target contract lists are conjunctions. Proving any source
 * conjunct implies each target conjunct is a conservative proof that the
 * complete source intersection is accepted by the target intersection.
 * Possible absence of a source value rides the contracts' `mayBeMissing`
 * flags and is resolved per source/target pair inside the proof.
 */
function assertContractSubset(
  sources: readonly PathSchemaContract[],
  targets: readonly PathSchemaContract[],
  label: string,
): void {
  for (const target of targets) {
    let lastError: unknown;
    const proved = sources.some((source) => {
      // A source that may hold no value must prove absence acceptable. When
      // the destination slot is itself optional, absence is a state the
      // destination already tolerates, so the value schemas are compared
      // directly. When the destination is required, absence must be provable
      // against the destination's value schema, so an explicit `undefined`
      // alternative is injected into the source side of the proof. Absence is
      // discharged at the flag level — never by rewriting the source schema —
      // so a producer schema that itself admits a *present* `undefined` value
      // keeps that alternative and the destination value schema must accept
      // it, optional slot or not. (Injecting `undefined` into the target
      // instead would trip the union-with-default "not stable under default
      // insertion" fail-close.)
      const sourceSchema: JSONSchema = source.mayBeMissing === true &&
          target.mayBeMissing !== true
        ? { anyOf: [source.schema, { type: "undefined" }] }
        : source.schema;
      try {
        assertSchemaSubset(
          withoutTopLevelScope(sourceSchema),
          withoutTopLevelScope(target.schema),
          label,
          { sourceRoot: source.root, targetRoot: target.root },
        );
        return true;
      } catch (error) {
        lastError = error;
        return false;
      }
    });
    if (!proved) throw lastError;
  }
}

/** Drop the `mayBeMissing` flag for proofs where absence cannot occur. */
function withoutMissingFlag(
  { mayBeMissing: _, ...contract }: PathSchemaContract,
): PathSchemaContract {
  return contract;
}

/**
 * Whether a supplied SERIALIZED link is identical to the value already
 * durably committed at its path under `baseCell`.
 *
 * This is what lets a restore flow (`linksPreservedVerbatim`) treat a
 * serialized link as a preserved direct handle without taking the caller's
 * word for any individual link: writing back bytes that are already committed
 * grants nothing that was not already granted. Anything else arriving under
 * the flag — a fresh link minted from the incoming pattern's schema
 * `default`s, a caller-mutated envelope — fails the comparison and falls
 * through to the rebuild rules, exactly as if the flag were unset.
 *
 * The comparison must run against COMMITTED state, not the transaction's
 * staged view: the caller that sets the flag validates after
 * `applySetupState` has already staged the argument write, so a staged-side
 * read would compare the supplied links against themselves and always pass.
 * `withTx()` with no transaction detaches the read.
 */
function linkMatchesCommittedState(
  suppliedLink: SuppliedLink,
  baseCell: Cell<unknown>,
  basePath: readonly (string | number)[],
): boolean {
  // Live Cells prove preservation in `derivePreserveDecision`, not equality
  // to stored bytes. They are not serialized FabricValues.
  if (isCell(suppliedLink.value)) return false;
  // After excluding live Cells, `parseLinkOrThrow` guarantees a serialized
  // link, which cannot equal an absent committed slot.
  const committedRoot = baseCell.withTx().getRaw();
  const committed = getValueAtPath(committedRoot, [
    ...basePath,
    ...suppliedLink.path,
  ]);
  return fabricAwareEqual(committed, suppliedLink.value);
}

/** Wrap a per-concern failure in the uniform supplied-link rejection. */
function incompatibleLinkError(displayPath: string, cause: unknown): Error {
  return new Error(
    `input link at ${displayPath} schema is not compatible: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  );
}

/**
 * Localize each contract's outer Cell wrapper and require every wrapped
 * contract to agree on one outer shape. A failed localization or a
 * disagreement is reported as `issue` — `disagreement` names the latter —
 * so each caller can raise it in its own error form.
 */
function localizeUniformOuter(
  contracts: readonly PathSchemaContract[],
  disagreement: string,
): {
  localized: OuterCellLocalization[];
  outer?: OuterCellShape;
  issue?: string;
} {
  const localized = contracts.map((contract) =>
    localizeOuterCellContract(contract)
  );
  const invalid = localized.find((entry) => entry.issue !== undefined);
  if (invalid?.issue !== undefined) {
    return { localized, issue: invalid.issue };
  }
  const outers = localized.flatMap((entry) =>
    entry.outer === undefined ? [] : [entry.outer]
  );
  const outer = outers[0];
  for (const candidate of outers.slice(1)) {
    if (!outerCellShapesMatch(outer!, candidate)) {
      return { localized, outer, issue: disagreement };
    }
  }
  return { localized, outer };
}

/** Resolve a link envelope's carried schema through refs, when it has one. */
function carriedEnvelopeSchema(
  link: NormalizedLink,
): JSONSchema | undefined {
  return link.schema === undefined ? undefined : linkPathContracts(
    [{ schema: link.schema, root: link.schema }],
    [],
  )[0]?.schema;
}

/** Derive the destination contracts a supplied link's path must satisfy. */
function deriveTargetContracts(
  destinationSchema: JSONSchema,
  destinationRoot: JSONSchema,
  destinationIsStream: boolean,
  basePath: readonly (string | number)[],
  linkPath: readonly (string | number)[],
  displayPath: string,
): PathSchemaContract[] {
  try {
    if (destinationIsStream) {
      const streamContracts = linkPathContracts(
        [{ schema: destinationSchema, root: destinationRoot }],
        basePath,
      ).map((contract) => consumeStreamEventContract(contract));
      return linkPathContracts(streamContracts, linkPath);
    }
    // Track destination presence so an optional destination slot records
    // `mayBeMissing`, mirroring the source-side tracking in
    // `buildSourceContracts`: a source that may hold no value must only be
    // provable against a destination that also tolerates absence.
    return linkPathContracts(
      [{ schema: destinationSchema, root: destinationRoot }],
      [...basePath, ...linkPath],
      { trackSourcePresence: true, preserveMissingFlag: true },
    );
  } catch (error) {
    throw incompatibleLinkError(displayPath, error);
  }
}

/**
 * Parse a supplied link and recover its producer's durable schema contract.
 * A metadata-less linked document is held to the prior argument contract on
 * a pattern update. Dynamic binding can explicitly accept an unproven source;
 * other supplied-link operations require the durable contract.
 */
function resolveDurableSource(
  suppliedLink: SuppliedLink,
  linkBase: Cell<unknown>,
  baseCell: Cell<unknown>,
  fullPath: readonly (string | number)[],
  pieces: PiecesController,
  priorArgumentSchema: JSONSchema | undefined,
  displayPath: string,
  allowUnprovenSource: boolean,
): {
  link: NormalizedLink;
  linkedCell: Cell<unknown>;
  durableSource: DurableSourceContract | undefined;
} {
  const link = parseLinkOrThrow(suppliedLink.value, linkBase);
  const linkedCell = pieces.runtime.getCellFromLink(
    { ...link, schema: undefined },
    undefined,
    linkBase.tx,
  );
  // A direct Cell view can be narrowed with asSchema() just as easily as a
  // serialized alias can carry a narrowed schema. Neither is a future-value
  // invariant, so a static producer proof needs producer-owned metadata.
  let durableSource = durableSourceContract(linkedCell, pieces);
  if (durableSource === undefined && priorArgumentSchema !== undefined) {
    // Pattern update over existing state: hold a metadata-less linked doc to
    // the prior argument contract at this path (see the option's doc).
    durableSource = {
      schemas: [{
        root: priorArgumentSchema,
        path: [...fullPath],
        rawBasePath: [],
        schemaBaseDepth: 0,
        validationCell: baseCell,
        validationPath: [...fullPath],
      }],
    };
  }
  if (durableSource === undefined && !allowUnprovenSource) {
    throw incompatibleLinkError(
      displayPath,
      "source has no durable schema contract",
    );
  }
  if (durableSource === undefined) {
    // An ordinary document is dynamic; a known Piece document whose contract
    // cannot be recovered is unproved. Check both metadata partitions, as for
    // scoped producer-contract recovery, before admitting a dynamic binding.
    const sourceLink = linkedCell.getAsNormalizedFullLink();
    const scopes = sourceLink.scope === "space"
      ? [sourceLink.scope]
      : [sourceLink.scope, "space"] as const;
    for (const scope of scopes) {
      const root = pieces.runtime.getCellFromLink(
        { ...sourceLink, path: [], schema: undefined, scope },
        undefined,
        linkedCell.tx,
      );
      if (
        root.getMetaRaw("result") !== undefined ||
        getPatternIdentityRef(root) !== undefined
      ) {
        throw incompatibleLinkError(
          displayPath,
          "source Piece metadata cannot establish a durable schema contract",
        );
      }
    }
  }
  return { link, linkedCell, durableSource };
}

/** Localize the destination contracts and derive their agreed outer shape. */
function localizeTargetOuter(
  targetContracts: readonly PathSchemaContract[],
  displayPath: string,
): {
  localizedTargets: OuterCellLocalization[];
  targetOuter: OuterCellShape | undefined;
} {
  const targets = localizeUniformOuter(
    targetContracts,
    "destination Cell constraints disagree",
  );
  if (targets.issue !== undefined) {
    throw incompatibleLinkError(displayPath, targets.issue);
  }
  return { localizedTargets: targets.localized, targetOuter: targets.outer };
}

/**
 * Decide whether a supplied link's original envelope survives the caller's
 * write, returning the destination's outer Cell shape when it does and
 * `undefined` when the envelope is rebuilt. Only a destination with an outer
 * Cell wrapper can accept a direct handle at all, so absent `targetOuter`
 * the decision is always a rebuild.
 *
 * Two independent ways to know the envelope survives: the value is a live
 * Cell the caller demonstrably holds, or the caller declared a preserving
 * write plan AND the link is identical to what is already committed at its
 * path.
 *
 * These answer different questions and must not be conflated. `isCell` is
 * PROVENANCE — a live Cell is a capability the caller possesses, whereas a
 * serialized sigil link is just bytes it wrote. The rebuild rules
 * (`policeRebuiltAlias`) are about the WRITE PLAN: every one of them polices
 * a rebuild that is about to happen. Inferring the plan from the provenance
 * is sound wherever the caller actually rebuilds, and false at `setPattern`,
 * which rebuilds nothing — it discards
 * `assertSuppliedLinkSchemasCompatible`'s return value and lets
 * `applySetupState` carry the argument over from `getRaw()`. Conflating them
 * would judge an injected capability input (Loom's `db: SqliteDb`, `asCell:
 * ["sqlite"]`) restored from raw storage as exposing the capability as an
 * ordinary alias — raw storage holds serialized links, which are never
 * `isCell()` — a laundering the caller is not performing, and the capability
 * could then never be carried across a source update.
 *
 * The declared plan is verified per link, not trusted: only bytes already
 * durably committed at this path count as "preserved" (see
 * `linkMatchesCommittedState`). In the one flow that sets the flag, the
 * staged argument is the previous argument merged with the INCOMING
 * pattern's schema defaults — a link-shaped default would be brand-new,
 * pattern-authored bytes riding the same restore, and it falls through to
 * the rebuild rules.
 */
function derivePreserveDecision(
  suppliedLink: SuppliedLink,
  targetOuter: OuterCellShape | undefined,
  baseCell: Cell<unknown>,
  basePath: readonly (string | number)[],
  linksPreservedVerbatim: boolean | undefined,
): OuterCellShape | undefined {
  if (targetOuter === undefined) return undefined;
  const preserves = isCell(suppliedLink.value) ||
    (linksPreservedVerbatim === true &&
      linkMatchesCommittedState(suppliedLink, baseCell, basePath));
  return preserves ? targetOuter : undefined;
}

/**
 * Build the producer-side contracts for the subset proofs, in two lenses:
 * `rawSourceContracts` keeps every Cell wrapper for the capability policing
 * in `policeRebuiltAlias`, while `sourceContracts` carries the sanitize-vs-
 * keep choice — a rebuilt link materializes through the destination's
 * schema, so its nested (non-stream) Cell wrappers are stripped from the
 * payload proof; a preserved envelope keeps them.
 */
function buildSourceContracts(
  durableSource: DurableSourceContract,
  preservesDirectHandle: boolean,
  displayPath: string,
): {
  rawSourceContracts: PathSchemaContract[];
  sourceContracts: PathSchemaContract[];
} {
  try {
    const rawSourceContracts = durableSource.schemas.flatMap((source) =>
      linkPathContracts(
        [{ schema: source.root, root: source.root }],
        source.path,
        { trackSourcePresence: true, preserveMissingFlag: true },
      )
    );
    const sourceContracts = durableSource.schemas.flatMap((source) => {
      const root = preservesDirectHandle
        ? source.root
        : sanitizeSchemaForLinks(source.root, KeepAsCell.OnlyStream);
      return linkPathContracts(
        [{ schema: root, root }],
        source.path,
        { trackSourcePresence: true, preserveMissingFlag: true },
      );
    });
    return { rawSourceContracts, sourceContracts };
  } catch (error) {
    throw incompatibleLinkError(displayPath, error);
  }
}

/**
 * Police a link whose envelope is about to be rebuilt from a materialized
 * read: the raw producer contract must not expose a connector capability as
 * an ordinary alias, a durable stream wrapper must survive on the rebuilt
 * link, and the link must not carry a Cell wrapper its producer never
 * declared.
 */
function policeRebuiltAlias(
  rawSourceContracts: readonly PathSchemaContract[],
  sourceContracts: readonly PathSchemaContract[],
  link: NormalizedLink,
  displayPath: string,
): void {
  try {
    const rawSources = localizeUniformOuter(
      rawSourceContracts,
      "source Cell constraints disagree",
    );
    if (rawSources.issue !== undefined) {
      throw new Error(rawSources.issue);
    }
    const rawSourceOuter = rawSources.outer;
    if (
      rawSourceOuter !== undefined && rawSourceOuter.kind !== "cell" &&
      rawSourceOuter.kind !== "stream"
    ) {
      throw new Error(
        `${rawSourceOuter.kind} capability cannot be exposed as an ordinary alias`,
      );
    }
    const durableEntries = sourceContracts.map((contract) =>
      ContextualFlowControl.getAsCellValues(contract.schema)
    );
    const preservesStream = durableEntries.some((entries) =>
      ContextualFlowControl.getAsCellKind(entries[0]) === "stream"
    );
    if (preservesStream) {
      const streamContract = sourceContracts.find((contract) =>
        ContextualFlowControl.getAsCellKind(
          ContextualFlowControl.getAsCellValues(contract.schema)[0],
        ) === "stream"
      )!;
      if (
        !asCellShapesMatch(carriedEnvelopeSchema(link), streamContract.schema)
      ) {
        throw new Error(
          "link does not preserve its durable stream wrapper",
        );
      }
    } else if (
      ContextualFlowControl.getAsCellValues(link.schema).length > 0
    ) {
      throw new Error("link carries a non-durable Cell wrapper");
    }
  } catch (error) {
    throw incompatibleLinkError(displayPath, error);
  }
}

/** A source Cell's scope must fit every destination contract's scope cap. */
function assertSourceScopeFits(
  targetContracts: readonly PathSchemaContract[],
  linkedCell: Cell<unknown>,
  displayPath: string,
): void {
  const sourceScope = linkedCell.getAsNormalizedFullLink().scope;
  for (const targetContract of targetContracts) {
    if (!canFollowSourceScope(targetContract.schema, sourceScope)) {
      throw incompatibleLinkError(
        displayPath,
        `source Cell scope ${sourceScope} exceeds the destination scope`,
      );
    }
  }
}

/**
 * Police a link whose original envelope survives to the durable write, and
 * return the localized payload contracts the subset proofs consume in its
 * place: a serialized envelope must re-assert its carried Cell wrapper
 * against the durable contracts, the source's outer capability must narrow
 * to the destination's, and both sides' outer wrappers are consumed so the
 * proofs compare payloads.
 */
function policePreservedEnvelope(
  suppliedLink: SuppliedLink,
  link: NormalizedLink,
  sourceContracts: readonly PathSchemaContract[],
  localizedTargets: readonly OuterCellLocalization[],
  targetOuter: OuterCellShape,
  displayPath: string,
): {
  sourceContracts: PathSchemaContract[];
  targetContracts: PathSchemaContract[];
} {
  // A SERIALIZED link carries its own `schema` envelope, and that envelope
  // is caller-written bytes; a live Cell has no separate envelope to forge,
  // so only the serialized case needs this check (`policeRebuiltAlias`
  // polices the same forgery for rebuilt links). A serialized link only
  // reaches here when it is identical to already-committed state, but
  // committed does not mean vetted — stored links can originate outside this
  // validator — so re-assert it: a carried wrapper's `asCell` STACK (kind
  // and scope, per `asCellShapesMatch`; payload compatibility is decided
  // after these wrapper checks) has to match every durable
  // contract of the source. (Loom's injected links carry no envelope —
  // `PiecesController.link` serializes with `KeepAsCell.OnlyStream` — so the
  // real restore case is unaffected.)
  if (!isCell(suppliedLink.value)) {
    const carried = ContextualFlowControl.getAsCellValues(link.schema);
    if (carried.length > 0) {
      const carriedSchema = carriedEnvelopeSchema(link);
      // `.every`, not `.some`: the durable contracts are a conjunction,
      // so a wrapper the source did not declare in ALL of them was never
      // uniformly granted. Contracts that disagree about the wrapper
      // stack reject every carried envelope — that state is already
      // refused at the outer level below.
      const matchesDurableContract = sourceContracts.length > 0 &&
        sourceContracts.every((contract) =>
          asCellShapesMatch(carriedSchema, contract.schema)
        );
      if (!matchesDurableContract) {
        throw incompatibleLinkError(
          displayPath,
          "link carries a non-durable Cell wrapper",
        );
      }
    }
  }
  const sources = localizeUniformOuter(
    sourceContracts,
    "source Cell constraints disagree",
  );
  if (sources.issue !== undefined) {
    throw incompatibleLinkError(displayPath, sources.issue);
  }
  const sourceOuter = sources.outer ?? {
    kind: isStream(suppliedLink.value) ? "stream" : "cell",
    scope: undefined,
  };
  if (!cellCapabilityCanNarrow(sourceOuter.kind, targetOuter.kind)) {
    if (
      sourceOuter.kind === "stream" || targetOuter.kind === "stream"
    ) {
      throw incompatibleLinkError(
        displayPath,
        `${
          sourceOuter.kind === "stream" ? "Stream" : "Cell"
        } handle is not accepted as ${targetOuter.kind}`,
      );
    }
    throw incompatibleLinkError(
      displayPath,
      `${sourceOuter.kind} capability cannot be exposed as ${targetOuter.kind}`,
    );
  }
  return {
    sourceContracts: sources.localized.map((entry) => entry.contract),
    targetContracts: localizedTargets.map((entry) => entry.contract),
  };
}

/** Prove a rebuilt link's payload flow from source to destination. */
function proveRebuiltContracts(
  sourceContracts: readonly PathSchemaContract[],
  targetContracts: readonly PathSchemaContract[],
  displayPath: string,
): void {
  // Nested (non-stream) Cell wrappers are read-side projections, not part
  // of the payload contract: a wrapper-declaring source may serve a plain
  // slot, and a plain source may serve a wrapper-declaring slot (the
  // destination materializes the handle through its own schema either
  // way). `buildSourceContracts` already sanitizes the source contracts on
  // this path; the proof must see the destination through the same lens, or
  // a destination's nested `asCell` fails the exact-match comparison
  // against the sanitized source — refusing, among others, every
  // same-schema source update of a piece whose roster array stores elements
  // with a Cell-typed `profile` field. Capability kinds such as `sqlite`
  // strip here too: the payload proof deliberately ignores them at nested
  // positions. Capability policing is `policeRebuiltAlias`'s job (a
  // capability source refuses exposure as an ordinary alias there), and no
  // supported flow places a connector wrapper below a link payload.
  const proofTargets = targetContracts.map((contract) => ({
    ...contract,
    schema: sanitizeSchemaForLinks(
      contract.schema,
      KeepAsCell.OnlyStream,
    ),
    root: sanitizeSchemaForLinks(contract.root, KeepAsCell.OnlyStream),
  }));
  assertContractSubset(
    sourceContracts,
    proofTargets,
    `input link at ${displayPath}`,
  );
}

/** Prove a preserved handle's payload flow, in both directions it can move. */
function provePreservedContracts(
  sourceContracts: readonly PathSchemaContract[],
  targetContracts: readonly PathSchemaContract[],
  targetOuter: OuterCellShape,
  displayPath: string,
): void {
  const label = `input link at ${displayPath}`;
  if (
    targetOuter.kind !== "writeonly" && targetOuter.kind !== "stream"
  ) {
    assertContractSubset(sourceContracts, targetContracts, label);
  }
  if (cellKindCanWrite(targetOuter.kind)) {
    // A writable handle can send values back to the producer, so the
    // destination payload contract must also fit the source payload.
    // Absence never flows through a write-back — the handle writes concrete
    // values — so slot optionality on either side is irrelevant here and
    // the `mayBeMissing` flags are dropped from both.
    assertContractSubset(
      targetContracts.map(withoutMissingFlag),
      sourceContracts.map(withoutMissingFlag),
      label,
    );
  }
}

/**
 * Whether an update retains both a committed handle and its input contract.
 * The producer's policy remains on the linked document; preserving the same
 * handle under the same contract changes neither its policy nor its authority.
 * This proves consumer-contract continuity, not that the producer contract
 * was checked at link creation or has stayed unchanged. Producer enforcement
 * on access and commit governs the retained handle.
 */
function retainsInputHandleContract(
  suppliedLink: SuppliedLink,
  baseCell: Cell<unknown>,
  basePath: readonly (string | number)[],
  priorArgumentSchema: JSONSchema | undefined,
  targetContracts: readonly PathSchemaContract[],
): boolean {
  if (
    priorArgumentSchema === undefined ||
    !linkMatchesCommittedState(suppliedLink, baseCell, basePath)
  ) return false;
  try {
    const priorContracts = deriveTargetContracts(
      priorArgumentSchema,
      priorArgumentSchema,
      false,
      basePath,
      suppliedLink.path,
      suppliedLink.path.join(".") || "<root>",
    );
    const sameContract = (
      prior: PathSchemaContract,
      target: PathSchemaContract,
    ): boolean =>
      prior.mayBeMissing === target.mayBeMissing &&
      schemasHaveSameContract(prior.schema, target.schema, {
        sourceRoot: prior.root,
        targetRoot: target.root,
      });
    return priorContracts.every((prior) =>
      targetContracts.some((target) => sameContract(prior, target))
    ) &&
      targetContracts.every((target) =>
        priorContracts.some((prior) => sameContract(prior, target))
      );
  } catch {
    // An unprovable contract still needs the full producer-side proof.
    return false;
  }
}

/**
 * Validate every supplied link against the destination schema's contract,
 * one helper per concern, and return the links that preserve a direct handle
 * to their source (see `derivePreserveDecision`) — the subset a restoring
 * caller writes back verbatim rather than rebuilding.
 *
 * @internal Exported for focused durable-link contract tests.
 */
export function assertSuppliedLinkSchemasCompatible(
  links: readonly SuppliedLink[],
  destinationSchema: JSONSchema,
  baseCell: Cell<unknown>,
  pieces: PiecesController,
  options: {
    basePath?: readonly (string | number)[];
    destinationIsStream?: boolean;
    destinationRoot?: JSONSchema;

    /**
     * Admit a live source handle without producer-owned schema metadata. This
     * preserves ordinary-cell and externally injected capability bindings in
     * `PiecesController.link`; it provides no static payload or capability
     * proof for such a source. Destination scope checks still apply. A source
     * with a durable contract always undergoes the full proof; known Piece
     * ownership without a recoverable contract is refused.
     */
    allowUnprovenSource?: boolean;

    /**
     * The prior pattern's argument schema, supplied only on a pattern update
     * over existing state. For callers without `allowUnprovenSource`, a
     * linked document with no producer-owned metadata —
     * e.g. a mergeable-push element doc, which is created under the piece's
     * own write authority and never carries any — is then held to the prior
     * contract at the link's own path instead of failing closed outright: the
     * proof becomes prior-contract ⊆ candidate, so a candidate that narrows
     * away values the piece may already hold is still rejected. Absent this
     * option (every non-update flow), an unprovable source stays a hard error,
     * so a fresh link to an arbitrary contract-less document is still refused.
     * With `linksPreservedVerbatim`, this also proves an existing direct
     * handle's consumer contract unchanged. Such a handle keeps the linked
     * producer's policy without requiring that policy on the consumer schema.
     */
    priorArgumentSchema?: JSONSchema;

    /**
     * The caller writes each supplied link's ORIGINAL envelope back, rather
     * than rebuilding it from a materialized read.
     *
     * This is a statement about the caller's WRITE PLAN, not about its
     * authority — authority is the `isCell` evidence in
     * `derivePreserveDecision`, which proves the caller held a live handle.
     * Only the caller knows its own plan, so it has to say. `setPattern` is
     * the case that has one: `applySetupState` carries the argument over from
     * `previousArgumentCell.getRaw()`, so every retained link survives byte
     * for byte by construction and there is no rebuild for
     * `policeRebuiltAlias` to police.
     *
     * The declaration is scoped, not trusted: a serialized link only counts
     * as preserved when it is identical to the value already durably
     * committed at its path ({@link linkMatchesCommittedState}) — restoring
     * committed bytes grants nothing new. Any link that fails that comparison
     * (one minted from the incoming pattern's schema `default`s, a mutated
     * envelope, a lying caller) is validated by the rebuild rules exactly as
     * if this option were unset. Left unset (every other flow), those rules
     * apply to every serialized link.
     */
    linksPreservedVerbatim?: boolean;
  } = {},
): Set<SuppliedLink> {
  const preservedDirectHandles = new Set<SuppliedLink>();
  for (const suppliedLink of links) {
    const basePath = options.basePath ?? [];
    const fullPath = [...basePath, ...suppliedLink.path];
    const displayPath = fullPath.join(".") || "<root>";
    let linkBase = baseCell;
    for (const segment of fullPath) {
      linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
    }
    const targetContracts = deriveTargetContracts(
      destinationSchema,
      options.destinationRoot ?? destinationSchema,
      options.destinationIsStream === true,
      basePath,
      suppliedLink.path,
      displayPath,
    );
    const { link, linkedCell, durableSource } = resolveDurableSource(
      suppliedLink,
      linkBase,
      baseCell,
      fullPath,
      pieces,
      options.priorArgumentSchema,
      displayPath,
      options.allowUnprovenSource === true && isCell(suppliedLink.value),
    );
    const { localizedTargets, targetOuter } = localizeTargetOuter(
      targetContracts,
      displayPath,
    );
    const preservedOuter = derivePreserveDecision(
      suppliedLink,
      targetOuter,
      baseCell,
      basePath,
      options.linksPreservedVerbatim,
    );
    if (preservedOuter !== undefined) preservedDirectHandles.add(suppliedLink);

    assertSourceScopeFits(targetContracts, linkedCell, displayPath);
    if (durableSource === undefined) continue;

    const { rawSourceContracts, sourceContracts } = buildSourceContracts(
      durableSource,
      preservedOuter !== undefined,
      displayPath,
    );
    if (preservedOuter === undefined) {
      policeRebuiltAlias(
        rawSourceContracts,
        sourceContracts,
        link,
        displayPath,
      );
    }
    if (preservedOuter === undefined) {
      proveRebuiltContracts(sourceContracts, targetContracts, displayPath);
    } else {
      const localized = policePreservedEnvelope(
        suppliedLink,
        link,
        sourceContracts,
        localizedTargets,
        preservedOuter,
        displayPath,
      );
      if (
        options.linksPreservedVerbatim === true &&
        options.destinationIsStream !== true &&
        retainsInputHandleContract(
          suppliedLink,
          baseCell,
          basePath,
          options.priorArgumentSchema,
          targetContracts,
        )
      ) continue;
      provePreservedContracts(
        localized.sourceContracts,
        localized.targetContracts,
        preservedOuter,
        displayPath,
      );
    }
  }
  return preservedDirectHandles;
}

/** @internal Exported for focused write-destination contract tests. */
export function localizeWritableDestinationContracts(
  destination: DurableSchemaPath,
  rootCell: Cell<unknown>,
  nextValue: unknown,
): {
  contracts: PathSchemaContract[];
  declaredStream?: boolean;
  approximatedCorrelatedPath: boolean;
} {
  const { root, path, rawBasePath, schemaBaseDepth, validationPath } =
    destination;
  let contracts: PathSchemaContract[] = [{ schema: root, root }];
  let approximatedCorrelatedPath = false;
  const rawRoot = rootCell.getRawUntyped({ lastNode: "top" });
  const materializedRoot = destination.validationCell.withTx(rootCell.tx)
    .asSchema(root).get();
  const stagedMaterializedRoot = replaceMaterializedCellValueAtPath(
    materializedRoot,
    validationPath,
    nextValue,
  );
  for (let index = 0; index <= path.length; index++) {
    const rawPrefix = index <= schemaBaseDepth
      ? rawBasePath
      : [...rawBasePath, ...path.slice(schemaBaseDepth, index)];
    const storedValue = rawValueAtPath(rawRoot, rawPrefix);
    let prefixCell = rootCell;
    for (const segment of rawPrefix) {
      prefixCell = prefixCell.key(segment as keyof unknown) as Cell<unknown>;
    }
    const stored = storedCellTopology(storedValue.value, prefixCell);
    const localized = contracts.map((contract) =>
      localizeOuterCellContract(contract, stored)
    );
    const invalid = localized.find((entry) => entry.issue !== undefined);
    if (invalid?.issue !== undefined) throw new Error(invalid.issue);
    const outers = localized.flatMap((entry) =>
      entry.outer === undefined ? [] : [entry.outer]
    );
    const outer = outers[0];
    for (const candidate of outers.slice(1)) {
      if (!outerCellShapesMatch(outer!, candidate)) {
        throw new Error("write destination Cell constraints disagree");
      }
    }
    const terminal = index === path.length;
    if (outer !== undefined) {
      if (!cellKindCanWrite(outer.kind)) {
        throw new Error(
          `${outer.kind} Cell write destination is not writable`,
        );
      }
      if (outer.kind === "stream" && !terminal) {
        throw new Error("stream Cell write destination path is not writable");
      }
    }
    const payloadContracts = localized.map((entry) => entry.contract);
    if (terminal) {
      return {
        contracts: payloadContracts,
        // An unwrapped contract constrains only the value. It says nothing
        // about whether another producer-owned projection exposes the same
        // destination as a Stream (opaque UI values commonly contain such
        // aliases). Only an explicit Cell wrapper participates in the
        // capability intersection.
        declaredStream: outer === undefined
          ? undefined
          : outer.kind === "stream",
        approximatedCorrelatedPath,
      };
    }
    try {
      contracts = linkPathContracts(payloadContracts, [path[index]!]);
    } catch {
      // A concrete write can be checked safely by staging it into every
      // complete producer root below, but Cell authority must be proven before
      // staging. Select the current complete ancestor's exact branches and
      // container shape; unlike schemaAtPath(), this retains restricted Cell
      // wrappers. The proof still cannot authorize a future durable link.
      const currentValue = materializedValueAtPath(
        materializedRoot,
        validationPath.slice(0, index),
      );
      const candidateValue = materializedValueAtPath(
        stagedMaterializedRoot,
        validationPath.slice(0, index),
      );
      contracts = payloadContracts.flatMap((contract) =>
        currentValuePathContracts(
          contract,
          path[index]!,
          currentValue,
          candidateValue,
        )
      );
      approximatedCorrelatedPath = true;
    }
  }
  throw new Error("write destination path could not be localized");
}

const MISSING_PROJECTION_ALIAS = Symbol("missing projection alias");

function rawValueAtPath(
  root: unknown,
  path: readonly (string | number)[],
): { present: boolean; value: unknown } {
  let value = root;
  for (const segment of path) {
    if (
      !isObjectOrArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return { present: false, value: undefined };
    }
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return { present: true, value };
}

/** @internal Exported for focused projection-presence tests. */
export function rawResolvedValueAtPath(
  tx: NonNullable<Cell<unknown>["tx"]>,
  resolved: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
): { present: boolean; value: unknown } {
  // Read the document envelope, not only its Cell value. A metadata-only
  // argument/derived document has no own `value` field, while an explicitly
  // stored Fabric undefined does. Cell.get() intentionally projects both as
  // JavaScript undefined and therefore cannot distinguish these cases.
  const document = tx.read({
    space: resolved.space,
    id: resolved.id,
    scope: resolved.scope,
    path: [],
  });
  if (document.error !== undefined) {
    if (document.error.name === "NotFoundError") {
      return { present: false, value: undefined };
    }
    throw new Error(
      `projection alias document read failed: ${document.error.name}`,
    );
  }
  const envelope = document.ok?.value;
  if (
    !isObjectOrArray(envelope) ||
    !Object.hasOwn(envelope, "value")
  ) {
    return { present: false, value: undefined };
  }
  return rawValueAtPath(
    (envelope as Record<PropertyKey, unknown>).value,
    resolved.path,
  );
}

/** @internal Exported for focused projection-presence tests. */
export function omitMissingProjectionAliases(
  materialized: unknown,
  raw: unknown,
  schemaView: unknown,
  cell: Cell<unknown>,
  pieces: PiecesController,
  schemaViewPresent = true,
  changedPaths: readonly (readonly (string | number)[])[] = [],
  acceptOpaqueValue:
    | ((value: unknown, schema: JSONSchema) => boolean)
    | undefined = undefined,
  resolving = new Set<string>(),
): unknown | typeof MISSING_PROJECTION_ALIAS {
  if (isLink(raw)) {
    const reachesNothingBelow = !changedPaths.some((path) => path.length > 0);
    if (isCell(schemaView) && reachesNothingBelow) {
      // Schema-aware reads preserve declared Cell/Stream projections as
      // handles. Keep that opaque proof in the staged producer root instead
      // of replacing it with the target's untyped payload; unrelated Stream
      // siblings otherwise look like malformed event objects while another
      // linked destination is being validated. A Cell on the spine of a
      // descendant write is the exception: materialize that producer value so
      // staging preserves its unchanged siblings.
      return schemaView;
    }
    // Settling this link on the link alone needs two things. The caller must
    // settle a bare link wherever one appears: the probe asks its predicate at
    // the most permissive point, which is enough because the one predicate
    // that reaches here answers on the link alone, while
    // `schemaAcceptsOpaqueCellValue` wants a Cell and says no — so a second
    // call site cannot enable this by passing a boolean it did not mean. And
    // the node must not be one the missing-alias sentinel below could claim,
    // whose precondition is an absent target under a materialization and a
    // schema view that both came back absent.
    //
    // Settled means settled whole. `acceptOpaqueValue` is consulted at a node
    // ahead of the keywords there, so nothing the link's own schema says, and
    // nothing a schema below it says, is measured against the target; a
    // keyword the containing object or array evaluates — `const`, `enum`,
    // `oneOf` discrimination, `uniqueItems` — additionally sees a link where
    // the target's value would have been.
    const settlesOnTheLink = reachesNothingBelow &&
      acceptOpaqueValue?.(raw, true) === true;
    if (settlesOnTheLink && (materialized !== undefined || schemaViewPresent)) {
      return raw;
    }
    const resolvedSchemaView = isCell(schemaView) && !isStream(schemaView)
      ? schemaView.get()
      : schemaView;
    const tx = cell.tx;
    if (tx === undefined) {
      throw new Error("projection alias reconciliation requires a transaction");
    }
    const parsed = parseLinkOrThrow(raw, cell);
    const fullLink = pieces.runtime.getCellFromLink(
      parsed,
      undefined,
      tx,
    ).getAsNormalizedFullLink();
    const resolved = resolveLink(
      pieces.runtime,
      tx,
      fullLink,
      "value",
    );
    const key = JSON.stringify([
      resolved.space,
      resolved.id,
      resolved.scope,
      resolved.path,
    ]);
    if (resolving.has(key)) return materialized;
    resolving.add(key);
    try {
      const state = rawResolvedValueAtPath(tx, resolved);
      if (
        !state.present && materialized === undefined && !schemaViewPresent
      ) {
        return MISSING_PROJECTION_ALIAS;
      }
      // Resolved only to learn the target exists; that answered, the link
      // settles the rest on its own.
      if (settlesOnTheLink) return raw;
      const resolvedCell = pieces.runtime.getCellFromLink(
        { ...resolved, schema: undefined },
        undefined,
        tx,
      );
      return omitMissingProjectionAliases(
        materialized,
        state.value,
        resolvedSchemaView,
        resolvedCell,
        pieces,
        schemaViewPresent,
        changedPaths,
        acceptOpaqueValue,
        resolving,
      );
    } finally {
      resolving.delete(key);
    }
  }
  if (
    !isObjectOrArray(materialized) ||
    !isObjectOrArray(raw)
  ) return materialized;

  // TODO(danfuzz): the `typeof` gate admits a `FabricSpecialObject` on
  // either side, and the spread copies zero properties from one — a fabric
  // `materialized` becomes `{}` in the validation root built for a
  // non-stream result write that redirects through a terminal, and a fabric
  // `raw`'s contents are never reconciled. Wants a `FabricSpecialObject`
  // test returning `materialized` whole.
  const result =
    (Array.isArray(materialized)
      ? materialized.slice()
      : { ...materialized }) as Record<string, unknown>;
  const materializedRecord = materialized as Record<PropertyKey, unknown>;
  const rawRecord = raw as Record<PropertyKey, unknown>;
  const viewRecord = isObjectOrArray(schemaView)
    ? schemaView as Record<PropertyKey, unknown>
    : undefined;
  for (const key of Object.keys(rawRecord)) {
    if (!Object.hasOwn(materializedRecord, key)) continue;
    const rawChild = rawRecord[key];
    const childViewPresent = viewRecord !== undefined &&
      Object.hasOwn(viewRecord, key);
    const childChangedPaths = changedPaths.flatMap((path) =>
      path.length > 0 && String(path[0]) === key ? [path.slice(1)] : []
    );
    const reconciled = omitMissingProjectionAliases(
      materializedRecord[key],
      rawChild,
      childViewPresent ? viewRecord[key] : undefined,
      cell.key(key as keyof unknown) as Cell<unknown>,
      pieces,
      childViewPresent,
      childChangedPaths,
      acceptOpaqueValue,
      resolving,
    );
    if (reconciled === MISSING_PROJECTION_ALIAS) {
      delete result[key];
      continue;
    }
    result[key] = reconciled;
  }
  return result;
}

/**
 * Prove that storing `nextValue` leaves every producer-owned document that
 * exposes the destination valid against the schema its producer declared.
 *
 * The staged root is the whole document, not the written path: a producer root
 * constrains its members jointly, so a payload that satisfies the schema at its
 * own path can still leave a sibling, a container bound, or a `required` member
 * unsatisfiable.
 *
 * What it does not stage is the contents of a link the write does not reach.
 * Such a link is staged as itself and accepted whole, subtree included: nothing
 * its own schema says, and nothing a schema below it says, is measured against
 * the target. That is the price of not materializing another document, and
 * everything that one links in turn, to judge a write that never reaches it.
 *
 * One thing is still asked of an unreached link — whether it has a target at
 * all. A projection alias with nothing behind it drops out of the staged root,
 * so `required` still refuses it.
 */
function validateDurableSourceRoots(
  destination: DurableSourceContract,
  nextValue: unknown,
  pieces: PiecesController,
  acceptOpaqueValue: (value: unknown, schema: JSONSchema) => boolean,
): string | undefined {
  const groups: Array<{
    root: JSONSchema;
    cell: Cell<unknown>;
    paths: (string | number)[][];
  }> = [];
  const sameCell = (left: Cell<unknown>, right: Cell<unknown>): boolean => {
    const a = left.getAsNormalizedFullLink();
    const b = right.getAsNormalizedFullLink();
    return a.space === b.space && a.id === b.id && a.scope === b.scope &&
      a.path.length === b.path.length &&
      a.path.every((segment, index) => segment === b.path[index]);
  };
  for (const schema of destination.schemas) {
    let group = groups.find((candidate) =>
      candidate.root === schema.root &&
      sameCell(candidate.cell, schema.validationCell)
    );
    if (group === undefined) {
      group = {
        root: schema.root,
        cell: schema.validationCell,
        paths: [],
      };
      groups.push(group);
    }
    if (
      !group.paths.some((path) =>
        path.length === schema.validationPath.length &&
        path.every((segment, index) => segment === schema.validationPath[index])
      )
    ) {
      group.paths.push(schema.validationPath);
    }
  }

  for (const group of groups) {
    const schemaView = group.cell.asSchema(group.root).get();
    let candidate = omitMissingProjectionAliases(
      group.cell.asSchema(undefined).get(),
      group.cell.getRawUntyped(),
      schemaView,
      group.cell,
      pieces,
      true,
      group.paths,
      acceptOpaqueValue,
    );
    if (candidate === MISSING_PROJECTION_ALIAS) candidate = undefined;
    for (const path of group.paths) {
      candidate = replaceMaterializedValueAtPath(candidate, path, nextValue);
    }
    const issue = validateSchemaValue(
      group.root,
      candidate,
      group.root,
      { acceptOpaqueValue },
    );
    if (issue !== undefined) return issue;
  }
  return undefined;
}

/** @internal Exported for focused projection-capability tests. */
export function resolveDeclaredStreamCapability(
  values: readonly (boolean | undefined)[],
): boolean {
  const declared = values.filter((entry): entry is boolean =>
    entry !== undefined
  );
  const isStream = declared[0] ?? false;
  if (declared.some((entry) => entry !== isStream)) {
    throw new Error(
      "write destination contracts disagree on Stream capability",
    );
  }
  return isStream;
}

class PiecePropIo implements PieceCellIo {
  #cc: PieceController;
  #type: PiecePropIoType;
  constructor(cc: PieceController, type: PiecePropIoType) {
    this.#cc = cc;
    this.#type = type;
  }

  async get(path?: CellPath) {
    const targetCell = await this.#getTargetCell();
    if (this.#type === "input" && path?.length) {
      assertPieceInputPath(targetCell, path, { allowArrayLength: true });
      const { conditionalDepth } = schemaPathSelection(
        targetCell.getAsNormalizedFullLink().schema,
        path,
        { allowArrayLength: true },
      );
      if (conditionalDepth !== undefined) {
        return await this.#getFromRoot(
          targetCell.key(...path.slice(0, conditionalDepth)),
          path.slice(conditionalDepth),
          true,
        );
      }
    }
    if (!path?.length) {
      return await this.#getFromRoot(targetCell, []);
    }
    // Pull the requested cell, not the whole input/result root. The sync
    // started by pull() sends its path plus narrowed schema to Memory v2, so
    // this avoids traversing unrelated linked fields (an input can contain a
    // broad authoring graph even when the caller asks for one small durable
    // field). No per-segment asCell handling is needed on the way down: key()
    // walks the schema (so an asCell ancestor's `properties` keep narrowing the
    // query) and link resolution follows the stored link at that segment during
    // the read. A TERMINAL asCell is simply unwrapped: since #5231 the
    // projection applies the asCell scope cap itself, so a capped handle stays
    // capped without routing through resolveAsCell().
    const selectedCell = targetCell.key(...path);
    await selectedCell.pull();
    // Relax `required` for scoped links that this session cannot materialize,
    // at the selected subtree rather than the root — same boundary as
    // #getFromRoot, see schemaWithScopedLinkRequiredsRelaxed.
    const selected = cellWithScopedLinkRequiredsRelaxed(selectedCell).get();
    if (isCell(selected)) {
      // An asCell projection materializes even an absent or explicitly
      // undefined slot as a Cell, so inspect the stored slot before reading
      // through the handle. Falling back preserves the root read's
      // absent-vs-undefined rules and its missing-path diagnostics.
      if (selectedCell.getRaw() === undefined) {
        return await this.#getFromRoot(targetCell, path);
      }
      const handle = cellWithScopedLinkRequiredsRelaxed(selected);
      await handle.pull();
      return handle.get();
    }
    if (selected === undefined) {
      return await this.#getFromRoot(targetCell, path);
    }
    return selected;
  }

  async #getFromRoot(
    targetCell: Cell<unknown>,
    path: CellPath,
    requireProjection = false,
  ) {
    // Preserve the existing missing-path diagnostics and the distinction
    // between an absent field and a schema-valid undefined value.
    await targetCell.pull();
    // Terminal read boundary: relax `required` for properties whose stored
    // value links into a scope this session may not be able to materialize
    // (perSession/perUser-derived outputs), so a whole-object read degrades
    // those members instead of voiding to `undefined` while every child-path
    // read succeeds. See schemaWithScopedLinkRequiredsRelaxed for the
    // #4746-compatible rationale.
    let root = cellWithScopedLinkRequiredsRelaxed(targetCell);
    if (requireProjection) {
      // A handle is a separate read boundary: syncing its outer projection
      // only materializes the handle, so demand its payload before choosing
      // a branch within it.
      while (true) {
        const schema = root.getAsNormalizedFullLink().schema;
        if (
          typeof schema === "object" && schema.asCell === undefined &&
          (schema.anyOf || schema.oneOf || schema.allOf)
        ) {
          const localized = localizeOuterCellContract({ schema, root: schema });
          if (localized.issue === undefined && localized.outer !== undefined) {
            // A union of uniform handles is one handle over a payload union.
            // Hoisting keeps handle construction and scope enforcement in the
            // runtime; removing the wrapper would remove its read cap.
            const { kind, scope } = localized.outer;
            root = root.asSchema(
              schemaWithProperties(localized.contract.schema, {
                asCell: [
                  { kind, ...(scope === undefined ? {} : { scope }) },
                  ...ContextualFlowControl.getAsCellValues(
                    localized.contract.schema,
                  ),
                ],
              }),
            );
          }
        }
        const value = root.get();
        if (!isCell(value)) break;
        root = cellWithScopedLinkRequiredsRelaxed(value);
        await root.pull();
      }
    }
    return resolveCellPath(root, path, { requireProjection });
  }

  /** Returns the root cell, or a path admitted through the input projection. */
  async getCell(path?: CellPath): Promise<Cell<unknown>> {
    const cell = await this.#getTargetCell();
    if (!path?.length) return cell;
    const selectedCell = cell.key(...path);
    if (this.#type === "input") {
      assertPieceInputPath(cell, path, { allowArrayLength: true });
      const { conditionalDepth } = schemaPathSelection(
        cell.getAsNormalizedFullLink().schema,
        path,
        { allowArrayLength: true },
      );
      if (conditionalDepth !== undefined) {
        const value = await this.#getFromRoot(
          cell.key(...path.slice(0, conditionalDepth)),
          path.slice(conditionalDepth),
          true,
        );
        // A projected container's backpointer retains its active branch.
        // Primitives have no backpointer; carry their selected default onto
        // the original Cell so absent slots preserve the same read value.
        if (isCellResultForDereferencing(value)) return getCellOrThrow(value);
        if (
          value === undefined || value === null || typeof value === "string" ||
          typeof value === "number" || typeof value === "boolean"
        ) {
          return selectedCell.asSchema(schemaWithProperties(
            selectedCell.getAsNormalizedFullLink().schema ?? true,
            { default: value },
          ));
        }
      }
    }
    return selectedCell;
  }

  async set(value: unknown, path?: CellPath) {
    await this.edit(() => ({ value }), path);
  }

  /**
   * Compute-and-set in one transaction. `produce` receives the value stored
   * at `path`, read raw inside the transaction, and answers with the value
   * to write — or `undefined`, which leaves the document unwritten. On a
   * commit conflict the whole closure re-runs against fresh state,
   * `produce` included: what lands is always a function of the document
   * the commit saw, never of an earlier read. `produce` must therefore be
   * a pure function of its argument — it runs any number of times, and
   * only its last answer is written. A no-write answer stages no
   * operation, and a transaction holding only reads is not
   * conflict-checked by storage: a caller whose decision not to write
   * must hold against concurrent writers has to verify it with a later
   * read, the way a write's caller verifies the write.
   */
  async edit(
    produce: (stored: unknown) => { value: unknown } | undefined,
    path?: CellPath,
  ): Promise<{ wrote: boolean }> {
    const pieces = this.#cc.pieces();
    let committedTargetCell: Cell<unknown> | undefined;
    // Under server execution a stream send appends outside this transaction,
    // so an aborted attempt can leave its event durable. Reusing one caller
    // identity makes both guards converge on that event: admission rejects a
    // duplicate above the dedupe horizon, and the serving drain skips one that
    // reaches it past the horizon
    // (`docs/specs/server-side-execution/events.md` §4, §5).
    // Initialize both halves together: a session replacement between attempts
    // must not bind this API call's stable event ID to a second session.
    let streamSendOptions:
      | { eventId: string; session: string }
      | undefined;

    const { ok, error } = await pieces.runtime.editWithRetry((tx) => {
      // Resolve the target from the piece metadata inside every retry. A
      // concurrent setsrc may replace the argument link/schema after this
      // write starts; reusing a cell captured before the retry would then
      // write through the superseded contract.
      const piece = this.#cc.getCell().withTx(tx);
      let targetCell: Cell<unknown>;
      if (this.#type === "input") {
        targetCell = pieces.getArgument(piece);
        assertPieceInputPath(targetCell, path ?? []);
      } else {
        const resultCell = pieces.getResult(piece);
        const durableSchema = readResultSchemaMeta(resultCell);
        targetCell = durableSchema === undefined
          ? resultCell
          : resultCell.asSchema(durableSchema);
      }
      committedTargetCell = targetCell;

      // Build the path with transaction context
      const txCell = targetCell.withTx(tx).key(...(path ?? []));

      const decision = produce(txCell.getRaw({ lastNode: "value" }));
      if (decision === undefined) return { wrote: false };
      const value = decision.value;

      const writePath = path ?? [];
      const writeTargetDiffers = (
        left: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
        right: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
      ): boolean =>
        left.space !== right.space || left.id !== right.id ||
        left.scope !== right.scope || left.path.length !== right.path.length ||
        left.path.some((segment, index) => segment !== right.path[index]);
      const originalWriteTarget = txCell.getAsNormalizedFullLink();
      const resolvedWriteTarget = resolveLink(
        pieces.runtime,
        tx,
        originalWriteTarget,
        "writeRedirect",
      );
      const writesThroughTerminal = writeTargetDiffers(
        originalWriteTarget,
        resolvedWriteTarget,
      );
      const validateWriteDestination = (nextValue: unknown): void => {
        if (!writesThroughTerminal) return;
        const resolved = resolvedWriteTarget;
        const resolvedCell = pieces.runtime.getCellFromLink(
          resolved,
          resolved.schema,
          tx,
        );
        const durableDestination = durableSourceContract(
          resolvedCell,
          pieces,
        );
        if (durableDestination === undefined) {
          throw new Error(
            `updated ${this.#type} write destination has no durable schema contract`,
          );
        }
        const destination = durableDestination;
        let localizedDestination: { contracts: PathSchemaContract[] };
        try {
          const destinationRootCell = pieces.runtime.getCellFromLink(
            { ...resolved, path: [], schema: undefined },
            undefined,
            tx,
          );
          const localized = destination.schemas.map((schemaPath) =>
            localizeWritableDestinationContracts(
              schemaPath,
              destinationRootCell,
              nextValue,
            )
          );
          // Called for the agreement it asserts: contracts that disagree on
          // Stream capability throw here. What it returns is the capability the
          // producer declares, which no one below asks about.
          resolveDeclaredStreamCapability(
            localized.map((entry) => entry.declaredStream),
          );
          localizedDestination = {
            contracts: localized.flatMap((entry) => entry.contracts),
          };
          const links = suppliedLinks(nextValue);
          if (
            links.length > 0 &&
            localized.some((entry) => entry.approximatedCorrelatedPath)
          ) {
            throw new Error(
              "correlated write destination cannot prove a supplied durable link",
            );
          }
          for (const contract of localizedDestination.contracts) {
            assertSuppliedLinkSchemasCompatible(
              links,
              contract.schema,
              resolvedCell,
              pieces,
              { destinationRoot: contract.root },
            );
          }
        } catch (error) {
          throw new Error(
            `updated ${this.#type} does not match its write destination: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const acceptsProvedLink = (
          candidate: unknown,
          candidateSchema: JSONSchema,
        ): boolean =>
          isLink(candidate) ||
          schemaAcceptsOpaqueCellValue(candidate, candidateSchema);
        let issue: string | undefined;
        for (const contract of localizedDestination.contracts) {
          issue = validateSchemaValue(
            contract.schema,
            nextValue,
            contract.root,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          if (issue !== undefined) break;
        }
        // A Stream destination consumes the value as an event: the write below
        // sends it instead of storing it, and `Cell.set()` reaches that decision
        // through this same predicate on this same cell. Nothing is stored, so
        // no producer document changes and no producer root's validity can
        // change. What the event itself owes — the producer's own event
        // contract, at every producer-owned projection of the destination — the
        // loop above has already proven.
        if (issue === undefined && !isStream(txCell)) {
          issue = validateDurableSourceRoots(
            destination,
            nextValue,
            pieces,
            acceptsProvedLink,
          );
        }
        if (issue !== undefined) {
          throw new Error(
            `updated ${this.#type} does not match its write destination: ${issue}`,
          );
        }
      };
      const setTerminalValue = (nextValue: unknown) => {
        validateWriteDestination(nextValue);
        if (
          nextValue === undefined && writePath.length > 0 &&
          !isStream(txCell)
        ) {
          // Cell.set() treats undefined as a missing child at a path. Piece IO
          // preserves Fabric's first-class explicit undefined by writing the
          // raw slot instead. Streams are the exception: undefined is an event
          // payload and must go through Cell.set(). Inspect the actual Cell so
          // compound and referenced stream schemas behave identically.
          const rawTarget = resolveLink(
            pieces.runtime,
            tx,
            txCell.getAsNormalizedFullLink(),
            "writeRedirect",
          );
          pieces.runtime.getCellFromLink(rawTarget, undefined, tx)
            .setRawUntyped(undefined);
        } else {
          txCell.set(
            nextValue,
            undefined,
            isStream(txCell) &&
              pieces.runtime.experimental.serverExecution === true
              ? streamSendOptions ??= {
                eventId: crypto.randomUUID(),
                // `ScopeKeyIdentity` permits a principal without a session;
                // the runtime's `.id` still gives the caller event a namespace.
                session: pieces.runtime.scopeKeyIdentity.sessionId ??
                  pieces.runtime.id,
              }
              : undefined,
          );
        }
      };

      if (this.#type === "input") {
        const schema = targetCell.getAsNormalizedFullLink().schema ?? true;
        const writeSchema = writePath.length === 0
          ? schema
          : ContextualFlowControl.schemaAtPath(
            schema,
            writePath.map((segment) => String(segment)),
          );
        const linksToRestore = suppliedLinks(value);
        assertWritablePiecePath(
          schema,
          writePath,
          linksToRestore.some((link) => link.path.length === 0),
          writesThroughTerminal,
          targetCell.withTx(tx),
        );
        const preservedDirectHandles = assertSuppliedLinkSchemasCompatible(
          linksToRestore,
          schema,
          targetCell,
          pieces,
          {
            basePath: writePath,
            destinationIsStream: isStream(txCell),
          },
        );
        let materializedValue = value;
        for (const suppliedLink of linksToRestore) {
          let linkBase = txCell;
          for (const segment of suppliedLink.path) {
            linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
          }
          const link = parseLinkOrThrow(suppliedLink.value, linkBase);
          const linkValue = preservedDirectHandles.has(suppliedLink)
            ? suppliedLink.value
            : pieces.runtime.getCellFromLink(
              link,
              sanitizeSchemaForLinks(link.schema, KeepAsCell.OnlyStream),
              tx,
            ).get();
          materializedValue = replaceMaterializedValueAtPath(
            materializedValue,
            suppliedLink.path,
            linkValue,
          );
        }
        const stagedRoot = replaceMaterializedValueAtPath(
          targetCell.asSchema(undefined).withTx(tx).get(),
          writePath,
          materializedValue,
        );
        // A slot whose stored value routes through a link this replica cannot
        // read — another principal's per-user instance, a document not
        // replicated here — materializes as absent, and judged as it stands
        // would refuse the write for a value owned elsewhere. Such a slot is
        // staged as the unresolved-link placeholder and accepted opaquely;
        // its schema check happens when a reactive read materializes it, the
        // rule stored-argument validation applies. A link the caller supplies
        // defers on the same terms — the caller vouches for the link, not for
        // its target being replicated here — so the raw tree the overlay
        // walks holds the caller's value, links and all, at the write path,
        // and a scalar or `undefined` written there is judged as written.
        // Where the write path crosses a stored link the raw tree stays as
        // stored, so the overlay can follow that link to the fields around
        // the written one. The overlay only ever turns an absence into an
        // accepted opaque, so a candidate is judged against the staged root
        // first and the overlay is consulted only when that fails.
        const rawRoot = targetCell.withTx(tx).getRaw();
        const rawForOverlay = writePathCrossesLink(rawRoot, writePath)
          ? rawRoot
          : replaceMaterializedValueAtPath(rawRoot, writePath, value);
        const argumentLink = targetCell.getAsNormalizedFullLink();
        const inputIssue = (candidate: unknown): string | undefined => {
          const options = {
            acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
          };
          const issue = validateSchemaValue(schema, candidate, schema, options);
          if (issue === undefined) return undefined;
          return validateSchemaValue(
            schema,
            overlayUnreadableLinkPlaceholders(
              tx,
              argumentLink,
              rawForOverlay,
              candidate,
            ),
            schema,
            options,
          );
        };
        const mergedRoot = mergeSchemaDefaults(
          stagedRoot,
          extractDefaultValues(schema),
          schema,
          {
            // A Piece API write is present even when its value is the Fabric
            // extension `undefined`; do not replace it with a default.
            valuePresent: true,
            mergeMaterializedLinks: true,
            acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
          },
        );
        let nextValue = getValueAtPath(mergedRoot, writePath);
        if (writePath.length > 0) {
          nextValue = mergeSchemaDefaults(
            nextValue,
            extractDefaultValues(writeSchema),
            writeSchema,
            {
              valuePresent: true,
              mergeMaterializedLinks: true,
              acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
              acceptUnionCandidate: (candidate) =>
                inputIssue(
                  replaceMaterializedValueAtPath(
                    stagedRoot,
                    writePath,
                    candidate,
                  ),
                ) === undefined,
            },
          );
        }
        const validationRoot = writePath.length === 0
          ? nextValue
          : replaceMaterializedValueAtPath(
            stagedRoot,
            writePath,
            nextValue,
          );
        const issue = inputIssue(validationRoot);
        if (issue !== undefined) {
          throw new Error(`updated input does not match its schema: ${issue}`);
        }
        for (const suppliedLink of linksToRestore) {
          nextValue = replaceMaterializedValueAtPath(
            nextValue,
            suppliedLink.path,
            suppliedLink.value,
          );
        }
        setTerminalValue(nextValue);
      } else {
        const schema = targetCell.getAsNormalizedFullLink().schema ?? true;
        const linksToRestore = suppliedLinks(value);
        assertWritablePiecePath(
          schema,
          writePath,
          linksToRestore.some((link) => link.path.length === 0),
          writesThroughTerminal,
          targetCell.withTx(tx),
        );
        const preservedDirectHandles = assertSuppliedLinkSchemasCompatible(
          linksToRestore,
          schema,
          targetCell,
          pieces,
          {
            basePath: writePath,
            destinationIsStream: isStream(txCell),
          },
        );
        let materializedValue = value;
        for (const suppliedLink of linksToRestore) {
          let linkBase = txCell;
          for (const segment of suppliedLink.path) {
            linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
          }
          const link = parseLinkOrThrow(suppliedLink.value, linkBase);
          const linkValue = preservedDirectHandles.has(suppliedLink)
            ? suppliedLink.value
            : pieces.runtime.getCellFromLink(
              link,
              sanitizeSchemaForLinks(link.schema, KeepAsCell.OnlyStream),
              tx,
            ).get();
          materializedValue = replaceMaterializedValueAtPath(
            materializedValue,
            suppliedLink.path,
            linkValue,
          );
        }
        if (isStream(txCell)) {
          // Sending an event does not replace the stream handle in the result
          // object. Validate the payload contract itself so unrelated result
          // projections (VNode/FS values, or optional aliases that are not
          // materialized yet) cannot invalidate an otherwise valid event.
          // This consumes exactly one stream wrapper and retains nested Cell
          // contracts plus Common Fabric extensions such as `undefined`.
          const eventContracts = linkPathContracts(
            [{ schema, root: schema }],
            writePath,
          ).map((contract) => consumeStreamEventContract(contract));
          for (const contract of eventContracts) {
            const issue = validateSchemaValue(
              contract.schema,
              materializedValue,
              contract.root,
              { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
            );
            if (issue !== undefined) {
              throw new Error(
                `updated result does not match its schema: ${issue}`,
              );
            }
          }
        } else {
          // Validate the WRITTEN SUBTREE against the schema contract at
          // `writePath` (RULED 2026-08-07, narrowing the #4717 guard):
          // the whole-result validation over-reached — it validated
          // against the replica's instantaneous view with no
          // convergence step, so under EXPERIMENTAL_SERVER_EXECUTION a
          // fresh client's property write raced server-derived-late
          // UNRELATED required properties ($NAME et al) and failed on
          // state it did not touch; the OFF arm carried the same
          // latent over-reach. What #4717 protects still binds: the
          // written value's schema-compatibility (and the
          // supplied-link compatibility above, unchanged). The sibling
          // stream branch has always validated exactly this way, for
          // the same reason — "unrelated result projections … cannot
          // invalidate an otherwise valid event" — extended here to
          // property writes.
          let pathContracts:
            | ReturnType<typeof linkPathContracts>
            | undefined;
          try {
            pathContracts = linkPathContracts(
              [{ schema, root: schema }],
              writePath,
            );
          } catch {
            // The one shape path contracts cannot decompose: an anyOf
            // whose branch selection CORRELATES the written field with
            // its parent value. For exactly those paths the pre-ruling
            // whole-result validation is the sound fallback — the
            // union cannot be judged without the siblings — so the
            // over-reach (and its server-derived-late hazard) returns
            // only where the schema itself demands the correlation.
            pathContracts = undefined;
          }
          if (pathContracts !== undefined) {
            for (const contract of pathContracts) {
              const issue = validateSchemaValue(
                contract.schema,
                materializedValue,
                contract.root,
                { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
              );
              if (issue !== undefined) {
                throw new Error(
                  `updated value does not match its schema at ${
                    JSON.stringify(writePath)
                  }: ${issue}`,
                );
              }
            }
            // Ancestor container CARDINALITY (review thread
            // r3739139515): the path-only contract validates the
            // written leaf, so a nested write could still persist an
            // array violating an ancestor's minItems/maxItems (a write
            // to index N extends the array past maxItems unseen).
            // Re-validate each array ancestor that carries cardinality
            // keywords against its POST-WRITE value, with content
            // keywords stripped: cardinality only — never the
            // unrelated-sibling validation the 2026-08-07 ruling
            // removed. Reading the touched container's own current
            // value is the write's own placement basis, not the
            // server-derived-late sibling race the ruling closed.
            for (let depth = writePath.length - 1; depth >= 0; depth--) {
              const ancestorPath = writePath.slice(0, depth);
              let ancestorContracts:
                | ReturnType<typeof linkPathContracts>
                | undefined;
              try {
                ancestorContracts = linkPathContracts(
                  [{ schema, root: schema }],
                  ancestorPath,
                );
              } catch {
                // Undecomposable (correlated anyOf): the whole-result
                // fallback branch below owns those paths.
                continue;
              }
              for (const contract of ancestorContracts) {
                const ancestorSchema = contract.schema;
                if (
                  !isObjectOrArray(ancestorSchema) ||
                  (!("maxItems" in ancestorSchema) &&
                    !("minItems" in ancestorSchema))
                ) {
                  continue;
                }
                const cardinality: Record<string, unknown> = {
                  type: "array",
                };
                if ("maxItems" in ancestorSchema) {
                  cardinality.maxItems = ancestorSchema.maxItems;
                }
                if ("minItems" in ancestorSchema) {
                  cardinality.minItems = ancestorSchema.minItems;
                }
                const postWrite = replaceMaterializedValueAtPath(
                  getValueAtPath(
                    targetCell.asSchema(undefined).withTx(tx).get(),
                    ancestorPath,
                  ),
                  writePath.slice(depth),
                  materializedValue,
                );
                const issue = validateSchemaValue(
                  cardinality as JSONSchema,
                  postWrite,
                  cardinality as JSONSchema,
                  { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
                );
                if (issue !== undefined) {
                  throw new Error(
                    `updated value does not match its container at ${
                      JSON.stringify(ancestorPath)
                    }: ${issue}`,
                  );
                }
              }
            }
          } else {
            const validationRoot = replaceMaterializedValueAtPath(
              // See omitMissingProjectionAliases: missing optional
              // projections stay absent while explicit undefined is
              // preserved wherever the schema accepts it.
              omitMissingProjectionAliases(
                targetCell.asSchema(undefined).withTx(tx).get(),
                targetCell.withTx(tx).getRawUntyped(),
                targetCell.withTx(tx).get(),
                targetCell.withTx(tx),
                pieces,
                true,
                [writePath],
              ),
              writePath,
              materializedValue,
            );
            const issue = validateSchemaValue(
              schema,
              validationRoot,
              schema,
              { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
            );
            if (issue !== undefined) {
              throw new Error(
                `updated result does not match its schema: ${issue}`,
              );
            }
          }
        }
        setTerminalValue(value);
      }
      return { wrote: true };
    });
    if (error) throw commitFailure(error);
    // A committed decision not to write leaves nothing to pull.
    if (ok !== undefined && !ok.wrote) return { wrote: false };

    const targetCell = committedTargetCell ?? await this.#getTargetCell();

    if (this.#type === "input") {
      await pieces.getResult(this.#cc.getCell()).pull();
    } else {
      await targetCell.pull();
    }
    await pieces.synced();
    return { wrote: true };
  }

  #getTargetCell(): Promise<Cell<unknown>> {
    if (this.#type === "input") {
      return Promise.resolve(
        this.#cc.pieces().getArgument(this.#cc.getCell()),
      );
    } else if (this.#type === "result") {
      return Promise.resolve(this.#cc.pieces().getResult(this.#cc.getCell()));
    }
    throw new Error(`Unknown property type "${this.#type}"`);
  }
}

export class PieceController<T = unknown> {
  #cell: Cell<T>;
  #pieces: PiecesController;
  #mutationVersion = 0;
  #latestSuccessfulMutationVersion = 0;
  readonly id: string;

  input: PieceCellIo;
  result: PieceCellIo;

  constructor(pieces: PiecesController, cell: Cell<T>) {
    const id = pieceId(cell);
    if (!id) {
      throw new Error("Could not get an ID from a Cell<Piece>");
    }
    this.id = id;
    this.#pieces = pieces;
    this.#cell = cell;
    this.input = new PiecePropIo(this, "input");
    this.result = new PiecePropIo(this, "result");
  }

  name(): string | undefined {
    return this.#cell.asSchema(nameSchema).get()?.[NAME];
  }

  getCell(): Cell<T> {
    return this.#cell;
  }

  /**
   * Create a copy in `destination` that tracks the same source. The copy starts
   * with default data unless `copyData` requests detached snapshots of the
   * selected piece's current input and stateful internal cells. A detached
   * piece becomes the copy's mutable fabric origin. A piece that already tracks
   * an origin passes that origin through, so both copies point at the same
   * update source.
   */
  async cloneTo(
    destination: PiecesController,
    options: { copyData?: boolean } = {},
  ): Promise<PieceController<T>> {
    await this.#cell.sync();
    const snapshot = getPieceSourceSnapshot(this.#cell);
    if (snapshot === undefined) {
      throw new Error("piece missing pattern identity");
    }
    const sourceSpace = this.#pieces.getSpace();
    const trackedOrigin = readPieceOrigin(
      this.#pieces.runtime,
      this.#cell,
    )?.url;
    let origin: string;
    if (trackedOrigin === undefined) {
      const sourceRef = parseFabricRef(
        `cf:${this.#cell.getAsNormalizedFullLink().id}`,
      );
      if (sourceRef === undefined || sourceRef.ref.kind !== "uri") {
        throw new Error("piece has no fabric URI");
      }
      origin = formatFabricRef({ ...sourceRef, space: sourceSpace });
    } else {
      origin = qualifyFabricOrigin(trackedOrigin, sourceSpace);
    }
    const program = await this.#pieces.runtime.patternManager
      .getPatternSourceProgramByIdentity(
        snapshot.pattern.identity,
        sourceSpace,
        destination.getSpace(),
      );
    if (program === undefined) {
      throw new Error("piece source is not available");
    }
    let input: unknown = undefined;
    let internals: CloneInternalSnapshot[] = [];
    if (options.copyData) {
      const inputCell = await this.input.getCell();
      const data = await snapshotCloneData(this.#cell, inputCell, snapshot);
      input = data.input;
      internals = data.internals;
    }
    const current = getPieceSourceSnapshot(this.#cell);
    if (current === undefined || !samePieceSourceSnapshot(snapshot, current)) {
      throw new Error("piece source changed while it was being cloned");
    }
    const clone = await destination.create<T>(
      { ...program, mainExport: snapshot.pattern.symbol },
      {
        origin,
        ...(options.copyData ? { input: input as object } : {}),
        start: false,
      },
    );
    try {
      if (options.copyData) {
        await restoreCloneInternals(clone.getCell(), internals);
      }
      // Opening rather than merely starting: a clone follows the piece it
      // was taken from, and following begins with the subscription the open
      // installs.
      await destination.openPiece(clone.getCell());
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await destination.stopPiece(clone.getCell());
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        const removed = await destination.remove(clone.getCell());
        if (!removed) {
          const stillRegistered = (await destination.getRegisteredPieces())
            .some((piece) => piece.id === clone.id);
          if (stillRegistered) {
            throw new Error("the incomplete piece remained registered");
          }
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "cloning failed and the incomplete piece could not be removed",
        );
      }
      throw error;
    }
    return clone;
  }

  /**
   * Helper for the meta reads below, which is the piece cell with no schema.
   * A meta read registers a load of the document under the reading cell's
   * schema, and this cell's is the pattern's result schema, so a read
   * through it asks storage for every document the result reaches — a
   * board's whole index — to answer one meta field. The schema-less view
   * loads the document alone.
   */
  #metaView(): Cell<T> {
    return this.#cell.asSchema(undefined);
  }

  /**
   * The piece's pattern pointer: the durable meta, or — for a KEYLESS piece
   * in the session that set it up — the runner's session-side pointer (the
   * never-durable contract, L3(a) RULED 2026-08-27: a keyless piece stamps
   * nothing durably; a fresh session correctly finds neither).
   */
  #patternPointer(): { identity: string; symbol: string } | undefined {
    return getPatternIdentityRef(this.#metaView()) ??
      this.#pieces.runtime.runner.sessionPatternPointerFor(this.#cell);
  }

  /** Return a stable reference to the pattern currently running this piece. */
  async getPatternRef(): Promise<PiecePatternRef | undefined> {
    const ref = this.#patternPointer();
    if (!ref) return undefined;

    const source: PiecePatternSourceRef = {
      ref: formatFabricRef({
        ref: { kind: "uri", scheme: "pattern", hash: ref.identity },
      }),
    };
    const repository = getPatternRepository(this.#metaView());
    if (repository !== undefined) source.repository = repository;
    const trackedSource = getPatternSource(this.#metaView());
    if (trackedSource !== undefined) source.origin = trackedSource;

    try {
      const program = await this.#pieces.runtime.patternManager
        .getPatternSourceProgramByIdentity(
          ref.identity,
          this.#pieces.getSpace(),
        );
      return program?.main === undefined
        ? { ...ref, source }
        : { ...ref, source: { ...source, entry: program.main } };
    } catch {
      // The content pointer remains useful even if the source closure is
      // unavailable or unreadable in this space.
      return { ...ref, source };
    }
  }

  async setInput(input: object): Promise<void> {
    const mutationVersion = ++this.#mutationVersion;
    await this.#runMutation(mutationVersion, async () => {
      while (true) {
        const { pattern, ref } = await this.#loadCurrentPattern();
        try {
          const links = suppliedLinks(input);
          assertSuppliedLinkSchemasCompatible(
            links,
            pattern.argumentSchema,
            this.#pieces.getArgument(this.#cell),
            this.#pieces,
          );
          // Validate the exact caller value before Runner serializes Cell
          // handles into argument links. Every accepted link below has already
          // been proved against its durable producer contract, so treating it
          // as opaque here checks the surrounding native value without
          // dereferencing a cold/absent `asCell` payload. This also preserves
          // Common Fabric's first-class explicit `undefined` semantics.
          const acceptsProvedLink = (
            value: unknown,
            schema: JSONSchema,
          ) => isLink(value) || schemaAcceptsOpaqueCellValue(value, schema);
          const candidate = mergeSchemaDefaults(
            input,
            extractDefaultValues(pattern.argumentSchema),
            pattern.argumentSchema,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          const issue = validateSchemaValue(
            pattern.argumentSchema,
            candidate,
            pattern.argumentSchema,
            { acceptOpaqueValue: acceptsProvedLink },
          );
          if (issue !== undefined) {
            throw new Error(
              `updated arguments do not match the candidate schema: ${issue}`,
            );
          }
          // Use setup/start so we can update inputs without forcing reschedule.
          // The identity guard prevents a concurrent setsrc from being
          // overwritten by this already-loaded pattern.
          return await execute(
            this.#pieces,
            this.id,
            pattern,
            input,
            { start: true, expectedPatternIdentity: ref },
          ) as Cell<T>;
        } catch (error) {
          if (error instanceof Error) {
            if (
              error.message.includes(
                "piece pattern changed while the source update was compiling",
              )
            ) {
              continue;
            }
            // Link-schema checking happens before the runner transaction so it
            // can inspect the caller's exact envelopes. If that check raced a
            // source update, retry against the durable winner instead of
            // reporting a stale contract failure.
            await this.#cell.sync();
            const currentRef = getPatternIdentityRef(this.#cell);
            if (
              currentRef !== undefined &&
              (currentRef.identity !== ref.identity ||
                currentRef.symbol !== ref.symbol)
            ) {
              continue;
            }
          }
          throw error;
        }
      }
    });
  }

  /**
   * The compiled pattern this piece is pinned to.
   *
   * By default the read also projects the result schema, loading every
   * document it reaches: the source-change and compatibility paths read
   * through that projection next and rely on it being local. A caller that
   * wants only the pattern — callable discovery — passes
   * `projectResult: false`, and the sync is bounded to the result document
   * that carries the pattern pointer.
   */
  async getPattern(
    options: { projectResult?: boolean } = {},
  ): Promise<Pattern> {
    return (await this.#loadCurrentPattern(options)).pattern;
  }

  async #loadCurrentPattern(
    { projectResult = true, repairCache = true }: {
      projectResult?: boolean;
      repairCache?: boolean;
    } = {},
  ): Promise<{
    pattern: Pattern;
    ref: { identity: string; symbol: string };
  }> {
    if (projectResult) await this.#cell.sync();
    else await this.#cell.asSchema(undefined).sync();
    const ref = this.#patternPointer();
    if (!ref) throw new Error("piece missing pattern identity");
    const runtime = this.#pieces.runtime;
    const pattern = await runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      this.#pieces.getSpace(),
      { repairCache },
    );
    if (!pattern) {
      throw new Error(
        `could not load pattern ${ref.identity}#${ref.symbol}`,
      );
    }
    return { pattern, ref };
  }

  /**
   * The piece's current pattern where it loads, and its stored pattern pointer
   * alone where it does not, with what the load threw as `failure`.
   *
   * A source change names its predecessor by the pointer and compares a
   * candidate with the loaded pattern, so a pattern that does not load costs
   * that comparison and nothing else. Whether a change may go ahead without
   * the comparison is the caller's to decide.
   *
   * @throws Error when the piece carries no pattern pointer, which leaves a
   * change nothing to name as its predecessor.
   */
  async #loadCurrentPatternOrPointer(
    options: { projectResult?: boolean; repairCache?: boolean } = {},
  ): Promise<
    & { ref: { identity: string; symbol: string } }
    & ({ pattern: Pattern } | { pattern: undefined; failure: unknown })
  > {
    try {
      return await this.#loadCurrentPattern(options);
    } catch (failure) {
      const ref = this.#patternPointer();
      if (ref === undefined) throw failure;
      return { pattern: undefined, ref, failure };
    }
  }

  /**
   * The pattern's authored source program, recovered from the content-addressed
   * `pattern:<identity>` source-doc closure in the piece's space. Replaces the
   * deleted meta cell's `program`. `main` is the executable entry filename;
   * `mainExport` is the pattern pointer's export symbol; `sourceRoots` names
   * retained source entry points such as attached tests; and `dataFiles` names
   * attached data files. Returns undefined when no verified source closure
   * exists (the source docs are written by every cold compile).
   */
  async getPatternSourceProgram(): Promise<
    | {
      main: string;
      mainExport?: string;
      files: { name: string; contents: string }[];
      sourceRoots?: string[];
      dataFiles?: string[];
    }
    | undefined
  > {
    const ref = this.#patternPointer();
    if (!ref) throw new Error("piece missing pattern identity");
    const program = await this.#pieces.runtime.patternManager
      .getPatternSourceProgramByIdentity(
        ref.identity,
        this.#pieces.getSpace(),
      );
    if (!program) return undefined;
    return { ...program, mainExport: ref.symbol };
  }

  /**
   * Record what asking the origin just concluded.
   *
   * An explicit update is a reconciliation like any other, and the source
   * panel reads one state whether a background check or its owner performed
   * it. Without this, asking an origin and being refused would leave the piece
   * saying nothing had looked.
   *
   * A failure to record is dropped. The outcome describes the attempt; it is
   * not the attempt's result, and losing it changes nothing the piece runs.
   */
  async #recordReconciliation(
    expected: PieceSourceSnapshot,
    origin: string,
    reconciliation: Omit<PieceReconciliation, "at" | "origin">,
  ): Promise<void> {
    // The result is not read. A commit that does not land leaves the piece
    // with whatever it recorded before, which is a worse answer than this one
    // and not a wrong one, and the caller's own result is what says whether
    // the change happened. `editWithRetry` reports a failed commit in that
    // result rather than by throwing, and the history this reads was already
    // read at the top of the change that led here, so there is nothing left
    // to throw either.
    await this.#pieces.runtime.editWithRetry((tx) => {
      // An outcome describes the piece the attempt reasoned about. A
      // concurrent detach, edit, or repoint has moved it somewhere this
      // conclusion does not describe, so the write is dropped rather than
      // landing on the piece that replaced it.
      const candidate = this.#cell.withTx(tx);
      // The session pointer too: a keyless piece keeps no durable identity, so
      // without it every comparison here would find no state and drop every
      // record such a piece ever reaches.
      const current = getPieceSourceSnapshot(
        candidate,
        this.#pieces.runtime.runner.sessionPatternPointerFor(this.#cell),
      );
      if (
        current === undefined ||
        current.pattern.identity !== expected.pattern.identity ||
        current.pattern.symbol !== expected.pattern.symbol ||
        current.origin !== expected.origin ||
        current.revisionId !== expected.revisionId
      ) return false;
      setPieceReconciliation(this.#cell, tx, {
        ...reconciliation,
        origin,
        at: Date.now(),
      });
      return true;
    });
  }

  /**
   * Refuse a candidate whose contract the piece's stored data does not
   * satisfy, recording that refusal before raising it.
   *
   * This refusal is the one that cannot be overruled: the piece would not be
   * able to run the source, so there is no warning to accept. Recording it is
   * what separates it, on the source panel, from the refusal that can — and
   * from a piece nothing has looked at, which is how it read while this was
   * only ever thrown.
   */
  async #refuseUnusableArgument(
    review: NonNullable<PreparedPieceSourceChange["review"]>,
    expected: PieceSourceSnapshot,
    origin: string | null,
    candidate: { identity: string; symbol: string },
    active: boolean,
  ): Promise<void> {
    const issue = review.issues.argument;
    if (issue === undefined) return;
    // Only an update from the piece's own active origin describes a
    // relationship the piece has; being pointed somewhere new does not.
    if (active && origin !== null) {
      // The panel already says the data does not fit; what it needs from the
      // message is which part of it, so the classifying prefix comes off.
      await this.#recordReconciliation(expected, origin, {
        outcome: "refused",
        reason: "argument-mismatch",
        offered: candidate,
        detail: storedArgumentRefusalDetail(issue),
      });
    }
    throw new Error(issue);
  }

  /**
   * Change which source a piece follows.
   *
   * Five operations share this path because they share a shape: detach from
   * the current origin, restore an exact retained source revision, follow an
   * origin recorded by an earlier revision, take what the active origin
   * offers now, or move to an origin its owner supplied. The last three all
   * resolve an origin and adopt what it holds, differing only in which origin
   * that is, which export it selects, and what the revision calls the
   * transition.
   *
   * `expectedPattern` pins the reference this change may run over. The
   * snapshot read below becomes the transition's precondition, checked
   * again inside the write transaction by `applyPieceSourceTransition`, so
   * a change that gets that far is already conditional on the piece not
   * moving. What the pin adds is the other half of the window: without it
   * this call adopts whatever it finds as its own expectation, so a writer
   * landing between a caller's proof and this read would have its change
   * silently written over. With it, such a piece is refused by name.
   */
  async changeSource(
    action: PieceSourceAction,
    options: {
      confirmedChange?: PreparedPieceSourceChange;
      expectedPattern?: { identity: string; symbol: string };
    } = {},
  ): Promise<PieceSourceActionResult> {
    if (!isPieceSourceAction(action)) {
      throw new Error("unsupported piece source action");
    }
    // A piece whose current pattern does not load is the piece a change of
    // source rescues: a stored identity only a retired bundle could resolve
    // strands it otherwise. The pointer still names the predecessor, which is
    // all a transition records of it, and all a detach needs. What an action
    // that adopts a candidate loses is the comparison of that candidate with
    // what the piece ran. The review below reports the loss as an
    // incompatibility, so such a change applies only once confirmed.
    const previous = await this.#loadCurrentPatternOrPointer();
    const previousRef = previous.ref;
    // Why the load failed is in no review, since a review has to read the
    // same on the call that confirms it. A confirmation repeats a load that
    // was already reported, so only the reviewing call logs it.
    if (
      previous.pattern === undefined && options.confirmedChange === undefined
    ) {
      pieceUpdateLogger.warn("change-source-current-unloadable", () => [
        "the current pattern failed to load; reviewing the source change",
        `against the stored identity ref ${previousRef.identity}#` +
        `${previousRef.symbol} alone (${this.#cell.space})`,
        previous.failure,
      ]);
    }
    const expected = getPieceSourceSnapshot(
      this.#cell,
      this.#pieces.runtime.runner.sessionPatternPointerFor(this.#cell),
    );
    if (expected === undefined) {
      throw new Error("piece missing source state");
    }
    const pinned = options.expectedPattern;
    if (
      pinned !== undefined &&
      (expected.pattern.identity !== pinned.identity ||
        expected.pattern.symbol !== pinned.symbol)
    ) {
      throw new PieceSourceChangedError(
        `The piece is on ${expected.pattern.identity}#` +
          `${expected.pattern.symbol}, not the ${pinned.identity}#` +
          `${pinned.symbol} this change was proved against.`,
      );
    }

    const confirmed = options.confirmedChange;
    if (
      confirmed !== undefined &&
      (!samePieceSourceAction(confirmed.action, action) ||
        !samePieceSourceSnapshot(confirmed.expected, expected))
    ) {
      throw new Error(
        "the piece source changed after compatibility was checked",
      );
    }

    const revisions = getPieceSourceRevisions(this.#cell);

    if (action.kind === "detach") {
      if (confirmed !== undefined) {
        throw new Error("detach does not use compatibility confirmation");
      }
      if (expected.origin === null) {
        throw new Error("piece is not following a source");
      }
      const baseline = await preparePieceSourceTransitionBaseline(
        this.#pieces.runtime,
        this.#cell,
        expected,
      );
      const transition = pieceSourceTransition(
        expected,
        "detach",
        null,
        baseline,
      );
      const mutationVersion = ++this.#mutationVersion;
      // The transaction's own verdict: `editWithRetry` reports a rejected
      // commit in its result, so past that check the transition is written.
      // What can still fail is the schema refresh `#runMutation` runs after
      // the operation, which does not undo the accepted detach.
      let committed = false;
      try {
        await this.#runMutation(mutationVersion, async () => {
          const result = await this.#pieces.runtime.editWithRetry((tx) => {
            applyPieceSourceTransition(
              this.#pieces.runtime,
              this.#cell,
              tx,
              previousRef,
              transition,
            );
            return true;
          });
          if (result.error !== undefined) throw result.error;
          committed = true;
          return this.#cell;
        });
        return { status: "applied" };
      } catch (error) {
        if (committed) {
          return {
            status: "applied",
            executionWarning: pieceSourceErrorMessage(error),
          };
        }
        throw error;
      }
    }

    let candidate: Pattern;
    let prepared: PreparedPieceSourceChange;
    let acceptedReview: PreparedPieceSourceChange["review"];
    if (confirmed !== undefined) {
      if (confirmed.review === undefined) {
        throw new Error(
          "the piece source compatibility confirmation is incomplete",
        );
      }
      await this.#refuseUnusableArgument(
        confirmed.review,
        expected,
        confirmed.origin,
        confirmed.candidate,
        action.kind === "adopt",
      );
      const loaded = await this.#pieces.runtime.patternManager
        .loadPatternByIdentity(
          confirmed.candidate.identity,
          confirmed.candidate.symbol,
          this.#pieces.getSpace(),
        );
      if (loaded === undefined) {
        throw new Error("the confirmed source version is not available");
      }
      candidate = loaded;
      prepared = confirmed;
      const currentReview = await pieceSourceCompatibilityReview(
        previous,
        candidate,
        this.#cell,
        this.#pieces,
      );
      await this.#refuseUnusableArgument(
        currentReview,
        expected,
        confirmed.origin,
        confirmed.candidate,
        action.kind === "adopt",
      );
      if (
        currentReview.argumentEvidence !==
          confirmed.review.argumentEvidence ||
        !deepEqual(currentReview.issues, confirmed.review.issues)
      ) {
        if (hasPieceSourceCompatibilityIssues(currentReview.issues)) {
          prepared = { ...confirmed, review: currentReview };
          return {
            status: "incompatible",
            message: pieceSourceCompatibilityMessage(currentReview.issues),
            prepared,
          };
        }
        throw new Error(
          "the retained piece input changed after compatibility was checked",
        );
      } else {
        acceptedReview = confirmed.review;
      }
    } else {
      // A piece with no source history and no origin predates both, and its
      // space may hold no source for what it runs. It takes the transition's
      // displaced-identity arm, as it does under `setPattern`. A piece that
      // recorded how it got its pattern keeps its claim to a restorable
      // current source, so the baseline still refuses one that has none.
      const baseline = await preparePieceSourceTransitionBaseline(
        this.#pieces.runtime,
        this.#cell,
        expected,
        expected.revisionId === null && expected.origin === null
          ? { allowUnavailable: true }
          : {},
      );
      let program: RuntimeProgram;
      let origin: string | null;
      let operation: PieceSourceTransition["operation"];
      let selectedRevisionId: string | undefined;
      if (action.kind === "restore") {
        const selected = sourceRevision(revisions, action.revisionId);
        const retained = await this.#pieces.runtime.patternManager
          .getPatternSourceProgramByIdentity(
            selected.pattern.identity,
            this.#pieces.getSpace(),
          );
        if (retained === undefined) {
          throw new Error(
            `source revision ${selected.revisionId} is not available`,
          );
        }
        program = { ...retained, mainExport: selected.pattern.symbol };
        origin = null;
        operation = "revert";
        selectedRevisionId = selected.revisionId;
      } else {
        // Every remaining action resolves an origin and adopts what it offers
        // now. They differ in which origin that is, which export it selects,
        // and what the revision calls the transition: following an origin the
        // piece used before, adopting what the active origin offers today, or
        // moving to one a person supplied.
        let symbol: string;
        if (action.kind === "follow") {
          const selected = sourceRevision(revisions, action.revisionId);
          if (selected.origin === undefined) {
            throw new Error(
              `source revision ${selected.revisionId} has no origin to follow`,
            );
          }
          origin = selected.origin;
          symbol = selected.pattern.symbol;
          operation = "repoint";
          selectedRevisionId = selected.revisionId;
        } else if (action.kind === "adopt") {
          if (expected.origin === null) {
            throw new Error("piece is not following a source");
          }
          origin = expected.origin;
          symbol = previousRef.symbol;
          operation = "origin-update";
        } else {
          origin = acceptEnteredOrigin(
            this.#pieces.runtime,
            this.#pieces.getSpace(),
            action.url,
          );
          symbol = previousRef.symbol;
          operation = "repoint";
        }
        try {
          const resolved = await resolvePieceOriginSource(
            this.#pieces.runtime,
            this.#pieces.getSpace(),
            origin,
            symbol,
            { self: { space: this.#pieces.getSpace(), pieceId: this.id } },
          );
          program = resolved.program;
        } catch (error) {
          // Only for `adopt`: the other two are being pointed at an origin the
          // piece does not follow yet, and an outcome recorded against one
          // would describe a relationship it does not have.
          if (action.kind === "adopt") {
            await this.#recordReconciliation(expected, origin, {
              outcome: "unreachable",
              detail: pieceSourceErrorMessage(error),
            });
          }
          throw error;
        }
      }

      candidate = await compileProgram(this.#pieces, program);
      const candidateRef = this.#pieces.runtime.patternManager
        .getArtifactEntryRef(candidate);
      if (candidateRef === undefined) {
        throw new Error("the candidate source has no pattern identity");
      }
      if (
        action.kind === "adopt" &&
        candidateRef.identity === previousRef.identity &&
        candidateRef.symbol === previousRef.symbol
      ) {
        // The origin offers exactly what the piece runs, so there is no
        // source transition to make. Recording the outcome is the whole
        // result: it is what turns an unexamined origin into a current one.
        // `origin` is the active one, which the adopt branch above refused to
        // proceed without.
        await this.#recordReconciliation(expected, origin!, {
          outcome: "followed",
          offered: candidateRef,
        });
        return { status: "applied" };
      }
      prepared = {
        action,
        expected,
        candidate: candidateRef,
        origin,
        operation,
        baseline,
        ...(selectedRevisionId === undefined ? {} : { selectedRevisionId }),
      };
      const review = await pieceSourceCompatibilityReview(
        previous,
        candidate,
        this.#cell,
        this.#pieces,
      );
      await this.#refuseUnusableArgument(
        review,
        expected,
        origin,
        candidateRef,
        action.kind === "adopt",
      );
      if (hasPieceSourceCompatibilityIssues(review.issues)) {
        prepared.review = review;
        if (action.kind === "adopt") {
          // Again the active origin, non-null since the adopt branch above.
          await this.#recordReconciliation(expected, origin!, {
            outcome: "refused",
            reason: "incompatible-schema",
            offered: candidateRef,
            detail: pieceSourceCompatibilityMessage(review.issues),
          });
        }
        return {
          status: "incompatible",
          message: pieceSourceCompatibilityMessage(review.issues),
          prepared,
        };
      }
    }

    const transition = pieceSourceTransition(
      expected,
      prepared.operation,
      prepared.origin,
      prepared.baseline,
      { selectedRevisionId: prepared.selectedRevisionId },
    );
    const mutationVersion = ++this.#mutationVersion;
    // The accepted setup transaction's receipt, held exactly when storage
    // accepted this change's transaction: from the resolved update, or from
    // the post-commit error that carries it. It is what lets the catch below
    // tell a transition that landed from one that did not.
    let commit: PatternSetupCommitReceipt | undefined;
    try {
      await this.#runMutation(mutationVersion, async () => {
        try {
          const result = await executePatternUpdate(
            this.#pieces,
            this.id,
            candidate,
            undefined,
            {
              expectedPatternIdentity: previousRef,
              validateCurrentArgument: acceptedReview === undefined
                ? undefined
                : (argumentCell) => {
                  const evidence = pieceSourceArgumentEvidence(
                    argumentCell,
                    this.#pieces,
                  );
                  if (evidence !== acceptedReview.argumentEvidence) {
                    throw new Error(
                      "the retained piece input changed after compatibility was checked",
                    );
                  }
                },
              validateArgumentLinks: (argumentCell, argumentSchema) => {
                try {
                  assertPieceSourceRetainedLinksCompatible(
                    argumentCell,
                    argumentSchema,
                    this.#pieces,
                    previous.pattern?.argumentSchema,
                  );
                } catch (error) {
                  const message = error instanceof Error
                    ? error.message
                    : String(error);
                  if (acceptedReview?.issues.retainedLinks === message) return;
                  throw error;
                }
              },
              sourceTransition: transition,
            },
          );
          commit = result.commit;
          return result.cell as Cell<T>;
        } catch (error) {
          if (error instanceof PatternSetupPostCommitError) {
            commit = error.commit;
          }
          throw error;
        }
      });
      // The transition cleared whatever the last reconciliation concluded,
      // and this is the fresh answer: the piece now runs what this origin
      // offered a moment ago. The guard is the state the transition left, read
      // back rather than reconstructed, because recording an origin normalizes
      // it and this has to match what the piece now stores.
      const settled = getPieceSourceSnapshot(
        this.#cell,
        this.#pieces.runtime.runner.sessionPatternPointerFor(this.#cell),
      );
      // Only when the piece is still on the revision this transition wrote.
      // Another transition landing in between describes a different piece
      // than the candidate below, and recording against it would say that
      // piece adopted source it never saw.
      if (
        settled !== undefined && settled.revisionId === transition.revisionId &&
        settled.origin !== null
      ) {
        await this.#recordReconciliation(settled, settled.origin, {
          outcome: "followed",
          offered: prepared.candidate,
        });
      }
      return { status: "applied" };
    } catch (error) {
      if (commit !== undefined) {
        // The transition committed and running its source then failed, so
        // neither outcome is true: the piece did not decline this source, and
        // it is not demonstrably running it either. The warning below says
        // what happened, and the next reconciliation settles what the piece
        // is doing rather than this guessing now. The wrapper's own message
        // only restates that split, so the warning carries the cause — the
        // failure itself — as `setPattern`'s refresh arm does.
        const cause = error instanceof PatternSetupPostCommitError
          ? error.cause
          : error;
        return {
          status: "applied",
          executionWarning: pieceSourceErrorMessage(cause),
        };
      }
      if (isOverridableArgumentCompatibilityError(error)) {
        const review = await pieceSourceCompatibilityReview(
          previous,
          candidate,
          this.#cell,
          this.#pieces,
        );
        await this.#refuseUnusableArgument(
          review,
          expected,
          prepared.origin,
          prepared.candidate,
          action.kind === "adopt",
        );
        if (hasPieceSourceCompatibilityIssues(review.issues)) {
          prepared.review = review;
          return {
            status: "incompatible",
            message: pieceSourceCompatibilityMessage(review.issues),
            prepared,
          };
        }
      }
      throw pinnedSourceMoved(error, pinned);
    }
  }

  /**
   * Review a candidate with the same compatibility rules used by source setup.
   * Compilation and source loading reuse verified caches without writing to
   * storage or creating module-update authority. Reads retain their normal
   * server-demand semantics. Apply validates retained input and source currency
   * again at commit time.
   */
  async checkPattern(
    program: RuntimeProgram,
  ): Promise<PatternCompatibilityReport> {
    const previous = await this
      .#loadCurrentPatternOrPointer({ repairCache: false });
    const candidate = await this.#pieces.runtime.patternManager.compilePattern(
      program,
      { space: this.#pieces.getSpace(), persist: false },
    );
    const candidateRef = this.#pieces.runtime.patternManager
      .getArtifactEntryRef(candidate);
    if (candidateRef === undefined) {
      throw new Error("the candidate source has no pattern identity");
    }
    const review = await pieceSourceCompatibilityReview(
      previous,
      candidate,
      this.#cell,
      this.#pieces,
    );
    const compatible = !hasPieceSourceCompatibilityIssues(review.issues);
    return {
      compatible,
      issues: review.issues,
      candidate: candidateRef,
      ...(compatible
        ? {}
        : { message: pieceSourceCompatibilityMessage(review.issues) }),
    };
  }

  /**
   * Replace the piece's source with `program`, detaching the piece from the
   * origin it follows: what it runs afterwards is `program` and stays
   * `program` until something writes it again.
   *
   * `expectedPattern` pins the reference this write may run over, exactly as
   * {@link changeSource}'s does and for the same window. The snapshot read
   * below becomes the transition's precondition, checked again inside the
   * write transaction by `applyPieceSourceTransition`, so a write that gets
   * that far is already conditional on the piece not moving. What the pin
   * adds is the other half: without it this call adopts whatever it finds as
   * its own expectation, so a writer landing between a caller's proof and
   * this read would have its change silently written over. With it, such a
   * piece is refused by name with {@link PieceSourceChangedError}.
   *
   * The pin is a precondition and nothing else. It does not confirm a
   * compatibility review, does not stand in for one, and does not change
   * what this method accepts: the schema assertion below and the
   * execute-time validators remain the whole of enforcement, and
   * `dangerouslyAllowIncompatibleSchema` remains the only thing that opens
   * them.
   *
   * Returns the accepted setup transaction's receipt: its content-addressed
   * pointer, its source revision, and the origin this write detached — see
   * {@link PatternUpdateReceipt} and {@link PieceSourceSetResult}. Every
   * field is taken from the transaction this call committed, so a later
   * concurrent update does not retroactively change any of them. A caller
   * reporting what it detached has no other way to be right about it: the
   * origin at the caller's own read is not the origin at the write, and only
   * the snapshot this call commits against is.
   *
   * Post-commit refresh failures are reported as `refresh.status === "failed"`
   * rather than as a rejection, because they do not undo the accepted source
   * update.
   */
  async setPattern(
    program: RuntimeProgram,
    options?: PatternUpdateOptions,
  ): Promise<PatternUpdateReceipt> {
    return await this.#updatePattern(
      () => compileProgram(this.#pieces, program),
      options,
    );
  }

  /**
   * Like {@link setPattern}, except the candidate is a pattern already
   * compiled into the space — the result of an earlier compile whose
   * closure the space holds — so nothing is compiled or persisted here
   * before the setup transaction. Everything else, the pin and the
   * compatibility checks included, is the same.
   */
  async setCompiledPattern(
    pattern: Pattern,
    options?: PatternUpdateOptions,
  ): Promise<PatternUpdateReceipt> {
    return await this.#updatePattern(() => Promise.resolve(pattern), options);
  }

  /**
   * Helper for `setPattern()` and `setCompiledPattern()`, which runs the
   * update over the candidate `compile` produces at the point in the flow
   * where the candidate is needed: after the current pattern and the
   * transition's baseline are in hand, ahead of the compatibility checks.
   */
  async #updatePattern(
    compile: () => Promise<Pattern>,
    options?: PatternUpdateOptions,
  ): Promise<PatternUpdateReceipt> {
    const mutationVersion = ++this.#mutationVersion;
    let transition: PieceSourceTransition | undefined;
    let commit: PatternSetupCommitReceipt | undefined;
    try {
      await this.#runMutation(mutationVersion, async () => {
        // A piece whose current pattern cannot load is exactly the piece a
        // source replacement rescues: a stored identity resolvable only from
        // a retired bundle (a wish-minted sidecar with no in-space program)
        // strands the piece otherwise. The loaded pattern feeds only the two
        // checks the escape hatch already waives — the backward-compatibility
        // assertion and retained-link validation — so under
        // `dangerouslyAllowIncompatibleSchema` a failed load degrades to the
        // stored identity ref alone. Without the flag the load failure stays
        // fatal, unchanged.
        //
        // The degradation reaches two populations. A piece with no retained
        // source takes the transition's displaced-identity arm below. A piece
        // whose source IS retained but whose artifact will not load — a
        // compile or evaluation failure under this runtime — keeps its
        // retained baseline: the stored ref serves only as the concurrency
        // guard and the candidate's predecessor entry, both of which name an
        // identity without loading it.
        //
        // A served update repairs no cache: a write the load would seal
        // into the serving wave is not one the update's own commit
        // should rest on or answer for.
        const previous = await this.#loadCurrentPatternOrPointer({
          repairCache: options?.served === undefined,
        });
        const previousPattern = previous.pattern;
        const previousRef = previous.ref;
        if (previous.pattern === undefined) {
          if (!options?.dangerouslyAllowIncompatibleSchema) {
            throw previous.failure;
          }
          pieceUpdateLogger.warn("set-pattern-current-unloadable", () => [
            "the current pattern failed to load; replacing source from the",
            `stored identity ref ${previousRef.identity}#${previousRef.symbol}`,
            `under dangerouslyAllowIncompatibleSchema (${this.#cell.space})`,
            previous.failure,
          ]);
        }
        const expected = getPieceSourceSnapshot(
          this.#cell,
          this.#pieces.runtime.runner.sessionPatternPointerFor(this.#cell),
        );
        if (expected === undefined) {
          throw new Error("piece missing source state");
        }
        const pinned = options?.expectedPattern;
        if (
          pinned !== undefined &&
          (expected.pattern.identity !== pinned.identity ||
            expected.pattern.symbol !== pinned.symbol)
        ) {
          throw new PieceSourceChangedError(
            `The piece is on ${expected.pattern.identity}#` +
              `${expected.pattern.symbol}, not the ${pinned.identity}#` +
              `${pinned.symbol} this write was proved against.`,
          );
        }
        const baseline = await preparePieceSourceTransitionBaseline(
          this.#pieces.runtime,
          this.#cell,
          expected,
          expected.revisionId === null && expected.origin === null
            ? { allowUnavailable: true }
            : {},
        );
        const pattern = await compile();
        const candidate = this.#pieces.runtime.patternManager
          .getArtifactEntryRef(pattern);
        if (candidate === undefined) {
          throw new Error("the candidate source has no pattern identity");
        }
        // Enforce the contract here and the stored-input checks inside the
        // setup transaction. `checkPattern()` collects the same checks for
        // preflight; its read-time verdict cannot replace commit-time checks.
        if (!options?.dangerouslyAllowIncompatibleSchema) {
          // Reached only when the load above succeeded: a failed load
          // without the flag rethrows there.
          assertPatternSchemasBackwardCompatible(previousPattern!, pattern);
        }
        // The `null` is the origin: this transition detaches. A caller
        // supplying the source has chosen what the piece runs, and a piece
        // still carrying its origin could be repointed afterwards to
        // whatever that origin ships, which is not what this caller named.
        transition = pieceSourceTransition(
          expected,
          "edit",
          null,
          baseline,
        );
        try {
          const result = await executePatternUpdate(
            this.#pieces,
            this.id,
            pattern,
            undefined,
            {
              expectedPatternIdentity: previousRef,
              validateArgumentLinks: options?.dangerouslyAllowIncompatibleSchema
                ? undefined
                : (argumentCell, argumentSchema) =>
                  assertSuppliedLinkSchemasCompatible(
                    suppliedLinks(argumentCell.getRaw()),
                    argumentSchema,
                    argumentCell,
                    this.#pieces,
                    {
                      // Same narrowing as the assertion above: this validator
                      // arm exists only without the flag, where the load
                      // succeeded.
                      priorArgumentSchema: previousPattern!.argumentSchema,
                      // `applySetupState` rewrites the argument from
                      // `getRaw()`, so every retained link's envelope is
                      // written back unchanged. Anything newly staged still
                      // faces the full rebuild rules.
                      linksPreservedVerbatim: true,
                    },
                  ),
              repository: options?.repository,
              sourceTransition: transition,
              ...(options?.served === undefined
                ? {}
                : { served: options.served }),
            },
          );
          commit = result.commit;
          return result.cell as Cell<T>;
        } catch (error) {
          if (error instanceof PatternSetupPostCommitError) {
            commit = error.commit;
          }
          throw error;
        }
      });
    } catch (error) {
      if (transition !== undefined && commit !== undefined) {
        // The wrapper says only that post-commit work failed, which this line
        // already says; what a reader needs is which work and why. Log the
        // cause, the same failure `refresh.warning` reports, so the console
        // and the receipt describe the failure identically.
        const cause = error instanceof PatternSetupPostCommitError
          ? error.cause
          : error;
        const warning = pieceSourceErrorMessage(cause);
        console.warn(
          "Piece source was saved, but refreshing the running piece failed:",
          cause,
        );
        // The transition committed, so it detached what its precondition
        // named, whatever happened to the refresh afterwards.
        return {
          status: "committed",
          ref: commit.pattern,
          space: commit.space,
          seq: commit.seq,
          revisionId: transition.revisionId,
          detachedOrigin: transition.expected.origin,
          refresh: { status: "failed", warning },
        };
      }
      throw pinnedSourceMoved(error, options?.expectedPattern);
    }
    // The mutation assigns `transition` before the write it belongs to, and
    // holds the accepted transaction's receipt in `commit`; every earlier exit
    // from it throws — so a mutation that resolved has both, and a mutation
    // that did not took the catch above. Asserted rather than guarded because
    // a guard here could never fire.
    return {
      status: "committed",
      ref: commit!.pattern,
      space: commit!.space,
      seq: commit!.seq,
      revisionId: transition!.revisionId,
      detachedOrigin: transition!.expected.origin,
      refresh: {
        status: options?.served === undefined ? "completed" : "deferred",
      },
    };
  }

  async #runMutation(
    mutationVersion: number,
    operation: () => Promise<Cell<T>>,
  ): Promise<void> {
    try {
      const cell = await operation();
      this.#latestSuccessfulMutationVersion = Math.max(
        this.#latestSuccessfulMutationVersion,
        mutationVersion,
      );
      if (mutationVersion === this.#mutationVersion) {
        this.#cell = cell;
      } else if (
        this.#latestSuccessfulMutationVersion === mutationVersion
      ) {
        // A newer mutation may have committed while this one was doing
        // post-commit work. If no newer mutation succeeded, reconcile from
        // durable identity instead of installing this now-stale schema view.
        await this.#refreshCellSchema(this.#mutationVersion);
      }
    } catch (error) {
      // A rejection is not evidence that setup did not commit: syncPattern()
      // and result pull both run after the atomic setup. Keep mutation versions
      // monotonic and reload the schema attached to the durable winner.
      if (this.#latestSuccessfulMutationVersion <= mutationVersion) {
        await this.#refreshCellSchema(this.#mutationVersion);
      }
      throw error;
    }
  }

  async #refreshCellSchema(refreshVersion: number): Promise<void> {
    const cell = this.#cell;
    while (
      refreshVersion === this.#mutationVersion && cell === this.#cell
    ) {
      await cell.sync();
      const refBeforeLoad = getPatternIdentityRef(cell);
      if (!refBeforeLoad) return;
      const pattern = await this.#pieces.runtime.patternManager
        .loadPatternByIdentity(
          refBeforeLoad.identity,
          refBeforeLoad.symbol,
          this.#pieces.getSpace(),
        );
      if (!pattern) return;
      await cell.sync();
      const refAfterLoad = getPatternIdentityRef(cell);
      if (
        !refAfterLoad ||
        refBeforeLoad.identity !== refAfterLoad.identity ||
        refBeforeLoad.symbol !== refAfterLoad.symbol
      ) {
        continue;
      }
      if (
        refreshVersion === this.#mutationVersion && cell === this.#cell
      ) {
        this.#cell = cell.asSchema(pattern.resultSchema);
      }
      return;
    }
  }

  async readingFrom(): Promise<PieceController[]> {
    const cells = await this.#pieces.getReadingFrom(this.#cell);
    return cells.map((cell) => new PieceController(this.#pieces, cell));
  }

  async readBy(): Promise<PieceController[]> {
    const cells = await this.#pieces.getReadByPieces(this.#cell);
    return cells.map((cell) => new PieceController(this.#pieces, cell));
  }

  pieces(): PiecesController {
    return this.#pieces;
  }
}

function sourceRevision(
  revisions: readonly PieceSourceRevision[],
  revisionId: string,
): PieceSourceRevision {
  const revision = revisions.find((candidate) =>
    candidate.revisionId === revisionId
  );
  if (revision === undefined) {
    throw new Error(`source revision ${revisionId} does not exist`);
  }
  return revision;
}

function isPieceSourceAction(action: unknown): action is PieceSourceAction {
  if (!isObjectOrArray(action) || !("kind" in action)) {
    return false;
  }
  if (action.kind === "detach" || action.kind === "adopt") return true;
  if (action.kind === "repoint") {
    return "url" in action && typeof action.url === "string" &&
      action.url.trim().length > 0;
  }
  return (action.kind === "restore" || action.kind === "follow") &&
    "revisionId" in action &&
    typeof action.revisionId === "string" &&
    action.revisionId.length > 0;
}

function samePieceSourceAction(
  left: PieceSourceAction,
  right: PieceSourceAction,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "detach" || left.kind === "adopt") return true;
  if (left.kind === "repoint") {
    return right.kind === "repoint" && left.url === right.url;
  }
  return right.kind === "restore" || right.kind === "follow"
    ? left.revisionId === right.revisionId
    : false;
}

function samePieceSourceSnapshot(
  left: PieceSourceSnapshot,
  right: PieceSourceSnapshot,
): boolean {
  return left.pattern.identity === right.pattern.identity &&
    left.pattern.symbol === right.pattern.symbol &&
    left.origin === right.origin &&
    left.revisionId === right.revisionId;
}

const RETAINED_INPUT_COMPATIBILITY_PREFIX =
  "piece source is incompatible with retained input: ";

async function syncRetainedLinkMetadata(
  argumentCell: Cell<unknown>,
  pieces: PiecesController,
): Promise<void> {
  const roots = new Map<string, Cell<unknown>>();
  for (const supplied of suppliedLinks(argumentCell.getRaw())) {
    let base = argumentCell;
    for (const segment of supplied.path) {
      base = base.key(segment as keyof unknown) as Cell<unknown>;
    }
    const link = parseLinkOrThrow(supplied.value, base);
    const root = pieces.runtime.getCellFromLink({
      ...link,
      path: [],
      schema: undefined,
    });
    const { space, id, scope } = root.getAsNormalizedFullLink();
    roots.set(JSON.stringify([space, id, scope]), root);
  }
  await Promise.all([...roots.values()].map(async (root) => {
    // Naming the source root loads the document with its metadata; a value
    // crossing loads only the selected value and does not establish that
    // contract evidence. The owner result an argument or internal document
    // names through its `result` backlink is a document of its own, named
    // in turn: the contract reads its metadata, and the store delivers no
    // link target with the document that carries the link.
    await root.sync();
    const link = root.getAsNormalizedFullLink();
    let metaRoot = root;
    if (
      link.scope !== "space" && root.getMetaRaw("schema") === undefined &&
      root.getMetaRaw("result") === undefined
    ) {
      // Scoped input redirects keep their producer metadata in base scope;
      // scoped results instead own their metadata in the selected partition.
      metaRoot = pieces.runtime.getCellFromLink({ ...link, scope: "space" });
      await metaRoot.sync();
    }
    const ownerLink = getMetaLink(metaRoot, "result");
    if (ownerLink !== undefined) {
      await pieces.runtime.getCellFromLink({
        ...ownerLink,
        path: [],
        schema: undefined,
      }).sync();
    }
  }));
}

function assertPieceSourceRetainedLinksCompatible(
  argumentCell: Cell<unknown>,
  candidateSchema: JSONSchema,
  pieces: PiecesController,
  priorArgumentSchema: JSONSchema | undefined,
): void {
  try {
    assertSuppliedLinkSchemasCompatible(
      suppliedLinks(argumentCell.getRaw()),
      candidateSchema,
      argumentCell,
      pieces,
      {
        priorArgumentSchema,
        linksPreservedVerbatim: true,
      },
    );
  } catch (error) {
    throw new Error(
      RETAINED_INPUT_COMPATIBILITY_PREFIX +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

function pieceSourceArgumentEvidence(
  argumentCell: Cell<unknown>,
  pieces: PiecesController,
): string {
  const raw = argumentCell.getRaw();
  const links = suppliedLinks(raw).map((suppliedLink) => {
    let linkBase = argumentCell;
    for (const segment of suppliedLink.path) {
      linkBase = linkBase.key(segment as keyof unknown) as Cell<unknown>;
    }
    try {
      const link = parseLinkOrThrow(suppliedLink.value, linkBase);
      const linkedCell = pieces.runtime.getCellFromLink(
        { ...link, schema: undefined },
        undefined,
        linkBase.tx,
      );
      const contract = durableSourceContract(linkedCell, pieces);
      return {
        path: suppliedLink.path,
        target: {
          space: linkedCell.space,
          id: linkedCell.getAsNormalizedFullLink().id,
          scope: linkedCell.getAsNormalizedFullLink().scope,
          path: linkedCell.getAsNormalizedFullLink().path,
        },
        contract: contract?.schemas.map((schema) => ({
          root: schema.root,
          path: schema.path,
          rawBasePath: schema.rawBasePath,
          schemaBaseDepth: schema.schemaBaseDepth,
          validationTarget: (() => {
            const target = schema.validationCell.getAsNormalizedFullLink();
            return {
              space: target.space,
              id: target.id,
              scope: target.scope,
              path: target.path,
            };
          })(),
          validationPath: schema.validationPath,
        })) ?? null,
      };
    } catch (error) {
      return { path: suppliedLink.path, error: pieceSourceErrorMessage(error) };
    }
  });
  return taggedHashStringOf({ raw, links });
}

/**
 * Every reason `candidate` cannot replace what `piece` runs, with the evidence
 * the stored argument was judged on.
 *
 * `previous.pattern` is `undefined` for a piece whose current pattern does not
 * load. Nothing can then say whether the candidate keeps the contract the piece
 * ran under, which is itself an incompatibility: the review reports it under
 * `schema`, naming the pattern by `previous.ref`, and judges retained links
 * against the candidate alone. The stored argument and the CFC envelopes are
 * judged as they always are, since neither consults the current pattern.
 */
async function pieceSourceCompatibilityReview(
  previous: {
    pattern: Pattern | undefined;
    ref: { identity: string; symbol: string };
  },
  candidate: Pattern,
  piece: Cell<unknown>,
  pieces: PiecesController,
): Promise<NonNullable<PreparedPieceSourceChange["review"]>> {
  const issues: PieceSourceCompatibilityIssues = {};
  if (previous.pattern === undefined) {
    issues.schema = `the piece's current pattern ` +
      `\`${previous.ref.identity}#${previous.ref.symbol}\` cannot be loaded, ` +
      `so the candidate cannot be compared with it`;
  } else {
    try {
      assertPatternSchemasBackwardCompatible(previous.pattern, candidate);
    } catch (error) {
      issues.schema = error instanceof Error ? error.message : String(error);
    }
  }

  const argumentCell = pieces.getArgument(piece);
  // The candidate can select inputs the current pattern does not expose.
  // Sync its projection before validating the newly selected values.
  await argumentCell.asSchema(candidate.argumentSchema).sync();
  try {
    pieces.runtime.runner.validateStoredArgument(
      pieces.runtime.readTx(),
      piece,
      candidate,
    );
  } catch (error) {
    issues.argument = pieceSourceErrorMessage(error);
  }

  try {
    await syncRetainedLinkMetadata(argumentCell, pieces);
    assertPieceSourceRetainedLinksCompatible(
      argumentCell,
      candidate.argumentSchema,
      pieces,
      previous.pattern?.argumentSchema,
    );
  } catch (error) {
    issues.retainedLinks = error instanceof Error
      ? error.message
      : String(error);
  }

  const cfc = pieceSourceCfcEnvelopeIssue(
    piece,
    argumentCell,
    candidate,
    pieces,
  );
  if (cfc !== undefined) issues.cfc = cfc;

  return {
    argumentEvidence: pieceSourceArgumentEvidence(argumentCell, pieces),
    issues,
  };
}

/**
 * Would the setup commit's CFC schema-envelope merges accept this candidate
 * over what the piece's documents already store?
 *
 * Why this is its own rule rather than a case of the three above: those all
 * reason about DECLARED types — the previous and candidate patterns' argument
 * and result schemas, and the stored argument VALUE against them. The CFC
 * envelope is neither. It is the schema the document was last committed under,
 * accumulated across every write that ever touched it, and it can carry claims
 * no pattern declares (a later write that strengthened a confidentiality label
 * widens it in place; a handler's write stamps its module identity onto the
 * `writeAuthorizedBy` claim of the field it wrote). So a piece whose pattern
 * pointer has run ahead of its stored envelope — the partially-migrated case
 * this command exists to catch — passes all three type-level checks and still
 * takes `CFC enforcement rejected commit` at the setup boundary. Reporting
 * `compatible: true` there is worse than having no preflight at all, because
 * the verdict is what gates a deploy.
 *
 * Two documents take that merge at commit, and both are reviewed here. The
 * argument document merges under the candidate's argument schema. The piece's
 * own document — the result, where a profile's owner-protected fields live —
 * merges under the candidate's result schema, and only when setup rewrites
 * the result projection at all, which `setupRewritesResultProjection` decides
 * for the review as it does for setup. Setup rewrites the projection in full,
 * so its schema input covers the whole document as generated output and every
 * path of it is exempt from the additive-required rule; the review passes the
 * same exemption, or a candidate that adds a generated result field would be
 * refused here and accepted by the deploy. An argument is an input: nothing
 * generates it, so its merge takes no exemption.
 *
 * Each merge is driven for real, in dry run, through
 * `storedCfcEnvelopeMergeIssue` — the fast paths the commit takes before it
 * merges and then the merge itself — so the two cannot disagree about what
 * merges.
 */
function pieceSourceCfcEnvelopeIssue(
  piece: Cell<unknown>,
  argumentCell: Cell<unknown>,
  candidate: Pattern,
  pieces: PiecesController,
): string | undefined {
  // `readTx()` cannot write, so the two dry runs stay dry runs.
  const tx = pieces.runtime.readTx();
  const issues = [
    pieceDocumentCfcEnvelopeIssue(
      "argument",
      argumentCell,
      candidate.argumentSchema,
      {},
      tx,
    ),
    // Setup writes the result projection, and with it the schema input the
    // commit merges, only where the candidate's projection differs from the
    // stored one. A candidate that changes nothing the projection carries
    // takes no merge at commit, so the review asks setup's own question
    // first rather than refusing over an envelope the commit never touches.
    pieces.runtime.runner.setupRewritesResultProjection(tx, candidate, piece)
      ? pieceDocumentCfcEnvelopeIssue(
        "result",
        piece,
        candidate.resultSchema,
        { generatedOutputPaths: [[]] },
        tx,
      )
      : undefined,
  ].filter((issue): issue is string => issue !== undefined);
  return issues.length === 0 ? undefined : issues.join("\n");
}

/**
 * The issue one of the piece's documents raises against the candidate schema
 * the setup commit would write it under, or `undefined` where the commit's
 * merge accepts it. `document` names the document in the message.
 */
function pieceDocumentCfcEnvelopeIssue(
  document: "argument" | "result",
  cell: Cell<unknown>,
  candidateSchema: JSONSchema,
  options: MergeCfcSchemaEnvelopeOptions,
  tx: IExtendedStorageTransaction,
): string | undefined {
  const link = cell.getAsNormalizedFullLink();
  const stored = loadStoredCfcEnvelope(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  if (stored.status === "none") {
    // No stored envelope means the merge never runs for this document at
    // commit time, so there is genuinely nothing for it to reject. (Documents
    // only acquire one once a write carries an IFC claim.)
    return undefined;
  }
  if (stored.status === "unreadable") {
    // The commit path records this same load failure as a rejection reason and
    // refuses the write. Skipping it here — the tempting reading, since we
    // cannot evaluate the merge — is precisely how a check green-lights an
    // update the deploy then refuses, so it is a blocker instead.
    return `the CFC schema envelope stored for this piece's ${document} ` +
      `document could not be read (${stored.reason}); applying a source ` +
      `would be rejected over the same failure`;
  }
  const issue = storedCfcEnvelopeMergeIssue(
    stored.schema,
    candidateSchema,
    options,
  );
  if (issue === undefined) return undefined;
  return issue.migration
    ? `the ${document} document stored for this piece predates the ` +
      `candidate's schema and cannot migrate to it: ${issue.message}`
    : `the candidate's ${document} schema does not merge with the CFC ` +
      `schema envelope stored for this piece's ${document} document: ` +
      `${issue.message}`;
}

function hasPieceSourceCompatibilityIssues(
  issues: PieceSourceCompatibilityIssues,
): boolean {
  return issues.schema !== undefined ||
    issues.argument !== undefined ||
    issues.retainedLinks !== undefined ||
    issues.cfc !== undefined;
}

function pieceSourceCompatibilityMessage(
  issues: PieceSourceCompatibilityIssues,
): string {
  return [issues.schema, issues.argument, issues.retainedLinks, issues.cfc]
    .filter((message): message is string => message !== undefined)
    .join("\n");
}

/**
 * Whether `error` is an update refused for the candidate's fit over the
 * piece — its schemas against the current pattern's, the links its argument
 * schema retains, the stored argument, or the stored CFC envelope the
 * candidate's schema cannot migrate — rather than for a reason of setup's
 * own.
 */
export function isPieceSourceCompatibilityRefusal(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith(PATTERN_SCHEMAS_INCOMPATIBLE) ||
    isOverridableArgumentCompatibilityError(error) ||
    isCfcMigrationRejection(error)
  );
}

function isOverridableArgumentCompatibilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(
    "updated arguments do not match the candidate schema:",
  ) || error.message.includes(RETAINED_INPUT_COMPATIBILITY_PREFIX);
}

function pieceSourceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pieceSourceTransition(
  expected: PieceSourceSnapshot,
  operation: PieceSourceTransition["operation"],
  origin: string | null,
  baseline: PieceSourceTransitionBaseline,
  options: { selectedRevisionId?: string } = {},
): PieceSourceTransition {
  const timestamp = Date.now();
  return {
    revisionId: crypto.randomUUID(),
    baseline,
    timestamp,
    operation,
    origin,
    expected,
    ...(options.selectedRevisionId === undefined
      ? {}
      : { selectedRevisionId: options.selectedRevisionId }),
  };
}

/**
 * Helper for `setInput()`, which re-runs the piece's current pattern over a
 * caller-supplied argument. A source change goes through
 * `executePatternUpdate` below instead, which carries the transition and
 * returns the accepted transaction's receipt.
 */
async function execute(
  pieces: PiecesController,
  pieceId: string,
  pattern: Pattern,
  input?: object,
  options?: {
    start?: boolean;
    expectedPatternIdentity?: { identity: string; symbol: string };
  },
): Promise<Cell<unknown>> {
  return await pieces.runWithPattern(pattern, pieceId, input, options);
}

/**
 * Helper for `setPattern()`, which returns the accepted setup transaction's
 * receipt in addition to the reconciled cell view.
 */
async function executePatternUpdate(
  pieces: PiecesController,
  pieceId: string,
  pattern: Pattern,
  input: object | undefined,
  options: {
    expectedPatternIdentity: { identity: string; symbol: string };
    validateCurrentArgument?: (argumentCell: Cell<unknown>) => void;
    validateArgumentLinks?: (
      argumentCell: Cell<unknown>,
      argumentSchema: JSONSchema,
    ) => void;
    repository?: string;
    sourceTransition: PieceSourceTransition;
    served?: { actingUser: string };
  },
): Promise<{
  cell: Cell<unknown>;
  commit: PatternSetupCommitReceipt;
}> {
  return await pieces.runPatternUpdate(
    pattern,
    pieceId,
    input,
    options,
  );
}
