import type { FabricValue } from "@commonfabric/api";
import {
  cloneIfNecessary,
  deepFreeze,
  isDeepFrozen,
  isFabricPlainContainer,
  valueEqual,
} from "@commonfabric/data-model";
import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";
import {
  canResolveScopeKey,
  type CommitPrecondition,
  getCommitPreconditionsConfig,
  type PatchOp,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  type SqliteOperation,
} from "@commonfabric/memory/v2";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { getLogger } from "@commonfabric/utils/logger";
import { PathKeyMap } from "@commonfabric/utils/path-key-map";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { readStatsActive, recordDocumentRead } from "../read-stats.ts";
import {
  patchOpIsStructural,
  patchOpPointerFields,
} from "../../../memory/v2/patch.ts";
import {
  encodePointer,
  parsePointer,
  pathsOverlap,
} from "../../../memory/v2/path.ts";
import type { CellScope } from "../builder/types.ts";
import { normalizeCellScope } from "../scope.ts";
import { getCommitSeq } from "./commit-identity.ts";
import type {
  Activity,
  ChangeGroup,
  CommitError,
  IAttestation,
  IMemoryAddress,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadActivity,
  IReadOptions,
  IStorageManager,
  IStorageTransaction,
  IStorageTransactionInconsistent,
  ITransactionJournal,
  ITransactionSealSink,
  ITransactionWriteRequest,
  IWriteAttempt,
  IWriteOptions,
  MediaType,
  MemorySpace,
  NativeStorageCommit,
  NativeStorageCommitOperation,
  ReadError,
  Result,
  StorageTransactionFailed,
  StorageTransactionRejected,
  StorageTransactionStatus,
  TransactionCommitOptions,
  TransactionReactivityLog,
  TransactionReadDetail,
  TransactionWriteDetail,
  Unit,
  URI,
  WriteError,
  WriterError,
} from "./interface.ts";
import { createReadOnlyTransactionError } from "./interface.ts";
import {
  assertLocalReadAvailable,
  releaseLocalReadBasis,
  usesLocalReads,
  validateLocalReadBasis,
} from "./local-read-policy.ts";
import {
  buildMergeableIntent,
  foldMergeableIntent,
  isNoopMergeableDelta,
  type MergeableBuildContext,
  type MergeableOpDelta,
  type MergeableOpIntent,
  mergeableOpPayloadContains,
  type OpSuppression,
} from "./mergeable-ops.ts";
import {
  getBlindStructuralTarget,
  ignoreReadForCommit,
  isDurableReadTx,
  isInternalVerifierRead,
  isMutableTransactionReadAllowed,
  isReadIgnoredForScheduling,
  isReadMarkedAsAttemptedWrite,
  isUiInputBlindWriteTx,
  pendingWriteElisionRead,
  registerCommitRejectionListener,
  stableInternalVerifierRead,
  takeCoverageWaits,
} from "./reactivity-log.ts";
import {
  ReadOnlyAddressError,
  TransactionAborted,
  TransactionCompleteError,
  WriteIsolationError,
} from "./transaction-errors.ts";
import {
  claim,
  load as loadInline,
  read as readAttestation,
  StateInconsistency,
} from "./transaction/attestation.ts";
import {
  applyMutablePathWrite,
  getValueTypeName,
  isContainerValue,
} from "./transaction/mutable-path-write.ts";
import { toTransactionDocumentValue } from "./v2-document.ts";
import { hasValueAtPath, readValueAtPath } from "./v2-path.ts";
import { recordWriteStackTrace } from "./write-stack-trace.ts";

type RootAttestation = IAttestation;

const DOCUMENT_MIME = "application/json" as const;

/**
 * A root this transaction replaced, and the epoch it stood until.
 *
 * `root` is the document's value for every read epoch at or below `until`; the
 * write that moved the epoch past `until` is the one that displaced it.
 */
type DisplacedRoot = {
  until: number;
  root: RootAttestation;
};

type ReadDocumentEntry = {
  initial: RootAttestation;
  validated: boolean;
  current?: RootAttestation;
  frozenReads?: PathKeyMap<FabricValue | undefined>;
  writeDetails?: Map<string, TransactionWriteDetail>;
  patchDetails?: Map<string, TransactionWriteDetail>;
  // Oldest first, and only for epochs a reader was actually handed. Absent on
  // the overwhelming majority of documents: one is created the first time a
  // write displaces a root some materialized read may still describe.
  displaced?: DisplacedRoot[];
};

type WritableDocumentEntry = {
  initial: RootAttestation;
  current: RootAttestation;
  validated: boolean;
  frozenReads: PathKeyMap<FabricValue | undefined>;
  writeDetails: Map<string, TransactionWriteDetail>;
  patchDetails: Map<string, TransactionWriteDetail>;
  displaced?: DisplacedRoot[];
  // Mergeable-write intents recorded by recordMergeableOp, keyed by document
  // path. The commit emits these as the corresponding mergeable op (which the
  // server resolves against durable state) instead of a value diffed against a
  // possibly-stale base, and drops the op's path from the commit's conflict read
  // set. See ./mergeable-ops.ts.
  mergeableOps?: Map<string, MergeableOpIntent>;
  // Paths where a mergeable intent cannot faithfully carry the transaction's
  // local change — a second mergeable op of a different kind was recorded, a
  // foreign write (a reshape such as sort/splice, or a whole-value set at or
  // above the path) rewrote the array after an op was recorded, or the
  // commit-time builder abandoned the intent because it no longer described the
  // local value. Such a path abandons the mergeable fast path and commits the
  // whole-array diff, which reflects the correct combined local value. Once
  // poisoned a path stays poisoned for the rest of the transaction, so a later
  // op does not resurrect a partial intent. Keyed like mergeableOps.
  mergeableOpsPoisoned?: Set<string>;
};

type DocumentEntry = ReadDocumentEntry | WritableDocumentEntry;

type SpaceBranch = {
  space: MemorySpace;
  replica: ReturnType<IStorageManager["open"]>["replica"];
  docs: Map<string, DocumentEntry>;
};

type ReadyState = {
  status: "ready";
};

type PendingState = {
  status: "pending";
  promise: Promise<Result<Unit, StorageTransactionRejected>>;
};

type DoneState = {
  status: "done";
  result: Result<Unit, StorageTransactionFailed>;
};

type TxState = ReadyState | DoneState | PendingState;

const logger = getLogger("storage.v2.transaction", {
  enabled: false,
  level: "error",
});

const createOnlyMarkKey = (
  id: string,
  scope?: unknown,
): string => `${normalizeCellScope(scope as CellScope | undefined)}\0${id}`;

// Enabled so cross-space partial-commit failures (no rollback) are visible.
const multiSpaceCommitLogger = getLogger("storage.v2.multi-space-commit", {
  enabled: true,
  level: "error",
});

const toStoreError = (error: unknown): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: "StoreError" as const,
    message,
    cause: { name: "StoreError", message },
  };
};

function withCommitTiming<T>(
  keys: string[],
  fn: () => T,
): T {
  logger.timeStart(...keys);
  try {
    return fn();
  } finally {
    logger.timeEnd(...keys);
  }
}

const currentDocument = (doc: DocumentEntry): RootAttestation =>
  doc.current ?? doc.initial;

/**
 * The root a read at `epoch` describes.
 *
 * The displaced roots are oldest first and short — one per epoch actually
 * handed to a reader — so the first one still standing at `epoch` is the
 * answer. Falling off the end means no write has displaced anything this
 * reader could still be describing, which is the ordinary case.
 */
const documentAtEpoch = (
  doc: DocumentEntry,
  epoch: number,
): RootAttestation => {
  const displaced = doc.displaced;
  if (displaced !== undefined) {
    for (let index = 0; index < displaced.length; index++) {
      if (displaced[index].until >= epoch) return displaced[index].root;
    }
  }
  return doc.current ?? doc.initial;
};

const isWritableDocument = (
  doc: DocumentEntry,
): doc is WritableDocumentEntry =>
  doc.current !== undefined &&
  doc.frozenReads !== undefined &&
  doc.writeDetails !== undefined &&
  doc.patchDetails !== undefined;

const ensureWritableDocument = (
  doc: DocumentEntry,
): WritableDocumentEntry => {
  if (isWritableDocument(doc)) {
    return doc;
  }
  doc.current = doc.initial;
  doc.frozenReads = new PathKeyMap();
  doc.writeDetails = new Map();
  doc.patchDetails = new Map();
  return doc as WritableDocumentEntry;
};

/**
 * Drops `doc.frozenReads` entries on the chain of `writtenPath` -- both
 * ancestors (whose containers were rebuilt by `applyMutablePathWrite()`)
 * and descendants (the subtree at the write target is gone). Sibling
 * subtrees off divergent ancestors are preserved: structural sharing
 * leaves their values reference-identical to the consumer's cached
 * snapshot.
 *
 * Additionally drops the synthetic `<parent>/length` sibling: writing to
 * `array[N]` can change `array.length`, and that pointer is a true sibling
 * of `array[N]` in the trie (not on its chain), so it needs its own
 * targeted invalidation.
 *
 * Both operations are O(D) in `writtenPath.length` thanks to the
 * `PathKeyMap` tree-walk -- no per-cache-entry sweep.
 */
const invalidateFrozenReadsOnChain = (
  doc: WritableDocumentEntry,
  writtenPath: readonly string[],
): void => {
  const map = doc.frozenReads;
  map.invalidateChain(writtenPath);
  // The chain walk already cleared every ancestor's value AND dropped the
  // subtree at `writtenPath`. Now also drop the parent's `length` child for
  // the JS-array-index case. For a root write this is a no-op; the chain
  // walk already cleared everything.
  if (writtenPath.length > 0) {
    const parent = writtenPath.slice(0, -1);
    map.invalidateChain([...parent, "length"]);
  }
};

const freezeReadValue = <T extends FabricValue | undefined>(value: T): T => {
  if (!isObjectOrArray(value)) {
    return value;
  }
  // What isolates a read from later mutation of its source is frozen-ness,
  // and `isDeepFrozen()` answers that question alone: a deep-frozen value
  // goes back by identity, and anything else is deep-cloned and frozen by
  // `cloneIfNecessary()`.
  //
  // `cloneIfNecessary()` decides its own identity fast path with
  // `isValidDeepFrozenFabricValue()`, which conjoins the frozen-ness question
  // with a membership walk of every node in the value. That walk is uncached,
  // so the first read of a stored document runs it in full, and for a list it
  // costs several times what the rest of the read does. Membership is settled
  // before a value reaches the replica: the write paths below hand every value
  // to `cloneIfNecessary()`, which either accepts it as a deep-frozen
  // `FabricValue` or rebuilds it as one.
  return (isDeepFrozen(value) ? value : cloneIfNecessary(value)) as T;
};

const collapseEmptyJsonDocumentEnvelope = (
  value: FabricValue | undefined,
): FabricValue | undefined => {
  if (
    value === undefined ||
    !isObjectNotArray(value) ||
    Object.keys(value).length > 0
  ) {
    return value;
  }
  return undefined;
};

const EMPTY_META = Object.freeze({});

type PathInspection =
  | {
    kind: "ok";
    value: FabricValue | undefined;
  }
  | {
    kind: "notFound";
    path: readonly string[];
  }
  | {
    kind: "typeMismatch";
    path: readonly string[];
    actualType: string;
  };

const inspectPath = (
  value: FabricValue | undefined,
  path: readonly string[],
): PathInspection => {
  if (path.length === 0) {
    return { kind: "ok", value };
  }

  let current: unknown = value;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;

    if (current === undefined) {
      return {
        kind: "notFound",
        path: path.slice(0, index),
      };
    }

    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      if (!isArrayIndexPropertyName(segment)) {
        return {
          kind: "typeMismatch",
          path: path.slice(0, index + 1),
          actualType: "array",
        };
      }
      current = current[Number(segment)];
      continue;
    }

    if (isObjectOrArray(current)) {
      current = current[segment];
      continue;
    }

    return {
      kind: "typeMismatch",
      path: path.slice(0, index + 1),
      actualType: getValueTypeName(current as FabricValue | undefined),
    };
  }

  return {
    kind: "ok",
    value: current as FabricValue | undefined,
  };
};

const findMaterializedParentPath = (
  currentRoot: FabricValue | undefined,
  path: readonly string[],
  isDelete: boolean,
): readonly string[] | undefined => {
  // Deletes never materialize intermediates; value writes (including
  // explicit `undefined`) do.
  if (isDelete) {
    return undefined;
  }

  // A write into a not-yet-initialized doc value materializes the entire
  // value at the root: that's the observable change, regardless of how
  // deep the leaf write is. (`path.length === 0` is the "we ARE the
  // root" case — there's no distinct materialization point, fall back
  // to the leaf via the caller.)
  if (currentRoot === undefined) {
    return path.length === 0 ? undefined : [];
  }

  if (path.length <= 1) {
    return undefined;
  }

  if (!isContainerValue(currentRoot)) {
    return undefined;
  }

  let current = currentRoot as Record<string, FabricValue> | FabricValue[];
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;

    if (Array.isArray(current)) {
      if (key === "length" || !isArrayIndexPropertyName(key)) {
        return undefined;
      }
      const next = current[Number(key)];
      if (next === undefined) {
        return path.slice(0, index);
      }
      if (!isContainerValue(next)) {
        return undefined;
      }
      current = next;
      continue;
    }

    const next = current[key];
    if (next === undefined) {
      return path.slice(0, index);
    }
    if (!isContainerValue(next)) {
      return undefined;
    }
    current = next;
  }

  return undefined;
};

type PatchDraftCandidate = {
  patch: PatchOp;
  path: readonly string[];
  coversDescendants: boolean;
  tailSpliceStartIndex?: number;
};

const findDeepestArrayPath = (
  before: FabricValue | undefined,
  after: FabricValue | undefined,
  path: readonly string[],
): readonly string[] | null => {
  let deepestArrayPath: readonly string[] | null = null;

  for (let index = 0; index < path.length; index += 1) {
    const prefix = path.slice(0, index);
    const beforeValue = readValueAtPath(before, prefix, {
      allowArrayLength: true,
    });
    const afterValue = readValueAtPath(after, prefix, {
      allowArrayLength: true,
    });
    if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
      deepestArrayPath = prefix;
    }
  }

  if (deepestArrayPath) {
    return deepestArrayPath;
  }

  const firstArrayLikeSegment = path.findIndex((segment) =>
    segment === "length" || isArrayIndexPropertyName(segment)
  );
  return firstArrayLikeSegment === -1
    ? null
    : path.slice(0, firstArrayLikeSegment);
};

/**
 * Builds a patch op from before/after state at `path`. Presence (slot
 * exists) is distinct from value: a slot holding `undefined` is present,
 * so add/remove are chosen from presence transitions, and a stored
 * `undefined` travels as a `replace`/`add` whose value is `undefined`.
 * When presence flags are omitted they are inferred from value
 * definedness (legacy callers in the array fast-path, where presence
 * parity was already established via `in` checks).
 */
const buildValuePatchCandidate = (
  path: readonly string[],
  value: FabricValue | undefined,
  previousValue: FabricValue | undefined,
  valuePresent: boolean = value !== undefined,
  previousPresent: boolean = previousValue !== undefined,
): PatchDraftCandidate | null => {
  if (valuePresent === previousPresent && valueEqual(value, previousValue)) {
    return null;
  }

  const pointer = encodePointer(path);
  if (!valuePresent) {
    if (!previousPresent) {
      return null;
    }
    return {
      patch: { op: "remove", path: pointer },
      path,
      coversDescendants: true,
    };
  }
  if (!previousPresent) {
    return {
      patch: { op: "add", path: pointer, value },
      path,
      coversDescendants: true,
    };
  }
  return {
    patch: { op: "replace", path: pointer, value },
    path,
    coversDescendants: true,
  };
};

const arrayTailIsDense = (
  value: readonly FabricValue[],
  start: number,
): boolean => {
  for (let index = start; index < value.length; index += 1) {
    if (!(index in value)) {
      return false;
    }
  }
  return true;
};

const buildArrayPatchCandidates = (
  path: readonly string[],
  before: FabricValue | undefined,
  after: FabricValue | undefined,
  beforePresent: boolean = before !== undefined,
  afterPresent: boolean = after !== undefined,
): PatchDraftCandidate[] => {
  if (beforePresent === afterPresent && valueEqual(before, after)) {
    return [];
  }

  if (!Array.isArray(before) || !Array.isArray(after)) {
    const candidate = buildValuePatchCandidate(
      path,
      after,
      before,
      afterPresent,
      beforePresent,
    );
    return candidate ? [candidate] : [];
  }

  // Both sides are arrays from here on, so the array slot itself is present
  // in both states; fallbacks below replace the whole array.
  const overlappingLength = Math.min(before.length, after.length);
  for (let index = 0; index < overlappingLength; index += 1) {
    if ((index in before) !== (index in after)) {
      const fallback = buildValuePatchCandidate(
        path,
        after,
        before,
        true,
        true,
      );
      return fallback ? [fallback] : [];
    }
  }

  if (after.length > before.length && !arrayTailIsDense(after, before.length)) {
    const fallback = buildValuePatchCandidate(path, after, before, true, true);
    return fallback ? [fallback] : [];
  }

  const candidates: PatchDraftCandidate[] = [];
  for (let index = 0; index < overlappingLength; index += 1) {
    if (!(index in before)) {
      continue;
    }

    const nextValue = after[index] as FabricValue | undefined;
    const previousValue = before[index] as FabricValue | undefined;
    if (valueEqual(nextValue, previousValue)) {
      continue;
    }

    candidates.push({
      patch: {
        op: "replace",
        path: encodePointer([...path, index.toString()]),
        value: nextValue,
      },
      path: [...path, index.toString()],
      coversDescendants: true,
    });
  }

  if (after.length > before.length) {
    candidates.push({
      patch: {
        op: "splice",
        path: encodePointer(path),
        index: before.length,
        remove: 0,
        add: after.slice(before.length),
      },
      path,
      coversDescendants: false,
      tailSpliceStartIndex: before.length,
    });
  } else if (after.length < before.length) {
    candidates.push({
      patch: {
        op: "splice",
        path: encodePointer(path),
        index: after.length,
        remove: before.length - after.length,
        add: [],
      },
      path,
      coversDescendants: false,
      tailSpliceStartIndex: after.length,
    });
  }

  if (candidates.length === 0) {
    const fallback = buildValuePatchCandidate(path, after, before, true, true);
    return fallback ? [fallback] : [];
  }

  return candidates;
};

// A concrete RFC 6901 array-index segment: a non-negative integer with no
// leading zeros. Mirrors `isArraySegment` in memory/v2/patch.ts. The `-` append
// marker is intentionally NOT an index — appending never shifts existing
// elements, so a leaf-only matcher handles it conservatively via the array path.
const ARRAY_INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

const terminalSegmentIsArrayIndex = (pointer: string): boolean => {
  const segments = parsePointer(pointer);
  const last = segments[segments.length - 1];
  return last !== undefined && ARRAY_INDEX_SEGMENT.test(last);
};

// Generator invariant guard (see docs/specs/memory-v2/08-conflict-granularity.md
// §"Array writes and the leaf-only matcher"). The commit-conflict matcher and
// the scheduler reader-dirty index are both LEAF-ONLY, which is sound only if
// array element insert/remove/reorder reaches the engine as a `splice` on the
// array path or a whole-array `replace` — never as a STRUCTURAL op (add / remove
// / move, per the wire-op registry) at an array INDEX. Such an op SHIFTS sibling
// elements, but its leaf path captures only the touched index, so a leaf-only
// matcher would neither conflict (commit) nor re-trigger (reader-dirty) a reader
// of a shifted sibling — a silent stale read. `buildArrayPatchCandidates` only
// ever emits per-index `replace`, array-path `splice`, or whole-array `replace`,
// so this assertion can never fire for real input; it converts a future
// regression in the array diff path into a loud failure instead of silent data
// loss. (A numeric *object* key is flagged too — the generator never emits a
// structural op on one either.)
//
// The op set and pointer fields checked come from the registry
// (`patchOpIsStructural` / `patchOpPointerFields`), so a new structural op is
// covered here automatically rather than escaping a hardcoded list.
//
// Exported for direct unit testing: the throw and `move` paths are unreachable
// through the generator (which is the invariant), so they can only be exercised
// by calling this with hand-built patches.
export const assertNoIndexedArrayStructuralOps = (
  patches: readonly PatchOp[],
): void => {
  for (const patch of patches) {
    if (!patchOpIsStructural(patch)) {
      continue;
    }
    const pointers = patchOpPointerFields(patch).map((field) =>
      (patch as unknown as Record<string, string>)[field]
    );
    if (!pointers.some(terminalSegmentIsArrayIndex)) {
      continue;
    }
    throw new Error(
      `v2 patch generator invariant violation: emitted an indexed-array ` +
        `${patch.op} (${pointers.join(" -> ")}). Array element ` +
        `insert/remove/reorder must be a splice on the array path or a ` +
        `whole-array replace; an indexed add/remove/move shifts siblings that ` +
        `the leaf-only conflict and reader-dirty matchers cannot track (see ` +
        `docs/specs/memory-v2/08-conflict-granularity.md).`,
    );
  }
};

const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => prefix.length <= path.length && pathsOverlap(prefix, path);

const isSubsumedByTailSplice = (
  spliceCandidate: PatchDraftCandidate,
  candidatePath: readonly string[],
): boolean => {
  if (spliceCandidate.tailSpliceStartIndex === undefined) {
    return false;
  }
  if (
    !isPrefixPath(spliceCandidate.path, candidatePath) ||
    candidatePath.length <= spliceCandidate.path.length
  ) {
    return false;
  }
  const childSegment = candidatePath[spliceCandidate.path.length];
  return childSegment !== undefined &&
    isArrayIndexPropertyName(childSegment) &&
    Number(childSegment) >= spliceCandidate.tailSpliceStartIndex;
};

// A `FabricSpecialObject` on either side falls to the `valueEqual` comparison
// below rather than being compared by key set: its state sits behind no key,
// so two distinct ones would compare by their empty key sets and report
// "unchanged", leaving an in-place fabric change at an ancestor prefix with no
// reactivity path. `differential.ts` guards its sibling walk the same way.
//
// That covers a `FabricInstance` too. `buildReactivityPathsForChange` calls
// this with the value at every proper ancestor prefix of a written path, read
// from the document as it stood when the transaction opened, so a write
// anywhere below a stored `FabricError` arrives here at commit time.
const shallowStructureChanged = (
  before: FabricValue | undefined,
  after: FabricValue | undefined,
): boolean => {
  if (isFabricPlainContainer(before) && isFabricPlainContainer(after)) {
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (beforeKeys.length !== afterKeys.length) {
      return true;
    }
    if (Array.isArray(before) !== Array.isArray(after)) {
      return true;
    }
    if (Array.isArray(before) && before.length !== after.length) {
      return true;
    }
    return !beforeKeys.every((key) => Object.hasOwn(after, key));
  }

  return !valueEqual(before, after);
};

const compareDocPaths = (
  left: readonly string[],
  right: readonly string[],
): number => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }

  const leftPointer = encodePointer(left);
  const rightPointer = encodePointer(right);
  return leftPointer < rightPointer ? -1 : leftPointer > rightPointer ? 1 : 0;
};

const buildReactivityPathsForChange = (
  beforeRoot: FabricValue | undefined,
  afterRoot: FabricValue | undefined,
  path: readonly string[],
): readonly (readonly string[])[] => {
  const beforeValue = readValueAtPath(beforeRoot, path, {
    allowArrayLength: true,
  });
  const afterValue = readValueAtPath(afterRoot, path, {
    allowArrayLength: true,
  });
  if (valueEqual(beforeValue, afterValue)) {
    return [];
  }

  const paths = new Map<string, readonly string[]>();
  if (path.length === 0) {
    paths.set("", []);
    return [...paths.values()];
  }

  for (let prefixLength = 1; prefixLength < path.length; prefixLength += 1) {
    const prefix = path.slice(0, prefixLength);
    if (
      !shallowStructureChanged(
        readValueAtPath(beforeRoot, prefix, {
          allowArrayLength: true,
        }),
        readValueAtPath(afterRoot, prefix, {
          allowArrayLength: true,
        }),
      )
    ) {
      continue;
    }
    paths.set(encodePointer(prefix), prefix);
  }

  paths.set(encodePointer(path), path);
  return [...paths.values()].sort(compareDocPaths);
};

class V2TransactionJournal implements ITransactionJournal {
  readonly #tx: V2StorageTransaction;

  constructor(tx: V2StorageTransaction) {
    this.#tx = tx;
  }

  activity(): Iterable<Activity> {
    throw new Error(
      "V2 transactions do not support journal.activity(); " +
        "use getReadActivities(), getReactivityLog(), or getWriteDetails().",
    );
  }

  novelty(space: MemorySpace): Iterable<IAttestation> {
    return (function* (tx: V2StorageTransaction) {
      for (const detail of tx.getWriteDetails(space) ?? []) {
        yield {
          address: {
            id: detail.address.id,
            path: detail.address.path,
          },
          value: detail.value,
        };
      }
    })(this.#tx);
  }

  history(space: MemorySpace): Iterable<IAttestation> {
    return (function* (tx: V2StorageTransaction) {
      for (const detail of tx.getWriteDetails(space) ?? []) {
        yield {
          address: {
            id: detail.address.id,
            path: detail.address.path,
          },
          value: detail.previousValue,
        };
      }
    })(this.#tx);
  }
}

export class V2StorageTransaction implements IStorageTransaction {
  changeGroup?: ChangeGroup;
  immediate?: boolean;

  /**
   * The scope INSTANCE identity this transaction's scoped reads and
   * writes resolve against (IStorageTransaction.scopeKeyIdentity —
   * server-execution v2 stage A, OW17's tx→replica identity seam). Set
   * ONCE by the wave run stamp before the first read; a later different
   * value throws, and a change after a document was loaded throws too:
   * the transaction's document cache is name-keyed, so one transaction
   * serves exactly one identity (the runner mints one per instance run).
   */
  get scopeKeyIdentity(): ScopeKeyIdentity | undefined {
    return this.#scopeKeyIdentity;
  }

  set scopeKeyIdentity(identity: ScopeKeyIdentity | undefined) {
    if (identity === undefined) return;
    const current = this.#scopeKeyIdentity;
    if (current !== undefined) {
      if (
        current.principal !== identity.principal ||
        current.sessionId !== identity.sessionId
      ) {
        throw new Error(
          "storage transaction already carries a different scope-key " +
            "identity: one transaction serves one identity (server-execution " +
            "v2 stage A, OW17's tx→replica seam — mint one transaction per " +
            "instance run)",
        );
      }
      return;
    }
    if (this.#loadedUnderIdentity) {
      throw new Error(
        "storage transaction already loaded documents under the storage " +
          "manager's own identity; a scope-key identity must be set before " +
          "the first read (server-execution v2 stage A, OW17's tx→replica " +
          "seam)",
      );
    }
    this.#scopeKeyIdentity = identity;
  }
  #scopeKeyIdentity: ScopeKeyIdentity | undefined;
  #loadedUnderIdentity = false;

  readonly journal = new V2TransactionJournal(this);

  #state: TxState = { status: "ready" };

  /**
   * The commit's fate — server verdict or local rejection — which `commit()`
   * itself may resolve later than: `commit()` additionally waits for the
   * subscribed view to reflect the committed write. Post-commit effects gated
   * on durability alone hook this via `commitVerdict()`. Resolved with the same
   * result `commit()` returns.
   */
  readonly #verdict = Promise.withResolvers<Result<Unit, CommitError>>();

  #branches = new Map<MemorySpace, SpaceBranch>();
  #readActivities: IReadActivity[] = [];
  #potentiallyExternalReadActivities: IReadActivity[] = [];

  /**
   * Per-transaction monotonic activity clock, shared between read activities
   * and write attempts so their relative order (the read/write interleaving) is
   * recoverable without a journal scan — V2 journals don't support
   * `activity()`. Stamped at the two record points: the `read()` activity push
   * and `#recordPatchIntent()`. Consumed by CFC write-prefix provenance
   * (`docs/specs/cfc-write-prefix-provenance.md` §4/§6).
   */
  #activityClock = 0;

  /**
   * How many times this transaction has replaced a document root. A read taken
   * at epoch E describes the state after E replacements, which is what lets a
   * materialized read keep answering for the moment it was taken while the
   * reader goes on writing. Zero writes means every document still stands at
   * its `initial` attestation, so every epoch describes the same state and
   * nothing below has to run.
   */
  #writeEpoch = 0;

  /**
   * The epoch reads resolve against while a materialized read is walking, or
   * `undefined` for the transaction's current state.
   */
  #readEpoch: number | undefined;

  /**
   * The newest epoch handed to a reader, or `undefined` where none has been. A
   * replacement keeps the root it displaces only when a reader could still ask
   * for it, and this is what decides that.
   */
  #lastIssuedEpoch: number | undefined;

  #writeAttemptLog: IWriteAttempt[] = [];
  #reactivityLogCache?: TransactionReactivityLog;
  #commitPreconditions = new Map<MemorySpace, CommitPrecondition[]>();
  #createOnlyMarks = new Map<
    MemorySpace,
    Map<string, { id: string; scope: CellScope }>
  >();

  /**
   * Folded SQLite write ops per space, applied in the same commit as cell ops.
   */
  #sqliteOps = new Map<MemorySpace, SqliteOperation[]>();

  #writeSpace?: MemorySpace;

  /**
   * Whether multi-space writes are enabled (see `enableMultiSpaceWrites()`).
   * When disabled the transaction rejects writes to a second space; when
   * enabled `commit()` splits into one per-space commit.
   */
  #multiSpaceWrites = false;

  /**
   * Whether authoritative-writes mode is on (see
   * `IStorageTransaction.markAuthoritativeWrites()` and the rationale there):
   * value writes are recorded and committed even when equal to the
   * currently-visible state — the no-op elision in
   * `#writeWithinBranch()`/`#writeBatchRun()` yields, the doc-level elision
   * in `getNativeCommit()` yields, and the commit is emitted as a _whole-doc_
   * set/delete rather than patches (a patch base extrapolated over a doomed
   * sealed overlay can name ancestors durable state never had, and `replace`
   * cannot create them). Set by effect-completion writebacks under the serving
   * posture; one-way.
   */
  #authoritativeWrites = false;

  /**
   * Whether whole-document-writes mode is on (see
   * `IStorageTransaction.markWholeDocumentWrites()`): the emission half of
   * authoritative mode on its own — set/delete rather than patches and
   * mergeable ops — with the no-op elision left in place. Set by the client
   * speculation overlay's seal, whose entries layer their ops over a confirmed
   * value that moves under them. One-way.
   */
  #wholeDocumentWrites = false;

  #commitOrder?: readonly MemorySpace[];

  /**
   * Spaces written to, in first-write order. Used as the default commit order.
   */
  #writtenSpaces: MemorySpace[] = [];

  #readOnlySource?: string;
  #lastDocument?: {
    branch: SpaceBranch;
    id: URI;
    type: MediaType;
    scope: CellScope;
    doc: DocumentEntry;
  };

  /**
   * Complete the transaction, keeping its result and releasing the state that
   * only an open transaction needs: the materialized branches, the read and
   * write activity, and the cached reactivity log. Those are consumed while
   * the transaction is open — the scheduler takes the reactivity log when the
   * action that opened the transaction finishes, and the commit path takes the
   * write details before the result is known. Whatever holds a completed
   * transaction afterwards, such as a cell bound to it or a cleanup closure
   * that captured it, would otherwise also hold every address that
   * transaction read.
   *
   * Only a commit that ran ends here. A transaction that never reached storage
   * — aborted, or rejected by validation — keeps its activity, because the
   * scheduler retries the action that opened it and re-establishes that
   * action's dependencies from those reads.
   */
  #finish(result: Result<Unit, StorageTransactionFailed>): void {
    // A rejected scheduler attempt retains eligibility that expired while its
    // commit waited, so finalization can stop a retry and release the basis.
    if (
      (this as IStorageTransaction).sourceAction === undefined ||
      result.error === undefined || validateLocalReadBasis(this) === undefined
    ) {
      releaseLocalReadBasis(this);
    }
    this.#state = { status: "done", result };
    this.#branches.clear();
    this.#readActivities.length = 0;
    this.#potentiallyExternalReadActivities.length = 0;
    this.#writeAttemptLog.length = 0;
    this.#reactivityLogCache = undefined;
    this.#lastDocument = undefined;
  }

  readonly #storage: IStorageManager;

  constructor(storage: IStorageManager) {
    this.#storage = storage;
  }

  setReadOnly(reason = "runtime.readTx()"): void {
    this.#readOnlySource = reason;
  }

  clearReadOnly(): void {
    this.#readOnlySource = undefined;
  }

  isReadOnly(): boolean {
    return this.#readOnlySource !== undefined;
  }

  enableMultiSpaceWrites(order?: readonly MemorySpace[]): void {
    this.#assertWritable("enableMultiSpaceWrites()");
    this.#multiSpaceWrites = true;
    if (order !== undefined) {
      this.#commitOrder = order;
    }
  }

  markAuthoritativeWrites(): void {
    this.#assertWritable("markAuthoritativeWrites()");
    this.#authoritativeWrites = true;
  }

  isAuthoritativeWrites(): boolean {
    return this.#authoritativeWrites;
  }

  markWholeDocumentWrites(): void {
    this.#assertWritable("markWholeDocumentWrites()");
    this.#wholeDocumentWrites = true;
  }

  /** Whether a document's write is emitted as a whole-document set/delete.
   * Authoritative mode implies it; whole-document mode is that half alone. */
  get #emitsWholeDocuments(): boolean {
    return this.#authoritativeWrites || this.#wholeDocumentWrites;
  }

  static create(manager: IStorageManager): IStorageTransaction {
    return new this(manager);
  }

  retainPendingWriteElision(target: IMemorySpaceAddress): void {
    const { space, ...address } = target;
    this.#retainPendingWriteElision(this.#branch(space), space, address);
  }

  isContentAddressedDocPersisted(space: MemorySpace, hash: string): boolean {
    return this.#storage.isContentAddressedDocPersisted?.(space, hash) ?? false;
  }

  status(): StorageTransactionStatus {
    if (this.#state.status === "done") {
      if (this.#state.result.error) {
        return {
          status: "error",
          journal: this.journal,
          error: this.#state.result.error,
        };
      }
      return { status: "done", journal: this.journal };
    }
    if (this.#state.status === "pending") {
      return { status: "pending", journal: this.journal };
    }
    return { status: "ready", journal: this.journal };
  }

  committedSeq(space: MemorySpace): number | undefined {
    return getCommitSeq(this, space);
  }

  getReadActivities(): readonly IReadActivity[] {
    return this.#readActivities;
  }

  /** @inheritDoc */
  getPotentiallyExternalReadActivities(): readonly IReadActivity[] {
    return this.#potentiallyExternalReadActivities;
  }

  getWriteAttemptLog(): readonly IWriteAttempt[] {
    return this.#writeAttemptLog;
  }

  getReactivityLog() {
    this.#reactivityLogCache ??= this.#buildReactivityLog();
    return this.#reactivityLogCache;
  }

  addCommitPrecondition(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void {
    this.#assertWritable("addCommitPrecondition()");
    const ready = this.#editable();
    if (ready.error) {
      throw ready.error;
    }
    // Claim `space` as a write target (sets #writeSpace, enforces single-space
    // write isolation) so a precondition-only commit is still sent and
    // validated instead of resolving ok without a write space.
    const claimed = this.#claimWriteSpace(space);
    if (claimed.error) {
      throw claimed.error;
    }
    const preconditions = this.#commitPreconditions.get(space);
    if (preconditions) {
      preconditions.push(precondition);
    } else {
      this.#commitPreconditions.set(space, [precondition]);
    }
  }

  getCommitPreconditions(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined {
    return this.#commitPreconditions.get(space);
  }

  /**
   * Every precondition `space`'s commit carries: the ones a caller attached
   * and the ones its create-only marks stand for. This is what the commit
   * sends and what the claim check reads to see which documents the server
   * judges for itself, so the two cannot drift apart.
   */
  #commitPreconditionsFor(space: MemorySpace): CommitPrecondition[] {
    const attached = this.#commitPreconditions.get(space);
    const createOnlyMarks = this.#createOnlyMarks.get(space);
    // Most commits pin nothing, and this runs on every one of them.
    if (attached === undefined && createOnlyMarks === undefined) return [];
    return [
      ...(attached ?? []),
      ...[...(createOnlyMarks?.values() ?? [])].map(({ id, scope }) => ({
        kind: "entity-absent" as const,
        id,
        scope,
      })),
    ];
  }

  markCreateOnly(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void {
    this.#assertWritable("markCreateOnly()");
    const ready = this.#editable();
    if (ready.error) {
      throw ready.error;
    }
    const claim = this.#claimWriteSpace(link.space);
    if (claim.error) {
      throw claim.error;
    }
    let marks = this.#createOnlyMarks.get(link.space);
    if (!marks) {
      marks = new Map();
      this.#createOnlyMarks.set(link.space, marks);
    }
    const scope = normalizeCellScope(link.scope as CellScope | undefined);
    marks.set(createOnlyMarkKey(link.id, scope), {
      id: link.id,
      scope,
    });
  }

  /**
   * Records one mergeable-op delta at a path. Which ops exist, whether a delta
   * records nothing, how repeated deltas fold into one intent, and how an
   * intent becomes wire ops are all defined once in `./mergeable-ops.ts` — this
   * method just accumulates, deferring the per-op questions to that registry.
   */
  recordMergeableOp(
    address: IMemorySpaceAddress,
    delta: MergeableOpDelta,
  ): void {
    this.#assertWritable("recordMergeableOp()");
    const ready = this.#editable();
    if (ready.error) throw ready.error;
    if (isNoopMergeableDelta(delta)) {
      return;
    }
    const doc = this.#writableMergeableTarget(address);
    if (!doc) throw new Error(`${delta.op} target is not writable`);
    const pathKey = encodePointer(address.path);
    // A poisoned path has already fallen back to the whole-array diff; a further
    // op does not revive it.
    if (doc.mergeableOpsPoisoned?.has(pathKey)) {
      return;
    }
    const existing = doc.mergeableOps?.get(pathKey);
    // A different mergeable op kind at the same path in one transaction cannot be
    // carried alongside the first: the intent map holds one op per path, so the
    // second would replace the first and the diff-suppression would then drop the
    // first op's element changes from the commit — silent data loss. Poison the
    // path instead so the whole-array diff carries both changes.
    if (existing !== undefined && existing.op !== delta.op) {
      doc.mergeableOps?.delete(pathKey);
      (doc.mergeableOpsPoisoned ??= new Set()).add(pathKey);
      return;
    }
    doc.mergeableOps ??= new Map();
    doc.mergeableOps.set(
      pathKey,
      foldMergeableIntent(existing, address.path, delta),
    );
  }

  /**
   * Abandons the mergeable fast path for `address`: a foreign write (a reshape
   * that is not itself a mergeable op) has rewritten the array after an op was
   * recorded, so the recorded tail no longer identifies the appended elements.
   * Drops any covered intent and marks its path poisoned so the commit emits
   * the whole-array diff (the correct local value) instead.
   *
   * The reshape reaches every intent _at_ or _beneath_ the written path: a
   * write to an enclosing object (`doc.set({rows})`) rewrites the array inside
   * it just as surely as a write to the array itself, and the intent's recorded
   * tail then spans elements the reshape supplied rather than ones an op
   * appended. Intents _above_ the write are untouched, which is what keeps an
   * element edit (`cell.key(i).set(...)`, a write beneath the array) composing
   * with a push, and leaves a write to a sibling field alone.
   *
   * A path carrying no intent yet is left alone — but that is not a statement
   * that a reshape before an op is harmless. It is caught later instead, by
   * each builder's own check at commit that its intent still describes the
   * local value (see `./mergeable-ops.ts`). The same goes for an element edit,
   * which is beneath the array and so passes through here untouched: harmless
   * to a tail op, fatal to a remove-by-value, and the builders are what tell
   * them apart.
   */
  poisonMergeableOp(address: IMemorySpaceAddress): void {
    // Only ever called right after a write on this transaction, so the tx is
    // editable — no editable() re-check. The write also made the address's
    // document writable, but a caller could resolve to a different (read-only)
    // slot, so a non-writable target is a real no-op.
    const doc = this.#writableMergeableTarget(address);
    if (!doc?.mergeableOps?.size) {
      return;
    }
    const covered = [...doc.mergeableOps.entries()]
      .filter(([, intent]) => isPrefixPath(address.path, intent.path))
      .map(([pathKey]) => pathKey);
    for (const pathKey of covered) {
      doc.mergeableOps.delete(pathKey);
      (doc.mergeableOpsPoisoned ??= new Set()).add(pathKey);
    }
  }

  /**
   * Returns the writable document entry for `address`, or `undefined` when it
   * is not writable. The caller wrote through this same transaction, so the
   * entry is writable; a missing writable entry is an invariant violation the
   * record methods throw on rather than silently dropping the operation.
   */
  #writableMergeableTarget(
    address: IMemorySpaceAddress,
  ): WritableDocumentEntry | undefined {
    const branch = this.#branch(address.space);
    const { doc } = this.#document(branch, address);
    return isWritableDocument(doc) ? doc : undefined;
  }

  *getMergeableOpAddresses(): Iterable<IMemorySpaceAddress> {
    for (const [space, branch] of this.#branches.entries()) {
      for (const [key, doc] of branch.docs.entries()) {
        if (!isWritableDocument(doc) || !doc.mergeableOps) {
          continue;
        }
        const { id, scope } = this.#parseDocKey(key);
        for (const intent of doc.mergeableOps.values()) {
          yield { space, id, scope, path: intent.path };
        }
      }
    }
  }

  recordSqliteWrite(space: MemorySpace, op: SqliteOperation): void {
    this.#assertWritable("recordSqliteWrite()");
    const ready = this.#editable();
    if (ready.error) {
      throw ready.error;
    }
    // Claim `space` as a write target (sets #writeSpace, enforces single-space
    // write isolation) so a sqlite-only commit still resolves a write space.
    const claimed = this.#claimWriteSpace(space);
    if (claimed.error) {
      throw claimed.error;
    }
    const existing = this.#sqliteOps.get(space);
    if (existing) {
      existing.push(op);
    } else {
      this.#sqliteOps.set(space, [op]);
    }
  }

  getNativeCommit(space: MemorySpace): NativeStorageCommit | undefined {
    const branch = this.#branches.get(space);
    const nativePreconditions = this.#commitPreconditionsFor(space);
    const sqliteOps = this.#sqliteOps.get(space);
    if (
      !branch &&
      nativePreconditions.length === 0 && !sqliteOps?.length
    ) {
      return undefined;
    }

    const operations: NativeStorageCommitOperation[] = [];
    // Unconfirmed schema documents whose staged write nets to no visible
    // change (#mustDeliverSchemaDoc; the visible copy sits on a layer the
    // wire never carries, such as a client speculation overlay entry).
    // They ride a commit that exports real content — whose references
    // they back — and are dropped from one that exports nothing: a
    // no-op-net transaction ships no references, so re-delivering there
    // would mint a commit, and its exported read set with it, where none
    // existed.
    const redeliveries: NativeStorageCommitOperation[] = [];
    for (const [key, doc] of branch?.docs.entries() ?? []) {
      if (!isWritableDocument(doc)) {
        continue;
      }
      if (doc.writeDetails.size === 0) {
        continue;
      }
      const { id, type, scope } = this.#parseDocKey(key);
      // Doc-level no-op elision — except for authoritative transactions
      // (markAuthoritativeWrites): `doc.initial` is the transaction-START
      // view, which may extrapolate over a DOOMED sealed overlay, so a
      // written doc that "ends where it started" may still differ from
      // the store — the completion asserts it anyway (the forced
      // full-cover path in buildPatchOperation). An unconfirmed schema
      // document steps out to the re-delivery set instead — as a
      // whole-doc set: content addressing makes any visible copy the
      // whole document.
      if (
        !this.#authoritativeWrites &&
        valueEqual(doc.current.value, doc.initial.value)
      ) {
        if (
          this.#mustDeliverSchemaDoc(space, id) &&
          doc.current.value !== undefined
        ) {
          redeliveries.push({
            op: "set",
            id,
            type,
            scope,
            value: doc.current.value,
          });
        }
        continue;
      }
      // Authoritative transactions (markAuthoritativeWrites —
      // effect-completion writebacks under the serving posture) commit
      // WHOLE-DOC set/delete, never patches (round-2 thread 17): their
      // patch base (`doc.initial`) is the tx-start OPTIMISTIC view,
      // which can extrapolate over a DOOMED sealed overlay — including
      // ancestors the overlay CREATED that durable state never had. A
      // patch op against such a base fails engine-side with
      // "missing path" (`replace` upserts only the terminal member),
      // rejecting the completion commit; the retry re-reads the same
      // poisoned view and burns its budget deterministically, wedging
      // the claim (the F2 wedge through a different crack). The
      // whole-doc set is the always-applicable full-cover assert — the
      // earlier per-path forced-assert machinery this replaces could
      // not create missing ancestors. Footprint: completion docs are
      // the builtins' own result/pending/error/internal cells (one doc
      // each, builtin-owned); completions already carry basisSeq=NOW
      // (no per-doc CAS — the hash guards arbitrate), so doc-level
      // last-writer-wins is the ruled posture, not a widening. The
      // mergeable fast path is skipped too: folding a mergeable op with
      // a whole-doc set would apply its delta twice. A completion
      // writeback can record one — llm-dialog's marked update pushes
      // onto the message list — so the intents it recorded are
      // abandoned below with the ops they would have produced.
      //
      // A whole-document transaction (markWholeDocumentWrites — the
      // client speculation overlay's seal) takes the same emission,
      // for the reason on that declaration.
      if (!this.#emitsWholeDocuments) {
        const mergeable = this.#buildMergeableOps(doc);
        const patch = this.#buildPatchOperation(
          id,
          type,
          scope,
          doc,
          mergeable.suppress,
        );
        if (mergeable.ops.length > 0) {
          // Emit the mergeable ops even when there is no base to diff against
          // (where buildPatchOperation returns null) so a stale-base write lands
          // against durable state instead of clobbering it with a whole-value
          // `set`.
          const basePatches = patch?.op === "patch" ? patch.patches : [];
          operations.push({
            op: "patch",
            id,
            type,
            scope,
            patches: [...mergeable.ops, ...basePatches],
            value: doc.current.value,
          });
          continue;
        }
        if (patch) {
          operations.push(patch);
          continue;
        }
      } else {
        this.#abandonMergeableOps(doc);
      }

      operations.push(
        doc.current.value === undefined ? { op: "delete", id, type, scope } : {
          op: "set",
          id,
          type,
          scope,
          value: doc.current.value,
        },
      );
    }

    if (
      redeliveries.length > 0 && (operations.length > 0 || sqliteOps?.length)
    ) {
      operations.push(...redeliveries);
    }

    return {
      operations,
      ...(nativePreconditions.length
        ? { preconditions: nativePreconditions }
        : {}),
      ...(sqliteOps?.length ? { sqliteOps: [...sqliteOps] } : {}),
    };
  }

  *getWriteDetails(space: MemorySpace): Iterable<TransactionWriteDetail> {
    const branch = this.#branches.get(space);
    if (!branch) {
      return;
    }
    for (const entry of branch.docs.values()) {
      if (!isWritableDocument(entry)) {
        continue;
      }
      yield* entry.writeDetails.values();
    }
  }

  *getWriteDetailsForTarget(target: {
    space: MemorySpace;
    id: URI;
    scope?: CellScope;
    path?: readonly PropertyKey[];
  }): Iterable<TransactionWriteDetail> {
    const branch = this.#branches.get(target.space);
    const entry = branch?.docs.get(this.#docKey(target));
    if (!entry || !isWritableDocument(entry)) {
      return;
    }
    yield* entry.writeDetails.values();
  }

  *getReadDetails(space: MemorySpace): Iterable<TransactionReadDetail> {
    const branch = this.#branches.get(space);
    if (!branch) {
      return;
    }
    for (const [key, entry] of branch.docs) {
      const frozenReads = entry.frozenReads;
      if (!frozenReads) {
        continue;
      }
      const { id, scope } = this.#parseDocKey(key);
      for (const [path, value] of frozenReads.entries()) {
        yield {
          address: { space, scope, id, path: [...path] },
          value: value as TransactionReadDetail["value"],
        };
      }
    }
  }

  /**
   * Records `space` as a write target. Without the multi-space opt-in, rejects a
   * second space with a write-isolation error (preserving the default
   * single-space guarantee). With it enabled, tracks the space in first-write
   * order for commit() to split on.
   */
  #claimWriteSpace(space: MemorySpace): Result<Unit, WriterError> {
    if (
      !this.#multiSpaceWrites &&
      this.#writeSpace !== undefined &&
      this.#writeSpace !== space
    ) {
      return {
        error: WriteIsolationError({
          open: this.#writeSpace,
          requested: space,
        }),
      };
    }
    if (this.#writeSpace === undefined) {
      this.#writeSpace = space;
    }
    if (!this.#writtenSpaces.includes(space)) {
      this.#writtenSpaces.push(space);
    }
    return { ok: {} };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    const ready = this.#editable();
    if (ready.error) {
      return { error: ready.error };
    }

    const branch = this.#branch(address.space);
    const { doc } = this.#document(branch, address);
    if (readStatsActive && !hasDataUriScheme(address.id)) {
      recordDocumentRead(this, doc);
    }
    // The one place a read chooses which root it is reading. A materialized
    // read walking under an epoch describes the state that epoch names; every
    // other read describes the transaction's current state. The epoch is only
    // ever set on a transaction that has written, because before that the two
    // are the same root.
    const current = this.#readEpoch === undefined
      ? currentDocument(doc)
      : documentAtEpoch(doc, this.#readEpoch);
    const readMeta = options?.meta ?? EMPTY_META;
    // In a UI-input blind-leaf-write tx (a scalar `$value` overwrite), every read
    // is recorded for CFC/scheduling but carries no value-equality commit
    // precondition: tag each activity with `ignoreReadForCommit` (so buildReads
    // downgrades it to a nonRecursive entity-root existence read instead of a
    // leaf-value precondition) and skip marking the doc `validated` (so the client
    // validate()/claim() pass skips it too). The mode is scoped to the user
    // `set()` call only — CFC boundary-commit reads run after the tx is unmarked
    // and keep their preconditions.
    const skipCommitPrecondition = isUiInputBlindWriteTx(this);
    const { space: _, ...memoryAddress } = address;

    if (!hasDataUriScheme(address.id)) {
      const readActivity = {
        space: address.space,
        scope: normalizeCellScope(address.scope),
        id: address.id,
        path: address.path,
        meta: skipCommitPrecondition
          ? { ...readMeta, ...ignoreReadForCommit }
          : readMeta,
        ...(options?.nonRecursive === true ? { nonRecursive: true } : {}),
        journalIndex: this.#activityClock++,
      };
      this.#recordReadActivity(readActivity);
      this.#invalidateReactivityLog();
    }
    if (options?.trackReadWithoutLoad === true) {
      if (!hasDataUriScheme(address.id) && !skipCommitPrecondition) {
        doc.validated = true;
      }
      return { ok: { address, value: undefined } };
    }

    if (usesLocalReads(this) && !hasDataUriScheme(address.id)) {
      const written = this.#readEpoch === undefined &&
        [...(doc.patchDetails?.values() ?? [])].some((write) =>
          isPrefixPath(write.address.path, address.path)
        );
      const replica = branch.replica;
      const identity = this.#scopeKeyIdentity;
      assertLocalReadAvailable(
        this,
        address,
        () =>
          written || replica.hasLocalDocumentCoverage?.(
              address.id,
              address.scope,
              identity,
            ) === true,
      );
    }

    if (isMutableTransactionReadAllowed(readMeta)) {
      if (
        !hasDataUriScheme(address.id) &&
        !doc.validated &&
        !skipCommitPrecondition
      ) {
        doc.validated = true;
      }
      return {
        ok: {
          address: memoryAddress,
          value: readValueAtPath(current.value, memoryAddress.path, {
            allowArrayLength: true,
          }),
        },
      };
    }

    // A CFC internal-verifier read of a blind UI-input write transaction
    // bases on the doc's NON-speculative stack (RULED 2026-08-21;
    // verification-coverage.md OW47, second producer — the name-draft
    // triage): the verifier verifies the durable policy state the server
    // will enforce against — a client speculation layer never reaches
    // the wire, so deriving from it verified state the server can never
    // see, and the basis it contributed made the §6 export refusal
    // terminal on the user's own typed input. `SpaceReplica.#buildReads`
    // (storage/v2.ts) names the same durable layer set for these reads,
    // so verify-durable and name-durable travel together. Scoped tight:
    // only the blind-write tx shape (the structural target survives the
    // unmark), and only reads issued AFTER the blind window closes —
    // CFC prepare's own reads. In-window reads keep the transaction's
    // ordinary view (they are machinery reads the commit set drops via
    // `ignoreReadForCommit`), value-consuming reads keep their overlay
    // view and the ruled §6 refusal, and every other transaction is
    // byte-identical to before. CFC prepare consults the transaction's
    // own writes through its write set (`writeValueForTarget`) before
    // falling back to this read, so serving replica state here loses
    // nothing the verifier needs. Served fresh and cache-bypassed: the
    // frozen-reads cache describes the transaction's checkout view, and
    // a durable-view value must neither take from it nor land in it.
    if (
      !skipCommitPrecondition &&
      isInternalVerifierRead(readMeta) &&
      !hasDataUriScheme(address.id) &&
      // Content-addressed documents are EXEMPT from durable serving:
      // their content is identical on every layer (the replica refuses
      // a cid: doc whose content does not hash to its id), so the
      // ordinary view IS the durable content — while the client's own
      // durable copy may not exist yet during an echo's arrival window
      // (the echo's staging carries the schema docs its writes
      // reference, and the covering SERVED commit already persisted the
      // same docs server-side). Serving "durably absent" here turned
      // the user's fill into the silent stored-schemaHash-missing
      // prepare failure. Their layers stay excluded from the blind tx's
      // verifier basis in `SpaceReplica.#buildReads` — consistent by
      // construction: the value equals the durable content whichever layer
      // serves it.
      !address.id.startsWith("cid:") &&
      getBlindStructuralTarget(this) !== undefined &&
      // A replica without a speculation overlay serves no separate
      // durable view — fall through then: the ordinary read IS it.
      branch.replica.getNonSpeculativeDocument !== undefined
    ) {
      const durable = branch.replica.getNonSpeculativeDocument(
        address.id,
        address.scope,
        this.#scopeKeyIdentity,
      );
      if (!doc.validated) {
        doc.validated = true;
      }
      const durableRoot: IAttestation = {
        address: {
          id: address.id,
          type: address.type ?? DOCUMENT_MIME,
          scope: address.scope,
          path: [],
        },
        // Served DIRECTLY, never through the empty-collapse
        // (`toTransactionDocumentValue` maps a PRESENT-but-empty
        // document to `undefined`): the verifier must see the doc's
        // durable state as it is — a present-empty envelope reads as
        // `{}` at the root and as no-metadata under `["cfc"]`, not as
        // a deleted document.
        value: durable as unknown as FabricValue | undefined,
      };
      const result = readAttestation(durableRoot, memoryAddress);
      if (result.error) {
        return { error: result.error.from(address.space) };
      }
      return {
        ok: {
          ...result.ok,
          value: freezeReadValue(result.ok.value),
        },
      };
    }

    // The frozen-reads cache describes the current root — writes invalidate it
    // along the chain they touch — so a read resolving against an earlier epoch
    // neither takes from it nor adds to it.
    const cacheable = this.#readEpoch === undefined;
    const frozenReads = cacheable ? doc.frozenReads : undefined;
    if (frozenReads?.has(memoryAddress.path)) {
      return {
        ok: {
          address: memoryAddress,
          value: frozenReads.get(memoryAddress.path),
        },
      };
    }

    const result = readAttestation(current, memoryAddress);
    if (
      !hasDataUriScheme(address.id) &&
      !doc.validated &&
      !skipCommitPrecondition
    ) {
      doc.validated = true;
    }
    if (result.error) {
      return { error: result.error.from(address.space) };
    }

    const frozenValue = freezeReadValue(result.ok.value);
    if (cacheable) {
      (doc.frozenReads ??= new PathKeyMap()).set(
        memoryAddress.path,
        frozenValue,
      );
    }
    return {
      ok: {
        ...result.ok,
        value: frozenValue,
      },
    };
  }

  hasWrites(): boolean {
    return this.#writeEpoch > 0;
  }

  /**
   * The epoch a materialized read taken now should describe.
   *
   * Handing one out is what tells a later write that the root it displaces is
   * still being described, so a reader that never asks costs the write path
   * nothing.
   */
  issueReadEpoch(): number {
    // A read taken while another is already walking is part of that walk — a
    // view building the child a reader just touched — so it describes the same
    // instant. Handing it a fresh epoch would let a subtree resolved after a
    // write describe a later moment than the value it hangs off.
    if (this.#readEpoch !== undefined) return this.#readEpoch;
    this.#lastIssuedEpoch = this.#writeEpoch;
    return this.#writeEpoch;
  }

  /**
   * Resolve reads against `epoch` until the matching {@link exitReadEpoch}.
   *
   * Paired rather than wrapped around a callback so a reader on the hot path
   * allocates no closure per property it touches. Returns the epoch that was
   * in force, which the caller hands back to restore it.
   */
  enterReadEpoch(epoch: number | undefined): number | undefined {
    const previous = this.#readEpoch;
    this.#readEpoch = epoch;
    return previous;
  }

  exitReadEpoch(previous: number | undefined): void {
    this.#readEpoch = previous;
  }

  /**
   * Move `doc` to a new root, keeping the one it displaces if a reader may
   * still be describing it.
   *
   * Every write funnels here, so the epoch counts root replacements and
   * nothing else.
   *
   * The root about to be displaced has stood since this document's last
   * displacement, so it answers for every epoch in between. It is worth keeping
   * exactly when a reader was handed one of those — which is the newest issued
   * epoch, since an older one is answered by the same root. A run of writes
   * with no read taken between them therefore keeps one root, not one per
   * write, and a document nobody has read against keeps none.
   *
   * Keeping one means freezing it, and freezing it before the write starts.
   * A write descends through `cloneForMutation` with `force: false`, which
   * thaws a frozen container by shallow-cloning it and leaves an already-
   * mutable one alone — so the root a first write leaves behind is mutable, and
   * the next write edits it where it stands rather than replacing it. Freezing
   * first puts that write on the cloning path, which is what makes the kept
   * root stay the value it was. `deepFreeze` short-circuits on what is already
   * deep-frozen, so this costs only what this transaction has thawed by
   * writing.
   *
   * Called before the write reads the root it is about to descend, which is why
   * this is separate from {@link V2StorageTransaction.#replaceCurrent}.
   */
  #preserveForReaders(doc: DocumentEntry): void {
    const issued = this.#lastIssuedEpoch;
    if (issued === undefined) return;
    if (issued <= (doc.displaced?.at(-1)?.until ?? -1)) return;
    const standing = currentDocument(doc);
    deepFreeze(standing.value);
    (doc.displaced ??= []).push({ until: this.#writeEpoch, root: standing });
  }

  #replaceCurrent(doc: DocumentEntry, next: RootAttestation): void {
    this.#writeEpoch++;
    doc.current = next;
  }

  trackReadPaths(
    address: Omit<IMemorySpaceAddress, "path">,
    paths: readonly (readonly string[])[],
    options?: Omit<IReadOptions, "trackReadWithoutLoad">,
  ): Result<Unit, ReadError> {
    if (paths.length === 0) return { ok: {} };
    const ready = this.#editable();
    if (ready.error) return { error: ready.error };

    const branch = this.#branch(address.space);
    const { doc } = this.#document(branch, address);
    if (hasDataUriScheme(address.id)) return { ok: {} };
    if (readStatsActive) recordDocumentRead(this, doc);

    const readMeta = options?.meta ?? EMPTY_META;
    const skipCommitPrecondition = isUiInputBlindWriteTx(this);
    const activityMeta = skipCommitPrecondition
      ? { ...readMeta, ...ignoreReadForCommit }
      : readMeta;
    const scope = normalizeCellScope(address.scope);
    if (options?.nonRecursive === true) {
      for (let index = 0; index < paths.length; index++) {
        this.#recordReadActivity({
          space: address.space,
          scope,
          id: address.id,
          path: paths[index],
          meta: activityMeta,
          nonRecursive: true,
          journalIndex: this.#activityClock++,
        });
      }
    } else {
      for (let index = 0; index < paths.length; index++) {
        this.#recordReadActivity({
          space: address.space,
          scope,
          id: address.id,
          path: paths[index],
          meta: activityMeta,
          journalIndex: this.#activityClock++,
        });
      }
    }
    if (!skipCommitPrecondition) doc.validated = true;
    this.#invalidateReactivityLog();
    return { ok: {} };
  }

  write(
    address: IMemorySpaceAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriterError | WriteError> {
    const ready = this.#prepareWriteSpace(address.space);
    if (ready.error) {
      return { error: ready.error };
    }
    return this.#writeWithinBranch(
      ready.ok,
      address.space,
      address,
      value,
      options,
    );
  }

  writeBatch(
    writes: Iterable<ITransactionWriteRequest>,
  ): Result<Unit, WriterError | WriteError> {
    let run: ITransactionWriteRequest[] = [];
    let runKey: string | undefined;

    const flushRun = (): Result<Unit, WriterError | WriteError> => {
      if (run.length === 0) {
        return { ok: {} };
      }
      const [{ address }] = run;
      const ready = this.#prepareWriteSpace(address.space);
      if (ready.error) {
        return { error: ready.error };
      }
      const result = this.#writeBatchRun(address.space, ready.ok, run);
      run = [];
      runKey = undefined;
      return result;
    };

    for (const write of writes) {
      // The run is flushed against a single document, fetched from the first
      // write's address (see `#writeBatchRun`). Documents are keyed by scope as
      // well as id (`makeDocKey`), so the run key must include scope: otherwise
      // writes to different scoped instances of the same id would be merged into
      // one run and applied to whichever instance came first, corrupting both.
      const key = `${write.address.space}|${
        normalizeCellScope(write.address.scope)
      }|${write.address.id}`;
      if (runKey === undefined || key === runKey) {
        run.push(write);
        runKey = key;
        continue;
      }
      const flushed = flushRun();
      if (flushed.error) {
        return flushed;
      }
      run.push(write);
      runKey = key;
    }

    return flushRun();
  }

  #writeWithinSpace(
    space: MemorySpace,
    address: IMemoryAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError> {
    this.#assertWritable("write()");
    return this.#writeWithinBranch(
      this.#branch(space),
      space,
      address,
      value,
      options,
    );
  }

  /**
   * Whether a write to `id` must be recorded — and, in a commit that
   * exports content, re-delivered — even when its value equals the
   * currently-visible state. True for a `cid:` schema document the
   * space's server has not confirmed: the visible copy may sit on a
   * layer that never reaches the wire — a client speculation overlay
   * entry, or a sibling commit still awaiting its verdict — so
   * visibility is no evidence the server holds the document, and a
   * commit whose content references it would be rejected with the
   * document neither included nor stored (the write-side delivery
   * guarantee, `docs/specs/content-addressed-schemas.md`). Only
   * server-confirmed persistence makes a re-delivery redundant, and
   * content addressing makes the confirmed copy immutable, so that
   * elision cannot race a change. A storage without persistence
   * tracking confirms nothing and always delivers — redundant `cid:`
   * re-sets apply as no-ops. The write layer records such writes
   * (`#writeWithinBranch`'s elisions yield) so commit assembly can decide;
   * getNativeCommit emits them only alongside real content, keeping a
   * no-op-net transaction's commit empty.
   */
  #mustDeliverSchemaDoc(space: MemorySpace, id: string): boolean {
    return id.startsWith("cid:") &&
      !this.isContentAddressedDocPersisted(space, id.slice("cid:".length));
  }

  /**
   * Unified write entry. Handles simple writes, root writes, type-mismatch
   * errors, and create-missing-intermediates in one path, all via
   * `applyMutablePathWrite()`. `cloneForMutation()` inside that helper
   * shallow-thaws only the containers on the write spine; off-spine
   * subtrees stay deep-frozen and structurally shared with the prior
   * `doc.current.value`.
   *
   * No-op short-circuits (presence-aware: a stored `undefined` is a real
   * state, distinct from an absent slot):
   *   - For a value write, if the leaf exists and is already deep-equal to
   *     `value`, return the unchanged attestation. A write of `undefined`
   *     to an absent leaf is NOT a no-op — it stores `undefined`,
   *     materializing intermediates if needed.
   *   - For a delete (`options.delete`), if the leaf doesn't exist —
   *     whether the leaf slot is absent or an intermediate is missing —
   *     return the unchanged attestation; don't allocate intermediate
   *     containers just to delete a slot that wasn't there.
   */
  #writeWithinBranch(
    branch: SpaceBranch,
    space: MemorySpace,
    address: IMemoryAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriteError> {
    if (hasDataUriScheme(address.id)) {
      return { error: ReadOnlyAddressError(address).from(space) };
    }
    const isDelete = options?.delete === true;

    const { doc: readDoc } = this.#document(branch, address);
    const doc = ensureWritableDocument(readDoc);
    this.#preserveForReaders(doc);
    const current = doc.current;
    const previous = inspectPath(current.value, address.path);
    if (previous.kind === "ok") {
      const present = hasValueAtPath(current.value, address.path, {
        allowArrayLength: true,
      });
      // Authoritative mode (markAuthoritativeWrites) disables the
      // equal-VALUE elision only: the visible state being diffed against
      // may be an extrapolation over a doomed sealed overlay, so "already
      // equal" is not evidence the store holds the value. An unconfirmed
      // schema document (#mustDeliverSchemaDoc) disables it the same way:
      // its visible copy may sit on a speculation layer the wire never
      // carries. Deletes of absent slots stay no-ops — there is nothing
      // to assert.
      if (
        isDelete ? !present : (present && valueEqual(previous.value, value) &&
          !this.#authoritativeWrites &&
          !this.#mustDeliverSchemaDoc(space, address.id))
      ) {
        this.#retainPendingWriteElision(branch, space, address);
        return { ok: current };
      }
    }
    if (previous.kind === "notFound" && isDelete) {
      this.#retainPendingWriteElision(branch, space, address);
      return { ok: current };
    }

    const isolatedValue = value === undefined
      ? undefined
      : cloneIfNecessary(value);

    // Compute the activity path and previous-value snapshots BEFORE the
    // write -- `applyMutablePathWrite()` mutates `current.value` in place
    // on the second-and-later write to this doc within a transaction
    // (`cloneForMutation({ force: false })` short-circuits to identity on
    // an already-mutable root). Reading `current.value` AFTER the mutation
    // would observe the post-write state and silently mis-report the
    // `previousActivityValue` to the reactivity log.
    //
    // For create-parents writes, the materialization point (deepest
    // pre-existing parent on the write path) is where the observable
    // change happens for subscribers watching a parent. For simple writes
    // it falls back to `address.path`.
    const activityPath = findMaterializedParentPath(
      current.value,
      address.path,
      isDelete,
    ) ?? address.path;
    const previousActivityValue = cloneIfNecessary(
      readValueAtPath(current.value, activityPath, {
        allowArrayLength: true,
      }),
    ) as FabricValue | undefined;
    // Pre-write slot presence (distinct from value: a slot holding
    // `undefined` is present) for the write details — also read BEFORE the
    // in-place mutation below. `hasValueAtPath` is vacuously true for the
    // empty path, so root presence is the root's own definedness (the
    // root IS the value — it has no present-but-undefined state).
    const presentBeforeWrite = (path: readonly string[]): boolean =>
      path.length === 0
        ? current.value !== undefined
        : hasValueAtPath(current.value, path, { allowArrayLength: true });
    const previousPresent = presentBeforeWrite(address.path);
    const previousActivityPresent = activityPath === address.path
      ? previousPresent
      : presentBeforeWrite(activityPath);

    const result = applyMutablePathWrite(
      current.value,
      address,
      isolatedValue,
      isDelete ? { delete: true } : undefined,
    );
    if (result.error) {
      return { error: result.error.from(space) };
    }
    // Authoritative mode records the (value-unchanged) write anyway so it
    // reaches the commit as a full-cover re-assert, and an unconfirmed
    // schema document is recorded for the same delivery reason; delete
    // no-ops still return (see above).
    if (
      !result.ok.changed &&
      (isDelete ||
        (!this.#authoritativeWrites &&
          !this.#mustDeliverSchemaDoc(space, address.id)))
    ) {
      this.#retainPendingWriteElision(branch, space, address);
      return { ok: current };
    }

    const collapsedNext: RootAttestation = {
      ...current,
      value: collapseEmptyJsonDocumentEnvelope(result.ok.root),
    };

    this.#replaceCurrent(doc, collapsedNext);
    invalidateFrozenReadsOnChain(doc, address.path);
    this.#recordPatchIntent(
      space,
      address,
      readValueAtPath(collapsedNext.value, address.path, {
        allowArrayLength: true,
      }),
      cloneIfNecessary(result.ok.previousValue) as FabricValue | undefined,
      doc,
      previousPresent,
    );
    this.#recordWriteActivity(
      space,
      { ...address, path: activityPath },
      readValueAtPath(collapsedNext.value, activityPath, {
        allowArrayLength: true,
      }),
      previousActivityValue,
      doc,
      previousActivityPresent,
    );

    return { ok: collapsedNext };
  }

  /** Elision over a pending document retains its commit basis. */
  #retainPendingWriteElision(
    branch: SpaceBranch,
    space: MemorySpace,
    address: IMemoryAddress,
  ): void {
    if (
      isUiInputBlindWriteTx(this) ||
      !branch.replica.hasPendingWrite(
        address.id,
        address.scope,
        this.#scopeKeyIdentity,
      )
    ) return;
    // Keep the commit dependency without subscribing the writer to itself or
    // consuming the output's CFC label. Validation still checks the original
    // document; the transaction's own unsealed writes are never a pending layer.
    // This document-wide check conservatively retains the older layer even
    // when a preceding write in this transaction supplied the elided value.
    const read = this.read({ ...address, space }, {
      trackReadWithoutLoad: true,
      meta: pendingWriteElisionRead,
    });
    if (read.error) throw read.error;
  }

  #writeBatchRun(
    space: MemorySpace,
    branch: SpaceBranch,
    writes: readonly ITransactionWriteRequest[],
  ): Result<Unit, WriteError> {
    if (
      writes.length <= 1 ||
      writes.some(({ address }) => hasDataUriScheme(address.id))
    ) {
      // Singleton-batch / data:URI fallback: route each write through the
      // unified single-write entry, which itself handles
      // create-missing-intermediates.
      for (const { address, value, delete: isDelete } of writes) {
        const result = this.#writeWithinSpace(
          space,
          address,
          value,
          isDelete ? { delete: true } : undefined,
        );
        if (result.error) {
          return { error: result.error };
        }
      }
      return { ok: {} };
    }

    const { doc: readDoc } = this.#document(branch, writes[0]!.address);
    const doc = ensureWritableDocument(readDoc);
    this.#preserveForReaders(doc);
    const originalRoot = doc.current.value;
    let nextRoot = originalRoot;
    let changed = false;
    const writtenPaths: (readonly string[])[] = [];

    // No explicit mutable-root prelude here: `applyMutablePathWrite()` calls
    // `cloneForMutation()` with `force: false`, which shallow-thaws the
    // root container on the first write (if it was frozen) and is an
    // identity short-circuit on subsequent writes (since the root is
    // mutable from then on). That gives us "mutate in place on the same
    // freshly-thawed spine across the whole batch" without ever needing a
    // deep clone of off-spine subtrees.
    //
    // Read-before-mutate ordering is load-bearing: `previousValue`,
    // `activityPath`, and `previousActivityValue` are all computed from
    // `nextRoot` BEFORE `applyMutablePathWrite()` is called. The helper
    // mutates `nextRoot` in place from the second iteration onward, so
    // reading it AFTER the call would observe the post-write state.
    // (See `#writeWithinBranch` for the same invariant and a regression
    // test.)
    for (const { address, value, delete: isDelete } of writes) {
      const isolatedValue = value === undefined
        ? undefined
        : cloneIfNecessary(value);
      const previousValue = readValueAtPath(nextRoot, address.path, {
        allowArrayLength: true,
      });
      // Presence-aware no-op detection (also keeps no-op deletes from
      // reaching `applyMutablePathWrite`, which would materialize
      // intermediates into `nextRoot` before the changed check).
      // Authoritative mode records equal-VALUE writes anyway, and an
      // unconfirmed schema document is recorded for its delivery
      // guarantee (see `#writeWithinBranch` for both); delete no-ops
      // still skip.
      const present = hasValueAtPath(nextRoot, address.path, {
        allowArrayLength: true,
      });
      if (
        isDelete
          ? !present
          : (present && valueEqual(previousValue, isolatedValue) &&
            !this.#authoritativeWrites &&
            !this.#mustDeliverSchemaDoc(space, address.id))
      ) {
        this.#retainPendingWriteElision(branch, space, address);
        continue;
      }
      const activityPath = findMaterializedParentPath(
        nextRoot,
        address.path,
        isDelete === true,
      ) ?? address.path;
      const previousActivityValue = cloneIfNecessary(
        readValueAtPath(nextRoot, activityPath, {
          allowArrayLength: true,
        }),
      ) as FabricValue | undefined;
      // Pre-write slot presence for the write details (see
      // `#writeWithinBranch`; empty path = root definedness, since
      // `hasValueAtPath` is vacuously true there) — read before
      // `applyMutablePathWrite` mutates `nextRoot` in place.
      const previousPresent = address.path.length === 0
        ? nextRoot !== undefined
        : present;
      const previousActivityPresent = activityPath === address.path
        ? previousPresent
        : activityPath.length === 0
        ? nextRoot !== undefined
        : hasValueAtPath(nextRoot, activityPath, {
          allowArrayLength: true,
        });
      const result = applyMutablePathWrite(
        nextRoot,
        address,
        isolatedValue,
        isDelete ? { delete: true } : undefined,
      );
      if (result.error) {
        if (changed) {
          this.#replaceCurrent(doc, {
            ...doc.current,
            value: collapseEmptyJsonDocumentEnvelope(
              nextRoot,
            ),
          });
          for (const written of writtenPaths) {
            invalidateFrozenReadsOnChain(doc, written);
          }
        }
        return { error: result.error.from(space) };
      }
      nextRoot = result.ok.root;
      if (
        !result.ok.changed &&
        (isDelete ||
          (!this.#authoritativeWrites &&
            !this.#mustDeliverSchemaDoc(space, address.id)))
      ) {
        this.#retainPendingWriteElision(branch, space, address);
        continue;
      }
      changed = true;
      writtenPaths.push(address.path);
      this.#recordPatchIntent(
        space,
        address,
        readValueAtPath(result.ok.root, address.path, {
          allowArrayLength: true,
        }),
        cloneIfNecessary(previousValue) as FabricValue | undefined,
        doc,
        previousPresent,
      );
      this.#recordWriteActivity(
        space,
        { ...address, path: activityPath },
        readValueAtPath(result.ok.root, activityPath, {
          allowArrayLength: true,
        }),
        previousActivityValue,
        doc,
        previousActivityPresent,
      );
    }

    if (!changed) {
      return { ok: {} };
    }

    this.#replaceCurrent(doc, {
      ...doc.current,
      value: collapseEmptyJsonDocumentEnvelope(
        nextRoot,
      ),
    });
    for (const written of writtenPaths) {
      invalidateFrozenReadsOnChain(doc, written);
    }
    return { ok: {} };
  }

  #recordWriteActivity(
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
    doc: WritableDocumentEntry,
    previousPresent?: boolean,
  ): void {
    recordWriteStackTrace(
      {
        space,
        id: address.id,
        path: address.path,
      },
      value,
      {
        scopeId: (this as { writeTraceScopeId?: string }).writeTraceScopeId,
        writerActionId: (this as { debugActionId?: string }).debugActionId,
      },
    );

    this.#upsertWriteDetail(
      doc.writeDetails,
      space,
      address,
      value,
      previousValue,
      previousPresent,
    );
    this.#invalidateReactivityLog();
  }

  #recordPatchIntent(
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
    doc: WritableDocumentEntry,
    previousPresent?: boolean,
  ): void {
    // The per-attempt order stamp. recordPatchIntent runs once per applied
    // write in both the single-write and batch paths, with the EXACT write
    // address (unlike recordWriteActivity's materialized-parent activity
    // path) and only after the value-equal elision checks — so the attempt
    // log carries exactly the write set the rest of the inspection surface
    // (writeDetails/reactivity) sees, in temporal order. Raw path on
    // purpose: the CFC consumer distinguishes `["value",...]` user writes
    // from `["cfc"]`/`["source"]` runtime surfaces.
    this.#writeAttemptLog.push({
      space,
      scope: normalizeCellScope(address.scope),
      id: address.id,
      path: address.path,
      journalIndex: this.#activityClock++,
    });
    this.#upsertWriteDetail(
      doc.patchDetails,
      space,
      address,
      value,
      previousValue,
      previousPresent,
    );
  }

  #upsertWriteDetail(
    details: Map<string, TransactionWriteDetail>,
    space: MemorySpace,
    address: IMemoryAddress,
    value: FabricValue | undefined,
    previousValue: FabricValue | undefined,
    previousPresent?: boolean,
  ): void {
    const writeActivity = {
      space,
      scope: normalizeCellScope(address.scope),
      id: address.id,
      path: address.path,
    };
    const key = encodePointer(address.path);
    const existing = details.get(key);
    if (existing) {
      // Only update the latest value — previousValue (and its presence
      // flag) intentionally stays as the pre-transaction state so that
      // journal.history() reports the correct before-snapshot for reverts
      // and conflict detection.
      existing.value = value;
      return;
    }

    details.set(key, {
      address: writeActivity,
      value,
      previousValue,
      ...(previousPresent !== undefined ? { previousPresent } : {}),
    });
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    this.#assertWritable("abort()");
    const ready = this.#editable();
    if (ready.error) {
      return { error: ready.error };
    }
    // Aborted before reaching storage, so the activity stays: the scheduler
    // rebuilds this action's dependencies from it and retries.
    this.#state = {
      status: "done",
      result: { error: TransactionAborted(reason) },
    };
    if ((this as IStorageTransaction).sourceAction === undefined) {
      releaseLocalReadBasis(this);
    }
    return { ok: {} };
  }

  commit(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> {
    // A rejection seals the commit's fate before the promise resolves — the
    // promise additionally waits out the read-repair gate so a retry runs
    // against the repaired base. The verdict must not: finalizeRejection
    // notifies this listener at rejection receipt, ahead of the gate.
    registerCommitRejectionListener(
      this,
      (rejection) => this.#verdict.resolve({ error: rejection }),
    );
    const promise = this.#commitImpl(options);
    // Backstop for the verdict signal: paths that never reach a push (zero
    // writes, pre-storage rejections) determine their fate exactly when the
    // commit promise resolves. The push path resolves #verdict earlier —
    // at the verdict — and this second resolve is then a no-op. An
    // internally REJECTED commit promise resolves the verdict with the
    // error: the verdict never rejects, and a waiter must not hang on a
    // commit whose fate is known.
    promise.then(
      (result) => this.#verdict.resolve(result),
      (reason) => this.#verdict.resolve({ error: toStoreError(reason) }),
    );
    // Synchronous registration with the manager's durability barrier: by the
    // time commit() returns, the in-flight commit is visible to
    // hasPendingCommits(), so a quiescence check started in the same turn
    // cannot miss it. The entry spans the full commit promise — coverage
    // included — so the barrier also covers follow-on commits issued from a
    // continuation chained on the promise. (The scheduler's event path
    // registers its own entry spanning its disposition handling, which
    // chains on the WRAPPER's promise and trails this one by the
    // verdict-time effect run.)
    this.#storage.trackPendingCommit(promise);
    return promise;
  }

  commitVerdict(): Promise<Result<Unit, CommitError>> {
    return this.#verdict.promise;
  }

  async #commitImpl(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> {
    this.#assertWritable("commit()");
    const unavailable = validateLocalReadBasis(this);
    if (unavailable !== undefined && this.#state.status === "ready") {
      this.abort(unavailable);
    }
    const ready = this.#editable();
    if (ready.error) {
      return { error: ready.error };
    }

    // Genuine cross-space commits split into one per-space commit. A
    // single-space transaction (the common case, even with the opt-in set) stays
    // on the proven path below.
    if (this.#multiSpaceWrites && this.#writtenSpaces.length > 1) {
      return this.#commitMultiSpace(options);
    }

    const writeSpace = this.#writeSpace;
    if (!writeSpace) {
      return this.#finishEmptyCommit();
    }

    const native = withCommitTiming(
      ["commit", "getNativeCommit"],
      () => this.getNativeCommit(writeSpace),
    );
    const operations = native?.operations ?? [];
    const hasCommitPreconditions = (native?.preconditions?.length ?? 0) > 0;
    const hasSqliteOps = (native?.sqliteOps?.length ?? 0) > 0;
    if (
      operations.length === 0 &&
      !hasCommitPreconditions && !hasSqliteOps
    ) {
      return this.#finishEmptyCommit();
    }

    const validation = withCommitTiming(
      ["commit", "validate"],
      () => this.#validate(),
    );
    if (validation.error) {
      // Rejected before reaching storage, so the activity stays: the scheduler
      // rebuilds this action's dependencies from it and retries.
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    const replica = this.#replicaForCommit(writeSpace);
    if (!replica.commitNative) {
      throw new Error("memory v2 replica does not support commitNative()");
    }
    const commitNative = replica.commitNative.bind(replica);
    const promise = withCommitTiming(
      ["commit", "commitNative"],
      () => commitNative(native!, this, options),
    );
    this.#state = { status: "pending", promise };
    try {
      const result = await promise;
      this.#finish(result);
      this.#verdict.resolve(result);
      // CT-1950: the caller's commit promise resolves at coverage — the
      // subscribed view reflects the committed write — while the verdict
      // above already released durability-gated effects. Drained on EVERY
      // settlement, not only success: waits are recorded per accepted
      // space, so a multi-space commit rejected on a later space still
      // holds its settlement (and commit callbacks) until the earlier
      // accepted spaces' parked writes reach the view.
      {
        const waits = takeCoverageWaits(this);
        if (waits.length > 0) {
          await Promise.all(waits);
        }
      }
      return result;
    } catch (error) {
      const result: Result<Unit, StorageTransactionRejected> = {
        error: toStoreError(error),
      };
      this.#finish(result);
      return result;
    }
  }

  /**
   * Commits a multi-space transaction as one per-space commit each, in commit
   * order (explicit or first-write). Commits run sequentially with no
   * cross-space atomicity: a later failure does not roll back earlier spaces; it
   * is logged and surfaced as the overall result.
   */
  async #commitMultiSpace(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> {
    const commits: { space: MemorySpace; native: NativeStorageCommit }[] = [];
    for (const space of this.#orderedCommitSpaces()) {
      const native = this.getNativeCommit(space);
      const operations = native?.operations ?? [];
      const hasCommitPreconditions = (native?.preconditions?.length ?? 0) > 0;
      const hasSqliteOps = (native?.sqliteOps?.length ?? 0) > 0;
      if (
        !native ||
        (operations.length === 0 &&
          !hasCommitPreconditions && !hasSqliteOps)
      ) {
        continue;
      }
      commits.push({ space, native });
    }

    if (commits.length === 0) {
      return this.#finishEmptyCommit();
    }

    const validation = this.#validate();
    if (validation.error) {
      // Rejected before reaching storage, so the activity stays: the scheduler
      // rebuilds this action's dependencies from it and retries.
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    const promise = this.#runSplitCommits(commits, options);
    this.#state = { status: "pending", promise };
    try {
      const result = await promise;
      this.#finish(result);
      this.#verdict.resolve(result);
      // Same split as the single-space path: verdicts (all spaces) release
      // effects; the commit promise waits for every space's coverage —
      // including on a partial failure, where the waits recorded by the
      // earlier ACCEPTED spaces still gate settlement.
      {
        const waits = takeCoverageWaits(this);
        if (waits.length > 0) {
          await Promise.all(waits);
        }
      }
      return result;
    } catch (error) {
      // Mirror the single-space path: a rejected commit must still transition
      // the transaction to "done" with an error rather than leaving it stuck
      // at "pending" (e.g. if a replica lacks commitNative()).
      const result: Result<Unit, StorageTransactionRejected> = {
        error: toStoreError(error),
      };
      this.#finish(result);
      return result;
    }
  }

  /**
   * The written spaces in commit order: the explicit order first (restricted to
   * spaces actually written), then any remaining spaces in first-write order.
   */
  #orderedCommitSpaces(): MemorySpace[] {
    if (this.#commitOrder === undefined) {
      return [...this.#writtenSpaces];
    }
    const ordered: MemorySpace[] = [];
    const seen = new Set<MemorySpace>();
    for (const space of this.#commitOrder) {
      if (!seen.has(space) && this.#writtenSpaces.includes(space)) {
        ordered.push(space);
        seen.add(space);
      }
    }
    for (const space of this.#writtenSpaces) {
      if (!seen.has(space)) {
        ordered.push(space);
        seen.add(space);
      }
    }
    return ordered;
  }

  async #runSplitCommits(
    commits: { space: MemorySpace; native: NativeStorageCommit }[],
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    for (let i = 0; i < commits.length; i++) {
      const { space, native } = commits[i];
      // The claim check that admitted the transaction ran before the first
      // space's round trip, which this loop has since awaited; this space's
      // read set is built inside the call below, from its replica as it is
      // now, so the check runs again for this space right here.
      if (i > 0) {
        const revalidation = this.#revalidateLaterSpace(space, i);
        if (revalidation.error) {
          return revalidation;
        }
      }
      const replica = this.#replicaForCommit(space);
      if (!replica.commitNative) {
        throw new Error("memory v2 replica does not support commitNative()");
      }
      const commitNative = replica.commitNative.bind(replica);
      // Stop at the first per-space failure rather than committing the
      // remaining spaces. The commit order is meaningful (e.g. a child space
      // before the parent that links to it), so once an earlier space fails we
      // must not durably apply later ones: doing so would violate the order and
      // double-apply those writes if the transaction is retried. Spaces already
      // committed before the failure are not rolled back (logged); the failing
      // space and everything after it are left uncommitted.
      try {
        const result = await commitNative(native, this, options);
        if (result.error) {
          multiSpaceCommitLogger.error(
            "multi-space-commit-failed",
            `Cross-space commit to ${space} failed after ${i} space(s); ` +
              `earlier spaces are not rolled back and later spaces are skipped`,
            result.error,
          );
          return { error: result.error };
        }
      } catch (error) {
        multiSpaceCommitLogger.error(
          "multi-space-commit-rejected",
          `Cross-space commit to ${space} rejected after ${i} space(s); ` +
            `earlier spaces are not rolled back and later spaces are skipped`,
          error,
        );
        return { error: toStoreError(error) };
      }
    }
    return { ok: {} };
  }

  /**
   * Helper for the per-space close loops, which re-runs the claim check on
   * `space`, the `index`th space to close. A failure is logged the way any
   * later space's rejected close is: the earlier spaces stay closed, and
   * this one and the rest are left unclosed.
   */
  #revalidateLaterSpace(
    space: MemorySpace,
    index: number,
  ): Result<Unit, IStorageTransactionInconsistent> {
    const branch = this.#branches.get(space);
    if (branch === undefined) return { ok: {} };
    const result = this.#validateBranch(space, branch);
    if (result.error) {
      multiSpaceCommitLogger.error(
        "multi-space-commit-stale",
        `Cross-space close of ${space} found a document changed after ` +
          `${index} space(s) closed; earlier spaces are not rolled back and ` +
          `later spaces are skipped`,
        result.error,
      );
    }
    return result;
  }

  /**
   * Helper for `#validateBranch()`, which names the documents `space`'s
   * commit pins for the server to evaluate against durable state before it
   * applies anything.
   *
   * Such a document needs no local claim check, and must not get one: an
   * `entity-absent` pin fails as `PreconditionFailedError`, which callers
   * treat as decided on the committed data's own merits rather than as a
   * basis a re-run repairs, so a local retryable rejection in its place
   * turns a settled outcome into a retry. Skipping loses no soundness,
   * because each pin is the stronger claim: a commit naming a document that
   * exists, or whose value no longer hashes to the pinned one, is refused
   * outright.
   *
   * The bound is the `commitPreconditions` flag. With it off, the commit
   * carries only its `entity-value-hash` pins — an `entity-absent` pin is
   * filtered out before the wire and the server never evaluates it — so
   * only the pins that survive that filter earn the exemption. Naming the
   * exempt kinds rather than the ineligible ones is what keeps a kind added
   * later from being exempted before anyone decides it should be.
   */
  #serverJudgedDocuments(space: MemorySpace): ReadonlySet<string> {
    const judged = new Set<string>();
    const absencePinsActive = getCommitPreconditionsConfig() === true;
    for (const precondition of this.#commitPreconditionsFor(space)) {
      const pinned = precondition.kind === "entity-value-hash" ||
        (precondition.kind === "entity-absent" && absencePinsActive);
      if (!pinned) continue;
      judged.add(
        this.#docKey({
          id: precondition.id as URI,
          type: DOCUMENT_MIME,
          scope: precondition.scope,
        }),
      );
    }
    return judged;
  }

  /**
   * Close by sealing (server-execution v2, serving-loop.md §3d): the same
   * close work commit() runs — per-space native commit construction in
   * commit order, validation, terminal state transition — with each space's
   * native commit handed to `sink` instead of its replica. Multi-space
   * transactions hand over in the same children-first order the split
   * commit path uses (protocol.md §2b), stopping at the first failure.
   */
  sealInto(
    sink: ITransactionSealSink,
  ): Promise<Result<Unit, CommitError>> {
    const promise = this.#sealImpl(sink);
    // Same durability-barrier registration as commit(): by the time
    // sealInto() returns, the in-flight close is visible to
    // hasPendingCommits().
    this.#storage.trackPendingCommit(promise);
    return promise;
  }

  async #sealImpl(
    sink: ITransactionSealSink,
  ): Promise<Result<Unit, CommitError>> {
    this.#assertWritable("sealInto()");
    const unavailable = validateLocalReadBasis(this);
    if (unavailable !== undefined && this.#state.status === "ready") {
      this.abort(unavailable);
    }
    const ready = this.#editable();
    if (ready.error) {
      return { error: ready.error };
    }

    const commits: { space: MemorySpace; native: NativeStorageCommit }[] = [];
    for (const space of this.#orderedCommitSpaces()) {
      const native = this.getNativeCommit(space);
      const operations = native?.operations ?? [];
      const hasCommitPreconditions = (native?.preconditions?.length ?? 0) > 0;
      const hasSqliteOps = (native?.sqliteOps?.length ?? 0) > 0;
      if (
        !native ||
        (operations.length === 0 &&
          !hasCommitPreconditions && !hasSqliteOps)
      ) {
        continue;
      }
      commits.push({ space, native });
    }

    if (commits.length === 0) {
      return this.#finishEmptyCommit();
    }

    const validation = this.#validate();
    if (validation.error) {
      // Rejected before sealing, so the activity stays: the scheduler
      // rebuilds this action's dependencies from it and retries.
      this.#state = {
        status: "done",
        result: { error: validation.error },
      };
      return { error: validation.error };
    }

    // Read-only spaces' read sets (stage F, discharging a stage-D bound):
    // spaces this tx read but wrote nothing to produce no native commit,
    // so their reads would never reach the accumulator — and a withdrawn
    // writer there could not fold this reader into the withdrawal. Hand
    // them over explicitly, before the space commits, inside the same
    // seal call.
    if (sink.sealSpaceReads !== undefined) {
      const writtenSpaces = new Set(commits.map((commit) => commit.space));
      const readOnlyReads = new Map<MemorySpace, IMemorySpaceAddress[]>();
      const log = this.#buildReactivityLog();
      // Both read classes: a shallow (nonRecursive) read of withdrawn
      // state makes a derived write exactly as blind as a deep one, and
      // the withdrawal closure folds by DOC identity anyway.
      const pendingElisions = this.#readActivities.filter((read) =>
        read.meta === pendingWriteElisionRead
      ).map(({ space, id, scope, path }) => ({ space, id, scope, path }));
      // These internal reads are absent from the scheduling log, but the
      // publication they reuse must survive even when it is in another space.
      for (
        const read of [...log.reads, ...log.shallowReads, ...pendingElisions]
      ) {
        if (writtenSpaces.has(read.space)) continue;
        let reads = readOnlyReads.get(read.space);
        if (reads === undefined) {
          reads = [];
          readOnlyReads.set(read.space, reads);
        }
        reads.push(read);
      }
      for (const [space, reads] of readOnlyReads) {
        sink.sealSpaceReads(space, reads);
      }
    }

    const promise = this.#runSealHandoffs(sink, commits);
    this.#state = { status: "pending", promise };
    try {
      const result = await promise;
      this.#finish(result);
      return result;
    } catch (error) {
      const result: Result<Unit, StorageTransactionRejected> = {
        error: toStoreError(error),
      };
      this.#finish(result);
      return result;
    }
  }

  async #runSealHandoffs(
    sink: ITransactionSealSink,
    commits: { space: MemorySpace; native: NativeStorageCommit }[],
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    for (let i = 0; i < commits.length; i++) {
      const { space, native } = commits[i];
      // Same re-check as runSplitCommits: the sink builds this space's read
      // set inside the call below, after the earlier spaces' handoffs were
      // awaited.
      if (i > 0) {
        const revalidation = this.#revalidateLaterSpace(space, i);
        if (revalidation.error) {
          return revalidation;
        }
      }
      // Stop at the first per-space failure, exactly like runSplitCommits:
      // spaces already sealed are not unwound here — the wave accumulator
      // owns the sealed writes' lifecycle from the moment it accepts them.
      try {
        const result = await sink.sealSpaceCommit(space, native, this);
        if (result.error) {
          multiSpaceCommitLogger.error(
            "seal-space-commit-failed",
            `Seal into wave for ${space} failed after ${i} space(s); ` +
              `later spaces are skipped`,
            result.error,
          );
          return { error: result.error as StorageTransactionRejected };
        }
      } catch (error) {
        multiSpaceCommitLogger.error(
          "seal-space-commit-rejected",
          `Seal into wave for ${space} rejected after ${i} space(s); ` +
            `later spaces are skipped`,
          error,
        );
        return { error: toStoreError(error) };
      }
    }
    return { ok: {} };
  }

  #editable(): Result<Unit, InactiveTransactionError> {
    if (this.#state.status === "ready") {
      return { ok: {} };
    }
    return {
      error: this.#state.status === "done" && this.#state.result.error
        ? this.#state.result.error
        : TransactionCompleteError(),
    };
  }

  #invalidateReactivityLog(): void {
    this.#reactivityLogCache = undefined;
  }

  /**
   * The explicit instance a logged scoped address names when this
   * transaction carries a run identity (server-execution v2 stage A):
   * the scheduler's dependency/trigger keys then key the read to THAT
   * instance (`entityKey` prefers it), so one node's N instance runs
   * register N distinct reads of one doc and a change to one instance
   * wakes exactly its readers. Absent for space-scope addresses (one
   * instance) and for every transaction without a run identity — the
   * logged address is then byte-identical to before.
   */
  #instanceOf(scope: CellScope | undefined): ScopeKey | undefined {
    const identity = this.#scopeKeyIdentity;
    if (identity === undefined) return undefined;
    const name = normalizeCellScope(scope);
    if (name === "space" || !canResolveScopeKey(name, identity)) {
      return undefined;
    }
    return resolveScopeKey(name, identity);
  }

  #buildReactivityLog(): TransactionReactivityLog {
    const reads: IMemorySpaceAddress[] = [];
    const shallowReads: IMemorySpaceAddress[] = [];
    let attemptedWrites: IMemorySpaceAddress[] | undefined;

    for (const read of this.#readActivities) {
      const meta = read.meta ?? EMPTY_META;
      const ignored = isReadIgnoredForScheduling(meta);
      const attempted = isReadMarkedAsAttemptedWrite(meta);
      if (ignored && !attempted) continue;

      const instance = this.#instanceOf(read.scope);
      const address = {
        space: read.space,
        scope: read.scope,
        id: read.id,
        ...(instance !== undefined ? { scopeKey: instance } : {}),
        path: read.path,
      };

      if (attempted) {
        attemptedWrites ??= [];
        attemptedWrites.push(address);
      }
      if (ignored) continue;
      if (read.nonRecursive === true) {
        shallowReads.push(address);
      } else {
        reads.push(address);
      }
    }

    const writes: IMemorySpaceAddress[] = [];
    for (const [space, branch] of this.#branches.entries()) {
      for (const [key, doc] of branch.docs.entries()) {
        if (!isWritableDocument(doc)) {
          continue;
        }

        const { id, scope } = this.#parseDocKey(key);
        const reactivityPaths = new Map<string, readonly string[]>();
        for (const detail of doc.patchDetails.values()) {
          for (
            const path of buildReactivityPathsForChange(
              doc.initial.value,
              doc.current.value,
              detail.address.path,
            )
          ) {
            reactivityPaths.set(encodePointer(path), path);
          }
        }

        const instance = this.#instanceOf(scope);
        for (
          const path of [...reactivityPaths.values()].sort(compareDocPaths)
        ) {
          writes.push({
            space,
            scope,
            id,
            ...(instance !== undefined ? { scopeKey: instance } : {}),
            path,
          });
        }
      }
    }

    return {
      reads,
      shallowReads,
      writes,
      ...(attemptedWrites && attemptedWrites.length > 0
        ? { attemptedWrites }
        : {}),
    };
  }

  /** Records every read and retains mutable classifications for later checks. */
  #recordReadActivity(read: IReadActivity): void {
    if (read.meta === stableInternalVerifierRead) {
      Object.freeze(read);
    } else {
      this.#potentiallyExternalReadActivities.push(read);
    }
    this.#readActivities.push(read);
  }

  #prepareWriteSpace(
    space: MemorySpace,
  ): Result<SpaceBranch, InactiveTransactionError | WriterError> {
    this.#assertWritable("write()");
    const ready = this.#editable();
    if (ready.error) {
      return { error: ready.error };
    }
    const claim = this.#claimWriteSpace(space);
    if (claim.error) {
      return { error: claim.error };
    }
    return { ok: this.#branch(space) };
  }

  #assertWritable(method: string): void {
    if (this.#readOnlySource === undefined) {
      return;
    }
    throw createReadOnlyTransactionError(method, this.#readOnlySource);
  }

  #branch(space: MemorySpace): SpaceBranch {
    let branch = this.#branches.get(space);
    if (!branch) {
      branch = {
        space,
        replica: this.#storage.open(space).replica,
        docs: new Map(),
      };
      this.#branches.set(space, branch);
    }
    return branch;
  }

  #replicaForCommit(
    space: MemorySpace,
  ): ReturnType<IStorageManager["open"]>["replica"] {
    return this.#branches.get(space)?.replica ??
      this.#storage.open(space).replica;
  }

  #document(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): { doc: DocumentEntry } {
    const scope = normalizeCellScope(address.scope);
    if (
      this.#lastDocument?.branch === branch &&
      this.#lastDocument.id === address.id &&
      this.#lastDocument.type === (address.type ?? DOCUMENT_MIME) &&
      this.#lastDocument.scope === scope
    ) {
      return { doc: this.#lastDocument.doc };
    }

    const key = this.#docKey(address);
    let doc = branch.docs.get(key);
    if (!doc) {
      const loaded = this.#loadRoot(branch, address);
      doc = {
        initial: loaded,
        validated: false,
      };
      branch.docs.set(key, doc);
    }
    this.#lastDocument = {
      branch,
      id: address.id,
      type: address.type ?? DOCUMENT_MIME,
      scope,
      doc,
    };
    return { doc };
  }

  #loadRoot(
    branch: SpaceBranch,
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): RootAttestation {
    const type = address.type ?? DOCUMENT_MIME;
    if (hasDataUriScheme(address.id)) {
      const loaded = loadInline({ id: address.id, type });
      if (loaded.error) {
        throw loaded.error;
      }
      return loaded.ok as RootAttestation;
    }

    // The tx→replica identity seam (server-execution v2 stage A, OW17):
    // a served per-instance run reads ITS instance of a scoped doc — the
    // replica holds one local doc per instance. Absent (every client,
    // the OFF arm) the replica resolves its own, exactly as before.
    this.#loadedUnderIdentity = true;
    const identity = this.#scopeKeyIdentity;
    const value = toTransactionDocumentValue(
      isDurableReadTx(this) && branch.replica.getNonSpeculativeDocument
        ? branch.replica.getNonSpeculativeDocument(
          address.id,
          address.scope,
          identity,
        )
        : branch.replica.getDocument(address.id, address.scope, identity),
    );
    // The runner's explicit-instance read, transaction layer (stage A): a
    // per-instance run's read of a scoped instance the replica has NEVER
    // seen kicks an instance-named load — the serving replica only ever
    // receives the SERVICE's instances through its own watches (the
    // memory server resolves a root's scoped links against the loopback
    // session), so a demander's instance arrives only when a read names
    // it. The read itself stays absent; the read is logged under that
    // instance, so the reader re-runs when the doc lands. Reserved once
    // per (space, instance, id) per manager (`shouldPullDoc`), like the
    // link-target kick in `Runtime.ensureLinkedDocLoaded`. Never on the
    // OFF arm (no identity) — byte-identical read path.
    if (
      !usesLocalReads(this) &&
      value === undefined && identity !== undefined &&
      normalizeCellScope(address.scope) !== "space" &&
      typeof this.#storage.syncInstance === "function" &&
      this.#storage.shouldPullDoc?.(
          branch.space,
          address.id,
          address.scope,
          identity,
        ) === true
    ) {
      this.#storage.trackUntilSettled(
        this.#storage.syncInstance(
          { space: branch.space, id: address.id, scope: address.scope },
          identity,
        ).catch(() => {
          // A failed load surfaces through the sync-failure log and the
          // pending-load ledger; the kick reservation was handed back.
        }),
      );
    }

    // The root address names the loaded INSTANCE (stage A) so the
    // commit-time claim re-reads exactly it (`claim` → `replica.get`);
    // absent for the manager's own identity — byte-identical address.
    const instance = this.#instanceOf(address.scope);
    return {
      address: {
        id: address.id,
        type,
        path: [],
        scope: normalizeCellScope(address.scope),
        ...(instance !== undefined ? { scopeKey: instance } : {}),
      },
      value,
    };
  }

  validateReplicaRoutes(): Result<Unit, IStorageTransactionInconsistent> {
    for (const [space, branch] of this.#branches) {
      const route = this.#validateReplicaRoute(space, branch);
      if (route.error) return route;
    }
    return { ok: {} };
  }

  #validateReplicaRoute(
    space: MemorySpace,
    branch: SpaceBranch,
    emptyReactiveCommit?: true,
  ): Result<Unit, IStorageTransactionInconsistent> {
    const currentReplica = this.#storage.open(space).replica;
    if (currentReplica === branch.replica) return { ok: {} };
    const firstDocument = branch.docs.values().next().value;
    if (firstDocument === undefined) return { ok: {} };
    const { address, value: expected } = firstDocument.initial;
    const actual = toTransactionDocumentValue(
      isDurableReadTx(this) &&
        currentReplica.getNonSpeculativeDocument
        ? currentReplica.getNonSpeculativeDocument(
          address.id as URI,
          address.scope,
          this.#scopeKeyIdentity,
        )
        : currentReplica.getDocument(
          address.id as URI,
          address.scope,
          this.#scopeKeyIdentity,
        ),
    );
    return {
      error: StateInconsistency({
        address,
        expected,
        actual,
        space,
        emptyReactiveCommit,
      }),
    };
  }

  /**
   * Validates a reactive run before accepting its unchanged output. An input
   * can change before the scheduler installs the run's read subscriptions;
   * rejecting that stale snapshot lets its normal retry observe the change.
   */
  #finishEmptyCommit(): Result<Unit, CommitError> {
    if ((this as IStorageTransaction).validateReactiveReads) {
      const validation = this.#validateReactiveReads();
      if (validation.error) {
        // Retain the read activity so the scheduler can subscribe and retry.
        this.#state = { status: "done", result: validation };
        return validation;
      }
    }
    const result = { ok: {} } satisfies Result<Unit, CommitError>;
    this.#finish(result);
    return result;
  }

  /** Checks exactly the deep and shallow reads that wake a reactive run. */
  #validateReactiveReads(): Result<Unit, StorageTransactionFailed> {
    for (const [space, branch] of this.#branches) {
      const route = this.#validateReplicaRoute(space, branch, true);
      if (route.error) return route;
    }
    const log = this.getReactivityLog();
    for (
      const [reads, shallow] of [
        [log.reads, false],
        [log.shallowReads, true],
      ] as const
    ) {
      for (const address of reads) {
        const branch = this.#branches.get(address.space);
        const doc = branch?.docs.get(this.#docKey(address));
        // Read recording creates both before adding activity. If a future
        // read path violates that invariant, fail closed before storage.
        if (branch === undefined || doc === undefined) {
          return {
            error: TransactionAborted(
              `Reactive read has no transaction snapshot: ${address.space}/${address.id}`,
            ),
          };
        }
        const replica = branch.replica;
        const current = toTransactionDocumentValue(
          isDurableReadTx(this) && replica.getNonSpeculativeDocument
            ? replica.getNonSpeculativeDocument(
              address.id,
              address.scope,
              this.#scopeKeyIdentity,
            )
            : replica.getDocument(
              address.id,
              address.scope,
              this.#scopeKeyIdentity,
            ),
        );
        const expected = readValueAtPath(doc.initial.value, address.path, {
          allowArrayLength: true,
        });
        const actual = readValueAtPath(current, address.path, {
          allowArrayLength: true,
        });
        if (
          hasValueAtPath(doc.initial.value, address.path, {
              allowArrayLength: true,
            }) !== hasValueAtPath(current, address.path, {
              allowArrayLength: true,
            }) ||
          (shallow
            ? shallowStructureChanged(expected, actual)
            : !valueEqual(expected, actual))
        ) {
          return {
            error: StateInconsistency({
              address,
              space: address.space,
              expected,
              actual,
              emptyReactiveCommit: true,
            }),
          };
        }
      }
    }
    return { ok: {} };
  }

  /**
   * The commit-time claim check over every space this transaction touched:
   * each snapshotted document is re-read from its replica, and a value that
   * differs from the snapshot rejects the transaction before its read set
   * is built (03-commit-model.md §3.3.4).
   */
  #validate(): Result<Unit, IStorageTransactionInconsistent> {
    for (const [space, branch] of this.#branches) {
      const result = this.#validateBranch(space, branch);
      if (result.error) {
        return result;
      }
    }
    return { ok: {} };
  }

  /**
   * Like `#validate()`, except over one space. A transaction closed as one
   * commit per space runs this again for each space after the first, right
   * before that space's read set is built, because the earlier spaces'
   * round trips are awaited in between and a frame can change this space's
   * documents while they are.
   */
  #validateBranch(
    space: MemorySpace,
    branch: SpaceBranch,
  ): Result<Unit, IStorageTransactionInconsistent> {
    const route = this.#validateReplicaRoute(space, branch);
    if (route.error) return route;
    const serverJudged = this.#serverJudgedDocuments(space);
    for (const [key, doc] of branch.docs) {
      if (!doc.validated || serverJudged.has(key)) {
        continue;
      }
      const result = claim(
        doc.initial,
        branch.replica,
        this.#scopeKeyIdentity,
        isDurableReadTx(this),
      );
      if (result.error) {
        return { error: result.error };
      }
    }
    return { ok: {} };
  }

  #docKey(
    address: Pick<IMemoryAddress, "id" | "type" | "scope">,
  ): string {
    return `${normalizeCellScope(address.scope)}\0${address.id}`;
  }

  #parseDocKey(
    key: string,
  ): { id: URI; type: MediaType; scope: CellScope } {
    const separator = key.indexOf("\0");
    if (separator === -1) {
      return { id: key as URI, type: DOCUMENT_MIME, scope: "space" };
    }
    return {
      scope: normalizeCellScope(key.slice(0, separator) as CellScope),
      id: key.slice(separator + 1) as URI,
      type: DOCUMENT_MIME,
    };
  }

  #buildPatchOperation(
    id: URI,
    type: MediaType,
    scope: CellScope,
    doc: WritableDocumentEntry,
    suppress: readonly OpSuppression[] = [],
  ): NativeStorageCommitOperation | null {
    if (doc.initial.value === undefined || doc.current.value === undefined) {
      return null;
    }

    const details = [...doc.patchDetails.values()];
    if (details.some((detail) => detail.address.path.length === 0)) {
      return null;
    }

    const patchDetails = new Map<string, {
      path: readonly string[];
      value: FabricValue | undefined;
      previousValue: FabricValue | undefined;
      valuePresent: boolean;
      previousPresent: boolean;
    }>();
    const arrayGroups = new Map<string, readonly string[]>();
    for (const detail of details) {
      const value = readValueAtPath(
        doc.current.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      const previousValue = readValueAtPath(
        doc.initial.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      // Presence-aware change detection: present-but-undefined and absent
      // both read as `undefined`, but transitions between them are real
      // changes (add/remove of an `undefined`-valued slot).
      const valuePresent = hasValueAtPath(
        doc.current.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      const previousPresent = hasValueAtPath(
        doc.initial.value,
        detail.address.path,
        { allowArrayLength: true },
      );
      if (
        valuePresent === previousPresent && valueEqual(value, previousValue)
      ) {
        // Equal-value elision. Authoritative transactions never reach
        // this builder (getNativeCommit routes them to whole-doc
        // set/delete — round-2 thread 17: the per-path forced asserts
        // that used to live here could not create ancestors a doomed
        // overlay minted, failing the completion commit engine-side).
        continue;
      }

      const arrayPatchPath = findDeepestArrayPath(
        doc.initial.value,
        doc.current.value,
        detail.address.path,
      );
      if (arrayPatchPath) {
        arrayGroups.set(arrayPatchPath.join("\0"), arrayPatchPath);
        continue;
      }

      patchDetails.set(detail.address.path.join("\0"), {
        path: detail.address.path,
        value,
        previousValue,
        valuePresent,
        previousPresent,
      });
    }

    const fullCoverCandidates: PatchDraftCandidate[] = [];
    for (const detail of patchDetails.values()) {
      const candidate = buildValuePatchCandidate(
        detail.path,
        detail.value,
        detail.previousValue,
        detail.valuePresent,
        detail.previousPresent,
      );
      if (candidate) {
        fullCoverCandidates.push(candidate);
      }
    }

    const nonCoverCandidates: PatchDraftCandidate[] = [];
    for (const arrayPath of arrayGroups.values()) {
      const beforeValue = readValueAtPath(doc.initial.value, arrayPath, {
        allowArrayLength: true,
      });
      const afterValue = readValueAtPath(doc.current.value, arrayPath, {
        allowArrayLength: true,
      });
      for (
        const candidate of buildArrayPatchCandidates(
          arrayPath,
          beforeValue,
          afterValue,
          hasValueAtPath(doc.initial.value, arrayPath, {
            allowArrayLength: true,
          }),
          hasValueAtPath(doc.current.value, arrayPath, {
            allowArrayLength: true,
          }),
        )
      ) {
        if (candidate.coversDescendants) {
          fullCoverCandidates.push(candidate);
        } else {
          nonCoverCandidates.push(candidate);
        }
      }
    }

    if (fullCoverCandidates.length === 0 && nonCoverCandidates.length === 0) {
      return null;
    }

    const tailSpliceCandidates = nonCoverCandidates.filter((candidate) =>
      candidate.tailSpliceStartIndex !== undefined
    );

    const retainedCoverCandidates = fullCoverCandidates
      .filter((candidate) =>
        !tailSpliceCandidates.some((spliceCandidate) =>
          isSubsumedByTailSplice(spliceCandidate, candidate.path)
        )
      )
      .sort((left, right) => left.path.length - right.path.length);
    const nonOverlappingCoverCandidates: typeof retainedCoverCandidates = [];
    for (const detail of retainedCoverCandidates) {
      if (
        nonOverlappingCoverCandidates.some((existing) =>
          pathsOverlap(existing.path, detail.path)
        )
      ) {
        continue;
      }
      nonOverlappingCoverCandidates.push(detail);
    }

    const retainedNonCoverCandidates = nonCoverCandidates.filter((detail) =>
      !nonOverlappingCoverCandidates.some((existing) =>
        isPrefixPath(existing.path, detail.path)
      ) &&
      !tailSpliceCandidates.some((spliceCandidate) =>
        spliceCandidate !== detail &&
        isSubsumedByTailSplice(spliceCandidate, detail.path)
      )
    );

    // Drop the candidates the append op replaces: the whole-array op at the
    // append path, and element candidates in the appended tail (index >= start).
    // Edits to existing elements (index < start) and unrelated sibling/ancestor
    // candidates are kept.
    const isSuppressed = (candidatePath: readonly string[]): boolean =>
      suppress.some(({ path, tailStart, subtree }) => {
        if (
          candidatePath.length === path.length &&
          isPrefixPath(path, candidatePath)
        ) {
          return true;
        }
        // A remove-by-value suppresses the whole subtree (any descendant); a tail
        // op suppresses only appended-tail element candidates; an increment
        // suppresses only the exact scalar path.
        if (subtree) {
          return isPrefixPath(path, candidatePath);
        }
        if (
          tailStart === undefined ||
          !isPrefixPath(path, candidatePath) ||
          candidatePath.length <= path.length
        ) {
          return false;
        }
        const childSegment = candidatePath[path.length];
        return childSegment !== undefined &&
          isArrayIndexPropertyName(childSegment) &&
          Number(childSegment) >= tailStart;
      });

    const patches: PatchOp[] = [
      ...nonOverlappingCoverCandidates
        .filter((candidate) => !isSuppressed(candidate.path))
        .map((candidate) => candidate.patch),
      ...retainedNonCoverCandidates
        .filter((candidate) => !isSuppressed(candidate.path))
        .map((candidate) => candidate.patch),
    ];

    if (patches.length === 0) {
      return null;
    }
    assertNoIndexedArrayStructuralOps(patches);

    return { op: "patch", id, type, scope, patches, value: doc.current.value };
  }

  /**
   * Builds the mergeable ops for a document's recorded intents, plus the paths
   * each covers so the diff candidates the op replaces can be suppressed. The
   * per-op payload/suppression rules live in `./mergeable-ops.ts`; here we only
   * supply each intent the working/initial array state its builder needs.
   *
   * A builder can also abandon its intent — the recorded op no longer describes
   * the transaction's local value (see `buildTailOp()` /
   * `buildRemoveByValue()`). Abandoning must poison the path here rather than
   * just skip the op, because a surviving intent still narrows the op's reads
   * out of the commit's conflict set (`v2.ts`) and would hand the replacing
   * whole-value diff a read set it has not earned. This runs inside
   * `getNativeCommit()`, which precedes that narrowing, so both sides see the
   * same intents.
   *
   * One intent is also abandoned for what its _siblings_ carry, which is why
   * the contexts are computed for all of them before any is built: a tail op's
   * payload is live values read out of the working document, so an intent whose
   * target sits inside that payload has already had its change applied by the
   * covering op, and sending it too would apply it twice (see
   * `mergeableOpPayloadContains()`). Coverage is judged on what each intent
   * _recorded_, not on which ops survived — an intent contained by an op that
   * is itself abandoned must fall back with it, so that the whole-value diff is
   * the only thing carrying that region.
   */
  #buildMergeableOps(
    doc: WritableDocumentEntry,
  ): { ops: PatchOp[]; suppress: OpSuppression[] } {
    const ops: PatchOp[] = [];
    const suppress: OpSuppression[] = [];
    if (!doc.mergeableOps || doc.current.value === undefined) {
      return { ops, suppress };
    }
    const pending = [...doc.mergeableOps.values()].map((intent) => ({
      intent,
      ctx: this.#mergeableBuildContext(doc, intent),
    }));

    const abandoned: string[] = [];
    for (const { intent, ctx } of pending) {
      const built = pending.some(({ intent: other, ctx: otherCtx }) =>
          mergeableOpPayloadContains(other, otherCtx, intent.path)
        )
        ? { abandon: true, ops: [], suppress: [] }
        : buildMergeableIntent(intent, ctx);
      if (built.abandon) {
        abandoned.push(encodePointer(intent.path));
        continue;
      }
      ops.push(...built.ops);
      suppress.push(...built.suppress);
    }
    for (const pathKey of abandoned) {
      doc.mergeableOps.delete(pathKey);
      (doc.mergeableOpsPoisoned ??= new Set()).add(pathKey);
    }
    return { ops, suppress };
  }

  /**
   * Abandons every mergeable intent a document recorded, for a commit that
   * emits the document whole. An intent narrows the reads incidental to its op
   * out of the commit's read set (`SpaceReplica.#commitReadActivities` in
   * `./v2.ts`), which is sound only while the op is what carries that region: a
   * mergeable op resolves against durable state, so the value it read does not
   * constrain it. A whole-document set carries the region instead, and it is
   * the value the run computed from what it read — so those reads are real
   * dependencies and have to stay. Abandoning is the delete-and-poison shape
   * `poisonMergeableOp()` uses, and it runs inside `getNativeCommit()`, which
   * precedes the narrowing, so both sides see the same intents.
   *
   * For a speculative seal the read set is what the entry's retirement floor
   * and its pending-read documents are built from, so an intent surviving here
   * retires the entry against a watermark that never covered what the run read.
   */
  #abandonMergeableOps(doc: WritableDocumentEntry): void {
    if (!doc.mergeableOps?.size) {
      return;
    }
    for (const pathKey of [...doc.mergeableOps.keys()]) {
      doc.mergeableOps.delete(pathKey);
      (doc.mergeableOpsPoisoned ??= new Set()).add(pathKey);
    }
  }

  /**
   * Returns the working/initial state at one intent's path, which its builder
   * turns into wire ops.
   */
  #mergeableBuildContext(
    doc: WritableDocumentEntry,
    intent: MergeableOpIntent,
  ): MergeableBuildContext {
    const working = readValueAtPath(doc.current.value, intent.path, {
      allowArrayLength: true,
    });
    const initial = doc.initial.value === undefined ? undefined : (
      readValueAtPath(doc.initial.value, intent.path, {
        allowArrayLength: true,
      })
    );
    return {
      workingArray: Array.isArray(working) ? working : undefined,
      hadInitialArray: Array.isArray(initial),
      // Presence, not definedness: an already-present slot (even holding
      // `undefined`) does not add a key to its parent, so the op does not
      // materialize a path and must not stamp `createsKey`.
      hadInitialValue: doc.initial.value !== undefined &&
        hasValueAtPath(doc.initial.value, intent.path, {
          allowArrayLength: true,
        }),
      initialArray: Array.isArray(initial)
        ? initial as readonly FabricValue[]
        : undefined,
    };
  }
}
