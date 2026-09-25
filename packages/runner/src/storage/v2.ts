import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import {
  cloneIfNecessary,
  hashStringOf,
  isKeyableObjectOrArray,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import {
  hasDataUriScheme,
  valueFromDataUri,
} from "@commonfabric/data-model/codec-data-uri";
import {
  verifySchemaDocument,
  walkSchemaDocumentClosure,
} from "@commonfabric/data-model-schema/schema-closure";
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { aclDocId, sameAcl } from "@commonfabric/memory/acl";
import type { ACL, Entity } from "@commonfabric/memory/interface";
import {
  type AuthorizationError as IAuthorizationError,
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type MemorySpace,
  type MIME,
  type Revision,
  type Signer,
  type TransactionError,
  type URI,
} from "@commonfabric/memory/interface";
import {
  type ApplyOpOperation,
  type ApplyOpResolution,
  type BranchName,
  canResolveScopeKey,
  type CellScope,
  type ClientCommit,
  type CommitClass,
  type CommitPrecondition,
  DEFAULT_BRANCH,
  type DocumentPath,
  type EntityDocument,
  type EntityIdListOptions,
  type EntityIdListResult,
  type EventAttentionResolveResult,
  type GenesisRoot,
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  isScopeKey,
  type OperationFieldQuery,
  type OperationFieldSnapshot,
  type PatchOp,
  type ReleaseOpFieldOperation,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  type SessionHolding,
  type SessionReadCeiling,
  type SessionSync,
  type SessionSyncUpsert,
  type SqliteDbRef,
  type SqliteOperation,
  type SqliteParamsWire,
  type SqliteQueryReader,
  type SqliteQueryResult,
  type SqliteRegisterDiskSourceResult,
  toDocumentPath,
  type ViewInterest,
  type ViewPlan,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import { mapLinkSchemas } from "@commonfabric/memory/v2/schema-table-links";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  applyPatchToDocument,
  PatchApplyError,
} from "../../../memory/v2/patch.ts";
import { encodePointer } from "../../../memory/v2/path.ts";
import type { JSONSchema, JSONSchemaObj } from "../builder/types.ts";
import type { Cancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  cfcEnvelopeLabelDocumentHashes,
  lookupCfcLabelDocument,
} from "../cfc/label-documents.ts";
import {
  isPrimitiveCellLink,
  type NormalizedLink,
  parseLinkPrimitive,
} from "../link-types.ts";
import { entityKey } from "../scheduler/keys.ts";
import {
  classifySchemaMeta,
  collectExternalSchemaRefHashes,
  schemaMetaRefHashes,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  acquireSchemaRegistryLease,
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../schema-registry.ts";
import { isCellScope, normalizeCellScope } from "../scope.ts";
import { normalizeSpaceHost, SpaceHostValidationError } from "../space-host.ts";
import type { RuntimeTelemetryMarker } from "../telemetry.ts";
import { combineOptionalSchema, isUnknownCellSchema } from "../traverse.ts";
import { recordCommitLocalSeq, recordCommitSeq } from "./commit-identity.ts";
import * as Differential from "./differential.ts";
import {
  type EventAppendOutcome,
  type EventAppendPacing,
  EventAppendQueue,
  type EventAppendQueueStore,
  memoryEventAppendQueueStore,
  type QueuedEventAppend,
} from "./event-append-queue.ts";
import {
  IMemoryAddress,
  IMergedChanges,
  IOperationStorageCapability,
  IPreconditionFailedError,
  IReadActivity,
  IRemoteStorageProviderSettings,
  ISpaceReplica,
  IStorageManager,
  IStorageNotification,
  IStorageProvider,
  IStorageSubscription,
  IStorageTransaction,
  IStorageTransactionInconsistent,
  NativeStorageCommit,
  PullError,
  PushError,
  ReplicaLoadFailureError,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  State,
  StorageNotification,
  StorageTransactionRejected,
  StoreReadThrough,
  toReplicaLoadFailureError,
  TransactionCommitOptions,
  UnexaminedAbsence,
  Unit,
  type ViewInterestLease,
} from "./interface.ts";
import {
  getBlindStructuralTarget,
  isDurableReadTx,
  isInternalVerifierRead,
  isMergeableOpRead,
  isReadExcludedFromConflict,
  isReadIgnoredForCommit,
  isReadMarkedAsAttemptedWrite,
  notifyCommitRejected,
  recordCoverageWait,
} from "./reactivity-log.ts";
import { SelectorTracker } from "./selector-tracker.ts";
import * as SubscriptionManager from "./subscription.ts";
import {
  getDirectTransactionMergeableOpAddresses,
  getDirectTransactionReadActivities,
  getTransactionWriteAttempts,
} from "./transaction-inspection.ts";
import { toTransactionDocumentValue } from "./v2-document.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
  type SessionFactory,
  storageAddressForHost,
  toWebSocketAddress,
} from "./v2-remote-session.ts";
import * as V2Transaction from "./v2-transaction.ts";
import {
  compactWatchEntries,
  externalizeSyncSelector,
  normalizeSyncEntries,
  normalizeSyncSelector,
  watchIdForEntry,
} from "./v2-watch.ts";

/**
 * Syncs the CFC schema document a document's `cfc.schemaHash` names and the
 * label documents its envelope references, and resolves to the sync's
 * error if it had one: the shape of `StorageManager`'s own step, and of
 * the syncer a test supplies in its place.
 */
export type CfcSchemaDocumentSyncer = (
  space: MemorySpace,
  document: EntityDocument | undefined,
) => Promise<Error | undefined>;

// A cell's CFC write-policy label lives at ["cfc"]. A mergeable write reads it as
// part of the write; that read is dropped from its conflict set.
const isCfcLabelPath = (path: readonly string[]): boolean =>
  path.length === 1 && path[0] === "cfc";

const isStrictPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length < path.length &&
  prefix.every((segment, index) => path[index] === segment);

const isSamePath = (
  a: readonly string[],
  b: readonly string[],
): boolean =>
  a.length === b.length && a.every((segment, index) => b[index] === segment);

// True when `path` is the immediate `length` child of `arrayPath` — i.e. a read
// of that array's own element count. A mergeable append / add-unique /
// remove-by-value changes this count, so such a read is a genuine dependency of
// the writer, not one of the op's own incidental sub-reads.
const isArrayLengthChildPath = (
  arrayPath: readonly string[],
  path: readonly string[],
): boolean =>
  path.length === arrayPath.length + 1 &&
  path[arrayPath.length] === "length" &&
  arrayPath.every((segment, index) => path[index] === segment);

export { watchIdForEntry } from "./v2-watch.ts";
export type { SessionFactory } from "./v2-remote-session.ts";

const logger = getLogger("storage.v2", {
  enabled: true,
  level: "error",
});
const pendingPatchLogger = getLogger("storage.v2.pending-patch", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

/** Its OWN logger, deliberately, because the module logger above sits at
 *  `level: "error"` and would swallow a warn. A session remount is the visible
 *  end of a starvation that was previously indistinguishable from a doc simply
 *  not being there (the profile-starvation fifth face was diagnosed from the
 *  ABSENCE of lines), so this one has to survive the default posture. Bounded:
 *  it fires only on an actual remount, which needs a terminated session AND an
 *  ACL commit. */
const sessionRemountLogger = getLogger("storage.v2.session-remount", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

const EMPTY_OVERLAY: ReadonlyMap<string, unknown> = new Map();

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

const DATA_URI_SYNC_CACHE_MAX = 10_000;
// Backstop for the inline conflict read-repair wait. In the connected path the
// caught-up sync arrives within a refresh cycle; this only fires if the sync is
// permanently undelivered on a still-open, never-reconnecting session, so the
// commit cannot hang forever. On expiry we surface the conflict and let the
// scheduler retry path re-gate on readiness.
const CONFLICT_READ_REPAIR_TIMEOUT_MS = 30_000;

// Strategy 1 — client-side conflict admission control (EXPERIMENT, default off).
// Once a commit conflicts, the client knows its read set is behind on the
// touched ids until the server catches it up. "preempt" (coarse) gates what we
// do with a new commit whose reads land on a still-catching-up id: assume it
// will conflict and pre-empt it locally (revert + re-run after catch-up)
// without sending. Measured NET-NEGATIVE on the lunch-poll workload: the stale
// floor taints every id a losing tx touched (incl. write targets), so it
// pre-empts commits that would have SUCCEEDED, turning them into extra
// revert+re-run cycles. 5x5 server conflicts rose ~1380 -> ~1600 (plus
// pre-empts), wall time flat (conflicts are cheap).
//
// A "hold" (precise) mode also existed here: hold the commit until catch-up,
// then run the server's precondition check LOCALLY, sending only the reads
// that still hold. It was removed (#5110 review, CT-1925) — holding one
// commit's send while a later, independent one proceeded violated the
// increasing-localSeq send order required by 04-protocol.md §3.9 (reproduced
// same-session admission order [1, 3, 2] against the real engine), and it
// never showed a measured win (NEUTRAL on lunch-poll: the staleness is only
// knowable on the server, not locally). Do not resurrect a wait-then-send
// admission gate without re-solving the ordering violation.
//
// Default off. Do NOT enable without re-measuring on the target workload.
// Catalogued in docs/development/EXPERIMENTAL_OPTIONS.md (conflictAdmissionMode).
type ConflictAdmissionMode = "off" | "preempt";
let conflictAdmissionModeOverride: ConflictAdmissionMode | undefined;
export function setConflictAdmissionMode(
  mode: ConflictAdmissionMode | undefined,
): void {
  conflictAdmissionModeOverride = mode;
}
// Back-compat for existing tests/callers: true -> coarse preempt, false -> off.
export function setConflictAdmissionEnabled(value: boolean | undefined): void {
  conflictAdmissionModeOverride = value === undefined
    ? undefined
    : (value ? "preempt" : "off");
}
function conflictAdmissionMode(): ConflictAdmissionMode {
  if (conflictAdmissionModeOverride !== undefined) {
    return conflictAdmissionModeOverride;
  }
  try {
    const value = Deno.env.get("CF_CONFLICT_ADMISSION");
    if (value === "preempt" || value === "1" || value === "true") {
      return "preempt";
    }
    return "off";
  } catch {
    return "off";
  }
}

/**
 * Identity of one data-URI pull: the URI, the schema it was read against, the
 * path into it, where it lives, and the identity resolving its linked cells.
 *
 * The result is a hash rather than those parts joined together. A data URI
 * carries its whole value in its id, so the id is the one part that varies
 * without bound — a rendered UI tree reaches tens of kilobytes — and a cache
 * keyed on it directly would cost that much per entry.
 */
export function dataURISyncKey(identity: {
  id: string;
  schema: JSONSchema | undefined;
  path: readonly string[];
  space: MemorySpace;
  scope: CellScope | undefined;
  scopeKeyIdentity?: ScopeKeyIdentity;
}): string {
  return hashStringOf([
    identity.id,
    identity.schema ? hashStringOf(identity.schema) : "",
    [...identity.path],
    identity.space,
    normalizeCellScope(identity.scope),
    identity.scopeKeyIdentity,
  ]);
}

const DOCUMENT_MIME = "application/json" as const;
const UNCACHED_TRANSACTION_VALUE = Symbol("uncachedTransactionValue");

/**
 * Placeholder entity for a conflict descriptor that names no entity. A
 * retrier compares against it rather than pulling it.
 */
export const UNKNOWN_CONFLICT_ENTITY = "of:unknown" as URI;

/**
 * Names the entity a commit's conflict descriptor is about: the first
 * operation that addresses one. A SQLite operation carries no entity
 * identifier, so a commit of nothing but SQLite writes names
 * {@link UNKNOWN_CONFLICT_ENTITY} instead.
 */
export const conflictEntityOf = (commit: ClientCommit): URI => {
  for (const operation of commit.operations) {
    if (operation.op !== "sqlite") {
      return operation.id as URI;
    }
  }
  return UNKNOWN_CONFLICT_ENTITY;
};

/**
 * One address in a `storage.push.error` marker's read set: the entity, then
 * the scope when it is not the space's own, then the path. Scope is part of
 * the address because it selects the instance a read resolved against, the
 * same way {@link commitReadActivities} keys its own exclusion by it.
 */
const readAddress = (
  read: { id: string; scope?: CellScope; path: readonly string[] },
): string => {
  const scope = normalizeCellScope(read.scope);
  const instance = scope === "space" ? read.id : `${read.id}@${scope}`;
  // `encodePointer` escapes the separator within each segment, so an entity
  // or a path segment holding one cannot spell another address. It writes a
  // separator before every segment, including the first, which the entity
  // does not take.
  return encodePointer([instance, ...read.path]).slice(1);
};

/**
 * The `storage.push.error` marker's account of a refused commit: the
 * rejection's text, the addresses in the commit's conflict set, and the
 * entities its operations address.
 *
 * Confirmed and pending reads become one list of addresses; the baseline each
 * was measured against is not part of an address.
 */
const rejectionAttribution = (
  rejection: StorageTransactionRejected,
  commit: ClientCommit,
): { message: string; reads: string[]; writes: string[] } => ({
  message: rejection.message,
  reads: [
    ...new Set(
      [...commit.reads.confirmed, ...commit.reads.pending].map(readAddress),
    ),
  ],
  writes: [
    ...new Set(
      commit.operations
        .filter((operation) => operation.op !== "sqlite")
        .map((operation) => operation.id),
    ),
  ],
});

const activeCommitPreconditions = (
  preconditions: readonly CommitPrecondition[] | undefined,
): readonly CommitPrecondition[] =>
  getCommitPreconditionsConfig()
    ? (preconditions ?? [])
    : (preconditions ?? []).filter((precondition) =>
      precondition.kind === "entity-value-hash"
    );

const toExplicitDocument = (value: FabricValue): EntityDocument => {
  if (!isObjectNotArray(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EntityDocument;
};

/**
 * The document operations of a native commit, with every root an explicit
 * document: the shape the replica applies as pending state.
 */
const documentOperationsOf = (
  transaction: NativeStorageCommit,
): NativeCommitOperation[] =>
  transaction.operations
    .filter((operation) => operation.type === DOCUMENT_MIME)
    .map((operation) =>
      operation.op === "delete"
        ? {
          op: "delete" as const,
          id: operation.id,
          scope: operation.scope,
        }
        : operation.op === "patch"
        ? {
          op: "patch" as const,
          id: operation.id,
          scope: operation.scope,
          patches: operation.patches,
          value: toExplicitDocument(operation.value),
        }
        : {
          op: "set" as const,
          id: operation.id,
          scope: operation.scope,
          value: toExplicitDocument(operation.value),
        }
    );

/**
 * The operations a commit hands the store: cell operations first, a patch
 * carrying its patches alone, and folded SQLite operations last.
 */
const storeOperationsOf = (
  operations: readonly NativeCommitOperation[],
  sqliteOps: readonly SqliteOperation[],
): ClientCommit["operations"] => [
  ...operations.map((operation) => {
    switch (operation.op) {
      case "delete":
        return operation;
      case "patch":
        return {
          op: "patch" as const,
          id: operation.id,
          scope: operation.scope,
          patches: operation.patches,
        };
      case "set":
        return {
          op: "set" as const,
          id: operation.id,
          scope: operation.scope,
          value: operation.value,
        };
    }
  }),
  ...sqliteOps,
];

type CachedTransactionValue =
  | FabricValue
  | typeof UNCACHED_TRANSACTION_VALUE
  | undefined;

type MaterializedVersion = {
  value: EntityDocument | undefined;
  transactionValue: CachedTransactionValue;
};

type PendingVersion =
  & {
    /** A sealed verdict already accepted this operation at the store seq. */
    acceptedSeq?: number;
  }
  & (
    | {
      localSeq: number;
      op: "set";
      value: EntityDocument;
    }
    | {
      localSeq: number;
      op: "patch";
      patches: PatchOp[];
      value: EntityDocument;
    }
    | {
      localSeq: number;
      op: "delete";
    }
  );

type ConfirmedVersion = MaterializedVersion & {
  seq: number;

  /** Partial local promotion of a wave whose contributions share one seq.
   * An authoritative frame replaces this record, so same-seq delivery is
   * never replayed. Entries remain only while an earlier pending contribution
   * could require reconstructing their local order. */
  localWavePromotion?: {
    base: EntityDocument | undefined;
    entries: PendingVersion[];
  };

  /**
   * The class of the covering commit — the commit whose write produced
   * `seq` (speculation.md §4's arrival-witness predicate, RULED
   * 2026-08-22). From the frame's `coverClass` on integrate (populated
   * by flag-ON servers), or recorded locally at an own commit's
   * promotion. Undefined when unknown (an OFF-arm or pre-predicate
   * frame, or `seq` 0) — the sweep treats unknown as never witnessing
   * arrival at an entry's floor.
   */
  coverClass?: CommitClass;
};

type PendingMaterializedPrefix = MaterializedVersion & {
  localSeq: number;
};

type PendingMaterializationCache = {
  confirmed: ConfirmedVersion;
  prefixes: PendingMaterializedPrefix[];
};

type DocumentRecord = {
  confirmed: ConfirmedVersion;
  pending: PendingVersion[];
  materialized?: PendingMaterializationCache;
};

type PendingPatchLogContext = {
  space: MemorySpace;
  id: URI;
  scope?: CellScope;
};

type ConfirmedCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;
  seq: number;
  nonRecursive?: boolean;
};

type PendingCommitRead = {
  id: URI;
  scope?: CellScope;
  path: DocumentPath;

  /**
   * Every pending layer the read's materialized view sat on, as an array —
   * each must resolve to an accepted commit (server pending-dependency
   * check; client cascade), and the array always includes the doc's
   * top-of-stack layer below the reader (CT-1872 1c; 03-commit-model.md
   * §3.5), whose resolution is the LEGACY staleness basis on servers that
   * ignore `basisSeq`. Scalarized to the top-of-stack element at send time
   * when the server does not advertise `pendingReadStacks` — the pre-stack
   * wire shape — and in that case the send is HELD until every omitted
   * lower dependency settles, so the old server can never durably accept a
   * commit the client cascade-rejects.
   */
  localSeq: number | number[];

  /**
   * The reader's confirmed basis for THIS document, in the SERVER's seq
   * space — the same value the confirmed branch emits as `seq`, which the
   * pre-CT-1910 pending shape discarded. A server that understands it scans
   * staleness over the FULL interval (basisSeq, head], excluding only the
   * own-session layers the read's dependency array names — for this
   * runner, which names its full surviving stack, exactly its own view —
   * repairing the pending-read basis over-advance; older servers ignore the
   * field and keep the max-dependency basis. See
   * {@link PendingRead.basisSeq} (memory/v2.ts).
   */
  basisSeq: number;

  nonRecursive?: boolean;
};

const pendingVersion = (
  localSeq: number,
  operation:
    | { op: "set"; value: EntityDocument }
    | { op: "patch"; patches: PatchOp[]; value: EntityDocument }
    | { op: "delete" },
): PendingVersion => ({ localSeq, ...operation });

const confirmedVersion = (
  seq: number,
  value: EntityDocument | undefined,
  coverClass?: CommitClass,
): ConfirmedVersion => ({
  seq,
  value,
  transactionValue: UNCACHED_TRANSACTION_VALUE,
  ...(coverClass === undefined ? {} : { coverClass }),
});

const transactionValueForVersion = (
  version: MaterializedVersion,
): FabricValue | undefined => {
  if (version.transactionValue === UNCACHED_TRANSACTION_VALUE) {
    version.transactionValue = toTransactionDocumentValue(version.value);
  }
  return version.transactionValue;
};

const applyPendingVersion = (
  base: EntityDocument | undefined,
  pending: PendingVersion,
  logContext: PendingPatchLogContext,
): EntityDocument | undefined => {
  switch (pending.op) {
    case "delete":
      return undefined;
    case "set":
      return cloneIfNecessary(pending.value) as EntityDocument;
    case "patch": {
      // Replay the layer's OPS over the base — never combine values. The
      // patch vocabulary is semantic (append / add-unique / increment /
      // splice / ...), so replaying re-folds the layer against whatever
      // base the server delivered, exactly as the server folds it on
      // accept — the client and the server share this applyPatch. Spine
      // materialization comes from the ops that allow it (createMissing),
      // mirroring the server's mergeable disposition, and the ops can only
      // express this layer's own writes, so a dropped sibling's data is
      // unrepresentable in the result (CT-1872 1a).
      try {
        return applyPatchToDocument(
          base,
          pending.patches as PatchOp[],
        ) as EntityDocument;
      } catch (error) {
        if (!(error instanceof PatchApplyError)) {
          // Only genuine inapplicability renders as a skipped layer; an
          // unexpected implementation failure must propagate.
          throw error;
        }
        // An op that cannot apply to this base (e.g. an append onto a
        // scalar a winner wrote) renders WITHOUT this layer: transiently
        // honest — the server rejects the same ops against the same base,
        // or a covering frame retires the layer with server truth. Under
        // strict semantics (CT-1875) this becomes a terminal rejection.
        pendingPatchLogger.debug("pending-replay-skip", () => [
          "pending patch layer skipped: ops do not apply to the current base",
          {
            space: logContext.space,
            id: logContext.id,
            scope: normalizeCellScope(logContext.scope),
            localSeq: pending.localSeq,
            error: String(error),
          },
        ]);
        return base;
      }
    }
  }
};

/** Whether the confirmed view covers an accepted operation. */
const isCoveredPendingVersion = (
  confirmed: ConfirmedVersion,
  pending: PendingVersion,
): boolean =>
  confirmed.localWavePromotion === undefined &&
  pending.acceptedSeq !== undefined && pending.acceptedSeq <= confirmed.seq;

/** Folds pending and locally accepted wave contributions in sealing order. */
const materializePendingVersions = (
  confirmed: ConfirmedVersion,
  pending: readonly PendingVersion[],
  logContext: PendingPatchLogContext,
): EntityDocument | undefined => {
  const promotion = confirmed.localWavePromotion;
  const interleaved = promotion !== undefined && promotion.entries.length > 0;
  const entries = interleaved
    ? [...promotion.entries, ...pending].sort((left, right) =>
      left.localSeq - right.localSeq
    )
    : pending;
  let value = interleaved ? promotion.base : confirmed.value;
  for (const entry of entries) {
    if (isCoveredPendingVersion(confirmed, entry)) continue;
    value = applyPendingVersion(value, entry, logContext);
  }
  return value;
};

const ensurePendingMaterializationCache = (
  record: DocumentRecord,
): PendingMaterializationCache => {
  const existing = record.materialized;
  if (existing && existing.confirmed === record.confirmed) {
    return existing;
  }
  const cache: PendingMaterializationCache = {
    confirmed: record.confirmed,
    prefixes: [],
  };
  record.materialized = cache;
  return cache;
};

const materializedVersionThroughPending = (
  record: DocumentRecord,
  logContext: PendingPatchLogContext,
  pendingCount = record.pending.length,
): MaterializedVersion => {
  if (pendingCount <= 0) {
    return record.confirmed;
  }
  if (record.confirmed.localWavePromotion?.entries.length) {
    // A later verdict can settle before an earlier pending contribution.
    // Reconstruct their sealing order until that unresolved prefix retires;
    // the ordinary prefix cache assumes all confirmed operations precede it.
    return {
      value: materializePendingVersions(
        record.confirmed,
        record.pending.slice(0, pendingCount),
        logContext,
      ),
      transactionValue: UNCACHED_TRANSACTION_VALUE,
    };
  }

  const cache = ensurePendingMaterializationCache(record);
  while (cache.prefixes.length < pendingCount) {
    const nextIndex = cache.prefixes.length;
    const base = nextIndex === 0
      ? record.confirmed
      : cache.prefixes[nextIndex - 1]!;
    const pending = record.pending[nextIndex]!;
    const covered = isCoveredPendingVersion(record.confirmed, pending);
    cache.prefixes.push({
      localSeq: pending.localSeq,
      value: covered
        ? base.value
        : applyPendingVersion(base.value, pending, logContext),
      transactionValue: covered
        ? base.transactionValue
        : UNCACHED_TRANSACTION_VALUE,
    });
  }
  return cache.prefixes[pendingCount - 1]!;
};

const dropMaterializedSuffix = (
  record: DocumentRecord,
  pendingIndex: number,
): void => {
  if (pendingIndex <= 0) {
    record.materialized = undefined;
    return;
  }

  const cache = record.materialized;
  if (!cache) {
    return;
  }
  if (cache.confirmed !== record.confirmed) {
    record.materialized = undefined;
    return;
  }

  cache.prefixes.length = Math.min(cache.prefixes.length, pendingIndex);
  if (cache.prefixes.length === 0) {
    record.materialized = undefined;
  }
};

/**
 * The grants a fresh non-home space's genesis ACL carries BESIDE its
 * concrete OWNER when the caller supplied no document of its own: the
 * rollout default, world-writable until ACL management has a UI
 * (04-protocol.md §4.5). It is the FALLBACK, not the rule — a caller
 * holding the space key names the exact document through
 * `registerSpaceIdentity(identity, { genesisAcl })` and the fallback is
 * never consulted. Retiring the wildcard is one edit here (`{}`), and one
 * deliberate rollout decision; nothing else in the genesis path spells the
 * wildcard out.
 */
export const DEFAULT_GENESIS_GRANTS: Readonly<ACL> = Object.freeze({
  "*": "WRITE",
});

/** The fallback genesis document for a fresh non-home space: `owner` as
 *  OWNER plus the rollout default grants. */
const defaultGenesisAcl = (owner: string): ACL => ({
  [owner]: "OWNER",
  ...DEFAULT_GENESIS_GRANTS,
});

/** The OWNER principals of a stored ACL document, the wildcard included —
 *  a space with `"*": "OWNER"` is owned by everyone, and a document that
 *  did not say so is not what stands (a non-object has none). */
const ownersOf = (document: unknown): string[] =>
  isObjectOrArray(document)
    ? Object.entries(document as Record<string, unknown>)
      .filter(([, capability]) => capability === "OWNER")
      .map(([principal]) => principal)
      .sort()
    : [];

/** Whether a stored ACL document is owned exactly as `expected` says: the
 *  same OWNER set, no more, no fewer. Grants below OWNER are the owner's to
 *  evolve and are not compared. */
const sameOwners = (stored: unknown, expected: ACL): boolean => {
  const actual = ownersOf(stored);
  const wanted = ownersOf(expected);
  return actual.length === wanted.length &&
    actual.every((principal, index) => principal === wanted[index]);
};

export interface Options {
  as: Signer;

  /**
   * Base URL of the default memory host. The storage endpoint path
   * (`/api/storage/memory`) is joined internally — pass the host, not
   * the full endpoint. This storage-only route may use HTTP, HTTPS,
   * WebSocket, or secure WebSocket.
   */
  memoryHost: URL;

  /**
   * Optional map from space DIDs to HTTP or HTTPS origin overrides. A space
   * listed here opens its storage connection against that host; absent map or
   * absent entry initially resolves to `memoryHost`. The map is fixed for
   * the manager's lifetime. A first late hint can replace a provisional
   * `memoryHost` route for an unseeded space before that route issues a
   * stateful operation.
   */
  spaceHostMap?: Record<string, string>;

  id?: string;
  settings?: IRemoteStorageProviderSettings;

  /** Space authority used only for fresh named-space ACL genesis. The durable
   *  replica session still authenticates as `as`. */
  spaceIdentity?: Signer;

  /** The event-intent queue's store seam (server-execution v2 Phase 3;
   *  events.md §5; LT9 re-ruled 2026-08-15: PROCESS-LIFETIME — reload
   *  survival is a non-goal this round). Absent = one in-memory store per
   *  manager, shared across its replicas, so an in-process replica
   *  replacement carries the predecessor's undischarged intents to the
   *  successor. Tests inject their own to observe or fail the store. */
  eventAppendQueueStore?: EventAppendQueueStore;

  /** OW27 (server-execution v2 Phase 7): the client event-append queue's
   *  per-stream send pacing — pace-never-drop, README §3.8. Absent = the
   *  default posture (`DEFAULT_EVENT_APPEND_PACING`); `false` = unpaced.
   *  Lives only in the flag-gated append path (the OFF arm never
   *  constructs the queue). */
  eventAppendPacing?: EventAppendPacing | false;

  /** Server-execution v2 Phase 5: declares this manager a SERVING
   *  manager whose home space is `servingHomeSpace`. Providers opened
   *  for OTHER spaces refuse scoped (user/session) reads fail-closed
   *  (protocol.md §2's grant-scoped read design, RULED 2026-08-13) —
   *  a serving runtime's foreign scoped read would otherwise resolve
   *  against the delegating service envelope and silently read an
   *  empty instance. Absent on every non-serving manager. */
  servingHomeSpace?: MemorySpace;
}

/**
 * Max concurrent watch-refresh round trips per space when
 * `experimentalConcurrentWatchRefresh` is on. Bounds how many requests a
 * traversal-discovered wave may have outstanding at once — high enough to hide
 * per-request latency behind a deep waterfall, low enough to keep the server's
 * receive queue and the client's outstanding-request set bounded.
 */
const CONCURRENT_WATCH_REFRESH_WINDOW = 8;

const comparePath = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    const a = left[index];
    const b = right[index];
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

// Canonical grouping/sort key for a pending read's dependency set: arrays
// are ascending, so the join is order-stable per identical stack.
const localSeqKey = (localSeq: number | number[]): string =>
  Array.isArray(localSeq) ? localSeq.join(",") : String(localSeq);

/**
 * Orders paths segment by segment, a shorter path ahead of one it prefixes.
 * That puts an ancestor directly ahead of every path below it, which is what
 * lets `compactRecursiveReads()` drop the descendants in one pass.
 */
const compareSegments = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return left.length - right.length;
};

const isPathPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/**
 * Helper for `compactCommitReads()`, which keeps the reads of one dependency
 * group that no other read of the group covers. A recursive read at a path
 * covers every path below it, so a read under another is dropped. Sorts
 * `reads` in place and returns the survivors in that order.
 */
const compactRecursiveReads = <Read extends { path: readonly string[] }>(
  reads: Read[],
): Read[] => {
  if (reads.length < 2) return reads;
  reads.sort((left, right) => compareSegments(left.path, right.path));
  const kept: Read[] = [];
  let covering: readonly string[] | undefined;
  for (const read of reads) {
    if (covering !== undefined && isPathPrefix(covering, read.path)) continue;
    kept.push(read);
    covering = read.path;
  }
  return kept;
};

const compactCommitReads = <
  Read extends ConfirmedCommitRead | PendingCommitRead,
>(
  reads: Read[],
): Read[] => {
  const dependencyKeys = new Map<number | number[], string>();
  const dependencyKeyFor = (localSeq: number | number[]): string => {
    let key = dependencyKeys.get(localSeq);
    if (key === undefined) {
      key = localSeqKey(localSeq);
      dependencyKeys.set(localSeq, key);
    }
    return key;
  };

  // Grouping reads the input in whatever order it arrives: a recursive read
  // displaces a shallow one at its path whichever comes first, and two reads
  // equal in every grouped field are interchangeable, so the order the groups
  // settle in decides nothing. The sort at the end is the one that orders.
  const grouped = new Map<string, {
    recursiveByPath: Map<string, Read>;
    nonRecursiveByPath: Map<string, Read>;
  }>();
  for (const candidate of reads) {
    // The dependency key carries every admission-relevant field — seq for
    // confirmed reads, the layer set AND basisSeq for pending reads — so
    // reads with divergent bases never merge: ancestor-path compaction
    // within a group may drop a descendant read, and a surviving ancestor
    // must not claim a higher basis than the dropped read declared.
    const dependencyKey = "seq" in candidate
      ? `confirmed:${
        normalizeCellScope(candidate.scope)
      }:${candidate.id}:${candidate.seq}`
      : `pending:${normalizeCellScope(candidate.scope)}:${candidate.id}:${
        dependencyKeyFor(candidate.localSeq)
      }:${candidate.basisSeq}`;
    let group = grouped.get(dependencyKey);
    if (!group) {
      group = {
        recursiveByPath: new Map(),
        nonRecursiveByPath: new Map(),
      };
      grouped.set(dependencyKey, group);
    }
    const pathKey = candidate.path.join("\0");
    if (candidate.nonRecursive === true) {
      if (group.recursiveByPath.has(pathKey)) {
        continue;
      }
      group.nonRecursiveByPath.set(pathKey, candidate);
    } else {
      group.nonRecursiveByPath.delete(pathKey);
      group.recursiveByPath.set(pathKey, candidate);
    }
  }

  const compacted: Read[] = [];
  for (const group of grouped.values()) {
    compacted.push(
      ...compactRecursiveReads([...group.recursiveByPath.values()]),
      ...group.nonRecursiveByPath.values(),
    );
  }

  return compacted.toSorted((left, right) => {
    const leftScope = normalizeCellScope(left.scope);
    const rightScope = normalizeCellScope(right.scope);
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }

    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1;
    }

    if ("seq" in left && "seq" in right && left.seq !== right.seq) {
      return left.seq - right.seq;
    }

    if ("localSeq" in left && "localSeq" in right) {
      const leftKey = dependencyKeyFor(left.localSeq);
      const rightKey = dependencyKeyFor(right.localSeq);
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
    }

    if (left.nonRecursive !== right.nonRecursive) {
      return left.nonRecursive === true ? -1 : 1;
    }

    return comparePath(left.path, right.path);
  });
};

const toCommitReadPath = (
  path: readonly (string | number)[],
): DocumentPath => toDocumentPath(path.map(String));

// Wire-compat downgrade for servers that do not advertise the
// `pendingReadStacks` hello flag: collapse every array dependency set —
// including those inside batched scheduler observations — to its
// top-of-stack element (the highest localSeq, i.e. the staleness basis).
// The lower-layer dependency check is lost against such servers by design
// (CT-1872 1c stays open there). pushCommit compensates by HOLDING the send
// until every omitted lower dependency settles — without the hold, the old
// server could durably accept a commit the client cascade-rejects (a
// split-brain: caller sees ConflictError for a write that landed).
const scalarizeLocalSeq = (localSeq: number | number[]): number =>
  Array.isArray(localSeq) ? Math.max(...localSeq) : localSeq;

const scalarizePendingReadStacks = (commit: ClientCommit): ClientCommit => {
  const hasStack = (reads: { localSeq: number | number[] }[]): boolean =>
    reads.some((read) => Array.isArray(read.localSeq));
  const scalarizeReads = <Read extends { localSeq: number | number[] }>(
    reads: Read[],
  ): Read[] =>
    reads.map((read) =>
      Array.isArray(read.localSeq)
        ? { ...read, localSeq: scalarizeLocalSeq(read.localSeq) }
        : read
    );
  if (!hasStack(commit.reads.pending)) {
    return commit;
  }
  return {
    ...commit,
    reads: {
      confirmed: commit.reads.confirmed,
      pending: scalarizeReads(commit.reads.pending),
    },
  };
};

/**
 * The selector schema a link target is asked for. Where the reader's schema
 * takes a handle at the link (`asCell` at its root, or at the root of an
 * `anyOf`/`oneOf` branch), the outermost handle boundary comes off, so the
 * selector describes the document's value the way the handle's reads do and
 * the serving replica holds the document as a value it keeps current rather
 * than as a reference it delivered once. Inner boundaries stay, as they do
 * on the handle's own schema, and a schema that takes no handle is asked for
 * as it is.
 */
function selectorSchemaForLink(
  schema: JSONSchema | undefined,
): JSONSchema | false {
  if (!isObjectOrArray(schema)) return schema ?? false;
  const unwrapped = unwrapOuterHandle(schema);
  const branches = (key: "anyOf" | "oneOf"): Partial<JSONSchemaObj> => {
    const list = unwrapped[key];
    if (!Array.isArray(list)) return {};
    return {
      [key]: list.map((branch) =>
        isObjectOrArray(branch) ? unwrapOuterHandle(branch) : branch
      ),
    };
  };
  return { ...unwrapped, ...branches("anyOf"), ...branches("oneOf") };
}

/** `schema` with its outermost `asCell` boundary removed, if it has one. */
function unwrapOuterHandle(schema: JSONSchemaObj): JSONSchemaObj {
  if (schema.asCell === undefined) return schema;
  const { asCell: _asCell, ...inner } = schema;
  const values = ContextualFlowControl.getAsCellValues(schema);
  return values.length > 1 ? { ...inner, asCell: values.slice(1) } : inner;
}

export class StorageManager implements IStorageManager {
  readonly id: string;
  readonly as: Signer;

  /**
   * The one authenticated session identity, shared by every space opened during
   * a manager lifecycle. `close()` invalidates those server sessions, so a
   * later sequential `Runtime` reusing this manager must start a fresh identity
   * rather than attempting to resurrect an invalidated token.
   */
  #sessionId: string;

  #settings: IRemoteStorageProviderSettings;
  #providers = new Map<MemorySpace, Provider>();
  #spaceAccessErrors = new Map<MemorySpace, Error>();
  #spaceAccessObservers = new Set<(space: MemorySpace, error: Error) => void>();
  #spaceAccessChangeObservers = new Set<(space: MemorySpace) => void>();
  #subscription = SubscriptionManager.create();
  #crossSpacePromises = new Set<Promise<void>>();

  /** The store read-throughs installed per space (see
   * IStorageManager.installStoreReadThrough); a provider resolves its
   * replica's through this map, so a replica built after the install and
   * a replacement replica both see it. */
  readonly #storeReadThroughs = new Map<MemorySpace, StoreReadThrough>();

  /**
   * Schema-registry retention lease: held for the manager's open lifetime,
   * released on close (idempotent), re-acquired when a closed manager is reused
   * through `open()`. Last lease out clears the realm's registry — the
   * session-lifetime retention contract in `schema-registry.ts`.
   */
  #schemaRegistryLease?: () => void;

  /**
   * Docs already offered a link-target pull via `shouldPullDoc()`. One entry
   * per (space, scope, id) for the manager's lifetime: the first pull registers
   * a server-side watch that keeps the doc flowing afterwards, so a second kick
   * is never needed — and never re-kicking is what keeps reads of genuinely
   * absent targets (dangling links, deleted docs) from churning the cross-space
   * convergence loop on every read.
   */
  #docPullKicks = new Set<string>();

  /**
   * Data URIs whose linked targets this manager has already pulled, keyed by a
   * hash of the URI, schema, path, space, and scope. Per manager rather than
   * per process: a hit skips the pull, and a manager that inherited another
   * manager's hit would leave its own replica without those documents.
   */
  #dataURISyncs = new BoundedKeyMap<string, Promise<void>>(
    DATA_URI_SYNC_CACHE_MAX,
  );

  /**
   * In-flight commits, registered synchronously by the transaction layer at
   * `commit()` entry (see `IStorageManager.trackPendingCommit()`). This is the
   * write-durability barrier: distinct from `#crossSpacePromises`, which also
   * carries cross-space _read_ work (link-target loads) and so must not gate
   * questions of whether there are unconfirmed writes.
   */
  #pendingCommits = new Set<Promise<unknown>>();

  #pendingCommitsSubscribers = new Set<(pending: boolean) => void>();
  #sessionFactory: SessionFactory;
  #eventAppendQueueStore?: EventAppendQueueStore;
  #eventAppendPacing?: EventAppendPacing | false;

  /** Phase 5: the serving manager's home space (Options.servingHomeSpace). */
  #servingHomeSpace?: MemorySpace;

  /** The read ceiling every session this manager opens declares
   * (`setSessionReadCeiling`); undefined on a manager whose sessions read
   * unbounded. */
  #sessionReadCeiling?: SessionReadCeiling;

  #spaceIdentities = new Map<MemorySpace, Signer>();

  /** Genesis ACL documents registered beside a space identity — the exact
   * document a fresh space is born with. `{ owner }` (OW31: the ACTING
   * user a serving-side provisioning run supplied) is stored here already
   * expanded into the fallback shape, so there is one representation and
   * one reader. Absent (every client that registered nothing), the
   * fallback is computed at genesis from the signer, byte-identical to the
   * pre-OW31 shape. A later registration for the same space replaces an
   * earlier one, as re-registering an owner always did. `supplied` marks a
   * caller's own document — the one registration whose genesis must land
   * exactly or be reported (see the ConflictError arm of
   * `#createInitializedSession`). */
  #spaceGenesisAcls = new Map<
    MemorySpace,
    { document: ACL; supplied: boolean; root?: GenesisRoot }
  >();

  /** Resume options for a space's manager-wide session that
   * `#createInitializedSession` detached ahead of a bootstrap that then
   * failed (a refused genesis, a lost route). The memory server keeps a
   * detached session resumable by its token for a TTL, so the next attempt
   * must present that token or be refused with "resume token is no longer
   * valid" — a wedge that hid the real error until the manager closed.
   * Recorded as soon as the manager-wide session is mounted (every later
   * throw leaves it detached), deleted the moment a session is handed to
   * the provider, and cleared by close(), which rotates the session id
   * the entry names. Scoped to the route generation it was minted under:
   * a token belongs to one host, and a replay after a route replacement
   * must not present the old host's token to the new one. */
  #detachedSessionResumes = new Map<
    MemorySpace,
    { options: MemoryV2Client.MountOptions; routeGeneration: number }
  >();

  /** Where each space's first mount stands on this manager: an attempt in
   * flight (the registered document is being read), or a session handed to
   * the provider (the document was consulted, or the space needed none). A
   * genesisAcl registered in either state could never be the space's
   * genesis, so registration refuses. A failed attempt leaves no entry — the
   * caller may correct the document and retry — and close() clears it. */
  #genesisPhase = new Map<
    MemorySpace,
    { phase: "in-flight"; attempt: symbol } | { phase: "handed-off" }
  >();

  /** Seed map from Options — fixed for the manager's lifetime. */
  #seedHosts: Record<string, string>;

  /** Late-bound host hints; see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();

  /** Base URL the default storage route is resolved from, held as text so a
   *  caller mutating their URL object cannot move the route. */
  #memoryHost: string;

  /** WebSocket storage endpoint used by an unseeded, unhinted space; read it
   *  through #resolveDefaultStorageRoute(). */
  #defaultStorageRoute?: string;

  /** Whether #defaultStorageRoute holds the result of a resolution attempt.
   *  Separate from the value, which is undefined when resolution failed. */
  #defaultStorageRouteResolved = false;

  /** Late-bound marker sink (the Runtime's telemetry bus); see setTelemetry. */
  #telemetry?: TelemetrySink;

  /**
   * In-flight document loads keyed `space/scope_key/id` (the scheduler's
   * `entityKey` format — one entry per scope _instance_, `key-vocabulary.md` §1
   * site 7: two instances of one doc are two loads, and collapsing them would
   * make one waiter observe another's failure). Keys are _built_ with
   * `entityKey()` so the strings cross-match the scheduler's
   * (`collectPendingLoadParkKeys()` correlates the two maps); both sides
   * resolve against this manager's own session identity. Refcounted: concurrent
   * `syncCell()` calls for the same document share one entry. Waiters resolve
   * when the count returns to zero — whether the load produced a value or found
   * the document absent.
   */
  #pendingLoads = new Map<string, {
    count: number;
    generation: number;
    address: {
      space: MemorySpace;
      scope: CellScope;
      id: URI;
      scopeKey?: ScopeKey;
    };
    failure: unknown;
    waiters: Set<(failure: unknown) => void>;
  }>();

  /**
   * The next pending-load generation. A positive recovery signal is
   * key-specific: successful settlement of a new generation for one doc names
   * that doc's stable failed boundary. Only a durable checkpoint carrying the
   * same boundary wakes, so unrelated loads remain inert. The boundary is
   * stable across manager recreation; the replacement epoch remains unique.
   */
  #nextPendingLoadGeneration = 1;

  readonly #loadRecoveryIdentity = crypto.randomUUID();
  #loadRecoveryObserver:
    | ((recovery: {
      failedEpoch: string;
      recoveryEpoch: string;
    }) => void)
    | undefined = undefined;

  /**
   * Sync failures already logged, keyed by (space, error identity). A denied
   * space repeats the identical failure for every doc pulled from it; one line
   * per distinct failure keeps the surfacing readable. Bounded: at the cap the
   * set resets, trading a repeated line for an unbounded set.
   */
  #loggedSyncFailures = new Set<string>();

  /**
   * The syncer a test supplies in place of the CFC schema document sync;
   * `undefined` means the manager's own.
   */
  #cfcSchemaDocumentSyncer: CfcSchemaDocumentSyncer | undefined = undefined;

  /**
   * Attach the runtime's telemetry bus so replicas can emit the
   * `storage.push/pull.*` markers. Late-bound and optional: the manager is
   * constructed before (and independently of) the Runtime, and providers read
   * it through a getter so spaces opened earlier still pick it up.
   */
  setTelemetry(telemetry: TelemetrySink): void {
    this.#telemetry = telemetry;
  }

  /** Changes memory-message compression for live and later remote sessions. */
  async setMessageCompressionEnabled(enabled: boolean): Promise<void> {
    await this.#sessionFactory.setMessageCompressionEnabled?.(enabled);
  }

  protected constructor(
    options: Options,
    sessionFactory: SessionFactory,
  ) {
    this.id = options.id ?? crypto.randomUUID();
    this.#sessionId = this.id;
    this.#schemaRegistryLease = acquireSchemaRegistryLease();
    this.as = options.as;
    this.#settings = options.settings ?? {};
    this.#sessionFactory = sessionFactory;
    // ONE store per manager (verdict blocker, 2026-08-12 / LT9): the
    // store must outlive any single SpaceReplica, or a provisional-replica
    // replacement hands the new queue a FRESH private store and the old
    // queue's undischarged user intents vanish in-process. That is the
    // one persistence class the queue has (process-lifetime; LT9
    // re-ruled 2026-08-15 — see event-append-queue.ts).
    this.#eventAppendQueueStore = options.eventAppendQueueStore ??
      memoryEventAppendQueueStore();
    this.#eventAppendPacing = options.eventAppendPacing;
    this.#servingHomeSpace = options.servingHomeSpace;
    if (options.spaceIdentity) {
      this.registerSpaceIdentity(options.spaceIdentity);
    }
    // Snapshot + freeze: the resolver snapshotted its own copy at
    // open(), so refusal logic must see the same fixed facts — a
    // caller mutating their map object must not desynchronize them.
    this.#seedHosts = Object.freeze({ ...(options.spaceHostMap ?? {}) });
    this.#memoryHost = String(options.memoryHost);
  }

  /**
   * The CFC schema document syncer a test may supply, the pending-load
   * registration step, and the linked-cell sync collector, which a test
   * drives directly.
   */
  get accessForTestingOnly(): {
    cfcSchemaDocumentSyncer: CfcSchemaDocumentSyncer | undefined;
    registerPendingLoad(address: {
      space: MemorySpace;
      scope: CellScope;
      id: URI;
      scopeKey?: ScopeKey;
    }): (failure?: unknown) => void;
    collectLinkedCellSyncs(
      value: unknown,
      base: NormalizedLink,
      schema: JSONSchema | undefined,
      promises: Promise<unknown>[],
      seen: Set<unknown>,
    ): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get cfcSchemaDocumentSyncer() {
        return outerThis.#cfcSchemaDocumentSyncer;
      },
      set cfcSchemaDocumentSyncer(value) {
        outerThis.#cfcSchemaDocumentSyncer = value;
      },
      registerPendingLoad: (address) => this.#registerPendingLoad(address),
      collectLinkedCellSyncs: (value, base, schema, promises, seen) =>
        this.#collectLinkedCellSyncs(
          value,
          base,
          schema,
          promises,
          seen,
          undefined,
        ),
    };
  }

  /**
   * Observer of a pending load's recovery, called with the failed and the
   * recovering epochs; the space server sets one while it serves.
   */
  get loadRecoveryObserver():
    | ((recovery: { failedEpoch: string; recoveryEpoch: string }) => void)
    | undefined {
    return this.#loadRecoveryObserver;
  }

  set loadRecoveryObserver(
    value:
      | ((recovery: { failedEpoch: string; recoveryEpoch: string }) => void)
      | undefined,
  ) {
    this.#loadRecoveryObserver = value;
  }

  /**
   * The WebSocket storage endpoint an unseeded, unhinted space opens against,
   * resolved from the memory host on the first read and kept from then on.
   * registerSpaceHost() is its only reader. A failed resolution is kept as
   * well: a custom session factory may use a non-network memoryHost
   * placeholder, and such a manager has no default route.
   */
  #resolveDefaultStorageRoute(): string | undefined {
    if (!this.#defaultStorageRouteResolved) {
      this.#defaultStorageRouteResolved = true;
      try {
        const resolveDefault = createStorageAddressResolver(
          new URL(this.#memoryHost),
        );
        this.#defaultStorageRoute = toWebSocketAddress(
          resolveDefault("did:key:route-comparison" as MemorySpace),
        ).toString();
      } catch {
        // The route stays undefined; the flag above stops the retry.
      }
    }
    return this.#defaultStorageRoute;
  }

  /**
   * Records a runtime-learned HTTP or HTTPS origin for a space (e.g. from
   * the home-space site table). Returns true when the hint is accepted or
   * confirms a configured or previously accepted route. Refusals:
   *
   * - The seed map wins: a seeded space cannot be re-pointed.
   * - The first accepted late hint remains in effect.
   * - A provider opened through the default route is provisional until its
   *   session accepts a stateful operation. Its first accepted hint replaces
   *   that route and replays its reads.
   * - A different-host hint cannot replace a route after a stateful operation
   *   is issued.
   *
   * Idempotent when the hint matches what is already in effect.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid host for space ${space}`,
        { cause },
      );
    }
    const normalized = route.toString();
    const seeded = this.#seedHosts[space];
    if (seeded !== undefined) {
      return new URL(seeded).toString() === normalized;
    }
    const existing = this.#dynamicHosts.get(space);
    if (existing !== undefined) {
      return existing === normalized;
    }
    const provider = this.#providers.get(space);
    const replacesDefaultRoute = provider !== undefined &&
      this.#resolveDefaultStorageRoute() !==
        toWebSocketAddress(storageAddressForHost(normalized)).toString();
    if (replacesDefaultRoute && !provider.canReplaceProvisionalReplica()) {
      return false;
    }
    this.#dynamicHosts.set(space, normalized);
    if (replacesDefaultRoute) {
      this.trackUntilSettled(provider.replaceProvisionalReplica());
    }
    return true;
  }

  /**
   * Retain a derived space key solely as the authority for that space's first
   * ACL commit. Providers continue to authenticate all ordinary replica work
   * as `this.as`.
   *
   * `options.owner` names the genesis ACL's OWNER (OW31, RULED 2026-08-18):
   * on a SERVING runtime the acting user of the provisioning run is
   * threaded here, so the space's first commit — signed by the space's own
   * keys — immediately delegates OWNER to that user and the serving
   * identity appears nowhere in the ACL. Absent (every client), the owner
   * is the manager's signer: the active user, the pre-OW31 shape
   * byte-for-byte.
   *
   * `options.genesisAcl` names the EXACT document a fresh space is born
   * with — its first and only genesis commit, with no intermediate
   * default ever written — so a space is never in a world-writable state
   * it did not ask for. It is validated by the memory server's own
   * genesis admission (a concrete OWNER, an ACL-only commit; INV-12/13),
   * never here: a refused document leaves the space uninitialized and
   * the open rejects, and a corrected registration may retry. The
   * document is a demand: the space's first open on this manager
   * proceeds only if the space is fresh (the document becomes its only
   * commit) or is already owned exactly as the document says — a seal
   * asserts ownership, and grants below OWNER are the owner's to evolve
   * afterwards, so a creator's restart survives its own grants; a space
   * populated before genesis, a retracted ACL, or a genesis another
   * initializer won under a different owner is refused rather than
   * silently entered under someone else's ACL. A genesis race this
   * attempt loses (the space was fresh when it looked) is held to the
   * exact document: what stands was written moments ago, not evolved,
   * and the likely winner — the same user's other runtime writing the
   * wildcard default — is precisely what the seal refused. It never
   * reaches the home arm. A caller that will open the
   * space itself must grant its own signer at least READ, or every open
   * after genesis is refused by the server. `owner` and `genesisAcl` are
   * two descriptions of one document, so supplying both in one
   * registration is refused rather than silently ranked; a registration
   * after the space's first mount has begun is refused too.
   */
  registerSpaceIdentity(
    identity: Signer,
    options?: { owner?: string; genesisAcl?: ACL; genesisRoot?: GenesisRoot },
  ): void {
    const space = identity.did() as MemorySpace;
    const owner = options?.owner;
    const genesisAcl = options?.genesisAcl;
    if (options?.genesisRoot !== undefined && genesisAcl === undefined) {
      throw new Error("genesisRoot requires an explicit genesisAcl");
    }
    if (owner !== undefined && genesisAcl !== undefined) {
      throw new Error(
        `registerSpaceIdentity(${space}): supply either owner or genesisAcl, ` +
          "not both — genesisAcl is the whole genesis document, and owner " +
          "only names the OWNER of the default one",
      );
    }
    if (genesisAcl !== undefined && this.#genesisPhase.has(space)) {
      // The document is read during the space's first mount; that mount is
      // under way or done, without it.
      throw new Error(
        `registerSpaceIdentity(${space}): the space is already open on this ` +
          "manager, so the supplied genesisAcl could never be its genesis — " +
          "register the document before the first open",
      );
    }
    if (
      genesisAcl !== undefined &&
      this.#sessionFactory.supportsAclBootstrap !== true
    ) {
      // A document nobody will write is a seal that never lands; the
      // caller asked for a closed space and would get an ACL-less one.
      throw new Error(
        `registerSpaceIdentity(${space}): this manager's session factory ` +
          "cannot bootstrap an ACL, so the supplied genesisAcl would never " +
          "be written",
      );
    }
    this.#spaceIdentities.set(space, identity);
    if (owner !== undefined) {
      this.#spaceGenesisAcls.set(space, {
        document: defaultGenesisAcl(owner),
        supplied: false,
      });
    }
    if (genesisAcl !== undefined) {
      // Snapshot: what genesis writes is what was registered, not what the
      // caller's object holds by the time the space is first opened.
      this.#spaceGenesisAcls.set(space, {
        document: { ...genesisAcl },
        ...(options?.genesisRoot === undefined
          ? {}
          : { root: cloneIfNecessary(options.genesisRoot, { frozen: false }) }),
        supplied: true,
      });
    }
  }

  /**
   * The delegated READ binding a SERVING manager's ordinary session
   * mounts carry (OW31, READ side RULED 2026-08-19): `actingAs:
   * "space-owner"` asks the memory server to resolve the session's
   * READ-class capability as the space's ACL OWNER — the user whose
   * space it is — admitted only for the delegating-class process
   * identity (the flag-gated list). Only serving managers
   * (`servingHomeSpace` set) send it; clients and the toolshed's own
   * non-serving runtimes never do, and the fresh-space BOOTSTRAP
   * session (which signs as the SPACE identity, an implicit owner)
   * never does either.
   */
  #servingActingAs(): { actingAs?: "space-owner" } {
    return this.#servingHomeSpace !== undefined
      ? { actingAs: "space-owner" }
      : {};
  }

  /**
   * The descriptor fields every session this manager opens carries beyond
   * its id: the serving binding and the declared read ceiling. One place,
   * so a reopen, a resume and a fresh mount all declare the same session.
   */
  #sessionDescriptorFields(space: MemorySpace): {
    genesisRoot?: GenesisRoot;
    actingAs?: "space-owner";
    readCeiling?: SessionReadCeiling;
  } {
    return {
      ...(this.#spaceGenesisAcls.get(space)?.root === undefined
        ? {}
        : { genesisRoot: this.#spaceGenesisAcls.get(space)!.root }),
      ...this.#servingActingAs(),
      ...(this.#sessionReadCeiling !== undefined
        ? { readCeiling: this.#sessionReadCeiling }
        : {}),
    };
  }

  /** See `IStorageManager.setSessionReadCeiling`. */
  setSessionReadCeiling(ceiling: SessionReadCeiling): void {
    if (this.#providers.size > 0) {
      throw new Error(
        "setSessionReadCeiling: a session is already open; a ceiling " +
          "declared now would leave it reading unbounded",
      );
    }
    this.#sessionReadCeiling = ceiling;
  }

  /** The serving manager's HOME space (Options.servingHomeSpace) —
   * undefined on every client manager. Consumers use it to decide
   * whether a write target is FOREIGN to the serving loop (OW31 seat
   * S-A: the compile-cache writeback attaches its trigger's delegated
   * carriage only for foreign targets). */
  get servingHomeSpace(): MemorySpace | undefined {
    return this.#servingHomeSpace;
  }

  /**
   * The manager's own authenticated session identity (IStorageManager
   * contract): every provider session authenticates as `this.as` and mounts
   * with `#sessionId`, so this pair is exactly what the memory server
   * resolves this manager's scoped operations against.
   */
  scopeKeyIdentity(): ScopeKeyIdentity {
    return { principal: this.as.did(), sessionId: this.#sessionId };
  }

  /**
   * Force `space`'s provider session — and with it, on a bootstrap-capable
   * session factory, the fresh-space ACL genesis (`#createInitializedSession`)
   * — to have completed (OW31 B4; protocol.md §2b's genesis clause). The
   * serving loop's wave commit step calls this for every `creation`-granted
   * foreign target BEFORE the sink applies its data batch, so the space's
   * commit #1 is its ACL. Idempotent: an already-mounted session (or an
   * already-initialized space) resolves immediately.
   */
  async ensureSpaceInitialized(space: MemorySpace): Promise<void> {
    await this.open(space).ensureSession?.();
  }

  async resolveEventAttention(
    space: MemorySpace,
    eventId: string,
    seq: number,
    sidecarId: string,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResult> {
    const replica = this.open(space).replica;
    if (replica.resolveEventAttention === undefined) {
      throw new Error("storage replica does not support event attention");
    }
    return await replica.resolveEventAttention(eventId, seq, sidecarId, action);
  }

  /** IStorageManager (server-execution v2 Phase 4): first-open observer
   * — the flag-ON client effects channel subscribes per space through
   * it. Assigned post-construction by the Runtime; undefined otherwise. */
  spaceOpenObserver?: (space: MemorySpace) => void;

  /** IStorageManager (Phase 4): the currently-open spaces, for the
   * effects channel's construction-time sweep. */
  openedSpaces(): MemorySpace[] {
    return [...this.#providers.keys()];
  }

  /**
   * IStorageManager — THE SESSION REMOUNT's trigger (see
   * SpaceReplica.#consumeOwedSessionRemount): an admitted commit touched
   * `space`'s ACL document, so a session this manager holds on that space
   * — revoked when an EARLIER ACL landed — may now re-open under a
   * different verdict. The executor host calls this for every registered
   * space server on every ACL-doc-touching admission; `space` is usually
   * NOT the caller's own, because the session that starves is typically a
   * CROSS-SPACE replica (a served dispatch's argument link into the
   * viewer's home space).
   *
   * ALREADY-OPEN providers only. Opening one here would mount a session
   * for a space this manager has never read, turning an unrelated ACL
   * commit into a connection.
   */
  noteSpaceAclChanged(space: MemorySpace): void {
    this.#providers.get(space)?.noteAclChanged();
  }

  isContentAddressedDocPersisted(space: MemorySpace, hash: string): boolean {
    // Already-open replicas only: creating a provider is a session-level
    // side effect no elision probe should carry. A space this manager has
    // not opened answers false, and false stages.
    return this.#providers.get(space)?.replica.isContentAddressedDocPersisted(
      hash,
    ) ??
      false;
  }

  /** @inheritDoc */
  installStoreReadThrough(space: MemorySpace, read: StoreReadThrough): void {
    this.#storeReadThroughs.set(space, read);
  }

  /** @inheritDoc */
  integrateStoreWrites(
    space: MemorySpace,
    writes: readonly { id: string; scopeKey: ScopeKey }[],
  ): number {
    // Already-open replicas only, like isContentAddressedDocPersisted: a
    // space this manager has not opened holds nothing to refresh.
    return this.#providers.get(space)?.replica.integrateStoreWrites(writes) ??
      0;
  }

  open(space: MemorySpace): IStorageProvider {
    // A manager reused after close() starts a new session; retention
    // follows it.
    this.#schemaRegistryLease ??= acquireSchemaRegistryLease();
    let provider = this.#providers.get(space);
    const firstOpen = !provider;
    if (!provider) {
      // Session principal drives user/session scoped storage. Even when we have
      // a derived space key for named spaces, the connection must authenticate
      // as the active user.
      const signer = this.as;
      const routeState: ProviderRouteState = { generation: 0 };
      provider = new Provider({
        as: signer,
        space,
        settings: this.#settings,
        subscription: this.#subscription,
        scopeKeyIdentity: () => this.scopeKeyIdentity(),
        // Phase 5's producer-side foreign-scoped-read refusal: only a
        // serving manager sets a home space, and only its FOREIGN
        // providers refuse (see Options.servingHomeSpace).
        refuseForeignScopedReads: this.#servingHomeSpace !== undefined &&
          this.#servingHomeSpace !== space,
        storeReadThrough: () => this.#storeReadThroughs.get(space),
        routeState,
        createSession: this.#sessionFactory.supportsAclBootstrap === true
          ? (routeGeneration, routeSignal) =>
            this.#createInitializedSession(
              space,
              signer,
              routeState,
              routeGeneration,
              routeSignal,
            )
          : (_routeGeneration, routeSignal) =>
            this.#sessionFactory.create(space, signer, {
              sessionId: this.#sessionId,
              ...this.#sessionDescriptorFields(space),
            }, routeSignal),
        syncReplayDependencies: (document) =>
          this.#syncCfcSchemaDocument(space, document),
        getTelemetry: () => this.#telemetry,
        onAccessChange: (error) => {
          const alreadyDenied = this.#spaceAccessErrors.has(space);
          if (error === undefined) {
            this.#spaceAccessErrors.delete(space);
          } else {
            this.#spaceAccessErrors.set(space, error);
            if (!alreadyDenied) {
              for (const observer of [...this.#spaceAccessObservers]) {
                try {
                  observer(space, error);
                } catch (cause) {
                  console.error("space-access-loss subscriber threw:", cause);
                }
              }
            }
          }
          if (alreadyDenied !== (error !== undefined)) {
            for (const observer of [...this.#spaceAccessChangeObservers]) {
              try {
                observer(space);
              } catch (cause) {
                console.error("space-access-change subscriber threw:", cause);
              }
            }
          }
        },
        eventAppendQueueStore: this.#eventAppendQueueStore,
        eventAppendPacing: this.#eventAppendPacing,
      });
      this.#providers.set(space, provider);
    }
    if (firstOpen && this.spaceOpenObserver !== undefined) {
      // Deferred a microtask: the observer subscribes cells, which
      // re-enters open() and the sync machinery — never re-entrantly
      // inside the first open call.
      queueMicrotask(() => {
        try {
          this.spaceOpenObserver?.(space);
        } catch (error) {
          console.warn("spaceOpenObserver threw", error);
        }
      });
    }
    return provider;
  }

  /**
   * Mount the normal user session, but serialize fresh-space ACL genesis ahead
   * of any replica work when this manager holds the space key. The temporary
   * bootstrap session authenticates as the space identity; the returned
   * durable session always authenticates as `signer`, preserving user/session
   * scope partitioning.
   *
   * Named-space keys only initialize a truly fresh space: with the genesis
   * document the caller registered beside the key, else the fallback — the
   * active user (or the registered owner) as OWNER plus the
   * `DEFAULT_GENESIS_GRANTS` rollout wildcard. Populated ACL-less
   * spaces are the temporary public-compatibility case and stay public. The
   * home identity (`signer.did() === space`) is the explicit private exception:
   * it claims a never-created owner-only ACL even when legacy data already
   * exists. A retracted ACL remains a tombstone and must not be recreated.
   */
  async #createInitializedSession(
    space: MemorySpace,
    signer: Signer,
    routeState: ProviderRouteState,
    routeGeneration: number,
    routeSignal: AbortSignal,
  ): Promise<OpenedSpaceSession> {
    const assertCurrentRoute = (): void => {
      if (
        routeSignal.aborted ||
        routeState.generation !== routeGeneration
      ) {
        throw routeSignal.reason instanceof Error
          ? routeSignal.reason
          : new Error("memory replica route replaced");
      }
    };
    const activeClients = new Set<MemoryV2Client.Client>();
    const closeActiveClients = (): void => {
      for (const client of activeClients) {
        void client.close().catch(() => {});
      }
    };
    const track = (opened: OpenedSpaceSession): OpenedSpaceSession => {
      activeClients.add(opened.client);
      assertCurrentRoute();
      return opened;
    };
    routeSignal.addEventListener("abort", closeActiveClients, { once: true });
    let completed = false;
    // Attempts can overlap across a route replacement; each marks its own
    // in-flight entry and clears only its own on failure, so a superseded
    // attempt's exit never unmarks its successor.
    const attempt = Symbol("genesis attempt");
    if (this.#genesisPhase.get(space)?.phase !== "handed-off") {
      this.#genesisPhase.set(space, { phase: "in-flight", attempt });
    }

    try {
      assertCurrentRoute();
      // A previous attempt on this same route that detached the
      // manager-wide session and then failed left it resumable only by
      // token; present it. A resume minted under another route is stale.
      const detached = this.#detachedSessionResumes.get(space);
      this.#detachedSessionResumes.delete(space);
      const normal = track(
        await this.#sessionFactory.create(
          space,
          signer,
          detached !== undefined && detached.routeGeneration === routeGeneration
            ? detached.options
            : {
              sessionId: this.#sessionId,
              ...this.#sessionDescriptorFields(space),
            },
          routeSignal,
        ),
      );
      // The manager-wide session is mounted; from here until a session is
      // handed to the provider, any throw leaves it resumable only by its
      // token. Remember how, so the next attempt is not refused for want
      // of the token (and so the next attempt's error is the real one).
      // Also what the final user mount below resumes: the
      // construction-wide manager session, never a replacement of that
      // still-live id without its token.
      const resumeNormal: MemoryV2Client.MountOptions = {
        sessionId: normal.session.sessionId,
        seenSeq: normal.session.serverSeq,
        ...(normal.session.sessionToken !== undefined
          ? { sessionToken: normal.session.sessionToken }
          : {}),
        ...this.#sessionDescriptorFields(space),
      };
      this.#detachedSessionResumes.set(space, {
        options: resumeNormal,
        routeGeneration,
      });
      const handOff = (opened: OpenedSpaceSession): OpenedSpaceSession => {
        this.#detachedSessionResumes.delete(space);
        this.#genesisPhase.set(space, { phase: "handed-off" });
        completed = true;
        return opened;
      };
      if (this.#sessionFactory.supportsAclBootstrap !== true) {
        return handOff(normal);
      }
      const isHomeSpace = signer.did() === space;
      const spaceIdentity = isHomeSpace
        ? signer
        : this.#spaceIdentities.get(space);
      if (spaceIdentity === undefined) {
        return handOff(normal);
      }

      // A caller's own genesis document (never the home arm's) is a
      // demand, not a preference. On a fresh space it is written verbatim.
      // Otherwise the space must be OWNED exactly as the document says: a
      // seal asserts ownership, and grants evolve afterwards under the
      // owner's authority (a share space's owner admitting guests), so an
      // exact-document rule would refuse the creator's own restart after
      // the first grant. What the ownership rule still refuses — at either
      // inspection, and after a lost genesis race in whichever window it
      // landed — is every case where the reopen below would otherwise
      // succeed under someone else's ACL with nothing reported: a space
      // populated with no ACL, a retracted ACL, a genesis another
      // initializer won with a different owner (the wildcard default names
      // the other user). Fail closed, and say what stands.
      const registered = this.#spaceGenesisAcls.get(space);
      const demanded = !isHomeSpace && registered?.supplied === true
        ? registered.document
        : undefined;
      // `reopen`: the space was not fresh when this attempt first looked —
      // ownership must match, grants may have evolved. `race`: the space
      // WAS fresh at this attempt's first inspection, so whatever stands
      // was written moments ago by a concurrent initializer, not evolved;
      // the exact document must stand. The likely race is one user's two
      // runtimes — a sealer against a pattern's default — where the owner
      // sets agree and the wildcard is exactly what the seal refused.
      const assertDemandedOwnershipStands = (
        snapshot:
          | { seq?: number; document?: { value?: unknown } | null }
          | undefined,
        arm: "reopen" | "race",
      ): void => {
        if (demanded === undefined) return;
        const stored = snapshot?.document?.value ?? null;
        const stands = stored === null
          ? (snapshot?.seq ?? 0) > 0
            ? "has a retracted ACL (a tombstone)"
            : "is populated with no ACL (the legacy-public case)"
          : arm === "race"
          ? sameAcl(stored, demanded)
            ? undefined
            : "was claimed concurrently with a different ACL"
          : sameOwners(stored, demanded)
          ? undefined
          : `is owned by ${ownersOf(stored).join(", ") || "nobody"}, not ${
            ownersOf(demanded).join(", ")
          }`;
        if (stands !== undefined) {
          throw new Error(
            `${space} ${stands}; the supplied genesis document cannot be ` +
              "its genesis and the space is not the one the caller asked for",
          );
        }
      };
      const aclSnapshotOf = (
        entities: Array<
          {
            id: string;
            scope?: string;
            seq?: number;
            document?: { value?: unknown } | null;
          }
        >,
      ) =>
        entities.find((entity) =>
          entity.id === aclId && (entity.scope ?? "space") === "space"
        );

      const openedServerSeq = normal.session.serverSeq;
      const aclId = aclDocId(space);
      const aclResult = await normal.session.queryGraph({
        roots: [{ id: aclId, selector: { path: [], schema: false } }],
      });
      assertCurrentRoute();
      const aclSnapshot = aclSnapshotOf(aclResult.entities);
      const aclNeverCreated = aclSnapshot?.seq === 0 &&
        aclSnapshot.document === null;
      if (!aclNeverCreated || (!isHomeSpace && openedServerSeq !== 0)) {
        assertDemandedOwnershipStands(aclSnapshot, "reopen");
        return handOff(normal);
      }

      // Do not reuse the bootstrap session for replica work: both it and the
      // replica allocate localSeq from 1, and named spaces must switch back from
      // the space signer to the active user before any user-scoped operation.
      activeClients.delete(normal.client);
      await normal.client.close();
      assertCurrentRoute();
      let bootstrapSessionId = crypto.randomUUID();
      while (bootstrapSessionId === this.#sessionId) {
        bootstrapSessionId = crypto.randomUUID();
      }
      let bootstrap: OpenedSpaceSession | undefined;
      try {
        bootstrap = track(
          await this.#sessionFactory.create(
            space,
            spaceIdentity,
            {
              sessionId: bootstrapSessionId,
              ...(registered?.root === undefined
                ? {}
                : { genesisRoot: registered.root }),
            },
            routeSignal,
          ),
        );
        assertCurrentRoute();
        const current = await bootstrap.session.queryGraph({
          roots: [{ id: aclId, selector: { path: [], schema: false } }],
        });
        assertCurrentRoute();
        const snapshot = aclSnapshotOf(current.entities);
        // Recheck emptiness in the authority session. In `off` mode an
        // unrelated writer can still populate the space between the first
        // inspection and bootstrap; that turns it into the named legacy-public
        // case and must not be claimed. Home remains the explicit exception.
        const aclStillNeverCreated = snapshot?.seq === 0 &&
          snapshot.document === null;
        if (
          !aclStillNeverCreated ||
          (!isHomeSpace && current.serverSeq !== 0)
        ) {
          // Claimed (or populated) between the first inspection and this
          // recheck: the default path reopens as the user below; a
          // demanded document must already be exactly what stands.
          assertDemandedOwnershipStands(snapshot, "race");
        } else {
          try {
            // The HOME arm is untouched — a home space is its own
            // identity and owner, and no registered document reaches it.
            // Non-home: the document registered beside the space identity
            // — a caller's own, or the fallback shape around the acting
            // user a serving run supplied (OW31, RULED 2026-08-18) — else
            // the fallback shape around the signer, the active user on a
            // client.
            const bootstrapAcl = isHomeSpace
              ? { [signer.did()]: "OWNER" }
              : registered?.document ?? defaultGenesisAcl(signer.did());
            if (
              registered?.root !== undefined &&
              bootstrap.client.serverFlags?.genesisRoot !== true
            ) {
              throw new Error(
                "Host does not support genesis root reservations",
              );
            }
            await bootstrap.session.transact({
              ...(registered?.root === undefined
                ? {}
                : { genesisRoot: registered.root }),
              localSeq: 1,
              reads: {
                confirmed: [{
                  id: aclId,
                  path: toDocumentPath([]),
                  seq: snapshot?.seq ?? 0,
                }],
                pending: [],
              },
              operations: [{
                op: "set",
                id: aclId,
                value: { value: bootstrapAcl },
              }],
            }, () => {
              assertCurrentRoute();
              routeState.writeIssuedGeneration = routeGeneration;
            });
          } catch (error) {
            // A concurrent space-authorized initializer may win between the
            // point read and commit. Other failures are real bootstrap errors.
            if (!(error instanceof Error) || error.name !== "ConflictError") {
              throw error;
            }
            // Default path: reopening as the user below is the authoritative
            // outcome — it succeeds only if the winning ACL grants access.
            // A demanded document: the winner's must be exactly it.
            if (demanded !== undefined) {
              const after = await bootstrap.session.queryGraph({
                roots: [{ id: aclId, selector: { path: [], schema: false } }],
              });
              assertCurrentRoute();
              assertDemandedOwnershipStands(
                aclSnapshotOf(after.entities),
                "race",
              );
            }
          }
        }
      } catch (error) {
        if (
          registered?.root === undefined || !(error instanceof Error) ||
          !["ConflictError", "AuthorizationError", "SessionRevokedError"]
            .includes(error.name)
        ) throw error;
        // A winning genesis can remove the bootstrap key's own READ access.
        // Verify its immutable root and exact ACL through the management
        // principal before treating that lost authority as a completed race.
        const winner = track(
          await this.#sessionFactory.create(
            space,
            signer,
            resumeNormal,
            routeSignal,
          ),
        );
        const current = await winner.session.queryGraph({
          roots: [{ id: aclId, selector: { path: [], schema: false } }],
        });
        assertCurrentRoute();
        assertDemandedOwnershipStands(aclSnapshotOf(current.entities), "race");
        return handOff(winner);
      } finally {
        if (bootstrap !== undefined) {
          activeClients.delete(bootstrap.client);
          await bootstrap.client.close();
        }
      }

      assertCurrentRoute();
      const resumed = track(
        await this.#sessionFactory.create(
          space,
          signer,
          resumeNormal,
          routeSignal,
        ),
      );
      return handOff(resumed);
    } finally {
      if (!completed) {
        const phase = this.#genesisPhase.get(space);
        if (phase?.phase === "in-flight" && phase.attempt === attempt) {
          this.#genesisPhase.delete(space);
        }
        routeSignal.removeEventListener("abort", closeActiveClients);
        await Promise.allSettled(
          [...activeClients].map((client) => client.close()),
        );
      }
    }
  }

  async close(): Promise<void> {
    // A detached-session resume names the session id this close rotates;
    // presenting it afterwards would mount the OLD id under a stale token.
    this.#detachedSessionResumes.clear();
    this.#genesisPhase.clear();
    // The lease releases AFTER teardown drains: a queued sync frame applied
    // during provider destruction still registers its schema documents
    // inside this session's epoch, not after the clear.
    try {
      if (this.#providers.size === 0) {
        return;
      }
      // allSettled: one rejecting teardown must not release the lease (the
      // finally below) while sibling teardowns are still draining frames.
      const outcomes = await Promise.allSettled(
        [...this.#providers.values()].map((provider) => provider.destroy()),
      );
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );
      if (rejected !== undefined) {
        throw (rejected as PromiseRejectedResult).reason;
      }
      this.#providers.clear();
      this.#spaceAccessErrors.clear();
      this.#dataURISyncs.clear();
      this.#sessionId = crypto.randomUUID();
    } finally {
      this.#schemaRegistryLease?.();
      this.#schemaRegistryLease = undefined;
    }
  }

  async closeNow(): Promise<void> {
    this.#detachedSessionResumes.clear();
    this.#genesisPhase.clear();
    try {
      if (this.#providers.size === 0) {
        return;
      }
      const outcomes = await Promise.allSettled(
        [...this.#providers.values()].map((provider) => provider.destroyNow()),
      );
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );
      if (rejected !== undefined) {
        throw (rejected as PromiseRejectedResult).reason;
      }
      this.#providers.clear();
      this.#spaceAccessErrors.clear();
      this.#dataURISyncs.clear();
      this.#sessionId = crypto.randomUUID();
    } finally {
      this.#schemaRegistryLease?.();
      this.#schemaRegistryLease = undefined;
    }
  }

  edit(): IStorageTransaction {
    return V2Transaction.V2StorageTransaction.create(this);
  }

  synced(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    Promise.all(
      [...this.#providers.values()].map((provider) => provider.synced()),
    ).finally(() => this.#resolveCrossSpace(resolve));
    return promise;
  }

  async pullOpenSpacesToHead(): Promise<void> {
    await Promise.all(
      [...this.#providers.values()].map((provider) =>
        provider.pullToServerHead()
      ),
    );
  }

  /**
   * INBOUND settlement only (server-execution v2 stage F): the serving
   * loop's wave-settle barrier. Awaits watch refreshes and update
   * processing across providers, but NOT commit settlement — a sealed
   * commit settles at the wave commit the loop performs after settling,
   * so the full `synced()` would deadlock against it (see
   * SpaceReplica.inputSynced).
   */
  async inputSynced(): Promise<void> {
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.inputSynced()),
    );
  }

  /**
   * A throwable `AuthorizationError` when `space` is under a permanent
   * authorization denial (an ACL shortfall, an audience or protocol mismatch),
   * or undefined when it is authorized or was never opened. Scoped to one space
   * on purpose: `synced()` stays silent so a denied cross-space link does not
   * fail an unrelated caller, and a caller that must access a specific space
   * reads this after `synced()` to surface the real failure.
   */
  authorizationError(space: MemorySpace): Error | undefined {
    return this.#providers.get(space)?.authorizationError();
  }

  /** @inheritDoc */
  spaceAccessError(space: MemorySpace): Error | undefined {
    return this.#spaceAccessErrors.get(space);
  }

  /** @inheritDoc */
  subscribeSpaceAccessLoss(
    observer: (space: MemorySpace, error: Error) => void,
  ): Cancel {
    this.#spaceAccessObservers.add(observer);
    return () => this.#spaceAccessObservers.delete(observer);
  }

  /** @inheritDoc */
  subscribeSpaceAccessChange(observer: (space: MemorySpace) => void): Cancel {
    this.#spaceAccessChangeObservers.add(observer);
    return () => this.#spaceAccessChangeObservers.delete(observer);
  }

  trackPendingCommit(promise: Promise<unknown>): void {
    // Normalize so a rejected commit settles the barrier instead of leaking an
    // unhandled rejection; the caller keeps the original promise for results.
    const tracked = promise.then(() => {}, () => {});
    this.#pendingCommits.add(tracked);
    if (this.#pendingCommits.size === 1) {
      this.#notifyPendingCommits(true);
    }
    tracked.finally(() => {
      this.#pendingCommits.delete(tracked);
      if (this.#pendingCommits.size === 0) {
        this.#notifyPendingCommits(false);
      }
    });
  }

  hasPendingCommits(): boolean {
    return this.#pendingCommits.size > 0;
  }

  async pendingCommitsSettled(): Promise<void> {
    await Promise.allSettled([...this.#pendingCommits]);
  }

  /**
   * Observe transitions of the pending-commit state: `true` when the set of
   * unconfirmed commits becomes non-empty, `false` when it drains. Drives the
   * client-side "unconfirmed writes" flag (e.g. the shell's before-unload
   * guard). Returns an unsubscribe function.
   */
  subscribePendingCommits(callback: (pending: boolean) => void): () => void {
    this.#pendingCommitsSubscribers.add(callback);
    return () => this.#pendingCommitsSubscribers.delete(callback);
  }

  #notifyPendingCommits(pending: boolean): void {
    for (const callback of this.#pendingCommitsSubscribers) {
      try {
        callback(pending);
      } catch (error) {
        console.error("pending-commits subscriber threw:", error);
      }
    }
  }

  shouldPullDoc(
    space: MemorySpace,
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean {
    if (hasDataUriScheme(id)) {
      return false;
    }
    const instance = this.#foreignInstanceKey(scope, identity);
    const key = `${space}\0${this.#pullKickKey(id, scope, instance)}`;
    if (this.#docPullKicks.has(key)) {
      return false;
    }
    this.#docPullKicks.add(key);
    // State the local replica can already serve needs no pull. getState is
    // undefined both for never-pulled docs and for docs known to hold no
    // value (deleted / genuinely absent) — the second kind gets one harmless
    // kick and is then held off by the kick set above.
    return this.open(space).replica.get({
      id,
      type: DOCUMENT_MIME as MIME,
      scope,
      ...(instance !== undefined ? { scopeKey: instance } : {}),
    }) === undefined;
  }

  retractDocPullKick(
    space: MemorySpace,
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): void {
    this.#docPullKicks.delete(
      `${space}\0${
        this.#pullKickKey(id, scope, this.#foreignInstanceKey(scope, identity))
      }`,
    );
  }

  /** Pull-kick keys are per scope INSTANCE (key-vocabulary.md §5's
   * M4-coupled list, stage F): name-keyed, A's kick suppressed B's pull
   * and B's doc never loaded at cardinality > 1. Resolved against the
   * manager's own identity — partition-unchanged at cardinality 1
   * (key-vocabulary.md §2) — or the explicit foreign instance a served
   * per-instance read names (server-execution v2 stage A). */
  #pullKickKey(id: URI, scope?: CellScope, instance?: ScopeKey): string {
    return `${
      instance ?? resolveScopeKey(scope, this.scopeKeyIdentity())
    }\0${id}`;
  }

  /**
   * The explicit instance a read under `identity` names when — and only
   * when — it differs from this manager's own resolution of `scope`
   * (server-execution v2 stage A — the runner's explicit-instance read):
   * a served per-instance run's read of a scoped doc names THAT
   * principal's instance on the wire and in the replica; an own-identity
   * read (every client, the OFF arm, and a served run whose identity IS
   * the service's) names nothing and keeps the fast own-instance path.
   * Undefined for `space` (one instance) and for a scope the identity
   * cannot resolve (the anonymous-session name fallback).
   */
  #foreignInstanceKey(
    scope: CellScope | undefined,
    identity: ScopeKeyIdentity | undefined,
  ): ScopeKey | undefined {
    if (identity === undefined) return undefined;
    const name = normalizeCellScope(scope);
    if (name === "space" || !canResolveScopeKey(name, identity)) {
      return undefined;
    }
    const instance = resolveScopeKey(name, identity);
    const own = this.scopeKeyIdentity();
    if (
      canResolveScopeKey(name, own) && resolveScopeKey(name, own) === instance
    ) {
      return undefined;
    }
    return instance;
  }

  addCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.add(promise);
  }

  removeCrossSpacePromise(promise: Promise<void>): void {
    this.#crossSpacePromises.delete(promise);
  }

  /**
   * Registers one pending load of `address` and returns its release step,
   * which takes the load's failure if it had one. The release that brings
   * the key's count back to zero settles the key's waiters and, when no
   * failure was recorded, reports the recovery epoch to
   * `loadRecoveryObserver`.
   */
  #registerPendingLoad(
    address: {
      space: MemorySpace;
      scope: CellScope;
      id: URI;

      /** The explicit instance an instance-named load targets (stage A);
       * the key — and the address the scheduler's park machinery
       * cross-matches — is then per THAT instance. */
      scopeKey?: ScopeKey;
    },
  ): (failure?: unknown) => void {
    const key = entityKey(address, this.scopeKeyIdentity());
    let entry = this.#pendingLoads.get(key);
    if (entry === undefined) {
      entry = {
        count: 0,
        generation: this.#nextPendingLoadGeneration++,
        address,
        failure: undefined,
        waiters: new Set<(failure: unknown) => void>(),
      };
    }
    entry.count++;
    this.#pendingLoads.set(key, entry);
    return (failure?: unknown) => {
      entry.failure ??= failure;
      entry.count--;
      if (entry.count > 0) return;
      this.#pendingLoads.delete(key);
      if (entry.failure === undefined) {
        this.#loadRecoveryObserver?.({
          failedEpoch: this.#loadFailureEpoch(key),
          recoveryEpoch: this.#loadEpoch(entry.generation),
        });
      }
      for (const waiter of entry.waiters) waiter(entry.failure);
      entry.waiters.clear();
    };
  }

  /**
   * Logs a sync failure that would otherwise resolve silently, once per
   * distinct (space, error) pair. The error name and message are the wire
   * server's own words: for an ACL denial that includes the principal and
   * space (`Principal <did> lacks READ on space <did>`), which is exactly
   * what a caller staring at an unexplained `undefined` needs.
   */
  #logSyncLoadFailure(
    space: MemorySpace,
    id: URI,
    failure: unknown,
  ): void {
    // Pull errors arrive as plain result objects (IConnectionError et al.),
    // not Error instances — read the fields structurally.
    const named = failure as { name?: unknown; message?: unknown } | undefined;
    const name = typeof named?.name === "string" ? named.name : "Error";
    const message = typeof named?.message === "string"
      ? named.message
      : String(failure);
    const key = `${space}|${name}|${message}`;
    if (this.#loggedSyncFailures.has(key)) return;
    if (this.#loggedSyncFailures.size >= 256) this.#loggedSyncFailures.clear();
    this.#loggedSyncFailures.add(key);
    logger.error("sync-load-failure", () => [
      `sync completed without data for ${id} in ${space}: ${name}: ${message}`,
    ]);
  }

  pendingLoadAddresses(): readonly {
    space: MemorySpace;
    scope: CellScope;
    id: URI;
    scopeKey?: ScopeKey;
  }[] {
    return [...this.#pendingLoads.values()].map((entry) => entry.address);
  }

  pendingLoadGeneration(key: string): number | undefined {
    return this.#pendingLoads.get(key)?.generation;
  }

  #loadEpoch(generation: number): string {
    return `load:${this.#loadRecoveryIdentity}:${generation}`;
  }

  #loadFailureEpoch(key: string): string {
    return `load-key:${key}`;
  }

  loadsSettled(keys: readonly string[]): Promise<void> {
    // Dedupe up front: `remaining` counts entries, but the shared onSettled is
    // added once per entry's waiter Set and fires once. A duplicated key would
    // inflate `remaining` without a matching callback, hanging the promise.
    const pending = [...new Set(keys)].filter((key) =>
      this.#pendingLoads.has(key)
    );
    if (pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let remaining = pending.length;
      let firstFailure: ReplicaLoadFailureError | undefined;
      const onSettled = (key: string, failure: unknown) => {
        if (failure !== undefined) {
          if (firstFailure === undefined) {
            firstFailure = toReplicaLoadFailureError(
              failure,
              this.#loadFailureEpoch(key),
            );
          }
        }
        remaining--;
        if (remaining !== 0) return;
        if (firstFailure !== undefined) reject(firstFailure);
        else resolve();
      };
      for (const key of pending) {
        this.#pendingLoads.get(key)!.waiters.add((failure) =>
          onSettled(key, failure)
        );
      }
    });
  }

  trackUntilSettled(work: Promise<unknown>): void {
    const tracked = work.finally(() =>
      this.#crossSpacePromises.delete(tracked)
    ) as Promise<void>;
    this.#crossSpacePromises.add(tracked);
  }

  pendingCrossSpacePromiseCount(): number {
    return this.#crossSpacePromises.size;
  }

  crossSpaceSettled(): Promise<void> {
    const { resolve, promise } = Promise.withResolvers<void>();
    void this.#resolveCrossSpace(resolve);
    return promise;
  }

  subscribe(subscription: IStorageNotification): void {
    this.#subscription.subscribe(subscription);
  }

  unsubscribe(subscription: IStorageNotification): void {
    this.#subscription.unsubscribe(subscription);
  }

  async syncCell<T>(
    cell: Cell<T>,
    options?: { scopeKeyIdentity?: ScopeKeyIdentity },
  ): Promise<Cell<T>> {
    const { space, id, schema, scope } = cell.getAsNormalizedFullLink();
    if (!space) {
      throw new Error("No space set");
    }

    if (hasDataUriScheme(id)) {
      return this.#syncDataURICell(
        cell,
        space,
        id,
        schema,
        scope,
        { ...(options?.scopeKeyIdentity ?? this.scopeKeyIdentity()) },
      );
    }

    const provider = this.open(space);
    // The runner's explicit-instance read (server-execution v2 stage A):
    // a served per-instance run's load of a scoped doc NAMES that
    // principal's instance — the load registers, travels, and lands per
    // instance. Own-identity loads (every client, the OFF arm) name
    // nothing and take exactly the pre-stage-A path.
    const instance = this.#foreignInstanceKey(scope, options?.scopeKeyIdentity);
    const releaseLoad = this.#registerPendingLoad({
      space,
      scope: normalizeCellScope(scope),
      id,
      ...(instance !== undefined ? { scopeKey: instance } : {}),
    });
    let loadFailure: unknown;
    try {
      const result = await provider.sync(
        id,
        {
          path: cell.path.map((segment) => segment.toString()),
          schema: schema ?? false,
        },
        scope,
        instance,
      );
      loadFailure = result.error;
      const schemaFailure = await this.#syncCfcSchemaDocument(
        space,
        (provider as {
          get?: (uri: URI, scope?: CellScope) => EntityDocument | undefined;
        }).get?.(id, scope),
      );
      loadFailure ??= schemaFailure;
      // A pull that "succeeds" while carrying an error (an ACL denial, a
      // transport failure) otherwise resolves this sync() normally and the
      // caller reads the doc as absent — deny, error, and absent all collapse
      // into the same silent undefined. Surface the failure; the pending-load
      // ledger below still carries it to scheduler waiters.
      if (loadFailure !== undefined) {
        this.#logSyncLoadFailure(space, id, loadFailure);
      }
      return cell;
    } catch (error) {
      loadFailure = error;
      throw error;
    } finally {
      releaseLoad(loadFailure);
    }
  }

  /**
   * The explicit-instance load by address (IStorageManager.syncInstance —
   * server-execution v2 stage A): the transaction layer's kick for a
   * served per-instance run's read of a scoped instance the replica has
   * never seen. Registered like syncCell's load (the preflight park
   * cross-matches the instance-keyed address) and named on the wire.
   * Own-identity or space-scope addresses name nothing and take the
   * ordinary root pull; a load that fails hands back the pull-kick
   * reservation so a later read may retry.
   */
  async syncInstance(
    address: { space: MemorySpace; id: URI; scope?: CellScope },
    identity: ScopeKeyIdentity,
  ): Promise<void> {
    if (hasDataUriScheme(address.id)) return;
    const scope = normalizeCellScope(address.scope);
    const instance = this.#foreignInstanceKey(scope, identity);
    const provider = this.open(address.space);
    const releaseLoad = this.#registerPendingLoad({
      space: address.space,
      scope,
      id: address.id,
      ...(instance !== undefined ? { scopeKey: instance } : {}),
    });
    let loadFailure: unknown;
    try {
      const result = await provider.sync(
        address.id,
        { path: [], schema: false },
        scope,
        instance,
      );
      loadFailure = result.error;
      if (loadFailure !== undefined) {
        this.#logSyncLoadFailure(address.space, address.id, loadFailure);
        this.retractDocPullKick(address.space, address.id, scope, identity);
      }
    } catch (error) {
      loadFailure = error;
      this.retractDocPullKick(address.space, address.id, scope, identity);
      throw error;
    } finally {
      releaseLoad(loadFailure);
    }
  }

  /**
   * Syncs the CFC schema document `document`'s `cfc.schemaHash` names and
   * every label document its envelope references, in parallel, and
   * resolves to the first sync error among them; a document naming none
   * resolves at once. A reader of the envelope resolves its labels
   * synchronously from the replica, so the label documents are pulled
   * beside the schema document rather than on first read. A syncer a test
   * supplied stands in for the whole step.
   */
  async #syncCfcSchemaDocument(
    space: MemorySpace,
    document: EntityDocument | undefined,
  ): Promise<Error | undefined> {
    const syncer = this.#cfcSchemaDocumentSyncer;
    if (syncer !== undefined) {
      return syncer(space, document);
    }
    const cfc = isObjectNotArray(document?.cfc) ? document.cfc : undefined;
    const ids: URI[] = [];
    const schemaHash = cfc?.schemaHash;
    if (typeof schemaHash === "string" && schemaHash.length > 0) {
      ids.push(`cid:${schemaHash}` as URI);
    }
    for (const hash of cfcEnvelopeLabelDocumentHashes(cfc)) {
      ids.push(`cid:${hash}` as URI);
    }
    if (ids.length === 0) return undefined;
    const provider = this.open(space);
    const results = await Promise.all(
      ids.map((id) => provider.sync(id, { path: [], schema: false })),
    );
    return results.find((result) => result.error !== undefined)?.error;
  }

  /**
   * Runs `start` as a pending load of `address`: the load is registered
   * before `start` is called and released when its result settles, with a
   * resolved error counted as the load's failure and logged.
   */
  #trackPendingProviderSync(
    address: {
      space: MemorySpace;
      scope: CellScope;
      id: URI;
      scopeKey?: ScopeKey;
    },
    start: () => Promise<Result<Unit, Error>>,
  ): Promise<Result<Unit, Error>> {
    const releaseLoad = this.#registerPendingLoad(address);
    let work: Promise<Result<Unit, Error>>;
    try {
      work = start();
    } catch (error) {
      releaseLoad(error);
      throw error;
    }
    const failLoad = (error: unknown): never => {
      releaseLoad(error);
      throw error;
    };

    return work.then((result) => {
      // Same silent-collapse hazard as syncCell: a link-target pull that
      // resolves while carrying an error reads as an absent target.
      if (result.error !== undefined) {
        this.#logSyncLoadFailure(address.space, address.id, result.error);
      }
      releaseLoad(result.error);
      return result;
    }, failLoad);
  }

  #resolveCrossSpace(resolve: () => void): Promise<void> {
    const promises = [...this.#crossSpacePromises.values()];
    if (promises.length === 0) {
      queueMicrotask(() => {
        if (this.#crossSpacePromises.size === 0) {
          resolve();
          return;
        }
        void this.#resolveCrossSpace(resolve);
      });
      return Promise.resolve();
    }
    return Promise.all(promises)
      .then(() => undefined)
      .finally(() => this.#resolveCrossSpace(resolve));
  }

  async #syncDataURICell<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
    identity: ScopeKeyIdentity,
  ): Promise<Cell<T>> {
    const cacheKey = dataURISyncKey({
      id,
      schema,
      path: cell.path.map(String),
      space,
      scope,
      scopeKeyIdentity: identity,
    });
    let work = this.#dataURISyncs.get(cacheKey);
    if (work === undefined) {
      work = this.#syncDataURILinkTargets(
        cell,
        space,
        id,
        schema,
        scope,
        identity,
      );
      this.#dataURISyncs.set(cacheKey, work);
    }
    await work;
    return cell;
  }

  async #syncDataURILinkTargets<T>(
    cell: Cell<T>,
    space: MemorySpace,
    id: string,
    schema: JSONSchema | undefined,
    scope: CellScope | undefined,
    identity: ScopeKeyIdentity,
  ): Promise<void> {
    let value: unknown = valueFromDataUri(id);
    for (const segment of [...cell.path.map(String)]) {
      if (!isObjectOrArray(value)) {
        return;
      }
      value = (value as Record<string, unknown>)[segment];
    }

    const base: NormalizedLink = {
      space,
      id: id as any,
      scope: normalizeCellScope(scope),
      path: [],
    };
    const promises: Promise<unknown>[] = [];
    this.#collectLinkedCellSyncs(
      value,
      base,
      schema,
      promises,
      new Set(),
      identity,
    );
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Walks `value` for cell links and pushes a pending provider sync of each
   * linked document onto `promises`, under the schema a read at the link's
   * place in `schema` would cross it with: the reader's sub-schema, which the
   * link's own schema cannot widen (`combineSchemaForLink`). Each link goes
   * through `#syncLinkTarget`, which crosses a link into a data-URI document
   * locally rather than sending it. `seen` holds the objects already walked. A served per-instance run's
   * `identity` names that principal's instance of each scoped target
   * (server-execution v2 stage A), as `syncCell` does for a stored
   * document.
   */
  #collectLinkedCellSyncs(
    value: unknown,
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    promises: Promise<unknown>[],
    seen: Set<unknown>,
    identity?: ScopeKeyIdentity,
  ): void {
    if (value === null || value === undefined || seen.has(value)) {
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    seen.add(value);

    if (isPrimitiveCellLink(value)) {
      const link = parseLinkPrimitive(value, base);
      if (link.id === undefined) return;
      this.#syncLinkTarget(
        { ...link, id: link.id },
        base,
        combineOptionalSchema(schema, link.schema),
        promises,
        seen,
        identity,
      );
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemSchema = schema
          ? ContextualFlowControl.getSchemaAtPath(schema, [String(i)])
          : undefined;
        this.#collectLinkedCellSyncs(
          item,
          base,
          itemSchema,
          promises,
          seen,
          identity,
        );
      }
      return;
    }

    // TODO(danfuzz): the walk stops at a `FabricSpecialObject`, so a cell link
    // held inside a `FabricInstance` reconstructed from the data URI is never
    // found here and its target document is never synced — the later read
    // finds it absent. (Stopping at a `FabricPrimitive` costs nothing; it is a
    // leaf.)
    if (isKeyableObjectOrArray(value)) {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (!isObjectOrArray(child)) {
          continue;
        }
        const childSchema = schema
          ? ContextualFlowControl.getSchemaAtPath(schema, [key])
          : undefined;
        this.#collectLinkedCellSyncs(
          child,
          base,
          childSchema,
          promises,
          seen,
          identity,
        );
      }
    }
  }

  /**
   * Syncs the document `link` names under `schema`, the schema a read
   * crosses the link with. A link into a data-URI document is walked
   * locally instead: the walk descends the link's path through the
   * document's value, and a link it meets on the way is followed with the
   * rest of the path appended, so a stand-in holding a caller's cell at
   * `def` reaches the store for a binding of `def.next` as the read does.
   * The reader's schema describes the value at the end of the path, so a
   * link met earlier contributes its own schema narrowed to the rest of the
   * path, the way `Cell.key()` narrows a schema it walks past.
   */
  #syncLinkTarget(
    link: NormalizedLink & { id: URI },
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    promises: Promise<unknown>[],
    seen: Set<unknown>,
    identity: ScopeKeyIdentity | undefined,
  ): void {
    const space = link.space ?? base.space!;
    // A handle with no declared value shape transfers only its
    // address. Loading its target requires a read through that handle.
    if (
      !hasDataUriScheme(link.id) && link.overwrite !== "redirect" &&
      isUnknownCellSchema(schema)
    ) return;
    const scope = normalizeCellScope(link.scope as CellScope | undefined);
    if (hasDataUriScheme(link.id)) {
      const dataBase: NormalizedLink = { space, id: link.id, scope, path: [] };
      const segments = link.path.map((segment) => segment.toString());
      let target: unknown = valueFromDataUri(link.id);
      for (let i = 0; i < segments.length; i++) {
        if (isPrimitiveCellLink(target)) {
          const inner = parseLinkPrimitive(target, dataBase);
          if (inner.id === undefined) return;
          const remaining = segments.slice(i);
          const innerSchema = inner.schema === undefined
            ? undefined
            : ContextualFlowControl.getSchemaAtPath(inner.schema, remaining);
          this.#syncLinkTarget(
            {
              ...inner,
              id: inner.id,
              path: [...inner.path, ...remaining],
            },
            dataBase,
            combineOptionalSchema(schema, innerSchema),
            promises,
            seen,
            identity,
          );
          return;
        }
        // TODO(danfuzz): the descent stops at a `FabricSpecialObject`, so a
        // path through a `FabricInstance` held in the document ends here and
        // the link past it is never synced.
        if (!isKeyableObjectOrArray(target)) return;
        target = (target as Record<string, unknown>)[segments[i]];
      }
      this.#collectLinkedCellSyncs(
        target,
        dataBase,
        schema,
        promises,
        seen,
        identity,
      );
      return;
    }
    const instance = this.#foreignInstanceKey(scope, identity);
    promises.push(
      this.#trackPendingProviderSync(
        {
          space,
          scope,
          id: link.id,
          ...(instance !== undefined ? { scopeKey: instance } : {}),
        },
        () =>
          this.open(space).sync(
            link.id,
            {
              path: link.path.map((segment) => segment.toString()),
              // A reader that takes a handle at the link asks for the
              // document under the handle's own schema, the wrapper removed:
              // a selector carrying the wrapper, or none, describes a
              // reference, which the serving replica delivers once and
              // never keeps current, while the handle's reads want the
              // value as it changes.
              schema: selectorSchemaForLink(schema),
            },
            scope,
            instance,
          ),
      ),
    );
  }

  //
  // Static members
  //

  /** Opens a manager over `options`, with a session factory for its host. */
  static open(options: Options) {
    const dynamicHosts = new Map<string, string>();
    const manager = new this(
      options,
      new RemoteSessionFactory(
        createStorageAddressResolver(
          options.memoryHost,
          options.spaceHostMap,
          dynamicHosts,
        ),
        options.as,
      ),
    );
    manager.#dynamicHosts = dynamicHosts;
    return manager;
  }
}

type ProviderRouteState = {
  generation: number;
  writeIssuedGeneration?: number;
};

type OpenedSpaceSession = {
  client: MemoryV2Client.Client;
  session: MemoryV2Client.SpaceSession;
};

type ProviderOptions = {
  as: Signer;
  space: MemorySpace;
  settings: IRemoteStorageProviderSettings;
  subscription: IStorageSubscription;
  onAccessChange?: (error: Error | undefined) => void;

  /**
   * The owning manager's authenticated session identity
   * (IStorageManager.scopeKeyIdentity) — what the replica's notification
   * differentials resolve scoped change addresses against.
   */
  scopeKeyIdentity: () => ScopeKeyIdentity;

  routeState: ProviderRouteState;
  createSession: (
    routeGeneration: number,
    routeSignal: AbortSignal,
  ) => Promise<OpenedSpaceSession>;
  syncReplayDependencies: (
    document: EntityDocument | undefined,
  ) => Promise<Error | undefined>;

  /** Late-bound: resolves to the Runtime's telemetry bus once attached. */
  getTelemetry?: () => TelemetrySink | undefined;

  /** The LT9 event-intent persistence seam (see Options). */
  eventAppendQueueStore?: EventAppendQueueStore;

  /** OW27 per-stream send pacing (see Options). */
  eventAppendPacing?: EventAppendPacing | false;

  /** Server-execution v2 Phase 5 (protocol.md §2's grant-scoped read
   * design, RULED 2026-08-13 — the delegated-scoped-read fail-closed
   * precondition): set on a SERVING manager's FOREIGN-space providers.
   * A scoped (user/session) read against such a provider REFUSES
   * loudly instead of shipping an unnamed scoped root the memory
   * server would resolve against the delegating service envelope —
   * the silent-empty-instance trap. Space-scope foreign reads (the
   * §2b free-read row) are unaffected. */
  refuseForeignScopedReads?: boolean;

  /** The manager's store read-through for this space, resolved at each
   * use so an install after the replica was built still takes effect
   * (see IStorageManager.installStoreReadThrough). Absent or resolving
   * to `undefined`: every load goes over the session. */
  storeReadThrough?: () => StoreReadThrough | undefined;
};

type SpaceReplicaOptions = Omit<ProviderOptions, "createSession"> & {
  routeGeneration: number;
  createSession: () => Promise<OpenedSpaceSession>;
};

type ProviderSyncRequest = {
  uri: URI;
  selector: SchemaPathSelector;
  scope?: CellScope;

  /** The explicit instance an instance-named load targets (stage A). */
  instance?: ScopeKey;
};

type ProviderOperationSubscription = {
  query: Omit<OperationFieldQuery, "principal" | "sessionId">;
  callback: (snapshot: OperationFieldSnapshot) => void;
  cancel?: Cancel;
  install?: Promise<void>;
  closed: boolean;
};

/**
 * Minimal marker sink — structurally the Runtime's `RuntimeTelemetry`.
 * Kept structural (type-only import) so the storage layer takes no runtime
 * dependency on the telemetry module.
 */
type TelemetrySink = { submit(marker: RuntimeTelemetryMarker): void };

class Provider implements IStorageProvider, IOperationStorageCapability {
  replica: SpaceReplica;

  /**
   * Registered reads to replay when a provisional replica is replaced, keyed by
   * document and then by the normalized selector. A normalized selector is
   * either the shared rejecting selector or an interned canonical instance, and
   * the entry holds it, so structurally equal selectors are the same object
   * here and identity separates them exactly.
   */
  #syncRequests = new Map<
    string,
    Map<SchemaPathSelector, ProviderSyncRequest>
  >();

  #destroyed = false;
  #routeAbort = new AbortController();
  #operationSubscriptions = new Set<ProviderOperationSubscription>();

  constructor(
    readonly options: ProviderOptions,
  ) {
    this.replica = this.#createReplica();
  }

  #createReplica(): SpaceReplica {
    const routeGeneration = this.options.routeState.generation;
    const routeSignal = this.#routeAbort.signal;
    return new SpaceReplica({
      ...this.options,
      routeGeneration,
      createSession: () =>
        this.options.createSession(routeGeneration, routeSignal),
    });
  }

  send(
    batch: { uri: URI; value: EntityDocument | undefined }[],
  ): Promise<Result<Unit, Error>> {
    return this.replica.send(batch.map(({ uri, value }) => ({
      uri,
      document: value,
    }))) as Promise<Result<Unit, Error>>;
  }

  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
    instance?: ScopeKey,
  ): Promise<Result<Unit, Error>> {
    // Externalization happens where requests enter, so request dedup, watch
    // ids, and session-resume replay all see one selector form.
    const normalizedSelector = externalizeSyncSelector(
      normalizeSyncSelector(selector),
      (hash) => this.replica.isContentAddressedDocPersisted(hash),
    );
    // Replay requests are per (doc, instance): an instance-named load
    // (stage A) must replay as that instance on a replacement replica.
    const key = docKey(uri, instance ?? normalizeCellScope(scope));
    let requests = this.#syncRequests.get(key);
    if (requests === undefined) {
      requests = new Map();
      this.#syncRequests.set(key, requests);
    }
    requests.set(normalizedSelector, {
      uri,
      selector: normalizedSelector,
      scope,
      ...(instance !== undefined ? { instance } : {}),
    });
    return this.replica.sync(
      uri,
      normalizedSelector,
      scope,
      instance,
    ) as Promise<
      Result<Unit, Error>
    >;
  }

  /** See {@link SpaceReplica.unexaminedAbsences}. */
  unexaminedAbsences(
    source: IStorageTransaction | undefined,
  ): readonly UnexaminedAbsence[] {
    return this.replica.unexaminedAbsences(source);
  }

  /** See {@link SpaceReplica.presentCount}. */
  presentCount(absences: readonly UnexaminedAbsence[]): number {
    return this.replica.presentCount(absences);
  }

  async #replaySync(
    replica: SpaceReplica,
    uri: URI,
    selector: SchemaPathSelector,
    scope?: CellScope,
    instance?: ScopeKey,
  ): Promise<Result<Unit, PullError>> {
    const result = await replica.sync(uri, selector, scope, instance);
    if (result.error !== undefined || uri.startsWith("cid:")) {
      return result;
    }
    const dependencyFailure = await this.options.syncReplayDependencies(
      replica.getDocument(uri, scope),
    );
    return dependencyFailure === undefined
      ? result
      : { error: dependencyFailure as PullError };
  }

  #followReplacement<T>(
    read: (replica: SpaceReplica) => Promise<T>,
  ): Promise<T> {
    const replica = this.replica;
    return read(replica).then(
      (result) =>
        this.replica !== replica && !this.#destroyed
          ? read(this.replica)
          : result,
      (error) => {
        if (this.replica !== replica && !this.#destroyed) {
          return read(this.replica);
        }
        throw error;
      },
    );
  }

  operationCodecs(): Promise<readonly string[]> {
    return this.#followReplacement((replica) => replica.operationCodecs());
  }

  queryOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
  ): Promise<OperationFieldSnapshot> {
    return this.#followReplacement((replica) =>
      replica.queryOperationField(query)
    );
  }

  applyOperation(operation: ApplyOpOperation): Promise<ApplyOpResolution> {
    return this.#followReplacement((replica) =>
      replica.applyOperation(operation)
    );
  }

  releaseOperationField(operation: ReleaseOpFieldOperation): Promise<void> {
    return this.#followReplacement((replica) =>
      replica.releaseOperationField(operation)
    );
  }

  async subscribeOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
    callback: (snapshot: OperationFieldSnapshot) => void,
  ): Promise<Cancel> {
    if (this.#destroyed) throw new Error("memory provider closed");
    const subscription: ProviderOperationSubscription = {
      query,
      callback,
      closed: false,
    };
    this.#operationSubscriptions.add(subscription);
    try {
      await this.#ensureOperationSubscription(subscription);
    } catch (error) {
      subscription.closed = true;
      this.#operationSubscriptions.delete(subscription);
      throw error;
    }
    if (subscription.closed || this.#destroyed) {
      throw new Error("memory provider closed");
    }
    return () => {
      if (subscription.closed) return;
      subscription.closed = true;
      this.#operationSubscriptions.delete(subscription);
      subscription.cancel?.();
      subscription.cancel = undefined;
    };
  }

  #ensureOperationSubscription(
    subscription: ProviderOperationSubscription,
  ): Promise<void> {
    if (subscription.install !== undefined) return subscription.install;
    const install = this.#installOperationSubscription(subscription);
    subscription.install = install;
    const clear = () => {
      if (subscription.install === install) subscription.install = undefined;
    };
    install.then(clear, clear);
    return install;
  }

  async #installOperationSubscription(
    subscription: ProviderOperationSubscription,
  ): Promise<void> {
    while (!subscription.closed && !this.#destroyed) {
      const replica = this.replica;
      let cancel: Cancel;
      try {
        cancel = await replica.subscribeOperationField(
          subscription.query,
          subscription.callback,
        );
      } catch (error) {
        if (replica !== this.replica && !this.#destroyed) continue;
        throw error;
      }
      if (subscription.closed || this.#destroyed) {
        cancel();
        return;
      }
      if (replica !== this.replica) {
        cancel();
        continue;
      }
      subscription.cancel?.();
      subscription.cancel = cancel;
      return;
    }
  }

  canReplaceProvisionalReplica(): boolean {
    const { generation, writeIssuedGeneration } = this.options.routeState;
    return writeIssuedGeneration !== generation;
  }

  async replaceProvisionalReplica(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    const previous = this.replica;
    this.#routeAbort.abort(new Error("memory replica route replaced"));
    this.options.routeState.generation++;
    this.#routeAbort = new AbortController();
    const replacement = this.#createReplica();
    this.replica = replacement;
    for (const subscription of this.#operationSubscriptions) {
      subscription.cancel?.();
      subscription.cancel = undefined;
    }
    previous.redirectOverlappingReadsTo((uri, selector, scope, instance) =>
      this.#replaySync(replacement, uri, selector, scope, instance)
    );
    previous.reset();
    previous.closeNow();
    const requests = [...this.#syncRequests.values()]
      .flatMap((bySelector) => [...bySelector.values()]);
    await Promise.all([
      ...requests.map(({ uri, selector, scope, instance }) =>
        this.#replaySync(replacement, uri, selector, scope, instance)
      ),
      ...[...this.#operationSubscriptions].map((subscription) =>
        this.#ensureOperationSubscription(subscription)
      ),
    ]);
  }

  synced(): Promise<void> {
    return this.#followReplacement((replica) => replica.synced());
  }

  /** See SpaceReplica.inputSynced (stage F's serving-loop barrier). */
  inputSynced(): Promise<void> {
    return this.#followReplacement((replica) => replica.inputSynced());
  }

  authorizationError(): Error | undefined {
    return this.replica.authorizationError();
  }

  ensureSession(): Promise<void> {
    return this.#followReplacement((replica) => replica.ensureSession());
  }

  /** See SpaceReplica.noteAclChanged (THE SESSION REMOUNT's latch). Only
   *  the CURRENT replica: a replaced one is being torn down. */
  noteAclChanged(): void {
    if (this.#destroyed) return;
    this.replica.noteAclChanged();
  }

  listEntityIds(): Promise<string[] | undefined> {
    return this.#followReplacement((replica) => replica.listEntityIds());
  }

  listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    return this.#followReplacement((replica) =>
      replica.listEntityIdPage(options)
    );
  }

  entityIdExists(id: string): Promise<boolean | undefined> {
    return this.#followReplacement((replica) => replica.entityIdExists(id));
  }

  pullToServerHead(): Promise<void> {
    return this.#followReplacement((replica) => replica.pullToServerHead());
  }

  sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    reader?: SqliteQueryReader,
  ): Promise<SqliteQueryResult> {
    return this.#followReplacement((replica) =>
      replica.sqliteQuery(db, sql, params, reader)
    );
  }

  sqliteServerCommitRowLabelEval(): boolean {
    return this.replica.sqliteServerCommitRowLabelEval();
  }

  registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    return this.replica.registerSqliteDiskSource(id, path);
  }

  get(uri: URI, scope?: CellScope): EntityDocument | undefined {
    return this.replica.getDocument(uri, scope);
  }

  sink(
    uri: URI,
    callback: (value: EntityDocument | undefined) => void,
  ): Cancel {
    return this.replica.sinkDocument(uri, callback);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    for (const subscription of this.#operationSubscriptions) {
      subscription.closed = true;
      subscription.cancel?.();
    }
    this.#operationSubscriptions.clear();
    this.#routeAbort.abort(new Error("memory replica closed"));
    this.options.routeState.generation++;
    await this.replica.close();
  }

  async destroyNow(): Promise<void> {
    if (!this.#destroyed) {
      this.#destroyed = true;
      for (const subscription of this.#operationSubscriptions) {
        subscription.closed = true;
        subscription.cancel?.();
      }
      this.#operationSubscriptions.clear();
      this.#routeAbort.abort(new Error("memory replica closed"));
      this.options.routeState.generation++;
    }
    await this.replica.closeNow();
  }
}

type WatchAddress = {
  id: URI;
  type: MIME;
  scope?: CellScope;

  /** The explicit instance an instance-named load targets (stage A). */
  scopeKey?: ScopeKey;
};

type SyncTask = {
  entries: [WatchAddress, SchemaPathSelector][];
  promise: Promise<Result<Unit, PullError>>;
};

type WatchRefreshBatch = {
  type: "pull" | "integrate";
  entries: Map<string, [WatchAddress, SchemaPathSelector]>;
  pending: PromiseWithResolvers<Result<Unit, PullError>>;
};

type NativeCommitOperation =
  | {
    op: "set";
    id: URI;
    scope?: CellScope;
    value: EntityDocument;
  }
  | {
    op: "patch";
    id: URI;
    scope?: CellScope;
    patches: PatchOp[];
    value: EntityDocument;
  }
  | { op: "delete"; id: URI; scope?: CellScope };

class StorageTransactionRejectionError extends Error {
  constructor(readonly rejection: StorageTransactionRejected) {
    super(rejection.message);
    this.name = rejection.name;
  }
}

/**
 * A commit that has been issued (optimistic write applied, verdict not yet
 * settled) and that carries PENDING reads — i.e. its read set depends on
 * another in-flight commit's optimistic state. Tracked in `#inFlightCommits`
 * so that when a dependency's optimistic writes are dropped (`#dropPending`),
 * the dependants can be rejected locally instead of waiting for the server's
 * inevitable "pending dependency not resolved" (CT-1872 1b).
 *
 * Commits with NO pending reads are deliberately never registered: a
 * zero-read mergeable/blind commit is DESIGNED to survive a parent drop (the
 * server materializes its spine via createMissing — CT-1872 1a), and the
 * scheduler-observation batch wrapper carries no reads at all. Cascading
 * either would break intended semantics.
 */
type InFlightCommit = {
  readonly localSeq: number;

  /**
   * The unique localSeqs named by `commit.reads.pending` — every in-flight
   * commit this one's read view sits on (resolution-only lower-layer reads
   * carry the same `localSeq` field, so they contribute here too).
   */
  readonly dependencies: ReadonlySet<number>;

  readonly operations: NativeCommitOperation[];
  readonly source?: IStorageTransaction;
  readonly commit: ClientCommit;

  /** The identity the commit's operations were applied under (a served
   * per-instance run's; absent = the replica's own) — its verdict
   * promotes or drops exactly those instances' pending layers. */
  readonly identity?: ScopeKeyIdentity;

  /**
   * Resolves when a rejection is fabricated locally for this commit (a
   * pending dependency was dropped, or the replica reset). Raced against the
   * server verdict in `#pushCommit`.
   */
  readonly localRejection: PromiseWithResolvers<StorageTransactionRejected>;

  /**
   * Set synchronously BEFORE `localRejection` resolves, so `#pushCommit`'s
   * pre-send checkpoints can observe the rejection without racing the
   * microtask queue. `undefined` means "not locally rejected".
   */
  localRejectionValue?: StorageTransactionRejected;

  /** True once `#pushCommit`'s finally ran — the outcome is finalized and the
   * entry can no longer be cascaded. */
  settled: boolean;
};

/**
 * The replica's local doc key: per scope INSTANCE (server-execution v2
 * stage A — OW17's instance-keyed serving replica; key-vocabulary.md §5).
 * `instance` is the shared `scope_key` — `space`, `user:<p>`,
 * `session:<p>:<s>` — resolved by the caller through
 * {@link SpaceReplica.instanceKey}: from an explicit key (a keyed frame,
 * a keyed address), else from the reading/sealing run's identity, else
 * from the replica's own identity. At cardinality 1 (every client, the
 * whole OFF arm) every key resolves from the replica's own identity, so
 * the re-keyed string partitions the local docs exactly as the scope-NAME
 * string did (key-vocabulary.md §2's argument): nothing distinct merges,
 * nothing merged separates. On a serving runtime the replica can now hold
 * BOTH the service instance and per-principal instances of one doc, and a
 * per-instance run reads and writes ITS instance. The one name-keyed
 * fallback: a scope the identity cannot resolve (an anonymous session's
 * user-scoped read) keys by the scope NAME, exactly as before.
 */
const docKey = (id: URI, instance: string): string => `${instance}\0${id}`;

/** A local address the replica keys: the scope name plus, where the
 * caller knows it, the explicit instance key. */
type LocalDocAddress = { id: URI; scope?: CellScope; scopeKey?: ScopeKey };

/**
 * One space's local replica: the documents the server has confirmed, the
 * local writes pending on them, and the session that keeps the two in step.
 * Exported so that a test holding one as `ISpaceReplica` can narrow to the
 * class.
 */
export class SpaceReplica
  implements ISpaceReplica, IOperationStorageCapability {
  readonly #space: MemorySpace;
  readonly #subscription: IStorageSubscription;
  readonly #scopeKeyIdentity: () => ScopeKeyIdentity;

  /** The replica's OWN instance keys per scope name, resolved once (the
   * manager's identity is stable for the manager's live span — `close()`
   * ends it and the replicas with it): the doc-key hot path resolves an
   * own-identity address with a map lookup, never a per-read
   * `resolveScopeKey`. A scope the identity cannot resolve keys by NAME. */
  #ownInstanceKeys: Map<string, string> | undefined;

  readonly #createSession: () => Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;
  #sessionHandle?: Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }>;

  /** The client of the last RESOLVED session handle — for synchronous
   *  capability reads (`sqliteServerCommitRowLabelEval`). */
  #sessionClient?: MemoryV2Client.Client;

  /** The session of the last RESOLVED handle — read synchronously so
   *  `authorizationError()` can observe a denial that terminated the session
   *  during reconnect, which closes its watch view without a fresh watch result
   *  to record. */
  #sessionSession?: MemoryV2Client.SpaceSession;

  /** THE SESSION REMOUNT's latch (see `noteAclChanged` /
   *  `#consumeOwedSessionRemount`): an admitted commit touched this space's
   *  ACL doc, so the verdict a terminated session died of may have changed.
   *  Cleared when the owed remount is consumed — or immediately, when there
   *  is no memoized mount to replace. */
  #aclChangedSinceMount = false;

  readonly #docs = new Map<string, DocumentRecord>();
  readonly #syncTasks = new Map<string, SyncTask>();
  readonly #commitPromises = new Set<Promise<unknown>>();

  /**
   * Issued-but-unsettled commits that carry pending reads, keyed by `localSeq`.
   * Scanned by `#cascadeDroppedDependency()` when a dependency's optimistic
   * writes are dropped. See the `InFlightCommit` doc for why zero-pending-read
   * commits are never registered.
   */
  readonly #inFlightCommits = new Map<number, InFlightCommit>();

  /**
   * Commits whose rejection verdict is known but whose optimistic layer is
   * still standing in `record.pending`, because `#finalizeRejection()` holds
   * the drop until the conflict read repair completes. `buildReads()` names
   * every layer it finds, so a commit minted in that window names a layer the
   * server will never resolve. Maps the dead `localSeq` to a promise that
   * settles when its drop completes: the pre-send checkpoint rejects such a
   * commit locally and gates its retry on that promise, so the retry rebuilds
   * against the repaired base rather than the dead one.
   */
  readonly #rejectedPendingLayers = new Map<number, Promise<void>>();

  /**
   * Every unsettled commit's outcome promise, keyed by `localSeq` (a superset
   * of `#inFlightCommits`: zero-read commits appear here too). The old-server
   * scalarization hold awaits these for the _omitted_ lower dependencies —
   * entries are removed on settlement, so an absent key means settled.
   */
  readonly #commitOutcomeBySeq = new Map<
    number,
    Promise<unknown>
  >();

  /**
   * Server verdict promises superseded by a local rejection. Kept _out_ of
   * `#commitPromises` so `synced()` never blocks on a verdict the server may
   * withhold indefinitely; `close()`/`closeNow()` drain the set after client
   * teardown rejects every in-flight request.
   */
  readonly #suppressedVerdicts = new Set<Promise<void>>();

  readonly #syncPromises = new Set<Promise<Result<Unit, PullError>>>();

  /**
   * Schema-hash hydration dedupe (`#hydrateArrivedCfcSchemaRefs()`): hashes
   * whose `cid:` pull is in flight or has succeeded; a failed pull removes its
   * entry so a later frame can retry.
   */
  readonly #kickedCfcSchemaPulls = new Set<string>();

  readonly #updatePromises = new Set<Promise<void>>();
  readonly #sinks = new Map<
    string,
    Set<(document: EntityDocument | undefined) => void>
  >();
  readonly #operationSinks = new Map<
    string,
    Set<(snapshot: OperationFieldSnapshot) => void>
  >();
  readonly #operationWatchRemovals = new Map<string, Promise<void>>();
  #watchView: MemoryV2Client.WatchView | null = null;

  /**
   * The specific view instance that `#consumeUpdates()` is iterating. This can
   * diverge from `#watchView` (the client may hand back a fresh view instance
   * on a later refresh while the original consumer keeps running), so teardown
   * must close _this_ view to settle the consumer's pending `next()`. Closing
   * only `#watchView` can leave the consumer's view open, hanging `dispose()`
   * on `Promise.allSettled([...#updatePromises])`.
   */
  #subscribedWatchView: MemoryV2Client.WatchView | null = null;

  #watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
    () => this.#scopeKeyIdentity(),
  );
  #watchedIds = new Set<string>();

  /** The store read-through this replica serves misses from (see
   * ProviderOptions.storeReadThrough). */
  readonly #storeReadThrough: () => StoreReadThrough | undefined;

  /**
   * Depth of frame integrations in progress (`#applySessionSync()`). A
   * read made while a frame integrates — the differential checkout's
   * snapshot through `get()`, the arrived-cfc hydration's `getDocument()`
   * — must not start a store read-through, which would integrate a
   * second frame from inside the first; a nonzero depth turns the
   * read-through off for that read.
   */
  #frameApplyDepth = 0;

  /**
   * The instances (doc keys) the store read-through has read and found
   * nothing at. No record stands for such an instance — a session's pull
   * that delivered nothing leaves none either, and a transaction's read
   * of it stays an unexamined absence for commit to reconcile — but the
   * store is not asked again until the feed reports a write to it
   * (`integrateStoreWrites()`), which reads it once more.
   */
  readonly #storeAbsences = new Set<string>();

  /**
   * The last `SessionSync` snapshot _absorbed_ for each watched key — its
   * address as the frame named it and the seq and deletedness it carried — kept
   * so the replica can _declare_ its holdings on a reconnect (`holdings()`).
   * Delivery-backed on purpose: `record.confirmed` also advances by local
   * promotion (`#confirmPending()`, an own accepted write extrapolated over the
   * pending base), and a holding declared at a promoted seq would let the
   * server elide the authoritative snapshot at that seq — a `patch` head's
   * merged foreign content the promotion cannot reproduce. Only a frame this
   * replica absorbed writes here.
   */
  readonly #delivered = new Map<
    string,
    {
      id: URI;
      scope: CellScope | undefined;
      scopeKey: ScopeKey | undefined;
      branch: BranchName;
      seq: number;
      deleted: boolean;
    }
  >();

  #nextLocalSeq = 1;

  /** The Phase-3 event-intent queue (events.md §5, LT9), created on the
   * first fire into this space. Owns fired-order discharge and the
   * duplicate-as-delivered classification; its entries are the client's
   * offline event queue. */
  #eventAppendQueue?: EventAppendQueue;

  #eventAppendQueueStore?: EventAppendQueueStore;
  #eventAppendPacing?: EventAppendPacing | false;

  /** Phase 5's producer-side foreign-scoped-read refusal (see
   * ProviderOptions.refuseForeignScopedReads). */
  #refuseForeignScopedReads = false;

  #closed = false;
  readonly #closeSignal = Promise.withResolvers<void>();
  #getTelemetry: () => TelemetrySink | undefined;
  #caughtUpLocalSeq = 0;

  /**
   * Accepted verdicts _parked_ until marker coverage: the server stages a
   * `caughtUpLocalSeq` obligation for every accept, and the client holds the
   * commit's promotion — pending overlay to confirmed mirror — until a frame's
   * marker covers it, so promotion extrapolates over a base that reflects the
   * foreign novelty the accept was applied on top of instead of minting a
   * confirmed state from a stale mirror. Verdicts return inline (the fan-out
   * stays batched); only their state application waits. Applied in ascending
   * `localSeq` order by `noteCaughtUpLocalSeq()`; cleared on reset (the re-pull
   * re-derives the durable state).
   */
  #parkedAccepts = new Map<number, {
    operations: NativeCommitOperation[];
    applied: AppliedCommit;

    /** Resolves when the parked application runs — the commit promise's
     * resolution point (CT-1950): the caller may then act on its
     * subscribed view as one reflecting the committed write. */
    settled: PromiseWithResolvers<void>;
  }>();

  /**
   * Waiters on a parked accept's _application_ (the read-consistency barrier —
   * see `whenApplied()`). Resolved when the parked accept promotes (marker
   * coverage, marker-channel death) or dies with the parked set (reset/close —
   * the re-pull re-derives the durable state, so applied is moot and the waiter
   * must not hang).
   */
  #appliedWaiters = new Map<number, PromiseWithResolvers<void>>();

  /**
   * Foreign novelty whose _visibility_ is still shadowed by own pending writes
   * (the settle input barrier — see `unappliedForeignSeqFloor()` on
   * `ISpaceReplica`): docKey → the set of shadowed inbound seqs. A _set_, not
   * one extremum: the floor must be the doc's _lowest_ hidden seq — every
   * derivation in the wave read the view from before the _earliest_ hidden
   * input, so W may not pass it even when later hidden updates superseded its
   * value — while the own-echo verdict repair must remove _exactly_ its own
   * mis-recorded seq without disturbing genuine foreign shadows folded around
   * it (a single min would be deleted whole, losing them). A shadowed _remove_
   * records the sentinel 1 — the wire carries no seq for removes, so the floor
   * holds W entirely until the shadow clears. Entries are pruned lazily when
   * the doc's pending set empties (promotion, drop, rollback); cleared whole on
   * reset.
   */
  readonly #shadowedForeignSeqs = new Map<string, Set<number>>();

  /**
   * The settle input barrier's _wake_ (`ISpaceReplica.shadowFlipObserver`):
   * invoked synchronously whenever a `#confirmPending()` promotion touched a
   * doc with a standing shadow (flag ON — the flip checkout's own condition),
   * value diff or not: the _floor_ lifts either way, and the floor is what the
   * wake exists for. The `SpaceServer` installs it at activation so a
   * clamped-then-quiet space's catch-up wave runs at the flip instead of
   * waiting out the idle window — the flip is the one input whose dirtiness
   * arrives _without_ a new admitted commit on the host feed (the commit was
   * drained waves ago; only its _visibility_ changed).
   *
   * Initialized _explicitly_ (`= undefined`), as are the two overlay wakes
   * below: the browser worker bundle compiles class fields without define
   * semantics, so an _uninitialized_ field is dropped from the class body and
   * an `"observer" in replica` probe reads false — the overlay's install would
   * silently return and the wake never fire in browsers. The overlay probes by
   * capability method instead, and the initializers keep the fields visible
   * either way.
   */
  shadowFlipObserver: (() => void) | undefined = undefined;

  /**
   * `localSeq` → the store seq its accept committed at (`speculation.md` §4):
   * the overlay destination's retirement floor is that the origin _acked_ and W
   * ≥ that commit's seq, and the ack seq is otherwise consumed by promotion.
   * Bounded (insertion-ordered, oldest pruned) — the overlay only ever asks
   * about recent origins.
   */
  readonly #ackedSeqsByLocalSeq = new Map<number, number>();

  static readonly #MAX_RETAINED_ACK_SEQS = 4096;

  /**
   * `localSeq`s of live _speculative_ sealed commits (`speculation.md` §1/§6):
   * overlay entries exist only in this process — the client never pushes them —
   * so a _pushed_ commit whose read basis names one can _never_ have that
   * dependency resolve server-side. `#commitOperations()` refuses such an
   * export loudly; membership ends when the speculative commit settles
   * (retirement/withdrawal drops its pending layers first, so no stack names a
   * seq after it leaves this set).
   */
  readonly #speculativeLocalSeqs = new Set<number>();

  /**
   * The overlay destination's retirement _wake_ for origin accepts
   * (`ISpaceReplica.speculationAckObserver`, `speculation.md` §4): fired when a
   * pushed commit's accept records its ack seq. Without it, an entry whose
   * sweep ran while its origin's verdict was still in flight (blocked on the
   * unacked layer) — and whose covering watermark event therefore passed —
   * would stay pending forever on a then-quiet space: rejected origins cascade
   * into the entry, but _accepted_ origins have no other client-side wake.
   * Guarded at the call site — an observer throw must not corrupt accept
   * settlement.
   */
  speculationAckObserver: (() => void) | undefined = undefined;

  #speculationArrivalObserver:
    | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
    | undefined = undefined;
  #caughtUpLocalSeqWaiters: {
    localSeq: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];

  /**
   * docKey → required `caughtUpLocalSeq`. An entry means this id conflicted and
   * is stale until we observe `caughtUpLocalSeq >= value`. Pruned as the runner
   * catches up; only populated while conflict admission control is enabled.
   */
  #staleFloor = new Map<string, number>();

  #queuedWatchRefresh: WatchRefreshBatch | null = null;
  #queuedWatchRefreshScheduled = false;

  /**
   * Number of watch-refresh round trips currently awaiting a response. Capped
   * at `#maxWatchRefreshInFlight()` (1 = single-flight; the concurrent window
   * otherwise) so a large incrementally-discovered wave cannot put an unbounded
   * number of requests on the wire.
   */
  #watchRefreshInFlight = 0;

  /**
   * The current _permanent_ authorization denial for this space (an ACL
   * shortfall, an audience or protocol mismatch), or `null` when the space is
   * authorized. A non-retriable `AuthorizationError` from a watch refresh sets
   * it; a successful refresh clears it; a retriable auth race and a transient
   * transport error leave it untouched, so a blip or token-refresh window does
   * not register as a denial. `authorizationError()` reports it as a throwable
   * error; `synced()` stays silent so a denied cross-space link remains a
   * silent absent read.
   */
  #lastAuthorizationError: IAuthorizationError | null = null;
  #onAccessChange?: (error: Error | undefined) => void;
  #cancelAccessLoss: Cancel | undefined;

  readonly #routeState: ProviderRouteState;
  readonly #routeGeneration: number;
  #replacementRead:
    | ((
      uri: URI,
      selector: SchemaPathSelector,
      scope?: CellScope,
      instance?: ScopeKey,
    ) => Promise<Result<Unit, PullError>>)
    | undefined;

  #viewPlans: readonly ViewPlan[] = [];
  #viewCapabilitySession: MemoryV2Client.SpaceSession | undefined;
  #cancelViewCapabilityLost: Cancel | undefined;
  #viewOwnerVersion = 0;
  #viewOwnerRetired: (() => void) | undefined;
  #viewRevision = 0;
  #viewPlanObservers = new Set<(plans: readonly ViewPlan[]) => void>();

  #localCoverageObservers = new Set<
    (addresses: readonly LocalDocAddress[]) => void
  >();

  #settings: IRemoteStorageProviderSettings;

  constructor(options: SpaceReplicaOptions) {
    this.#space = options.space;
    this.#subscription = options.subscription;
    this.#onAccessChange = options.onAccessChange;
    this.#scopeKeyIdentity = options.scopeKeyIdentity;
    this.#createSession = options.createSession;
    this.#getTelemetry = options.getTelemetry ?? (() => undefined);
    this.#settings = options.settings;
    this.#routeState = options.routeState;
    this.#routeGeneration = options.routeGeneration;
    this.#eventAppendQueueStore = options.eventAppendQueueStore;
    this.#eventAppendPacing = options.eventAppendPacing;
    this.#refuseForeignScopedReads = options.refuseForeignScopedReads === true;
    this.#storeReadThrough = options.storeReadThrough ?? (() => undefined);
    // Eager queue init (LT9; verdict blocker, 2026-08-12): a dead
    // predecessor replica's intents in the manager-shared store must
    // discharge WITHOUT waiting for a fresh fire. The constructor's
    // load kicks the drain iff rows exist; an empty load is inert (no
    // session is established until something discharges).
    this.#ensureEventAppendQueue();
  }

  /**
   * The caught-up and stale-floor bookkeeping, the read builder, the
   * session-sync consumer, the watch-set refresh, the session-sync apply
   * step, and the conflict read repair, which a test drives directly. It
   * also reports whether the replica holds a record for a document.
   */
  get accessForTestingOnly(): {
    noteCaughtUpLocalSeq(localSeq: number | undefined): void;
    waitForCaughtUpLocalSeq(localSeq: number): Promise<void>;
    recordStaleFloor(commit: ClientCommit, localSeq: number): void;
    preemptThreshold(commit: ClientCommit): number | undefined;
    buildReads(
      source: IStorageTransaction | undefined,
      localSeq: number,
      identity?: ScopeKeyIdentity,
    ): ClientCommit["reads"];
    consumeUpdates(iterator: AsyncIterator<SessionSync>): Promise<void>;
    refreshWatchSet(
      entries: Iterable<[WatchAddress, SchemaPathSelector]>,
      type?: "pull" | "integrate",
    ): Promise<Result<Unit, PullError>>;
    applySessionSync(sync: SessionSync, type: "pull" | "integrate"): void;
    waitForConflictReadRepair(
      rejection: StorageTransactionRejected,
    ): Promise<void>;
    hasDocumentRecord(
      id: URI,
      scope?: CellScope,
      identity?: ScopeKeyIdentity,
    ): boolean;
    hydrateArrivedCfcSchemaRefs(sync: SessionSync): void;
  } {
    return {
      noteCaughtUpLocalSeq: (localSeq) => this.#noteCaughtUpLocalSeq(localSeq),
      waitForCaughtUpLocalSeq: (localSeq) =>
        this.#waitForCaughtUpLocalSeq(localSeq),
      recordStaleFloor: (commit, localSeq) =>
        this.#recordStaleFloor(commit, localSeq),
      preemptThreshold: (commit) => this.#preemptThreshold(commit),
      buildReads: (source, localSeq, identity) =>
        this.#buildReads(source, localSeq, identity),
      consumeUpdates: (iterator) => this.#consumeUpdates(iterator),
      refreshWatchSet: (entries, type) => this.#refreshWatchSet(entries, type),
      applySessionSync: (sync, type) => this.#applySessionSync(sync, type),
      waitForConflictReadRepair: (rejection) =>
        this.#waitForConflictReadRepair(rejection),
      hasDocumentRecord: (id, scope, identity) =>
        this.#hasDocumentRecord(id, scope, identity),
      hydrateArrivedCfcSchemaRefs: (sync) =>
        this.#hydrateArrivedCfcSchemaRefs(sync),
    };
  }

  /**
   * Observer of authoritative arrivals, called at the end of applying a frame
   * with the docs whose confirmed seq the frame moved forward; the overlay
   * destination sets one as its retirement wake for the owed arrival
   * re-sweep of speculation.md §4 (`ISpaceReplica.speculationArrivalObserver`).
   * Guarded at the call site, so an observer throw cannot corrupt frame
   * integration.
   */
  get speculationArrivalObserver():
    | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
    | undefined {
    return this.#speculationArrivalObserver;
  }

  set speculationArrivalObserver(
    value:
      | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
      | undefined,
  ) {
    this.#speculationArrivalObserver = value;
  }

  did(): MemorySpace {
    return this.#space;
  }

  /**
   * The scope INSTANCE key a local address keys under (see `docKey`):
   * the address's explicit `scopeKey` when it names one; else the scope
   * name resolved against `identity` (a served run's demand-supplied
   * identity — the tx→replica seam) when given; else against the
   * replica's own identity (every client, the OFF arm). An unresolvable
   * scope keys by NAME.
   */
  instanceKey(
    scope: CellScope | undefined,
    identity?: ScopeKeyIdentity,
    explicit?: ScopeKey,
  ): string {
    if (explicit !== undefined) return explicit;
    const name = normalizeCellScope(scope);
    if (identity !== undefined) {
      return canResolveScopeKey(name, identity)
        ? resolveScopeKey(name, identity)
        : name;
    }
    return this.#ownInstanceKey(name);
  }

  #ownInstanceKey(name: CellScope): string {
    let keys = this.#ownInstanceKeys;
    if (keys === undefined) {
      keys = new Map();
      const own = this.#scopeKeyIdentity();
      for (const scope of ["space", "user", "session"] as const) {
        keys.set(
          scope,
          canResolveScopeKey(scope, own) ? resolveScopeKey(scope, own) : scope,
        );
      }
      this.#ownInstanceKeys = keys;
    }
    return keys.get(name) ?? name;
  }

  /** The doc key of a local address under `identity` (see instanceKey). */
  #docKeyOf(address: LocalDocAddress, identity?: ScopeKeyIdentity): string {
    return docKey(
      address.id,
      this.instanceKey(address.scope, identity, address.scopeKey),
    );
  }

  /**
   * Whether this replica holds a record for the document. A record appears
   * once the replica has examined the document — an examination that found
   * a value and one that found the document absent both leave one — and
   * also once a local write for it is pending. This is the predicate
   * {@link loadUnexaminedAbsences} decides by. It takes `scope` and
   * `identity` as {@link getDocument} takes them, so a caller reading the
   * two together names one document across both.
   *
   * `getDocument()` reads `undefined` for a record whose value materializes
   * as `undefined` and for a document with no record at all, so a caller
   * separating those two reads both.
   */
  #hasDocumentRecord(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean {
    return this.#docs.has(this.#docKeyOf({ id, scope }, identity));
  }

  /**
   * The touched-doc entries of one operation batch (seal, verdict, frame):
   * each carries the instance it applies to, so the notification
   * differential snapshots THAT instance and the change addresses carry
   * it. The key is attached only where the batch names an instance
   * explicitly (an explicit run identity, a keyed frame) AND the scope is
   * not `space` — never for own-identity batches, so an OFF-arm
   * notification address is byte-identical to before.
   */
  #touchedOf(
    operations: readonly { id: URI; scope?: CellScope; scopeKey?: ScopeKey }[],
    identity?: ScopeKeyIdentity,
  ): LocalDocAddress[] {
    return operations.map((operation) => {
      const explicit = operation.scopeKey ??
        (identity !== undefined &&
            normalizeCellScope(operation.scope) !== "space"
          ? this.instanceKey(operation.scope, identity) as ScopeKey
          : undefined);
      return explicit === undefined
        ? { id: operation.id, scope: operation.scope }
        : { id: operation.id, scope: operation.scope, scopeKey: explicit };
    });
  }

  redirectOverlappingReadsTo(
    replacementRead: (
      uri: URI,
      selector: SchemaPathSelector,
      scope?: CellScope,
      instance?: ScopeKey,
    ) => Promise<Result<Unit, PullError>>,
  ): void {
    this.#replacementRead = replacementRead;
  }

  get(entry: IMemoryAddress): Revision<State> | undefined {
    this.#readThroughOnMiss(
      entry.id as URI,
      entry.scope,
      undefined,
      entry.scopeKey,
    );
    return this.#getState(
      entry.id as URI,
      entry.scope,
      undefined,
      entry.scopeKey,
    );
  }

  /**
   * Re-reads every listed instance this replica holds a record for
   * through the installed store read-through and integrates the results
   * as one inbound frame (see IStorageManager.integrateStoreWrites).
   * Returns how many were refreshed. An instance the replica has never
   * read is left alone: nothing depends on it, and its first read serves
   * it from the store anyway.
   */
  integrateStoreWrites(
    writes: readonly { id: string; scopeKey: ScopeKey }[],
  ): number {
    const read = this.#storeReadThrough();
    if (read === undefined || writes.length === 0) return 0;
    const upserts: SessionSyncUpsert[] = [];
    for (const write of writes) {
      const id = write.id as URI;
      const key = docKey(id, write.scopeKey);
      if (!this.#docs.has(key) && !this.#storeAbsences.has(key)) continue;
      const upsert = read({ id, scopeKey: write.scopeKey });
      if (upsert !== undefined) upserts.push(upsert);
    }
    if (upserts.length === 0) return 0;
    this.#integrateReadThrough(upserts, "integrate");
    return upserts.length;
  }

  async sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
    instance?: ScopeKey,
  ): Promise<Result<Unit, PullError>> {
    const replacementAtStart = this.#replacementRead;
    // An instance-named load (stage A) carries its instance on the pull
    // entry's address, so the watch root names it on the wire and the
    // arriving doc keys under it; a plain load carries none.
    const address = {
      id: uri,
      type: DOCUMENT_MIME as MIME,
      scope,
      ...(instance !== undefined ? { scopeKey: instance } : {}),
    };
    const result = await this.pull([[address, selector]]);
    const replacement = this.#replacementRead;
    if (replacementAtStart === undefined && replacement !== undefined) {
      return await replacement(
        uri,
        normalizeSyncEntries([[address, selector]])[0][1],
        scope,
        instance,
      );
    }
    return result;
  }

  sinkDocument(
    uri: URI,
    callback: (document: EntityDocument | undefined) => void,
  ): Cancel {
    const key = docKey(uri, "space");
    let subscribers = this.#sinks.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.#sinks.set(key, subscribers);
    }
    subscribers.add(callback);
    void this.sync(uri);
    return () => {
      const current = this.#sinks.get(key);
      current?.delete(callback);
      if (current && current.size === 0) {
        this.#sinks.delete(key);
      }
    };
  }

  async send(
    batch: { uri: URI; document: EntityDocument | undefined }[],
  ): Promise<Result<Unit, PushError>> {
    const operations = batch.map(({ uri, document }) =>
      document === undefined ? { op: "delete" as const, id: uri } : {
        op: "set" as const,
        id: uri,
        value: document,
      }
    );
    return await this.#commitOperations(operations, undefined);
  }

  async synced(): Promise<void> {
    await Promise.all([...this.#syncPromises, ...this.#commitPromises]);
  }

  /**
   * INBOUND settlement only (server-execution v2 stage F): outstanding
   * watch refreshes/pulls, EXCLUDING commit settlement AND update
   * processing. The serving loop's wave settle needs "requested input
   * has arrived" — but a SEALED commit's settlement resolves only at
   * the wave commit the loop performs AFTER settling, and update
   * PROCESSING can park behind that same sealed commit (promotion
   * ordering), so awaiting either is a deadlock by construction (broken
   * only by the flush deadline — observed as every first wave of a
   * burst flushing at T_flush). Client code keeps `synced()`:
   * durability is exactly what a client barrier means.
   *
   * The stage-F residual — a foreign authored frame parked behind an
   * own sealed commit could be claimed by W one wave early — is CLOSED
   * as of Phase 2 (the plan's revisit (a)), by exclusion rather than by
   * awaiting: this barrier still never waits on parked applications
   * (the deadlock above), and the wave instead EXCLUDES still-shadowed
   * seqs from its W advance via `unappliedForeignSeqFloor`, with the
   * shadow-flip notification in `#confirmPending` registering the
   * dirtiness the moment the parked overlay leaves.
   *
   * Arrival includes the transport handing over every frame it holds when
   * this is called; frames the server sends later do not extend the wait. The
   * serving runtime's loopback transport delivers one frame per event-loop
   * turn, so a frame the server has already sent — the authored commit a
   * wave is about to claim among it — can sit queued behind others for
   * several turns. Handing a frame over is not processing it, so this wait
   * cannot park behind a sealed commit.
   */
  async inputSynced(): Promise<void> {
    await this.#sessionClient?.delivered();
    await Promise.all([...this.#syncPromises]);
  }

  /**
   * A real, throwable `AuthorizationError` when this space is under a permanent
   * authorization denial, or undefined when it is authorized. `synced()`
   * deliberately does NOT throw this: a denied cross-space link must stay a
   * silent absent read (the sync-load-failure surfacing contract), and the
   * global sync barrier aggregates every space, so throwing there would fail a
   * whole runtime settle on an incidental unauthorized link. A caller that cares
   * about a SPECIFIC space — the CLI, opening the space it was asked to act on —
   * reads this after `synced()` and surfaces it deliberately.
   *
   * A watch refresh records the denial in most cases. A permanent denial during
   * RECONNECT is the exception: the memory client terminates the session and
   * closes its watch view without another refresh result (see the client's
   * `SpaceSession.restore`), so `#lastAuthorizationError` never captures it and a
   * caller that only reaches `synced()` without a further pull would see the
   * space as authorized. Consult the terminated session directly for that case.
   */
  authorizationError(): Error | undefined {
    if (this.#lastAuthorizationError !== null) {
      return authorizationErrorToThrow(this.#lastAuthorizationError);
    }
    // `terminateSession` stores a permanent AuthorizationError as the session's
    // close error; a graceful close ("memory session closed") or a takeover
    // revocation (SessionRevokedError) carries a different name and is not an
    // authorization denial for this space, so only the AuthorizationError is
    // surfaced here.
    const closeError = this.#sessionSession?.closeError;
    if (closeError !== undefined && closeError.name === "AuthorizationError") {
      return closeError;
    }
    return undefined;
  }

  /**
   * Record the authorization status a watch refresh result implies. A permanent
   * (non-retriable) AuthorizationError becomes the sticky failure
   * `authorizationError()` reports; a successful refresh proves the session is
   * authorized and clears it. A transient connection error or a retriable auth
   * race leaves the last known status unchanged, so a blip does not mask or
   * manufacture a denial.
   */
  #noteAuthorizationStatus(result: Result<Unit, PullError>): void {
    if (result.error) {
      if (
        result.error.name === "AuthorizationError" &&
        (result.error as { retriable?: unknown }).retriable !== true
      ) {
        this.#lastAuthorizationError = result.error as IAuthorizationError;
        this.#onAccessChange?.(
          authorizationErrorToThrow(this.#lastAuthorizationError),
        );
      }
      return;
    }
    this.#lastAuthorizationError = null;
  }

  async ensureSession(): Promise<void> {
    await this.#activeSessionHandle();
  }

  /**
   * THE SESSION REMOUNT's latch (the fifth face of profile starvation).
   *
   * An admitted commit touched this space's ACL document, so the
   * AUTHORIZATION VERDICT that terminated this replica's session may have
   * changed. Record it; `#memoizedSessionHandle()` consumes it on the next
   * load.
   *
   * Why a latch instead of tearing the session down right here: the memory
   * server emits the admitted-commit notice BEFORE it runs
   * `#revokeDeauthorizedSessions` (both inside one `transact` — server.ts,
   * `#notifyCommitAdmitted` then the `aclTouched` sweep). At notification
   * time the session that the very same commit is about to revoke is still
   * OPEN, so an eager teardown would inspect a live session, decline, and
   * the revocation landing a moment later would starve exactly as before.
   * Latching makes the fix independent of that ordering rather than
   * dependent on it.
   *
   * Consumption is event-driven, not timed: the next load attempt calls
   * `#memoizedSessionHandle()`, and the serving loop already re-attempts a
   * deferred event's load every drain (see the scheduler's `failHeadEventLoadPark`
   * and the SpaceServer's deferral backstop), so the heal arrives on the
   * cadence the deferral machinery already runs at.
   */
  noteAclChanged(): void {
    if (this.#closed) return;
    this.#aclChangedSinceMount = true;
  }

  /**
   * THE SESSION REMOUNT itself. Drop a memoized session that an ACL verdict
   * terminated, so the next `#memoizedSessionHandle()` opens a fresh one.
   *
   * A revoked (or permanently denied) space session is TERMINAL for that
   * session object: `terminateSession` (memory/v2/client.ts) closes it,
   * clears its watch specs, and stores the verdict in `closeError`, which
   * `#assertOpen()` then rethrows for every later call. Nothing on the read
   * or commit path ever dropped the memoized mount —
   * `#memoizedSessionHandle()` clears it only in `close()`/`closeNow()` — so
   * every subsequent pull
   * reused the same dead session and the space read `unauthorized` forever.
   * `storage/rejection.ts`'s `SessionError` note named this gap when it was
   * written: "the convergence argument is sound, only the remount is
   * missing."
   *
   * WHY AN ACL COMMIT IS THE ONLY TRIGGER. The verdict that killed the
   * session is a function of the space's ACL, so re-opening on any other
   * schedule re-runs a decision whose inputs have not changed — one doomed
   * round-trip per retry, exactly the cost `isTransientCommitRejection`
   * refuses to pay for `SessionError`. This is the space-root ensure's own
   * discipline for the very same boot order, one layer down: latch the owed
   * work at the fail-closed refusal, consume it when a commit touches
   * `of:<space>` (executor/space-server.ts `#rootEnsureAwaitingOwner`).
   *
   * WHY IT CANNOT WIDEN AUTHORITY. This re-opens a session; it does not
   * decide one. `session.open` re-runs the server's full admission against
   * the ACL as it now stands, and under OW31's ruled read posture a serving
   * mount carries `actingAs: "space-owner"`, so the server re-resolves the
   * binding from the LANDED ACL and the session runs as whoever owns the
   * space now. Two cases:
   *   - the genesis case (this defect): the pre-genesis session opened under
   *     the service envelope's fresh-space READ floor and the genesis ACL
   *     `{user: OWNER}` de-authorized it by design. The re-open binds the
   *     user, who is OWNER, and is admitted.
   *   - a GENUINE de-authorization (the user removed, ownership moved): the
   *     re-open is DENIED at `session.open`. `#memoizedSessionHandle()`'s
   *     catch drops the failed handle, the load keeps failing, and the
   *     served event
   *     keeps deferring — the ratified wedge, which OW54's give-up arm
   *     covers. Fail-closed, and loud.
   */
  #consumeOwedSessionRemount(): void {
    if (!this.#aclChangedSinceMount) return;
    const stale = this.#sessionHandle;
    if (stale === undefined) {
      // Nothing memoized to replace: the next open already re-decides.
      this.#aclChangedSinceMount = false;
      return;
    }
    // ONLY an ACL verdict. A handle still opening, a live session, a
    // graceful close ("memory session closed"), and a transport drop (which
    // the client's own `reconnect()`/`restore()` already heals) must all be
    // left alone: this arm exists for the one termination class no other
    // path recovers from.
    const closeError = this.#sessionSession?.closeError;
    if (
      closeError === undefined ||
      (closeError.name !== "SessionRevokedError" &&
        closeError.name !== "AuthorizationError")
    ) {
      // The latch is deliberately LEFT SET here, and clearing it would be a
      // race rather than a tidy-up. The notice arrives BEFORE the revocation
      // (see `noteAclChanged`), so a pull landing in that window sees a still
      // healthy session; discharging the latch on it would throw away the
      // remount the revocation is about to make necessary. Leaving it set
      // costs at most ONE re-open later, on a session some other verdict
      // terminates — which an ACL change is a legitimate reason to re-evaluate
      // anyway — and the latch clears when that remount runs.
      return;
    }
    this.#aclChangedSinceMount = false;
    this.#sessionHandle = undefined;
    this.#sessionClient = undefined;
    // Dropping the terminated session drops the `closeError` half of
    // `authorizationError()` with it. That is the right direction — keeping it
    // would report a denial for a space that may have just healed, and a
    // caller like the CLI would refuse to act on an authorized space — but it
    // does open a narrow window: for a denial that ONLY the close error
    // recorded (the reconnect case that never produced a watch result;
    // see `authorizationError`'s own note), `authorizationError()` reads
    // undefined between the remount arming and the next pull re-recording it.
    // No serving-loop caller reads it in that window, and no CLIENT manager is
    // ever notified at all (the host is the only caller). FLAGGED, not filled.
    this.#sessionSession = undefined;
    // The dead session's views. `terminateSession` already closed the
    // SESSION's own view; these are the replica's references to it, which a
    // later refresh would otherwise overwrite rather than close (the leak
    // `#refreshWatchSet()`'s own catch guards against).
    this.#watchView?.close();
    this.#watchView = null;
    this.#subscribedWatchView?.close();
    this.#subscribedWatchView = null;
    // Close the connection the dead session rode: the next mount builds a
    // fresh client, and leaving this one open would accumulate one
    // connection per revocation.
    stale.then(({ client }) => client.close()).catch(() => {});
    sessionRemountLogger.warn("session-remount", () => [
      `space ${this.#space}: the memoized session was terminated by ` +
      `${closeError.name} and a commit touched its ACL doc; remounting. ` +
      "A fresh session.open re-runs the server's admission against the " +
      "ACL as it now stands (OW31: a serving mount's READ decisions " +
      "resolve as the space's OWNER), so a genuine de-authorization is " +
      "denied there rather than healed here.",
    ]);
    // DROP THE WATCH-SELECTOR TRACKER. The fresh session carries no
    // watches — `terminateSession` cleared `#watchSpecs` and the server
    // dropped the session from its registry — but the tracker still records
    // every selector the DEAD session had successfully covered, and `pull()`
    // answers a covered selector out of it WITHOUT ever reaching a session.
    // So without this line, a doc the replica had read before the revocation
    // is answered `{ok:{}}` from a replica that stopped receiving its
    // updates: a SILENT STALE READ.
    //
    // The first pass flagged this as a residual with the claim that "each
    // address re-installs on its next pull". That claim was FALSE, and an
    // independent review (Cubic, P1 ×3 on this PR) was right to push on it:
    // it holds only for an address whose pull FAILED, because a failed
    // fetch removes its own selectors from the tracker — which is the
    // starved-load case this PR fixes, and not this one. Reproduced before
    // fixing: after the remount the read returned SUCCESS while the replica
    // still held the pre-revocation value.
    //
    // Scope is deliberately the tracker ALONE — not `#docs`, not
    // `#watchedIds`, not the conflict-admission state, all of which
    // `reset()` also wipes (that is a rebuild-from-scratch; this is not).
    // The cost is one genuine fetch per still-wanted address after a
    // remount, which re-installs its watch on the fresh session. A remount
    // is rare; the alternative is serving values from a subscription that
    // no longer exists.
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
  }

  async queryOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
  ): Promise<OperationFieldSnapshot> {
    const { session } = await this.#activeSessionHandle();
    return (await session.queryOperationField(query)).field;
  }

  async operationCodecs(): Promise<readonly string[]> {
    const { client } = await this.#activeSessionHandle();
    if (client.serverFlags?.applyOp !== true) return [];
    return client.serverFlags.operationCodecs ?? [];
  }

  async applyOperation(
    operation: ApplyOpOperation,
  ): Promise<ApplyOpResolution> {
    const { client, session } = await this.#activeSessionHandle();
    if (client.serverFlags?.applyOp !== true) {
      throw new Error("memory server does not support apply-op");
    }
    const localSeq = this.#nextLocalSeq++;
    const request = session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [operation],
    }, () => this.#markRouteWriteIssued());
    this.#commitPromises.add(request);
    let applied;
    try {
      applied = await request;
    } finally {
      this.#commitPromises.delete(request);
    }
    const resolution = applied.operationResolutions?.[0];
    if (resolution === undefined) {
      throw new Error("apply-op commit returned no operation resolution");
    }
    return resolution;
  }

  async releaseOperationField(
    operation: ReleaseOpFieldOperation,
  ): Promise<void> {
    const { client, session } = await this.#activeSessionHandle();
    if (client.serverFlags?.applyOp !== true) {
      throw new Error("memory server does not support release-op-field");
    }
    const localSeq = this.#nextLocalSeq++;
    const request = session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [operation],
    }, () => this.#markRouteWriteIssued());
    this.#commitPromises.add(request);
    try {
      await request;
    } finally {
      this.#commitPromises.delete(request);
    }
  }

  async subscribeOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
    callback: (snapshot: OperationFieldSnapshot) => void,
  ): Promise<Cancel> {
    const watchId = `operation:${hashStringOf(query)}`;
    let callbacks = this.#operationSinks.get(watchId);
    if (callbacks === undefined) {
      callbacks = new Set();
      this.#operationSinks.set(watchId, callbacks);
    }
    callbacks.add(callback);

    try {
      await this.#operationWatchRemovals.get(watchId);
      const { session } = await this.#activeSessionHandle();
      const { view, precedingSyncs, sync } = await session.watchAddSync([{
        id: watchId,
        kind: "operation",
        query,
      }]);
      if (this.#closed) {
        view.close();
        throw new Error("memory replica closed");
      }
      this.#watchView = view;
      for (const precedingSync of precedingSyncs) {
        this.#applySessionSync(precedingSync, "integrate");
      }
      this.#applySessionSync(sync, "integrate");
      this.#consumeWatchView(view);
    } catch (error) {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.#operationSinks.delete(watchId);
      throw error;
    }

    return () => {
      const current = this.#operationSinks.get(watchId);
      current?.delete(callback);
      if (current?.size !== 0) return;
      this.#operationSinks.delete(watchId);
      const removal = this.#removeOperationWatch(watchId).finally(() => {
        if (this.#operationWatchRemovals.get(watchId) === removal) {
          this.#operationWatchRemovals.delete(watchId);
        }
      });
      this.#operationWatchRemovals.set(watchId, removal);
    };
  }

  async #removeOperationWatch(watchId: string): Promise<void> {
    try {
      const { session } = await this.#activeSessionHandle();
      const { view, precedingSyncs, sync } = await session.watchRemoveSync([
        watchId,
      ]);
      if (this.#closed) {
        view.close();
        return;
      }
      this.#watchView = view;
      for (const precedingSync of precedingSyncs) {
        this.#applySessionSync(precedingSync, "integrate");
      }
      this.#applySessionSync(sync, "integrate");
      this.#consumeWatchView(view);
    } catch (error) {
      if (!this.#closed) {
        console.warn("failed to remove operation watch", error);
      }
    }
  }

  async sqliteQuery(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    reader?: SqliteQueryReader,
  ): Promise<SqliteQueryResult> {
    const { session } = await this.#activeSessionHandle();
    return await session.sqliteQuery(db, sql, params, reader);
  }

  async listEntityIds(): Promise<string[] | undefined> {
    const { client, session } = await this.#activeSessionHandle();
    if (client.serverFlags?.entityIdListing !== true) {
      return undefined;
    }
    if (client.serverFlags.entityIdPagination !== true) {
      return (await session.listEntityIds())?.ids;
    }

    const ids: string[] = [];
    let after: string | undefined;
    let expectedServerSeq: number | undefined;
    for (;;) {
      const page = await session.listEntityIds({
        ...(after === undefined ? {} : { after }),
        ...(expectedServerSeq === undefined ? {} : { expectedServerSeq }),
      });
      if (page === undefined) return undefined;
      expectedServerSeq ??= page.serverSeq;
      ids.push(...page.ids);
      if (page.nextAfter === undefined) return ids;
      after = page.nextAfter;
    }
  }

  async listEntityIdPage(
    options: EntityIdListOptions = {},
  ): Promise<EntityIdListResult | undefined> {
    const { client, session } = await this.#activeSessionHandle();
    if (
      client.serverFlags?.entityIdListing !== true ||
      client.serverFlags.entityIdPagination !== true
    ) {
      return undefined;
    }
    return await session.listEntityIds(options);
  }

  async entityIdExists(id: string): Promise<boolean | undefined> {
    const { client, session } = await this.#activeSessionHandle();
    if (client.serverFlags?.entityIdLookup !== true) {
      return undefined;
    }
    return (await session.entityIdExists(id))?.exists;
  }

  async pullToServerHead(): Promise<void> {
    const { session } = await this.#activeSessionHandle();
    // An empty-root graph query fetches no document but still crosses the wire
    // and returns the server's current sequence. Because a WebSocket delivers a
    // connection's frames in order, any subscription fan-out the server has
    // already sent on this connection has been received and applied by the time
    // this response arrives — so the round trip doubles as a "this replica has
    // caught up to everything the server had sent" barrier. `graph.query` is an
    // unconditional round trip (it cannot be answered from the local replica),
    // unlike the entity-id listing calls, which a server may decline by flag.
    await session.queryGraph({ roots: [] });
  }

  /**
   * Whether the server this replica is connected to advertised commit-time
   * row-label evaluation (`sqliteCommitRowLabelEval`) in its handshake.
   * Synchronous — the sqlite write gate runs inside `db.exec` — so it reads
   * the LIVE client of the last resolved session: `false` until a session
   * exists (fail closed; by the time a handler can call `db.exec`, its cells
   * have synced through a session) and refreshed by reconnect handshakes.
   */
  sqliteServerCommitRowLabelEval(): boolean {
    return this.#sessionClient?.serverFlags?.sqliteCommitRowLabelEval === true;
  }

  async registerSqliteDiskSource(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult> {
    const { session } = await this.#activeSessionHandle();
    return await session.registerSqliteDiskSource(
      id,
      path,
      () => this.#markRouteWriteIssued(),
    );
  }

  /** @inheritDoc */
  subscribeLocalCoverage(
    observer: (addresses: readonly LocalDocAddress[]) => void,
  ): () => void {
    this.#localCoverageObservers.add(observer);
    return () => this.#localCoverageObservers.delete(observer);
  }

  /** Negotiates view delivery on this replica's authenticated session. */
  async supportsViewReplication(): Promise<boolean> {
    const { client, session } = await this.#memoizedSessionHandle();
    if (this.#viewCapabilitySession !== session) {
      this.#cancelViewCapabilityLost?.();
      this.#viewCapabilitySession = session;
      this.#cancelViewCapabilityLost = session.subscribeViewCapabilityLost(() =>
        this.#publishViewPlans([])
      );
    }
    return client.serverFlags?.viewScopedReplicationV1 === true;
  }

  /** Whether the current connection retains the negotiated view protocol. */
  viewReplicationSupported(): boolean {
    return this.#sessionClient?.serverFlags?.viewScopedReplicationV1 === true;
  }

  /** Waits for session authentication and watch restoration after reconnect. */
  async whenSessionRestored(): Promise<void> {
    const { session } = await this.#memoizedSessionHandle();
    await session.whenRestored();
  }

  /** @inheritDoc */
  acquireViewInterests(onReplaced: () => void): ViewInterestLease {
    const previous = this.#viewOwnerRetired;
    const version = ++this.#viewOwnerVersion;
    this.#viewOwnerRetired = onReplaced;
    previous?.();
    const isCurrent = () => !this.#closed && this.#viewOwnerVersion === version;
    return {
      isCurrent,
      nextRevision: () => {
        if (!isCurrent()) throw new Error("View interest owner has retired");
        return this.#viewRevision++;
      },
      set: (views) => this.setViewInterests(views, isCurrent),
      release: () => {
        if (!isCurrent()) return;
        this.#viewOwnerRetired = undefined;
        const releasedVersion = ++this.#viewOwnerVersion;
        void this.setViewInterests(
          [],
          () => this.#viewOwnerVersion === releasedVersion,
        ).catch(() => {});
      },
    };
  }

  /** Replaces renderer demand while preserving ordinary watch ownership. */
  async setViewInterests(
    views: ViewInterest[],
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!isCurrent() || this.#closed) return false;
    const { client, session } = await this.#memoizedSessionHandle();
    if (!isCurrent() || this.#closed) return false;
    if (
      views.length > 0 && client.serverFlags?.viewScopedReplicationV1 !== true
    ) return false;
    await session.viewSetSync(views, ({ view, precedingSyncs, sync }) => {
      if (this.#closed) return;
      this.#watchView = view;
      for (const frame of [...precedingSyncs, sync]) {
        this.#applySessionSync(
          isCurrent() ? frame : { ...frame, viewPlans: undefined },
          "integrate",
        );
      }
      this.#consumeWatchView(view);
    });
    return !this.#closed && isCurrent();
  }

  /** Observes complete eligibility snapshots after their input documents arrive. */
  subscribeViewPlans(
    observer: (plans: readonly ViewPlan[]) => void,
  ): () => void {
    this.#viewPlanObservers.add(observer);
    observer(this.#viewPlans);
    return () => this.#viewPlanObservers.delete(observer);
  }

  #publishViewPlans(plans: readonly ViewPlan[]): void {
    this.#viewPlans = plans;
    for (const observer of this.#viewPlanObservers) {
      try {
        observer(plans);
      } catch (error) {
        logger.error(
          "view-plan-observer-error",
          "View plan observer failed",
          error,
        );
      }
    }
  }

  /** @inheritDoc */
  hasLocalDocumentCoverage(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean {
    const key = this.#docKeyOf({ id, scope }, identity);
    const record = this.#docs.get(key);
    return this.#delivered.has(key) ||
      (record?.confirmed.seq ?? 0) > 0 ||
      record?.pending.some((entry) => entry.op !== "patch") === true;
  }

  /** ISpaceReplica.confirmedDocumentSeq: the accepted seq this replica's
   * confirmed base stands at for the instance, pending writes excluded. */
  confirmedDocumentSeq(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): number {
    return this.#docs.get(this.#docKeyOf({ id, scope }, identity))
      ?.confirmed.seq ?? 0;
  }

  getDocument(
    uri: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): EntityDocument | undefined {
    this.#readThroughOnMiss(uri, scope, identity);
    return this.#visibleDocument(uri, scope, identity);
  }

  /** ISpaceReplica.getNonSpeculativeDocument (RULED 2026-08-21;
   * verification-coverage.md OW47, second producer): the doc's view
   * over confirmed state plus only its DURABLE pending layers,
   * skipping the client speculation overlay (#speculativeLocalSeqs).
   * The value side of the blind-write verifier-read basis — the same
   * layers `#buildReads` names for such reads. */
  getNonSpeculativeDocument(
    uri: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): EntityDocument | undefined {
    this.#readThroughOnMiss(uri, scope, identity);
    const record = this.#docs.get(
      docKey(uri, this.instanceKey(scope, identity)),
    );
    if (!record) {
      return undefined;
    }
    const hasSpeculative = record.pending.some((entry) =>
      this.#speculativeLocalSeqs.has(entry.localSeq)
    );
    if (!hasSpeculative) {
      // No speculation on this doc: the non-speculative view IS the
      // visible view (served from the prefix cache).
      return this.#visibleDocument(uri, scope, identity);
    }
    // Fold only the durable pending layers over the confirmed base, in
    // stack order. The durable subset is a SUBSEQUENCE of the pending
    // array, not a prefix, so the prefix materialization cache does not
    // apply; a doc carrying speculation is a bounded transient (the
    // overlay destination retires it), so this stays a cold path.
    return materializePendingVersions(
      record.confirmed,
      record.pending.filter((entry) =>
        !this.#speculativeLocalSeqs.has(entry.localSeq)
      ),
      {
        space: this.#space,
        id: uri,
        scope,
      },
    );
  }

  /** Whether an optimistic local write for this doc is still pending — not
   *  yet promoted into the confirmed mirror (a parked accept keeps it
   *  pending until its marker arrives; CT-1927). */
  hasPendingWrite(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean {
    const record = this.#docs.get(this.#docKeyOf({ id, scope }, identity));
    return record !== undefined && record.pending.length > 0;
  }

  /** ISpaceReplica.speculationRetirementView (server-execution v2
   * Phase 2, speculation.md §4): the doc's confirmed seq — with the
   * covering commit's class where known (the arrival-witness predicate,
   * RULED 2026-08-22) — plus every pending layer's localSeq: the
   * overlay destination's retirement inputs. */
  speculationRetirementView(
    id: URI,
    scope?: CellScope,
  ): {
    confirmedSeq: number;
    coverClass?: CommitClass;
    pendingLocalSeqs: number[];
  } {
    const record = this.#docs.get(this.#docKeyOf({ id, scope }));
    if (record === undefined) {
      return { confirmedSeq: 0, pendingLocalSeqs: [] };
    }
    return {
      confirmedSeq: record.confirmed.seq,
      ...(record.confirmed.coverClass === undefined
        ? {}
        : { coverClass: record.confirmed.coverClass }),
      pendingLocalSeqs: [
        ...new Set(record.pending.map((entry) => entry.localSeq)),
      ],
    };
  }

  /** ISpaceReplica.ackedSeqOf (server-execution v2 Phase 2,
   * speculation.md §4): the store seq a local commit's accept committed
   * at, or undefined while it is unsettled — or if it was rejected, or
   * pruned from the bounded record (both read as "no ack floor": the
   * entry falls back to its confirmed read basis). */
  ackedSeqOf(localSeq: number): number | undefined {
    return this.#ackedSeqsByLocalSeq.get(localSeq);
  }

  /**
   * Resolves when the accepted commit at `localSeq` has been APPLIED to
   * this replica's settled view — immediately when its accept was
   * confirmed at verdict time, else when its PARKED accept promotes
   * (marker coverage via noteCaughtUpLocalSeq, or marker-channel death)
   * or dies with the parked set (reset/close, where the re-pull
   * re-derives the durable state).
   *
   * Server-execution v2 stage G's effect-retirement read barrier
   * (serving-loop.md §4): the outbox holds an effect's in-flight entry
   * until every completion commit's writes are readable, so a stale
   * re-admit of the same key dedupes instead of re-claiming against
   * unabsorbed state and firing a second egress. Since F1a
   * (settleSealedCommit → confirmPending), sealed commits — waves and
   * effect completions alike — confirm at verdict time and never park,
   * so for completions this resolves immediately: the barrier is the
   * BELT over that structural guarantee, and the parked branch below
   * remains for pushed (socket) commits under CT-1927.
   *
   * Callers sequence this AFTER the sealed commit's `settled` promise:
   * the confirm (or, for pushed commits, settleAccept's park-or-confirm
   * decision) runs inside settlement, so consulting the parked set
   * before settlement would race it.
   */

  /**
   * Queue one event append for this space (server-execution v2 Phase 3;
   * events.md §1, §5): the client's ONLY computational commit under the
   * flag. Fired-order discharge with retry across transport loss and
   * session replacement; a duplicate above the stream's dedupe horizon
   * resolves as delivered (`EventAppendDuplicateError` — events.md §5's
   * duplicate-submission rule). The returned promise settles with the
   * delivery outcome; rendering never waits on it (the echo is local).
   */
  enqueueEventAppend(
    append: Omit<QueuedEventAppend, "clientSeq"> & { clientSeq?: number },
  ): Promise<EventAppendOutcome> {
    return this.#ensureEventAppendQueue().enqueue(append);
  }

  async resolveEventAttention(
    eventId: string,
    seq: number,
    sidecarId: string,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResult> {
    const { session } = await this.#activeSessionHandle();
    return await session.resolveEventAttention(eventId, seq, sidecarId, action);
  }

  /** Pending (undischarged) event intents — the offline queue's live
   * content, bounded by pending-intent count (speculation.md §5). */
  pendingEventAppends(): readonly QueuedEventAppend[] {
    return this.#eventAppendQueue?.pending ?? [];
  }

  #ensureEventAppendQueue(): EventAppendQueue {
    if (this.#eventAppendQueue === undefined) {
      this.#eventAppendQueue = new EventAppendQueue({
        space: this.#space,
        transact: async (commit) => {
          const { session } = await this.#activeSessionHandle();
          // The route-write marker rides the SAME beforeIssue hook as
          // ordinary commits (verdict blocker, 2026-08-12): an event
          // append is a stateful operation against this route, so once
          // one has issued, canReplaceProvisionalReplica() must answer
          // false — a late host hint may no longer swap the replica out
          // underneath the queue and strand its traffic on a closed
          // route.
          return await session.transact(
            commit,
            () => this.#markRouteWriteIssued(),
          );
        },
        // Allocated at SEND time from the replica's one counter, so the
        // increasing-localSeq send-order discipline (04-protocol §3.9)
        // holds across event appends and ordinary commits alike.
        nextLocalSeq: () => this.#nextLocalSeq++,
        store: this.#eventAppendQueueStore,
        pacing: this.#eventAppendPacing,
      });
    }
    return this.#eventAppendQueue;
  }

  whenApplied(localSeq: number): Promise<void> {
    if (!this.#parkedAccepts.has(localSeq)) return Promise.resolve();
    let waiter = this.#appliedWaiters.get(localSeq);
    if (waiter === undefined) {
      waiter = Promise.withResolvers<void>();
      this.#appliedWaiters.set(localSeq, waiter);
    }
    return waiter.promise;
  }

  #resolveAppliedWaiter(localSeq: number): void {
    const waiter = this.#appliedWaiters.get(localSeq);
    if (waiter !== undefined) {
      this.#appliedWaiters.delete(localSeq);
      waiter.resolve();
    }
  }

  /**
   * ISpaceReplica.unappliedForeignSeqFloor (server-execution v2 Phase 2's
   * settle input barrier): the lowest inbound seq still shadowed by an
   * own pending write, or `undefined` when nothing is. Prunes lazily —
   * an entry whose doc no longer has pending writes has become visible
   * (promotion fired the shadow-flip notification; a drop re-exposes the
   * confirmed value through the rejection path's own re-runs), so it no
   * longer bounds the wave's advance.
   */
  unappliedForeignSeqFloor(): number | undefined {
    if (this.#shadowedForeignSeqs.size === 0) return undefined;
    let floor: number | undefined;
    for (const [key, seqs] of this.#shadowedForeignSeqs) {
      const record = this.#docs.get(key);
      if (
        record === undefined || record.pending.length === 0 ||
        seqs.size === 0
      ) {
        this.#shadowedForeignSeqs.delete(key);
        continue;
      }
      for (const seq of seqs) {
        if (floor === undefined || seq < floor) floor = seq;
      }
    }
    return floor;
  }

  async close(): Promise<void> {
    this.#cancelAccessLoss?.();
    this.#cancelAccessLoss = undefined;
    this.#localCoverageObservers.clear();
    this.#viewPlanObservers.clear();
    this.#cancelViewCapabilityLost?.();
    this.#cancelViewCapabilityLost = undefined;
    this.#viewCapabilitySession = undefined;
    this.#viewPlans = [];
    const retireViewOwner = this.#viewOwnerRetired;
    this.#viewOwnerRetired = undefined;
    this.#viewOwnerVersion++;
    retireViewOwner?.();
    this.#closed = true;
    this.#closeSignal.resolve();
    this.#eventAppendQueue?.close();
    this.#resetConflictAdmissionState();
    this.#rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    // Settle any queued (not-yet-sent) watch refresh first so its pull promise
    // cannot outlive close(); `#closed` also makes `#refreshWatchSet()` fail
    // closed for any refresh already in flight.
    this.#cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    this.#operationSinks.clear();
    // Also close the view the update consumer is bound to, in case it diverged
    // from #watchView; otherwise its pending next() never settles and the
    // `Promise.allSettled([...#updatePromises])` below hangs forever.
    this.#subscribedWatchView?.close();
    this.#subscribedWatchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      let resolved:
        | {
          client: MemoryV2Client.Client;
          session: MemoryV2Client.SpaceSession;
        }
        | undefined;
      try {
        resolved = await sessionHandle;
      } catch {
        resolved = undefined;
      }
      if (resolved !== undefined) {
        // Closing the client rejects every in-flight request (pulls/watch
        // refreshes) with a ConnectionError and closes the session's watch
        // view — the generic drain for any open watch, not just the two views
        // tracked above.
        await resolved.client.close();
      }
    }
    // With the client closed, every in-flight commit and read/watch pull has
    // been rejected and now settles promptly. Awaiting them here can no longer
    // hang and guarantees no transport promise is left pending when close()
    // resolves. Suppressed verdicts (server responses superseded by a local
    // rejection) live outside #commitPromises and join the same drain.
    await Promise.allSettled([
      ...this.#commitPromises,
      ...this.#suppressedVerdicts,
    ]);
    await Promise.allSettled([...this.#syncPromises]);
    await Promise.allSettled([...this.#updatePromises]);
    await Promise.allSettled([...this.#operationWatchRemovals.values()]);
    this.#operationWatchRemovals.clear();
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
  }

  #resetConflictAdmissionState(): void {
    this.#caughtUpLocalSeq = 0;
    this.#staleFloor.clear();
    // Parked accepts die with the marker space: on reset the re-pull
    // re-derives durable state (which contains the accepted writes), and on
    // close there is nothing left to promote into. Their promises RESOLVE —
    // the commits succeeded durably; a caller must never see a durable
    // success reported as failure (CT-1950).
    for (const entry of this.#parkedAccepts.values()) {
      entry.settled.resolve();
    }
    this.#parkedAccepts.clear();
    // Their applied-waiters resolve rather than hang: the accepted writes
    // now arrive (or died) through the re-pull, so the barrier's question
    // — "has the settled view moved past the accept?" — is answered.
    for (const waiter of this.#appliedWaiters.values()) {
      waiter.resolve();
    }
    this.#appliedWaiters.clear();
    // Shadowed-foreign floors die with the marker space too: the re-pull
    // re-derives the durable state, so nothing stays invisible.
    this.#shadowedForeignSeqs.clear();
    this.#ackedSeqsByLocalSeq.clear();
  }

  #noteCaughtUpLocalSeq(localSeq: number | undefined): void {
    if (localSeq === undefined) {
      return;
    }
    this.#caughtUpLocalSeq = Math.max(this.#caughtUpLocalSeq, localSeq);
    // Apply parked accepts the marker now covers, ascending, BEFORE waking
    // marker waiters: gated code (readyToRetry retries) resumes against a
    // replica where every promotion COVERED BY THIS MARKER is settled.
    // Accepts decided but not yet covered — verdict received, coverage
    // still outstanding (the two moments CT-1950 splits) — remain parked
    // past this wake: their pending overlays stay visible and their
    // settlement promises unresolved until their own marker arrives.
    if (this.#parkedAccepts.size > 0) {
      const due = [...this.#parkedAccepts.keys()]
        .filter((parked) => parked <= this.#caughtUpLocalSeq)
        .sort((left, right) => left - right);
      for (const parked of due) {
        // Re-entrancy guard (Phase 2): confirmPending's flag-ON
        // shadow-flip notification runs subscriber callbacks
        // synchronously, and a callback that re-enters the replica
        // (reset, applyParkedAcceptsNow via a closing watch view) can
        // consume parked entries out from under this loop — so the
        // lookup tolerates an entry another frame already applied.
        const entry = this.#parkedAccepts.get(parked);
        if (entry === undefined) continue;
        this.#parkedAccepts.delete(parked);
        // Parked accepts are pushed transact accepts (sealed commits
        // never park — settleSealedCommit confirms directly): authored.
        this.#confirmPending(
          parked,
          entry.operations,
          entry.applied,
          "authored",
        );
        entry.settled.resolve();
      }
    }
    const ready: PromiseWithResolvers<void>[] = [];
    this.#caughtUpLocalSeqWaiters = this.#caughtUpLocalSeqWaiters.filter(
      (waiter) => {
        if (waiter.localSeq <= this.#caughtUpLocalSeq) {
          ready.push(waiter.pending);
          return false;
        }
        return true;
      },
    );
    for (const pending of ready) {
      pending.resolve();
    }
    // Ids whose staleness has now been caught up are fresh again; stop
    // pre-empting commits that read them.
    if (this.#staleFloor.size > 0) {
      for (const [key, floor] of this.#staleFloor) {
        if (floor <= this.#caughtUpLocalSeq) {
          this.#staleFloor.delete(key);
        }
      }
    }
  }

  #waitForCaughtUpLocalSeq(localSeq: number): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("memory replica closed"));
    }
    if (this.#caughtUpLocalSeq >= localSeq) {
      return Promise.resolve();
    }
    const pending = Promise.withResolvers<void>();
    this.#caughtUpLocalSeqWaiters.push({ localSeq, pending });
    return pending.promise;
  }

  #rejectCaughtUpLocalSeqWaiters(error: Error): void {
    const waiters = this.#caughtUpLocalSeqWaiters;
    this.#caughtUpLocalSeqWaiters = [];
    for (const waiter of waiters) {
      waiter.pending.reject(error);
    }
  }

  closeNow(): void {
    this.#cancelAccessLoss?.();
    this.#cancelAccessLoss = undefined;
    this.#localCoverageObservers.clear();
    this.#viewPlanObservers.clear();
    this.#cancelViewCapabilityLost?.();
    this.#cancelViewCapabilityLost = undefined;
    this.#viewCapabilitySession = undefined;
    this.#viewPlans = [];
    const retireViewOwner = this.#viewOwnerRetired;
    this.#viewOwnerRetired = undefined;
    this.#viewOwnerVersion++;
    retireViewOwner?.();
    this.#closed = true;
    this.#closeSignal.resolve();
    this.#eventAppendQueue?.close();
    this.#resetConflictAdmissionState();
    this.#cancelQueuedWatchRefresh();
    this.#watchView?.close();
    this.#watchView = null;
    this.#subscribedWatchView?.close();
    this.#subscribedWatchView = null;
    const sessionHandle = this.#sessionHandle;
    this.#sessionHandle = undefined;
    if (sessionHandle) {
      sessionHandle.then(({ client }) => client.close()).catch(() => {
        // The session never opened cleanly; there is nothing to close.
      });
    }
    // The fire-and-forget client.close() above rejects in-flight requests; drain
    // their read pulls too so no transport promise is left pending. Suppressed
    // verdicts settle off the same teardown rejection.
    void Promise.allSettled([...this.#syncPromises]);
    void Promise.allSettled([...this.#updatePromises]);
    void Promise.allSettled([...this.#operationWatchRemovals.values()]);
    this.#operationWatchRemovals.clear();
    void Promise.allSettled([...this.#suppressedVerdicts]);
    this.#rejectCaughtUpLocalSeqWaiters(new Error("memory replica closed"));
    this.#syncTasks.clear();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
  }

  async load(
    entries: [WatchAddress, SchemaPathSelector | undefined][],
  ): Promise<Result<Unit, PullError>> {
    const known = entries
      .map(([address]) =>
        this.#getState(address.id, address.scope, undefined, address.scopeKey)
      )
      .filter((state): state is Revision<State> => state !== undefined);
    this.#subscription.next({
      type: "load",
      space: this.#space,
      changes: Differential.load(known, this.#scopeKeyIdentity()),
    });
    return await this.pull(entries);
  }

  async pull(
    entries: [WatchAddress, SchemaPathSelector | undefined][],
  ): Promise<Result<Unit, PullError>> {
    if (entries.length === 0) {
      return { ok: {} };
    }
    // A store read-through answers the pull in place: the roots are read
    // from the store, and no watch reaches the session — the documents a
    // selector's schema would have crossed to are read on first access
    // instead, and a later commit touching a held document reaches the
    // replica through `integrateStoreWrites()`.
    const readThrough = this.#storeReadThrough();
    if (readThrough !== undefined) {
      this.#pullFromStore(readThrough, entries);
      return { ok: {} };
    }
    // The owed session remount, consumed BEFORE the watch-selector tracker
    // is consulted below — not only at `#memoizedSessionHandle()`. A
    // selector the tracker already covers is answered from it and never
    // reaches a
    // session at all, so consuming only at the mount point leaves precisely
    // the docs the replica had successfully read being served out of a
    // subscription the revocation killed. Found by independent review
    // (Cubic P1) and reproduced before fixing: the post-remount read
    // returned SUCCESS carrying the pre-revocation value. Idempotent and
    // cheap — a bare boolean test when nothing is owed.
    this.#consumeOwedSessionRemount();

    const normalizedEntries = normalizeSyncEntries(entries);
    // Phase 5's delegated-scoped-read fail-closed refusal, ENTRY-scoped
    // (the F3 fix; protocol.md §2's grant-scoped read design): decided
    // HERE, per caller, before the entries join the coalesced
    // watch-refresh batch — the batch shares ONE pending promise across
    // every concurrent caller, so a refusal thrown inside the batch
    // (the `#refreshWatchSet()` backstop below) poisons innocent SPACE-scope
    // foreign reads coalesced beside the offender: the load-bearing
    // §2b free-read row would fail intermittently whenever any pattern
    // persistently attempted one foreign scoped read. Refusing the
    // OFFENDING caller's pull keeps the refusal action-scoped, the
    // arc's standing refusal convention.
    if (this.#refuseForeignScopedReads) {
      for (const [address] of normalizedEntries) {
        const scope = normalizeCellScope(address.scope) ?? "space";
        if (scope !== "space") {
          return {
            error: toPullError(
              new Error(
                `foreign scoped read refused on the serving path: ` +
                  `${address.id} (scope "${scope}") in ${this.#space} — ` +
                  "a serving runtime reads foreign scoped instances only " +
                  "under the grant-scoped read design (protocol.md §2; " +
                  "delegated scoped reads are fail-closed until grant " +
                  "resolution lands)",
              ),
            ),
          };
        }
      }
    }
    // Compose the dedup key from per-part hashes instead of hashing a fresh
    // wrapper object: hashOf's frozen-object cache is only consulted at entry
    // level, so embedding the (large, already canonical) selector schema in a
    // fresh wrapper re-walked it on every pull. hashStringOf(schema) hits the
    // identity cache for frozen schemas and costs one walk for mutable ones.
    // JSON.stringify escapes every field, so ids/scopes/path segments
    // containing delimiter characters cannot produce ambiguous keys.
    const key = JSON.stringify(
      normalizedEntries.map(([address, selector]) => [
        address.id,
        normalizeCellScope(address.scope) ?? null,
        selector === undefined ? null : selector.path,
        selector?.schema === undefined ? null : hashStringOf(selector.schema),
        // The explicit instance (stage A) is part of the sync identity:
        // two instances of one doc are two syncs. `null` for the
        // universal keyless case — the OFF-arm key TEXT gains a trailing
        // `,null` per entry (this map is private, single-producer, never
        // serialized; the PARTITION is unchanged: every keyless entry
        // still dedupes exactly as before).
        address.scopeKey ?? null,
      ]),
    );
    const existing = this.#syncTasks.get(key);
    if (existing) {
      return await existing.promise;
    }

    const task: SyncTask = {
      entries: normalizedEntries,
      promise: Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    };
    // Entries covered by an already-registered selector are not re-fetched,
    // but the covering watch may still be IN FLIGHT. A sync's contract is
    // "resolved means the data is locally available", so collect the covering
    // promises and await them — returning early here would let a caller (e.g.
    // handler-input presync) proceed before the doc-carrying response lands.
    // For coverage registered by a long-settled watch the promise is already
    // resolved and the await is a no-op.
    const coveredInFlight: Promise<Result<Unit, PullError>>[] = [];
    const newEntries = normalizedEntries.filter(([address, selector]) => {
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
        ...(address.scopeKey !== undefined
          ? { scopeKey: address.scopeKey }
          : {}),
      };
      const [superset, supersetPromise] = this.#watchSelectorTracker
        .getSupersetSelector(
          baseAddress,
          selector,
        );
      if (superset !== undefined && supersetPromise !== undefined) {
        coveredInFlight.push(supersetPromise);
      }
      return superset === undefined;
    });
    if (newEntries.length === 0) {
      if (coveredInFlight.length === 0) {
        return { ok: {} };
      }
      const results = await Promise.all(coveredInFlight);
      return results.find((result) => result.error) ?? { ok: {} };
    }
    task.entries = newEntries;
    this.#syncTasks.set(key, task);
    const fetchPromise = this.#enqueueWatchRefresh("pull", newEntries);
    // Mixed batch: some entries fetched here, others covered by in-flight
    // watches. The pull resolves only when ALL requested docs are locally
    // available, and concurrent same-key callers dedupe onto this COMBINED
    // wait (joining only `fetchPromise` would let them resolve before the
    // covered docs land).
    const combinedPromise = coveredInFlight.length === 0
      ? fetchPromise
      : (async (): Promise<Result<Unit, PullError>> => {
        const result = await fetchPromise;
        if (result.error) {
          return result;
        }
        const covered = await Promise.all(coveredInFlight);
        return covered.find((coveredResult) => coveredResult.error) ?? result;
      })();
    task.promise = combinedPromise;
    for (const [address, selector] of newEntries) {
      const baseAddress = {
        id: address.id,
        type: DOCUMENT_MIME,
        scope: normalizeCellScope(address.scope),
        ...(address.scopeKey !== undefined
          ? { scopeKey: address.scopeKey }
          : {}),
      };
      // The tracker promise is what FUTURE pulls covered by these selectors
      // await: their data is available once THIS fetch lands, independent of
      // this batch's own covered set — so register the raw fetch promise.
      this.#watchSelectorTracker.add(
        baseAddress,
        selector,
        fetchPromise,
      );
    }
    this.#syncPromises.add(combinedPromise);
    try {
      return await combinedPromise;
    } finally {
      this.#syncTasks.delete(key);
      this.#syncPromises.delete(combinedPromise);
      // Tracker cleanup is keyed on THIS batch's fetch result alone: a
      // failure in a covered watch belongs to the pull that registered it,
      // and must not invalidate selectors whose fetch succeeded here.
      const result = await fetchPromise;
      if (result.error) {
        for (const [address, selector] of newEntries) {
          const baseAddress = {
            id: address.id,
            type: DOCUMENT_MIME,
            scope: normalizeCellScope(address.scope),
            ...(address.scopeKey !== undefined
              ? { scopeKey: address.scopeKey }
              : {}),
          };
          this.#watchSelectorTracker.delete(
            baseAddress,
            selector,
          );
        }
      }
    }
  }

  async commitNative(
    transaction: NativeStorageCommit,
    source?: IStorageTransaction,
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const preconditions = activeCommitPreconditions(transaction.preconditions);
    const operations = withCommitTiming(
      ["commitNative", "normalize"],
      () => documentOperationsOf(transaction),
    );

    const sqliteOps = transaction.sqliteOps ?? [];

    if (
      operations.length === 0 &&
      !preconditions?.length &&
      sqliteOps.length === 0
    ) {
      return { ok: {} };
    }

    return await withCommitTiming(
      ["commitNative", "commitOperations"],
      () =>
        this.#commitOperations(
          operations,
          source,
          preconditions,
          sqliteOps,
          options,
        ),
    );
  }

  /**
   * Seal a native commit into the optimistic overlay without pushing it
   * (server-execution v2, serving-loop.md §3d): the local half of
   * commitNative — normalize, build the client commit with its read set,
   * apply pending, notify — with the store half deferred to `verdict`. The
   * wave accumulator resolves the verdict at its commit step: `committed`
   * promotes the pending writes at the wave commit's seq, `withdrawn`
   * rolls them back through the same rejection path a refused push takes —
   * EXCEPT the `superseded` variant (speculation.md §4's retirement),
   * which routes through `#finalizeSupersededSpeculation`: a
   * SUCCESS-shaped drop that skips the rejection machinery, does not
   * cascade-reject dependants (an authored commit that read the echo is
   * decided by the store's CAS — and since the leg-C export refusal, a
   * dependent basis naming the echo never exports at all), and settles
   * ok. The pending overlay this leaves behind is the wave's layered
   * view — later action runs read the sealed writes through the
   * ordinary read path until the verdict settles them.
   */
  sealNative(
    transaction: NativeStorageCommit,
    source: IStorageTransaction | undefined,
    verdict: Promise<SealedCommitVerdict>,
    options?: {
      readonly speculative?: boolean;
      readonly identity?: ScopeKeyIdentity;
      readonly reads?: ClientCommit["reads"];
    },
  ): SealedNativeCommit {
    return this.#sealOperations(
      documentOperationsOf(transaction),
      source,
      activeCommitPreconditions(transaction.preconditions),
      transaction.sqliteOps ?? [],
      verdict,
      options,
    );
  }

  /**
   * The operations, preconditions, and read set `transaction` hands the
   * store, as {@link sealNative} builds them into a sealed commit, without
   * applying anything here: for a committer that commits to the store
   * ahead of sealing the same transaction into this replica, which needs
   * the store's shape before the replica has seen the writes. The reads
   * are `source`'s, against this replica's records for `identity`'s
   * instances as they stand, so a pending read names the durable basis
   * beneath the layers it saw; handed back to {@link sealNative} as its
   * `reads`, they are the one snapshot both the store and the seal rest
   * on.
   */
  storeCommitOf(
    transaction: NativeStorageCommit,
    source: IStorageTransaction | undefined,
    identity?: ScopeKeyIdentity,
  ): {
    operations: ClientCommit["operations"];
    preconditions: readonly CommitPrecondition[];
    reads: ClientCommit["reads"];
  } {
    return {
      operations: storeOperationsOf(
        documentOperationsOf(transaction),
        transaction.sqliteOps ?? [],
      ),
      preconditions: activeCommitPreconditions(transaction.preconditions),
      reads: this.#buildReads(source, this.#nextLocalSeq, identity),
    };
  }

  #sealOperations(
    operations: NativeCommitOperation[],
    source: IStorageTransaction | undefined,
    preconditions: readonly CommitPrecondition[],
    sqliteOps: readonly SqliteOperation[],
    verdict: Promise<SealedCommitVerdict>,
    options?: {
      readonly speculative?: boolean;
      readonly identity?: ScopeKeyIdentity;
      readonly reads?: ClientCommit["reads"];
    },
  ): SealedNativeCommit {
    // The tx→replica identity seam (server-execution v2 stage A, OW17): a
    // served per-instance run seals under ITS identity — its ops apply to
    // that identity's local instances, its read set is built against
    // those instances' pending stacks, and its verdict settles exactly
    // them (the in-flight entry remembers the identity). Absent = the
    // replica's own, byte-identical to before.
    const identity = options?.identity;
    const localSeq = this.#nextLocalSeq++;
    if (source !== undefined) {
      recordCommitLocalSeq(source, this.#space, localSeq);
    }
    const commit: ClientCommit = {
      localSeq,
      reads: options?.reads ?? this.#buildReads(source, localSeq, identity),
      // Cell ops first, folded SQLite ops last — the same commit shape
      // commitOperations builds, so the wave batch is made of ordinary
      // client commits.
      operations: storeOperationsOf(operations, sqliteOps),
      ...(preconditions.length > 0
        ? { preconditions: [...preconditions] }
        : {}),
    };
    const touched = this.#touchedOf(operations, identity);
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.#hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.#hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope, scopeKey }) =>
          snapshotState(this, id, scope, scopeKey)
        ),
        this.#scopeKeyIdentity(),
      )
      : undefined;

    for (const operation of operations) {
      this.#applyPending(operation, localSeq, identity);
    }

    if (before !== undefined) {
      const optimistic = before.compare(this);
      this.#subscription.next({
        type: "commit",
        space: this.#space,
        changes: optimistic,
        source,
      });
      if (shouldNotifySinks) {
        this.#notifySinks(optimistic);
      }
    } else if (shouldNotifySinks) {
      this.#notifySinksForIds(touched);
    }

    const settled = this.#settleSealedCommit(
      localSeq,
      operations,
      commit,
      source,
      verdict,
      identity,
    );
    if (options?.speculative !== true) {
      // Durable sealed commits (the wave's) join the synced() barrier
      // and the ordered-push outcome map as any commit does. A CLIENT
      // SPECULATION entry joins NEITHER (speculation.md §1: the overlay
      // is process-memory only, never synced, never committed): a
      // client settle must not wait on the echo's retirement, and no
      // push ordering ever involves it. Its in-flight registration
      // (inside settleSealedCommit) still happens, so reset sweeps and
      // origin-drop cascades reach the echo.
      this.#commitPromises.add(settled);
      this.#commitOutcomeBySeq.set(
        localSeq,
        settled.catch(() => {}).finally(() => {
          this.#commitOutcomeBySeq.delete(localSeq);
        }),
      );
      settled.finally(() => {
        this.#commitPromises.delete(settled);
      });
    } else {
      // Track the speculative seq for the export refusal (speculation.md
      // §6, RULED 2026-08-13): while any pending stack carries this
      // layer, a pushed commit's read basis naming it is refused in
      // commitOperations. Settlement (retirement or withdrawal) drops
      // the pending layers before `settled` resolves, so removal here
      // never races a stack that still names the seq.
      this.#speculativeLocalSeqs.add(localSeq);
      settled.catch(() => {}).finally(() => {
        this.#speculativeLocalSeqs.delete(localSeq);
      });
    }
    return { localSeq, commit, settled };
  }

  /** Records accepted sealed operations before their promotion continuation. */
  #noteSealedReceipt(
    localSeq: number,
    operations: NativeCommitOperation[],
    seq: number,
    identity?: ScopeKeyIdentity,
  ): void {
    const touched = this.#touchedOf(operations, identity);
    const changed = touched.filter(({ id, scope, scopeKey }) => {
      const record = this.#record(id, scope, undefined, scopeKey);
      return record.confirmed.localWavePromotion === undefined &&
        record.confirmed.seq >= seq &&
        record.pending.some((entry) => entry.localSeq === localSeq);
    });
    const shouldNotifySubscribers = changed.length > 0 &&
      this.#hasNotificationSubscribers();
    const shouldNotifySinks = changed.length > 0 &&
      this.#hasSinkSubscribers(changed);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        changed.map(({ id, scope, scopeKey }) =>
          snapshotState(this, id, scope, scopeKey)
        ),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    // The confirmed view can advance between receipt and settlement, or
    // already cover the receipt. Covered operations are present in that value;
    // partial local wave promotions still need their pending contributions.
    for (const { id, scope, scopeKey } of touched) {
      const record = this.#record(id, scope, undefined, scopeKey);
      for (const entry of record.pending) {
        if (entry.localSeq === localSeq) entry.acceptedSeq = seq;
      }
      record.materialized = undefined;
    }
    if (before !== undefined) {
      const changes = before.compare(this);
      if ([...changes].length > 0) {
        this.#subscription.next({
          type: "integrate",
          space: this.#space,
          changes,
        });
        if (shouldNotifySinks) this.#notifySinks(changes);
      }
    } else if (shouldNotifySinks) {
      this.#notifySinksForIds(changed);
    }
  }

  async #settleSealedCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source: IStorageTransaction | undefined,
    verdict: Promise<SealedCommitVerdict>,
    identity?: ScopeKeyIdentity,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // Registered unconditionally — unlike a pushed commit, a sealed commit
    // needs the entry even with zero pending reads: reset() sweeps
    // in-flight entries to reject them locally, and a sealed commit's
    // verdict is held externally by the wave, so without the entry a reset
    // would strand its pending writes until a verdict for a wave that no
    // longer exists.
    const inFlight = this.#registerInFlightCommit(
      localSeq,
      operations,
      commit,
      source,
      { alwaysRegister: true, identity },
    )!;
    try {
      const outcome = await Promise.race([
        verdict.then(
          (v) => {
            if (
              "committed" in v && inFlight.localRejectionValue === undefined
            ) {
              this.#noteSealedReceipt(
                localSeq,
                operations,
                v.committed.seq,
                identity,
              );
            }
            return { verdict: v };
          },
          // The accumulator's contract is to resolve every verdict; a
          // rejection is a wave-machinery bug, mapped to a withdrawal so
          // the pending writes still roll back instead of stranding.
          (reason) => ({
            verdict: {
              withdrawn: {
                message: `wave verdict rejected: ${
                  reason instanceof Error ? reason.message : String(reason)
                }`,
              },
            } satisfies SealedCommitVerdict,
          }),
        ),
        inFlight.localRejection.promise.then((rejection) => ({ rejection })),
      ]);
      if ("rejection" in outcome) {
        // A local rejection (dependency cascade, replica reset) beat the
        // wave's verdict; the eventual verdict is moot. A late `committed`
        // flags a wave that outlived its replica — the analogue of
        // suppressLateVerdict's warn.
        verdict.then((v) => {
          if ("committed" in v) {
            logger.warn("seal-late-commit", () => [
              "wave committed a sealed commit after its local rejection; " +
              "write not promoted",
              { localSeq },
            ]);
          }
        }, () => {});
        return await this.#finalizeRejection(
          localSeq,
          operations,
          source,
          outcome.rejection,
          identity,
        );
      }
      const v = outcome.verdict;
      if ("withdrawn" in v) {
        if (
          (v.withdrawn as { superseded?: true }).superseded === true
        ) {
          // Speculation retirement (server-execution v2 Phase 2,
          // speculation.md §4): a SUCCESS-shaped withdrawal — the
          // authoritative derivation covers the echo, the store wins by
          // construction. Drop the pending writes and notify the
          // visible flip, but do NOT cascade-reject dependants (an
          // authored commit that read the echo is decided by the
          // store's CAS, not by the echo's lifecycle) and settle OK.
          return this.#finalizeSupersededSpeculation(
            localSeq,
            operations,
            source,
            identity,
          );
        }
        const withdrawalCause = "cause" in v.withdrawn
          ? v.withdrawn.cause
          : undefined;
        // Settlement consumers need the wave's structured distinction: a
        // dropped contribution may retry in place, while an abort/abandon
        // belongs to the enclosing lifecycle. Do not make them parse prose.
        const rejection = {
          ...this.#makeLocalRejection(commit, v.withdrawn.message),
          ...(withdrawalCause !== undefined
            ? { waveWithdrawalCause: withdrawalCause }
            : {}),
        };
        return await this.#finalizeRejection(
          localSeq,
          operations,
          source,
          rejection,
          identity,
        );
      }
      // Locally-committed verdicts confirm IMMEDIATELY — never parked
      // (F1a, the completion-visibility wedge). A sealed commit's
      // verdict is resolved by the co-hosted executor (wave.ts /
      // space-server.ts) AFTER the engine applied the commit
      // synchronously through the engine-wave sink: the verdict IS the
      // store's answer, and verdict-time extrapolation is exactly as
      // current as this replica can be. CT-1927's parking exists to
      // keep a REMOTE mirror from promoting over missing foreign
      // novelty ordered before its accept — but engine-plane commits
      // bypass the server's transact path, which is the only place
      // catch-up marker obligations are staged (`noteExecutorCommit`
      // stages none), so a parked sealed accept's covering marker can
      // NEVER arrive. Routing through settleAccept therefore parked
      // these forever: `whenApplied` waiters never resolved, the
      // outbox's readability-gated retirement never retired (one
      // permanently-in-flight entry + one unresolved waiter leaked per
      // served effect), and any A→B→A input cycle starved deduping
      // against the dead entry. Residual extrapolation over foreign
      // novelty self-heals through the engine's own dirtiness fan-out
      // (`noteExecutorCommit` → frames), the same reconvergence
      // per-doc-dropped seals already rely on (wave.ts §3d). Pushed
      // (socket) commits keep full settleAccept semantics — remote
      // parking is untouched.
      // The cover class: a sealed native commit is the co-hosted
      // executor's wave commit (speculative seals resolve withdrawn and
      // never reach here) — the wave admission class, derived.
      if (source !== undefined) {
        recordCommitSeq(source, this.#space, v.committed.seq);
      }
      this.#confirmPending(
        localSeq,
        operations,
        {
          seq: v.committed.seq,
          branch: commit.branch ?? DEFAULT_BRANCH,
          revisions: [],
        },
        "derived",
        identity,
      );
      return { ok: {} };
    } finally {
      this.#settleInFlightCommit(localSeq);
    }
  }

  reset(): void {
    // Every unsettled in-flight commit's optimistic pending write is about to
    // be wiped by #docs.clear(); locally reject each so its pushCommit
    // finalizes promptly instead of waiting on a server verdict for state
    // that no longer exists. readyToRetry resolves immediately (nothing to
    // repair — the replica is being rebuilt from scratch).
    for (const entry of [...this.#inFlightCommits.values()]) {
      this.#rejectInFlightCommitLocally(
        entry,
        this.#makeLocalRejection(entry.commit, "memory replica reset"),
      );
    }
    this.#docs.clear();
    this.#watchedIds.clear();
    this.#delivered.clear();
    this.#resetConflictAdmissionState();
    this.#rejectCaughtUpLocalSeqWaiters(new Error("memory replica reset"));
    this.#cancelQueuedWatchRefresh();
    this.#watchSelectorTracker = new SelectorTracker<Result<Unit, PullError>>(
      () => this.#scopeKeyIdentity(),
    );
    this.#subscription.next({
      type: "reset",
      space: this.#space,
    });
  }

  /**
   * Adds the watches `entries` describe to the session and applies the
   * frames that come back, resolving to the pull's verdict; a refresh that
   * fails resolves to its error rather than rejecting.
   */
  async #refreshWatchSet(
    entries: Iterable<[WatchAddress, SchemaPathSelector]>,
    type: "pull" | "integrate" = "pull",
  ): Promise<Result<Unit, PullError>> {
    const refreshStart = performance.now();
    try {
      const { session } = await this.#activeSessionHandle();
      // Per-session (no global): mirror the storage setting onto the session so
      // its watch-mutation family (set + add) uses the ordered-issue concurrent
      // path. Idempotent; cheap to re-assert each refresh. Optional-chained so
      // lightweight session doubles in tests (which never opt into concurrency)
      // are unaffected.
      session.setConcurrentWatchRefresh?.(
        this.#settings.experimentalConcurrentWatchRefresh === true,
      );
      const rawEntries = [...entries];
      const watchEntries = compactWatchEntries(
        rawEntries,
        this.#scopeKeyIdentity(),
      );
      if (watchEntries.length === 0) {
        return { ok: {} };
      }
      // Phase 5's delegated-scoped-read fail-closed refusal, producer
      // side (protocol.md §2's grant-scoped read design; see
      // ProviderOptions.refuseForeignScopedReads): a serving runtime's
      // scoped read of a FOREIGN space never reaches the wire — the
      // unnamed scoped root would resolve against the delegating
      // service envelope (a silently empty instance), and the runner
      // cannot yet name a per-run foreign instance on a subscription.
      // The memory server's admission carries the co-hosted belt; this
      // is the producer half, so the two land as one stack.
      //
      // BACKSTOP only (the F3 fix): the live refusal is ENTRY-scoped at
      // pull() — per caller, before the entry joins the batch — because
      // a throw HERE fails the whole coalesced batch (one shared
      // pending promise), poisoning innocent space-scope reads beside
      // the offender. Every watch entry flows through pull(), so this
      // arm firing means a new path bypassed the entry refusal — a
      // bug, kept loud rather than silently filtered (dropping the
      // entry would resolve its caller OK without the data).
      if (this.#refuseForeignScopedReads) {
        for (const [address] of watchEntries) {
          const scope = address.scope ?? "space";
          if (scope !== "space") {
            throw new Error(
              `foreign scoped read refused on the serving path: ` +
                `${address.id} (scope "${scope}") in ${this.#space} — ` +
                "a serving runtime reads foreign scoped instances only " +
                "under the grant-scoped read design (protocol.md §2; " +
                "delegated scoped reads are fail-closed until grant " +
                "resolution lands)",
            );
          }
        }
      }

      const watches = watchEntries.map(([address, selector]) => ({
        id: watchIdForEntry(address, selector, ""),
        kind: "graph" as const,
        query: {
          roots: [{
            id: address.id,
            scope: normalizeCellScope(address.scope),
            // The runner's explicit-instance read (server-execution v2
            // stage A): an instance-named load names its instance on the
            // wire — lease-holder-only at admission (protocol.md §2's
            // read row), which is exactly who issues one (a serving
            // runtime's per-instance run). Own-identity loads name
            // nothing: byte-identical roots, the no-key admission fast
            // path.
            ...(address.scopeKey !== undefined
              ? { entityScopeKey: address.scopeKey }
              : {}),
            selector,
          }],
        },
      }));

      // Both sub-spans record in `finally` blocks, as `total` below does: a
      // refresh that fails inside the request or inside application still
      // paid for it, and a success-only span would leave that share in
      // `total` alone, so the halves would not add up across outcomes.
      const watchAddStart = performance.now();
      let mutation: MemoryV2Client.WatchMutationResult;
      try {
        mutation = await session.watchAddSync(watches);
      } finally {
        logger.time(watchAddStart, "watchRefresh", "watchAddSync");
      }
      const { view, precedingSyncs, sync } = mutation;

      if (this.#closed) {
        view.close();
        return { error: toConnectionError(new Error("memory replica closed")) };
      }

      this.#watchView = view;
      const applyStart = performance.now();
      try {
        for (const precedingSync of precedingSyncs) {
          this.#applySessionSync(precedingSync, "integrate");
        }
        this.#applySessionSync(sync, type);
        // deno-coverage-ignore-start -- the client's own view has applied
        // every frame handed over here, so only an apply bug lands here
      } catch (error) {
        // The frame failed to apply, so this refresh's view never gets a
        // consumer; without a close it leaks when a later refresh
        // overwrites `#watchView`.
        view.close();
        throw error;
      } finally {
        // deno-coverage-ignore-stop
        logger.time(applyStart, "watchRefresh", "applySessionSync");
      }
      this.#consumeWatchView(view);
      return { ok: {} };
    } catch (error) {
      return { error: toPullError(error) };
    } finally {
      logger.time(refreshStart, "watchRefresh", "total");
    }
  }

  #consumeWatchView(view: MemoryV2Client.WatchView): void {
    if (this.#subscribedWatchView === view) return;
    const previous = this.#subscribedWatchView;
    this.#subscribedWatchView = view;
    previous?.close();
    const updates = this.#consumeUpdates(view.subscribeSync())
      .finally(() => {
        this.#updatePromises.delete(updates);
        if (this.#subscribedWatchView === view) {
          this.#subscribedWatchView = null;
          this.#applyParkedAcceptsNow();
        }
      });
    this.#updatePromises.add(updates);
  }

  #enqueueWatchRefresh(
    type: "pull" | "integrate",
    entries: [WatchAddress, SchemaPathSelector][],
  ): Promise<Result<Unit, PullError>> {
    if (this.#queuedWatchRefresh !== null) {
      for (const [address, selector] of entries) {
        this.#queuedWatchRefresh.entries.set(
          watchIdForEntry(address, selector, ""),
          [address, selector],
        );
      }
      return this.#queuedWatchRefresh.pending.promise;
    }

    const batch: WatchRefreshBatch = {
      type,
      entries: new Map(entries.map(([address, selector]) => [
        watchIdForEntry(address, selector, ""),
        [address, selector] as [WatchAddress, SchemaPathSelector],
      ])),
      pending: Promise.withResolvers<Result<Unit, PullError>>(),
    };
    this.#queuedWatchRefresh = batch;
    this.#scheduleWatchRefreshFlush();
    return batch.pending.promise;
  }

  /**
   * Max watch-refresh round trips allowed in flight at once. 1 preserves the
   * historical strict single-flight behavior; with
   * `experimentalConcurrentWatchRefresh` on, refreshes overlap up to a bounded
   * window so traversal-discovered waves fan out WITHOUT an unbounded number of
   * outstanding requests (backpressure).
   */
  #maxWatchRefreshInFlight(): number {
    return this.#settings.experimentalConcurrentWatchRefresh === true
      ? CONCURRENT_WATCH_REFRESH_WINDOW
      : 1;
  }

  #scheduleWatchRefreshFlush(): void {
    // Flush the queued batch when a slot is free. Same-tick coalescing (via
    // `#queuedWatchRefreshScheduled` + the merge in `#enqueueWatchRefresh`) is
    // unchanged; the window bounds cross-RTT concurrency (1 = single-flight).
    if (
      this.#queuedWatchRefresh === null ||
      this.#queuedWatchRefreshScheduled ||
      this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()
    ) {
      return;
    }
    this.#queuedWatchRefreshScheduled = true;
    queueMicrotask(() => {
      this.#queuedWatchRefreshScheduled = false;
      if (
        this.#queuedWatchRefresh === null ||
        this.#watchRefreshInFlight >= this.#maxWatchRefreshInFlight()
      ) {
        return;
      }
      const batch = this.#queuedWatchRefresh;
      this.#queuedWatchRefresh = null;
      this.#watchRefreshInFlight += 1;
      void this.#flushWatchRefreshBatch(batch);
      // If the window admits more and another batch has already coalesced,
      // schedule it now; otherwise the flush's `finally` re-schedules as slots
      // free.
      this.#scheduleWatchRefreshFlush();
    });
  }

  async #flushWatchRefreshBatch(
    batch: WatchRefreshBatch,
  ): Promise<void> {
    try {
      const result = await this.#refreshWatchSet(
        batch.entries.values(),
        batch.type,
      );
      this.#noteAuthorizationStatus(result);
      batch.pending.resolve(result);
    } catch (error) {
      const result: Result<Unit, PullError> = { error: toPullError(error) };
      this.#noteAuthorizationStatus(result);
      batch.pending.resolve(result);
    } finally {
      this.#watchRefreshInFlight -= 1;
      this.#scheduleWatchRefreshFlush();
    }
  }

  #cancelQueuedWatchRefresh(): void {
    this.#queuedWatchRefreshScheduled = false;
    if (this.#queuedWatchRefresh !== null) {
      this.#queuedWatchRefresh.pending.resolve({
        error: toConnectionError(new Error("memory replica closed")),
      });
      this.#queuedWatchRefresh = null;
    }
  }

  async #consumeUpdates(
    iterator: AsyncIterator<SessionSync>,
  ): Promise<void> {
    while (true) {
      const next = await iterator.next();
      if (next.done || this.#closed) {
        return;
      }
      const applyStart = performance.now();
      try {
        this.#applySessionSync(next.value, "integrate");
      } catch (error) {
        // The background consumer must never die wholesale on one bad
        // frame (OW61: a validation throw here was an unhandled rejection
        // that killed the consuming worker — nothing upstream awaits this
        // loop per-frame). Delivery-guarantee violations are contained
        // per-doc inside `#applySessionSync()` already; this catch is the net
        // under every OTHER producer or apply bug: log loudly, skip the
        // frame, keep consuming. The replica stays behind for the
        // frame's docs until a later delivery covers them.
        logger.error("consume-updates-frame-failed", () => [
          "dropping a subscription frame that failed to apply; the",
          "consumer continues:",
          error,
        ]);
      } finally {
        // The push-side counterpart of `watchRefresh/applySessionSync`:
        // this key times application from the subscription iterator;
        // the refresh key times application during graph-watch refreshes.
        // Direct operation-watch and watch-removal application have no
        // span under either key.
        logger.time(applyStart, "watchPush", "applySessionSync");
      }
    }
  }

  async #commitOperations(
    operations: NativeCommitOperation[],
    source?: IStorageTransaction,
    preconditions: readonly CommitPrecondition[] = [],
    sqliteOps: readonly SqliteOperation[] = [],
    commitOptions?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const activePreconditions = activeCommitPreconditions(preconditions);
    if (
      operations.length === 0 && sqliteOps.length === 0 &&
      activePreconditions.length === 0
    ) {
      return { ok: {} };
    }

    const localSeq = this.#nextLocalSeq++;
    if (source !== undefined) {
      recordCommitLocalSeq(source, this.#space, localSeq);
    }
    const commit = withCommitTiming(
      ["commitOperations", "buildCommit"],
      (): ClientCommit => ({
        localSeq,
        reads: this.#buildReads(source, localSeq),
        // Cell ops first, folded SQLite ops last (applied in array order by the
        // engine; sqlite ops are not entity revisions and carry no id/scope).
        operations: storeOperationsOf(operations, sqliteOps),
        ...(activePreconditions.length > 0
          ? { preconditions: [...activePreconditions] }
          : {}),
      }),
    );
    // The export refusal (server-execution v2 Phase 2, speculation.md
    // §6; RULED 2026-08-13): a commit basis naming a SPECULATIVE
    // overlay layer must not reach the wire — the layer exists only in
    // this process, so the server would reject the dependency as
    // unresolved on every attempt (pre-fix: the observed
    // `pending dependency not resolved` convergence-retry loop, ~43
    // attempts across the 30s window per event). Refused HERE, before
    // the optimistic apply, with a terminal-classified error: nothing
    // renders, nothing reverts, nothing retries.
    const speculativeLayers = this.#speculativeLayersOf(commit);
    if (speculativeLayers.length > 0) {
      const rejection = this.#makeSpeculativeBasisRefusal(
        commit,
        speculativeLayers,
      );
      logger.error("speculative-basis-refused", () => [
        "commit refused before export: read basis names speculative " +
        "overlay layer(s) (speculation.md §6)",
        {
          localSeq,
          speculativeLayers: [...speculativeLayers],
          reads: commit.reads.pending
            .filter((read) => {
              const layers = Array.isArray(read.localSeq)
                ? read.localSeq
                : [read.localSeq];
              return layers.some((layer) => speculativeLayers.includes(layer));
            })
            .map((read) => read.id),
        },
      ]);
      if (source !== undefined) {
        notifyCommitRejected(source, rejection);
      }
      return { error: rejection };
    }
    // A pushed commit is the replica's own identity's (every client, the
    // OFF arm): touched entries carry no explicit instance.
    const touched: LocalDocAddress[] = operations.map((operation) => ({
      id: operation.id,
      scope: operation.scope,
    }));
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.#hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.#hasSinkSubscribers(touched);
    const before = withCommitTiming(
      ["commitOperations", "snapshotBefore"],
      () =>
        shouldNotifySubscribers
          ? Differential.checkout(
            this,
            touched.map(({ id, scope, scopeKey }) =>
              snapshotState(this, id, scope, scopeKey)
            ),
            this.#scopeKeyIdentity(),
          )
          : undefined,
    );

    withCommitTiming(["commitOperations", "applyPending"], () => {
      for (const operation of operations) {
        this.#applyPending(operation, localSeq);
      }
    });

    withCommitTiming(["commitOperations", "notifyOptimistic"], () => {
      if (before !== undefined) {
        const optimistic = before.compare(this);
        this.#subscription.next({
          type: "commit",
          space: this.#space,
          changes: optimistic,
          source,
        });
        if (shouldNotifySinks) {
          this.#notifySinks(optimistic);
        }
      } else if (shouldNotifySinks) {
        this.#notifySinksForIds(touched);
      }
    });

    const promise = withCommitTiming(
      ["commitOperations", "pushCommitStart"],
      () =>
        this.#pushCommit(
          localSeq,
          operations,
          commit,
          source,
          { commitOptions },
        ),
    );
    this.#commitPromises.add(promise);
    // Keyed registration for the old-server scalarization hold: a later
    // stacked commit awaits its omitted lower dependencies' outcomes here.
    // Removed on settlement (absent key = settled); the .catch keeps the
    // tracking copy from surfacing as an unhandled rejection.
    this.#commitOutcomeBySeq.set(
      localSeq,
      promise.catch(() => {}).finally(() => {
        this.#commitOutcomeBySeq.delete(localSeq);
      }),
    );
    const result = await promise;
    this.#commitPromises.delete(promise);
    return result;
  }

  /**
   * Register a commit in `#inFlightCommits` so a dropped dependency can
   * reject it locally. Returns undefined — no registration — when the commit
   * has no pending reads: with nothing read from another commit's optimistic
   * state there is no dependency to cascade on, and this is the natural
   * exemption for zero-read/mergeable/blind commits and the
   * scheduler-observation batch wrapper (all DESIGNED to survive a parent
   * drop; see the InFlightCommit doc).
   */
  #registerInFlightCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    options: { alwaysRegister?: boolean; identity?: ScopeKeyIdentity } = {},
  ): InFlightCommit | undefined {
    if (
      commit.reads.pending.length === 0 && options.alwaysRegister !== true
    ) {
      return undefined;
    }
    const dependencies = new Set<number>();
    for (const read of commit.reads.pending) {
      if (Array.isArray(read.localSeq)) {
        for (const layer of read.localSeq) {
          dependencies.add(layer);
        }
      } else {
        dependencies.add(read.localSeq);
      }
    }
    const entry: InFlightCommit = {
      localSeq,
      dependencies,
      operations,
      source,
      commit,
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
      localRejection: Promise.withResolvers<StorageTransactionRejected>(),
      settled: false,
    };
    this.#inFlightCommits.set(localSeq, entry);
    return entry;
  }

  /**
   * Mark a commit's outcome as finalized and remove it from the cascade scan
   * set. Idempotent — pushCommit's finally may run after reset() already
   * signaled a local rejection for the same entry.
   */
  #settleInFlightCommit(localSeq: number): void {
    const entry = this.#inFlightCommits.get(localSeq);
    if (entry === undefined) {
      return;
    }
    entry.settled = true;
    this.#inFlightCommits.delete(localSeq);
  }

  /**
   * Signal a locally-fabricated rejection for an in-flight commit. Invariant
   * holder: `localRejectionValue` must be observable synchronously BEFORE
   * `localRejection` resolves — pushCommit's pre-send checkpoints read the
   * field directly; the promise only feeds the transact race.
   */
  #rejectInFlightCommitLocally(
    entry: InFlightCommit,
    rejection: StorageTransactionRejected,
  ): void {
    if (entry.settled || entry.localRejectionValue !== undefined) {
      return;
    }
    entry.localRejectionValue = rejection;
    entry.localRejection.resolve(rejection);
  }

  /**
   * A server verdict superseded by a local rejection: consume it off the
   * books. Late reject is the expected outcome (the server eventually agrees
   * the dependency never resolved) and is swallowed. Late ACCEPT is
   * deterministically impossible once resolution-only pending reads are
   * emitted — the server cannot accept a commit whose pending dependency has
   * no commit row — so it warns to flag a bug; the write is NOT promoted
   * (its pending entries were already dropped by finalizeRejection).
   */
  #suppressLateVerdict(
    verdict: Promise<AppliedCommit>,
    localSeq: number,
  ): void {
    const settled = verdict.then(() => {
      logger.warn("cascade-late-accept", () => [
        "server accepted a commit after its local rejection; write not promoted",
        { localSeq },
      ]);
    }, (error) => {
      logger.debug("cascade-late-reject", () => [
        `late server verdict after local rejection: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { localSeq },
      ]);
    }).finally(() => {
      this.#suppressedVerdicts.delete(settled);
    });
    this.#suppressedVerdicts.add(settled);
  }

  async #pushCommit(
    localSeq: number,
    operations: NativeCommitOperation[],
    commit: ClientCommit,
    source?: IStorageTransaction,
    options: {
      routeSources?: readonly IStorageTransaction[];
      prepareIssue?: (commit: ClientCommit) => boolean;
      commitOptions?: TransactionCommitOptions;
    } = {},
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    const routeSources = options.routeSources ??
      (source === undefined ? [] : [source]);
    const resolveAtVerdict = options.commitOptions?.resolveAt === "verdict";
    // Rejection receipt seals the fate for EVERY contributing transaction.
    // finalizeRejection's own notify covers the cascade paths that do not
    // come through here; the once-guard makes the overlap free.
    const notifyRejectionSources = (
      rejection: StorageTransactionRejected,
    ): void => {
      for (const routeSource of routeSources) {
        notifyCommitRejected(routeSource, rejection);
      }
    };
    // Register BEFORE any await: commitOperations calls pushCommit
    // synchronously after applyPending, so registration is atomic with the
    // optimistic write — a dependency drop can never slip between the two.
    const inFlight = this.#registerInFlightCommit(
      localSeq,
      operations,
      commit,
      source,
    );
    const telemetry = this.#getTelemetry();
    const pushOpId = `push:${this.#space}:${localSeq}`;
    try {
      if (inFlight !== undefined) {
        // A dependency rejected before this commit was even minted: its
        // optimistic layer outlives the verdict by the length of the read
        // repair, and buildReads names every layer still standing. Settle
        // here so the doomed commit never reaches the wire — this is the
        // window a single conflict otherwise turns into a run of commits the
        // server can only reject.
        const sealed = this.#preSendRejection(inFlight);
        if (sealed !== undefined) {
          logger.debug("commit-dead-dependency", () => [
            `commit rejected before send: ${sealed.message}`,
            { localSeq, operations: operations.length },
          ]);
          // Traced like any other failed push, with no session id because no
          // session was dialed. The storm this checkpoint suppresses was
          // found by counting errored push spans, so the suppression has to
          // be countable on the same surface.
          telemetry?.submit({
            type: "storage.push.start",
            id: pushOpId,
            operation: "transact",
            localSeq,
            spaceDid: this.#space,
          });
          telemetry?.submit({
            type: "storage.push.error",
            id: pushOpId,
            error: sealed.name,
            ...rejectionAttribution(sealed, commit),
          });
          notifyRejectionSources(sealed);
          return await this.#finalizeRejection(
            localSeq,
            operations,
            source,
            sealed,
          );
        }
      }
      // Strategy 1: a commit whose read set lands on a still-catching-up id.
      const admissionMode = conflictAdmissionMode();
      if (admissionMode !== "off") {
        const threshold = this.#preemptThreshold(commit);
        if (threshold !== undefined) {
          // Coarse mode: assume conflict and pre-empt without sending.
          const rejection = this.#makePreemptRejection(commit, threshold);
          logger.debug("commit-preempted", () => [
            `commit preempted: stale until caughtUpLocalSeq>=${threshold}`,
            { localSeq, operations: operations.length },
          ]);
          notifyRejectionSources(rejection);
          return await this.#finalizeRejection(
            localSeq,
            operations,
            source,
            rejection,
          );
        }
      }
      // The push marker window covers (re)dial + send + confirm: the full
      // client-side cost of durably landing this commit.
      // (space.did, commit.local_seq) joins to the server's memory.transact span.
      telemetry?.submit({
        type: "storage.push.start",
        id: pushOpId,
        operation: "transact",
        localSeq,
        spaceDid: this.#space,
      });
      try {
        const { client, session } = await this.#activeSessionHandle();
        if (
          options.prepareIssue !== undefined &&
          !options.prepareIssue(commit)
        ) {
          return { ok: {} };
        }
        // Wire-compat: only a server advertising `pendingReadStacks` can
        // resolve array dependency sets — otherwise collapse each to its
        // top-of-stack element before sending.
        const wireCommit = client.serverFlags?.pendingReadStacks === true
          ? commit
          : scalarizePendingReadStacks(commit);
        if (wireCommit !== commit && inFlight !== undefined) {
          // Old-server hold (split-brain guard): the scalarized wire omits
          // the lower layers, so the server could durably ACCEPT a commit
          // this client is about to cascade-reject — the caller would see a
          // ConflictError for a write that landed. Do not send until every
          // omitted dependency settles: a dropped one trips the doom
          // checkpoint below before anything reaches the wire, and
          // all-accepted makes the scalar shape sound (their resolution is
          // already durable). Verdicts arrive in submission order, so this
          // adds at most roughly one verdict round-trip, only against
          // pre-`pendingReadStacks` servers, only for stacked commits.
          const waits: Promise<unknown>[] = [];
          for (const read of commit.reads.pending) {
            if (!Array.isArray(read.localSeq)) continue;
            const top = scalarizeLocalSeq(read.localSeq);
            for (const layer of read.localSeq) {
              if (layer === top) continue;
              const outcome = this.#commitOutcomeBySeq.get(layer);
              if (outcome !== undefined) {
                waits.push(outcome);
              }
            }
          }
          if (waits.length > 0) {
            await Promise.all(waits);
          }
        }
        const sealed = inFlight === undefined
          ? undefined
          : this.#preSendRejection(inFlight);
        if (sealed !== undefined) {
          // A pending dependency was rejected or dropped while we awaited the
          // scheduler batch flush, the session handshake, or the old-server
          // hold — do not send a commit whose doom is already provable.
          telemetry?.submit({
            type: "storage.push.error",
            id: pushOpId,
            sessionId: session.sessionId,
            error: sealed.name,
            ...rejectionAttribution(sealed, commit),
          });
          notifyRejectionSources(sealed);
          return await this.#finalizeRejection(
            localSeq,
            operations,
            source,
            sealed,
          );
        }
        if (inFlight === undefined) {
          // No pending reads → no dependency that can be dropped from under
          // this commit; keep the direct await.
          const applied = await session.transact(
            wireCommit,
            () => this.#markRouteWriteIssued(routeSources),
          );
          const settled = this.#settleAccept(
            localSeq,
            operations,
            applied,
            resolveAtVerdict,
            source,
          );
          // Tx-sourced commits ALWAYS record the coverage wait: the inner
          // settlement promise carries commit callbacks and the
          // pending-commit barrier, which stay on the full timeline even
          // when the caller opted its returned promise into verdict timing.
          // Only the direct path — where the promise returned here IS the
          // caller's promise — honors the verdict opt-out inline.
          if (source !== undefined) {
            recordCoverageWait(source, settled);
          } else if (!resolveAtVerdict) {
            await settled;
          }
          telemetry?.submit({
            type: "storage.push.complete",
            id: pushOpId,
            sessionId: session.sessionId,
          });
          return { ok: {} };
        }
        // Race the server verdict against a locally-fabricated rejection (a
        // dependency dropped mid-flight, or a replica reset). A server
        // rejection wins the race by REJECTING it, landing in the catch below.
        const verdict = session.transact(
          wireCommit,
          () => this.#markRouteWriteIssued(routeSources),
        );
        const outcome = await Promise.race([
          verdict.then((applied) => ({ applied })),
          inFlight.localRejection.promise.then((rejection) => ({ rejection })),
        ]);
        if ("rejection" in outcome) {
          // Local rejection won: the eventual server verdict is moot. Do NOT
          // recordStaleFloor — a locally fabricated rejection carries no server
          // catch-up point (parity with the preempt path above).
          this.#suppressLateVerdict(verdict, localSeq);
          telemetry?.submit({
            type: "storage.push.error",
            id: pushOpId,
            sessionId: session.sessionId,
            error: outcome.rejection.name ?? "TransactionError",
            ...rejectionAttribution(outcome.rejection, commit),
          });
          notifyRejectionSources(outcome.rejection);
          return await this.#finalizeRejection(
            localSeq,
            operations,
            source,
            outcome.rejection,
          );
        }
        const settledRace = this.#settleAccept(
          localSeq,
          operations,
          outcome.applied,
          resolveAtVerdict,
          source,
        );
        // Same rule as the direct-await branch above: tx-sourced commits
        // always record; only the direct path honors the verdict opt-out.
        if (source !== undefined) {
          recordCoverageWait(source, settledRace);
        } else if (!resolveAtVerdict) {
          await settledRace;
        }
        telemetry?.submit({
          type: "storage.push.complete",
          id: pushOpId,
          sessionId: session.sessionId,
        });
        return { ok: {} };
      } catch (error) {
        let cause = error;
        if (this.#replacementRead !== undefined) {
          const routeConflict = new Error("memory replica route replaced");
          routeConflict.name = "ConflictError";
          cause = routeConflict;
        }
        const schedulerDependencyRejection =
          cause instanceof StorageTransactionRejectionError ? cause : undefined;
        let rejection = schedulerDependencyRejection !== undefined
          ? schedulerDependencyRejection.rejection
          : toRejectedError(cause, commit, this.#space);
        // Leg-C belt (speculation.md §6): a ConflictError whose commit
        // names one of THIS replica's speculative layers can never
        // converge — the dependency never reaches the wire.
        // commitOperations refuses the export up front, so reaching
        // here means a build path slipped through; upgrade to the
        // terminal refusal rather than letting the caller spin its
        // retry window against a dependency that is never coming.
        if (
          schedulerDependencyRejection === undefined &&
          rejection.name === "ConflictError"
        ) {
          const speculativeLayers = this.#speculativeLayersOf(commit);
          if (speculativeLayers.length > 0) {
            logger.error("speculative-basis-exported", () => [
              "a commit naming speculative overlay layer(s) reached the " +
              "wire (the build-time refusal should have caught this); " +
              "upgrading the rejection to the terminal refusal",
              { localSeq, speculativeLayers },
            ]);
            rejection = this.#makeSpeculativeBasisRefusal(
              commit,
              speculativeLayers,
            );
          }
        }
        telemetry?.submit({
          type: "storage.push.error",
          id: pushOpId,
          error: rejection.name ?? "TransactionError",
          ...rejectionAttribution(rejection, commit),
        });
        if (schedulerDependencyRejection === undefined) {
          this.#attachProviderReadyToRetry(rejection, localSeq);
          if (admissionMode !== "off" && rejection.name === "ConflictError") {
            this.#recordStaleFloor(commit, localSeq);
          }
        }
        // Counted (even while silent) so multi-writer churn can be read back via
        // getLoggerCounts(): "commit-conflict" is a stale-seq-basis rejection that
        // drops only the optimistic pending write and re-derives from confirmed
        // state; a non-falling count under load means conflicts ratchet rather
        // than storm.
        logger.debug(
          rejection.name === "ConflictError"
            ? "commit-conflict"
            : "commit-rejected",
          () => [
            `commit ${rejection.name ?? "rejected"}: ${rejection.message}`,
            { localSeq, operations: operations.length },
          ],
        );
        notifyRejectionSources(rejection);
        return await this.#finalizeRejection(
          localSeq,
          operations,
          source,
          rejection,
        );
      }
    } finally {
      this.#settleInFlightCommit(localSeq);
    }
  }

  #markRouteWriteIssued(
    sources: readonly IStorageTransaction[] = [],
  ): void {
    for (const source of sources) {
      const validation = source.validateReplicaRoutes?.();
      if (validation?.error !== undefined) {
        throw Object.assign(
          new Error(validation.error.message),
          validation.error,
        );
      }
    }
    if (
      this.#closed ||
      this.#routeState.generation !== this.#routeGeneration
    ) {
      throw new Error("memory replica route replaced");
    }
    this.#routeState.writeIssuedGeneration = this.#routeGeneration;
  }

  #assertActiveRoute(): void {
    if (
      this.#closed ||
      this.#routeState.generation !== this.#routeGeneration
    ) {
      throw new Error("memory replica closed");
    }
  }

  #activeSessionHandle(): Promise<OpenedSpaceSession> {
    try {
      this.#assertActiveRoute();
    } catch (error) {
      return Promise.reject(error);
    }
    const handle = this.#memoizedSessionHandle();
    if (this.#sessionClient !== undefined) {
      return handle;
    }
    return Promise.race([
      handle.then((value) => ({ value })),
      this.#closeSignal.promise.then(() => ({ value: undefined })),
    ]).then((opened) => {
      if (opened.value === undefined) {
        throw new Error("memory replica closed");
      }
      this.#assertActiveRoute();
      return opened.value;
    });
  }

  /**
   * Speculation retirement (server-execution v2 Phase 2, speculation.md
   * §4): drop a speculative sealed commit's pending writes and notify
   * the visible flip to the authoritative value. finalizeRejection minus
   * two deliberate absences — no conflict-read-repair wait (nothing
   * conflicted) and NO dependency cascade (retirement is success-shaped:
   * an authored commit that read the echo is decided by the store's CAS,
   * and a downstream speculation retires on its own floor). The
   * notification is an ordinary `integrate` (authoritative state became
   * visible), not a `revert` (nothing failed).
   */
  #finalizeSupersededSpeculation(
    localSeq: number,
    operations: NativeCommitOperation[],
    source: IStorageTransaction | undefined,
    identity?: ScopeKeyIdentity,
  ): Result<Unit, StorageTransactionRejected> {
    const touched = this.#touchedOf(operations, identity);
    const hasSemanticOperations = operations.length > 0;
    const shouldNotifySubscribers = hasSemanticOperations &&
      this.#hasNotificationSubscribers();
    const shouldNotifySinks = hasSemanticOperations &&
      this.#hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope, scopeKey }) =>
          snapshotState(this, id, scope, scopeKey)
        ),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    this.#dropPending(localSeq);
    if (before !== undefined) {
      const changes = before.compare(this);
      if ([...changes].length > 0) {
        // The flip carries the retiring echo's own transaction as its
        // source (speculation.md §4's "own retirement is not a trigger"
        // rider): the writer's scheduler node skips its own flip.
        this.#subscription.next({
          type: "integrate",
          space: this.#space,
          changes,
          ...(source !== undefined ? { source } : {}),
        } as StorageNotification);
        if (shouldNotifySinks) {
          this.#notifySinks(changes);
        }
      }
    } else if (shouldNotifySinks) {
      this.#notifySinksForIds(touched);
    }
    return { ok: {} };
  }

  /**
   * Finalizes a rejection, the shared tail for both real conflicts and
   * pre-empted commits: waits for the caught-up read-repair, drops the
   * optimistic pending write, and emits the revert notification reflecting
   * repaired confirmed state.
   */
  async #finalizeRejection(
    localSeq: number,
    operations: NativeCommitOperation[],
    source: IStorageTransaction | undefined,
    rejection: StorageTransactionRejected,
    identity?: ScopeKeyIdentity,
  ): Promise<Result<Unit, StorageTransactionRejected>> {
    // The verdict is known from here on, but this commit's optimistic layer
    // stands in `record.pending` for as long as the read repair below runs.
    // Mark the layer dead for that window so no new commit is minted and sent
    // against it; the promise settles once the drop and its revert are done.
    const dropped = Promise.withResolvers<void>();
    this.#rejectedPendingLayers.set(localSeq, dropped.promise);
    try {
      // The fate is sealed here. The verdict-gated effect layer (verdict
      // callbacks, outbox clearing) fires on this notification; the
      // settlement promise and commit callbacks wait out the read-repair
      // gate below, because a retry needs the repaired base.
      if (source !== undefined) {
        notifyCommitRejected(source, rejection);
      }
      const touched = this.#touchedOf(operations, identity);
      const hasSemanticOperations = operations.length > 0;
      const shouldNotifySubscribers = hasSemanticOperations &&
        this.#hasNotificationSubscribers();
      const shouldNotifySinks = hasSemanticOperations &&
        this.#hasSinkSubscribers(touched);
      const before = shouldNotifySubscribers
        ? Differential.checkout(
          this,
          touched.map(({ id, scope, scopeKey }) =>
            snapshotState(this, id, scope, scopeKey)
          ),
          this.#scopeKeyIdentity(),
        )
        : undefined;
      await this.#waitForConflictReadRepair(rejection);
      this.#dropPending(localSeq);
      // Every drop funnels through here (server conflict, preempt, cascade,
      // reset — this is dropPending's only call site), so scanning right
      // after the drop catches every dependant; transitivity emerges from
      // recursion (a victim's own finalizeRejection lands back here with its
      // localSeq).
      this.#cascadeDroppedDependency(localSeq);
      if (before !== undefined) {
        const changes = before.compare(this);
        // The revert snapshots CURRENT confirmed state (which already
        // includes any newer seq received by subscription since this commit
        // started) and drops only this commit's pending write — so it should
        // not stomp newer data. Counted to verify reverts stay bounded.
        logger.debug("commit-revert", () => [
          `revert after ${rejection.name ?? "rejection"}`,
        ]);
        this.#subscription.next({
          type: "revert",
          space: this.#space,
          changes,
          reason: rejection,
          source,
        });
        if (shouldNotifySinks) {
          this.#notifySinks(changes);
        }
      } else if (shouldNotifySinks) {
        this.#notifySinksForIds(touched);
      }
      return { error: rejection };
    } finally {
      this.#rejectedPendingLayers.delete(localSeq);
      dropped.resolve();
    }
  }

  /**
   * Return the raw reads that become commit-time concurrency preconditions.
   * Reconciliation and commit construction must use the same set: loading a
   * read that buildReads later drops can spend a retry on an observation the
   * server would never validate.
   */
  #commitReadActivities(
    source: IStorageTransaction,
    reads: Iterable<IReadActivity>,
  ): IReadActivity[] {
    // A mergeable op resolves against durable state, so it does not depend on
    // the document's prior value. Reads incidental to the op are excluded,
    // while a handler's own explicit read remains a real dependency.
    const mergeableOpPathsByEntity = new Map<
      string,
      (readonly string[])[]
    >();
    for (const op of getDirectTransactionMergeableOpAddresses(source) ?? []) {
      if (op.space !== this.#space) continue;
      const key = `${op.id}\0${normalizeCellScope(op.scope)}`;
      const paths = mergeableOpPathsByEntity.get(key);
      if (paths) {
        paths.push(op.path);
      } else {
        mergeableOpPathsByEntity.set(key, [op.path]);
      }
    }

    const commitReads: IReadActivity[] = [];
    for (const read of reads) {
      if (
        read.space !== this.#space ||
        (read.type ?? DOCUMENT_MIME) !== DOCUMENT_MIME ||
        hasDataUriScheme(read.id) ||
        // Content-addressed documents cannot change, so their reads carry no
        // commit-time concurrency precondition.
        read.id.startsWith("cid:") ||
        // Blind UI-input write-target reads are replaced by one structural
        // parent read after buildReads' main loop.
        isReadIgnoredForCommit(read.meta) ||
        // Reference-resolution shape reads stay reactive but do not constrain
        // the commit; recursive reads remain value dependencies.
        (isReadExcludedFromConflict(read.meta) &&
          read.nonRecursive === true) ||
        // Runtime verifier reads of the CFC label are point-in-time policy
        // observations, not consumed values.
        (isInternalVerifierRead(read.meta) && isCfcLabelPath(read.path))
      ) {
        continue;
      }

      const scope = normalizeCellScope(read.scope);
      const opPaths = mergeableOpPathsByEntity.get(`${read.id}\0${scope}`);
      // A read of an op array's length is a genuine dependency: the handler
      // used the element count that a concurrent mergeable op changes.
      const readsMergeableOpArrayLength = opPaths !== undefined &&
        opPaths.some((opPath) => isArrayLengthChildPath(opPath, read.path));
      if (
        opPaths !== undefined &&
        !readsMergeableOpArrayLength &&
        (isMergeableOpRead(read.meta) ||
          isReadMarkedAsAttemptedWrite(read.meta) ||
          isCfcLabelPath(read.path) ||
          opPaths.some((opPath) =>
            isStrictPrefixPath(opPath, read.path) ||
            (read.nonRecursive === true && isSamePath(opPath, read.path))
          ))
      ) {
        continue;
      }
      commitReads.push(read);
    }
    return commitReads;
  }

  /**
   * The documents `source` read as absent that this replica has never
   * examined, each keyed the way a pending load for it is keyed: an address
   * naming a foreign instance carries that instance's key, and one naming
   * the replica's own carries none.
   *
   * A read of a document the replica never synced resolves as absent, and
   * {@link buildReads} exports that as `seq: 0` — the claim that no such
   * document exists. The engine rejects the commit as `stale confirmed read`
   * whenever one does, and the rejection is right: the reading run followed
   * a link into a document it did not hold, so its traversal is sound only
   * if that document really is absent. `Runtime.editWithRetry` takes this
   * list between running its action and committing, waits for the loads
   * already in flight for these documents, and re-runs the action when
   * {@link presentCount} then finds any of them present — the same
   * convergence the engine's rejection would force, without the round trip,
   * the catch-up gate, or the wasted upload.
   *
   * Session-scoped reads of this replica's own fresh session are excluded,
   * because no unseen server-side revision can exist under that instance.
   * A served run can carry another session's identity, though, and that
   * explicit instance is reconciled like a user-scoped one.
   *
   * The instance key matches {@link buildReads}: a served run uses the
   * transaction's scope identity, while ordinary client transactions use the
   * replica's own identity.
   */
  unexaminedAbsences(
    source: IStorageTransaction | undefined,
  ): UnexaminedAbsence[] {
    if (source === undefined) return [];
    const reads = getDirectTransactionReadActivities(source);
    if (!reads) return [];
    const identity = source.scopeKeyIdentity;
    // Documents this transaction writes are its own creations in flight:
    // reading one as absent and then writing it is what creating a document
    // IS, and the paired absence claim is what the engine validates the
    // create against. Only reads with no such write are absences the
    // transaction merely relied on.
    const ownWrites = new Set<string>();
    for (const write of getTransactionWriteAttempts(source) ?? []) {
      if (write.space !== this.#space) continue;
      ownWrites.add(docKey(write.id, this.instanceKey(write.scope, identity)));
    }
    const unexamined = new Map<string, UnexaminedAbsence>();
    for (const read of this.#commitReadActivities(source, reads)) {
      const scope = normalizeCellScope(read.scope);
      // A malformed/incomplete served identity cannot name the instance on
      // the wire. Leave its claim for commit admission rather than waiting
      // on a different instance under the replica identity.
      if (identity !== undefined && !canResolveScopeKey(scope, identity)) {
        continue;
      }
      const instance = this.instanceKey(scope, identity);
      const ownInstance = this.instanceKey(scope);
      if (scope === "session" && instance === ownInstance) continue;
      const key = docKey(read.id, instance);
      if (ownWrites.has(key)) continue;
      if (this.#docs.has(key) || unexamined.has(key)) continue;
      unexamined.set(key, {
        space: this.#space,
        id: read.id,
        scope,
        ...(scope !== "space" && instance !== ownInstance
          ? { scopeKey: instance as ScopeKey }
          : {}),
      });
    }
    return [...unexamined.values()];
  }

  /**
   * How many of `absences` this replica now holds with a confirmed revision.
   * `absences` is a list this replica's own {@link unexaminedAbsences}
   * returned, not any address of that shape: a foreign instance is keyed by
   * the `scopeKey` that call baked in, and an address from elsewhere would
   * be counted against the replica's own instance.
   */
  presentCount(absences: readonly UnexaminedAbsence[]): number {
    let present = 0;
    for (const absence of absences) {
      const key = docKey(
        absence.id,
        this.instanceKey(absence.scope, undefined, absence.scopeKey),
      );
      if ((this.#docs.get(key)?.confirmed.seq ?? 0) > 0) present += 1;
    }
    return present;
  }

  #buildReads(
    source: IStorageTransaction | undefined,
    localSeq: number,
    // The reading run's identity (a served per-instance seal): each read's
    // pending layers and confirmed seq come from THAT instance's record.
    identity?: ScopeKeyIdentity,
  ): ClientCommit["reads"] {
    const confirmed: ConfirmedCommitRead[] = [];
    const pending: PendingCommitRead[] = [];
    if (!source) {
      return { confirmed, pending };
    }

    const reads = getDirectTransactionReadActivities(source);
    if (!reads) {
      throw new Error(
        "Memory v2 commit tracking requires source.getReadActivities(); " +
          "journal.activity() fallback is unsupported.",
      );
    }

    // For a blind UI-input write, handleCellSet threads the cell's PARENT address
    // here; its `ignoreReadForCommit` reads are dropped below and replaced by one
    // nonRecursive read at this parent (emitted after the loop).
    const structuralTarget = getBlindStructuralTarget(source);

    // Pending bases belong to a document instance and the speculative-layer
    // policy. Every path read in this synchronous build shares that same stack.
    const pendingLayersByDocument = [
      new Map<string, number[]>(),
      new Map<string, number[]>(),
    ];

    // Emit one commit read for `id`, baselined against the most recent in-flight
    // local version of that doc below this commit's localSeq if one exists, else
    // the confirmed seq (or an explicit `confirmedSeq` override, e.g. a read that
    // carries its own `meta.seq`). Shared by the per-read loop below and the blind
    // write's structural precondition so the two emission sites stay in lockstep.
    //
    // Both the layers and the confirmed seq are read from the replica as the
    // commit is built, not from the transaction's own snapshot of the doc,
    // and a frame can land between the two. What the transaction owes this
    // site (03-commit-model.md §3.3.4) is its commit-time claim check,
    // passed before its reads are built: `claim()` in
    // transaction/attestation.ts re-reads every doc the transaction
    // snapshotted from this replica, and a differing value rejects the
    // transaction locally as `StorageTransactionInconsistent`. So the
    // content the transaction read is the content at the basis named here.
    //
    // `excludeSpeculativeLayers` (verification-coverage.md OW47, the client
    // own-write durability seam): the blind write's structural read passes
    // true, and its named layers then skip the client's own SPECULATIVE
    // overlay layers (#speculativeLocalSeqs). A speculative layer is
    // process-local render state that never reaches the wire as a commit,
    // so naming it made the export refusal (speculation.md §6,
    // `speculative-basis-refused`) fire on a read that carries NO value
    // dependency — which terminally dropped a USER's typed input whenever
    // one of their own handler echoes still stood on the target doc. An
    // echo's standing window is at least a full served round trip (the
    // arrival gate holds it until every doc it wrote is confirmed), and
    // unbounded for a never-served instance, so "the user typed while an
    // echo stood" is a routine state, not a race (rootcause §2b; the
    // cellset-lww end-to-end step; the group-chat messageDraft shape).
    // The blind-write tx's SECOND layer-naming producer passes true too
    // (RULED 2026-08-21; the name-draft triage): CFC prepare's
    // internal-verifier read of the write-target doc, whose VALUE the
    // transaction read path serves from the same non-speculative stack
    // (v2-transaction.ts) — the verifier verifies durable policy state
    // and names the durable basis, together. A verifier read AT the CFC
    // metadata path leaves the conflict set in the loop below and never
    // reaches this emission, so the producer here is a verifier read at
    // another path, a document's ["schema"] member among them.
    // Content-addressed (cid:)
    // reads keep their ordinary overlay value there — identical to the
    // durable content by construction — while this exclusion still
    // covers their layers, so an echo-staged schema doc neither aborts
    // the fill nor dooms its export.
    // The structural existence/shape precondition is evaluated against
    // durable state either way (basisSeq stays the true confirmed basis),
    // DURABLE in-flight layers stay named (dependency + CT-1910
    // own-session-exclusion semantics unchanged), and value-consuming
    // reads keep the ruled refusal — speculation-overlay.test.ts pins
    // both directions.
    const pushCommitRead = (
      id: URI,
      scope: CellScope | undefined,
      path: DocumentPath,
      nonRecursive: boolean,
      confirmedSeq?: number,
      excludeSpeculativeLayers = false,
    ) => {
      const recordKey = docKey(id, this.instanceKey(scope, identity));
      const record = this.#docs.get(recordKey);
      // The read's materialized view sat on EVERY lower pending layer, not
      // just the nearest one: name them ALL (ascending; the last element is
      // the doc's top-of-stack below this commit) so a dropped deeper layer
      // still dooms this commit (server: pending-dependency resolution;
      // client: cascade). Servers that honor `basisSeq` scan staleness from
      // it, excluding only the own-session layers the array names
      // (CT-1910) — naming the full stack is thus also what keeps the
      // scan from conflicting with this commit's own view. Legacy
      // servers base staleness at the highest element only — a lower-layer
      // basis WITHOUT that exclusion would false-conflict with the
      // session's own later stacked writes (CT-1872 1c).
      const layersByDocument = pendingLayersByDocument[
        excludeSpeculativeLayers ? 1 : 0
      ];
      let layers = layersByDocument.get(recordKey);
      if (layers === undefined) {
        layers = [
          ...new Set(
            record?.pending
              .filter((version) => version.localSeq < localSeq)
              .filter((version) =>
                !excludeSpeculativeLayers ||
                !this.#speculativeLocalSeqs.has(version.localSeq)
              )
              .map((version) => version.localSeq) ?? [],
          ),
        ].sort((left, right) => left - right);
        layersByDocument.set(recordKey, layers);
      }
      const shape = nonRecursive ? { nonRecursive: true } : {};
      if (layers.length > 0) {
        pending.push({
          id,
          scope,
          path,
          localSeq: layers.length === 1 ? layers[0] : layers,
          // The true confirmed basis this doc's view sat on — the same value
          // the confirmed branch below emits (CT-1910).
          basisSeq: confirmedSeq ?? record?.confirmed.seq ?? 0,
          ...shape,
        });
      } else {
        confirmed.push({
          id,
          scope,
          path,
          seq: confirmedSeq ?? record?.confirmed.seq ?? 0,
          ...shape,
        });
      }
    };

    for (const read of this.#commitReadActivities(source, reads)) {
      const scope = normalizeCellScope(read.scope);
      pushCommitRead(
        read.id as URI,
        scope,
        toCommitReadPath(read.path),
        read.nonRecursive === true,
        typeof read.meta?.seq === "number" ? read.meta.seq : undefined,
        // A CFC internal-verifier read of a blind UI-input write tx
        // bases on the doc's NON-speculative stack (RULED 2026-08-21;
        // OW47's second producer — the name-draft triage): the read's
        // VALUE was served from that stack (v2-transaction.ts read()),
        // so the layers named here must be the same durable set —
        // verify-durable and name-durable travel together. Confined to
        // the blind-write tx shape: `structuralTarget` survives the
        // unmark exactly so commit-time emission can recognize it, and
        // a verifier read in any other tx keeps naming every layer. The
        // verifier reads that arrive here are the ones outside the CFC
        // metadata path, which the loop above drops outright.
        (source !== undefined && isDurableReadTx(source)) ||
          (structuralTarget !== undefined &&
            isInternalVerifierRead(read.meta)),
      );
    }
    // The blind UI-input write's single structural existence/shape precondition: a
    // nonRecursive read at the cell's PARENT (threaded from handleCellSet). It
    // conflicts with a concurrent whole-doc delete/replace (TIER-1, path-blind) and
    // with a reshape of the parent or any ancestor (TIER-2 nonRecursive overlap
    // fires at-or-above the read path), but NOT with a write to the cell's own
    // value (which sits below the parent, including array elements) — so the
    // own-write race stays conflict-free.
    if (
      structuralTarget !== undefined &&
      structuralTarget.space === this.#space
    ) {
      pushCommitRead(
        structuralTarget.id as URI,
        normalizeCellScope(
          structuralTarget.scope as Parameters<typeof normalizeCellScope>[0],
        ),
        toCommitReadPath(structuralTarget.path),
        true,
        undefined,
        // The blind write consumes no overlay value, so its structural
        // read must base on the doc's non-speculative stack — otherwise
        // a standing echo turns the user's own input into a terminal
        // export refusal (OW47; see pushCommitRead's doc above).
        /* excludeSpeculativeLayers */ true,
      );
    }
    // Keep the nonRecursive flag on the reads sent to the engine (it was
    // historically stripped here). The engine applies shallow (shape-only)
    // conflict granularity to nonRecursive reads (patchOverlapsNonRecursiveRead),
    // matching how the scheduler reader-dirty index already treats them.
    return {
      confirmed: compactCommitReads(confirmed),
      pending: compactCommitReads(pending),
    };
  }

  /**
   * Validates the read-side delivery guarantee over a whole frame BEFORE
   * any of it is applied (`docs/specs/content-addressed-schemas.md`), and
   * registers the frame's schema documents: every schema ref a delivered
   * document embeds — a registered schema document's own refs, a link
   * schema anywhere in an ordinary document's value, or the reserved
   * `schema` metadata member any document carries (`cid:` documents
   * included; content addressing hashes `.value` alone) — must reach a
   * VERIFIED schema document delivered by this frame (the prospective
   * overlay) or already stored. A `schema` member in the malformed form
   * — a `cid:` reference outside a single root `$ref` — quarantines its
   * document outright: the commit boundary refuses that form, so it can
   * only predate the enforcement or come from out-of-band writing.
   *
   * A violated guarantee QUARANTINES the offending document — the caller
   * applies the frame without it, and this replica keeps whatever it
   * already held under that id — with a loud diagnostic per document
   * (verification-coverage.md OW61, coordinator recommendation (i),
   * ACKed 2026-08-24). Fail-closed for the DOC: a document whose refs
   * cannot verify never applies, and an unverifiable schema document
   * never registers, so no unverified schema is ever used. Contained for
   * the PROCESS: this ran on the background consume path
   * (`#consumeUpdates`), where the previous frame-wide throw was an
   * unhandled rejection that killed the consuming worker wholesale on
   * one bad document — a robustness hole against any producer bug (the
   * OW61 board: 13 file-level failures from one delivery race). The
   * server deliberately ELIDES cid docs this session already received
   * (not retransmitting schemas is why content addressing exists —
   * OW61's reversal ruling), so a compliant server legitimately emits
   * frames whose refs resolve only against this replica's stored docs;
   * a ref that fails to resolve here therefore indicates a CLIENT-side
   * absorb/ordering defect (a dropped, reordered, or un-retained
   * earlier delivery — the defect class OW61's investigation owns).
   * Quarantine contains that defect loudly; the heal arrives with the
   * next reconnect — the replica declares its holdings then (`holdings`),
   * a quarantined doc is not among them, and the server re-delivers it
   * with its closure — or with the next `watch.set`, whose frame carries
   * the whole assembled closure. Under elision an unchanged quarantined
   * doc is rightly never re-delivered mid-session on its own.
   *
   * Direct refs suffice: a stored verified dependency was itself validated
   * when it arrived, and a locally written one carried its closure in its
   * own transaction. Registration is safe pre-apply — it is hash-verified
   * and realm-global, so a quarantined frame entry leaves only true
   * content behind.
   *
   * Which `cid:` documents are schema documents is decided by
   * content-addressed identity, the classifier the server's assembly pass
   * also uses: a document is a schema document exactly when its id is the
   * schema interning of its value. Validation applies the same identity
   * check to each dependency — mere presence under the id is not delivery,
   * and a forged local copy fails even when the realm registry holds a
   * valid twin from another space.
   *
   * @returns the ids of the frame's upserts that must NOT apply.
   */
  #validateArrivedSchemaDocuments(sync: SessionSync): Set<string> {
    const registered: [string, JSONSchema][] = [];
    // Dependency hash → every delivered document id that embeds it: the
    // quarantine set on a violation, and the violation report.
    const embedded = new Map<string, Set<string>>();
    const embed = (hash: string, id: string) => {
      let referrers = embedded.get(hash);
      if (referrers === undefined) {
        referrers = new Set();
        embedded.set(hash, referrers);
      }
      referrers.add(id);
    };
    // The prospective frame: what the replica will hold once this frame
    // applies. Dependencies resolve against it first.
    const overlay = new Map<string, unknown>();
    const deletedInFrame = new Set<string>();
    // The quarantine unit is the upsert ID, not the document instance:
    // this validator's maps were id-keyed (branch- and instance-blind)
    // in the frame-wide era too, so a same-id entry on another branch
    // in the same frame drops with the offender — strictly less damage
    // than the whole-frame rejection this replaces (review note S1).
    const quarantined = new Set<string>();
    for (const remove of sync.removes) {
      if (typeof remove.id === "string") deletedInFrame.add(remove.id);
    }
    // The `schema` metadata member, read the same way on every document.
    // Returns whether the document survives; a malformed member is
    // quarantined here, before any obligation of its own is recorded.
    const embedSchemaMeta = (id: string, doc: unknown): boolean => {
      const form = classifySchemaMeta(doc);
      if (form.kind === "malformed") {
        quarantined.add(id);
        overlay.delete(id);
        logger.error("schema-doc-quarantine", () => [
          `Document ${id} was delivered with malformed schema metadata ` +
          `(${form.reason}). The commit boundary refuses this form, so ` +
          `the stored document predates that enforcement or was written ` +
          `out of band. The document is quarantined; this replica keeps ` +
          `its previous state for it.`,
        ]);
        return false;
      }
      for (const hash of schemaMetaRefHashes(form)) embed(hash, id);
      return true;
    };
    for (const upsert of sync.upserts) {
      const id = upsert.id;
      if (typeof id !== "string") continue;
      if (upsert.deleted === true) {
        deletedInFrame.add(id);
        continue;
      }
      const doc = upsert.doc;
      if (!isObjectNotArray(doc)) continue;
      overlay.set(id, doc);
      deletedInFrame.delete(id);
      if (!embedSchemaMeta(id, doc)) continue;
      if (id.startsWith("cid:")) {
        const value = (doc as { value?: unknown }).value;
        const hash = id.slice("cid:".length);
        const schema = verifySchemaDocument(hash, value);
        if (schema !== undefined) {
          registered.push([id, registerSchemaDocument(hash, schema)]);
          // A schema document's own refs are collected below from its
          // registered form; schema keywords such as `default` may carry
          // link-shaped DATA, so it is not link-scanned.
          continue;
        }
        // Content addressing forbids the content under an id to change:
        // when the replica already stores content that IS the schema
        // document this id names — however it got here, an earlier frame
        // or a local write — an arriving copy that fails the identity
        // check is a forged replacement, not another document class.
        // Quarantine the ARRIVING copy; the stored verified one stays,
        // so refs to this hash keep resolving.
        if (this.#isVerifiedSchemaDocDelivered(hash, EMPTY_OVERLAY)) {
          quarantined.add(id);
          overlay.delete(id);
          logger.error("schema-doc-quarantine", () => [
            `Schema document ${id} was replaced with content that does ` +
            `not hash to its id — content under a content-addressed id ` +
            `must never change. The arriving copy is quarantined; this ` +
            `replica keeps its stored, verified document.`,
          ]);
          continue;
        }
      }
      // Link positions — the `schema` metadata member was embedded above.
      // An `$alias`-shaped record in an arriving document is plain data,
      // never a delivery obligation.
      mapLinkSchemas(doc as FabricValue, (schema) => {
        for (
          const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
        ) {
          embed(hash, id);
        }
        return schema;
      });
    }
    for (const [id, document] of registered) {
      for (const dep of collectExternalSchemaRefHashes(document)) {
        embed(dep, id);
      }
    }
    // Validation runs after the whole frame is collected: a dependency may
    // follow its dependent within the frame, and intra-frame order must
    // not matter. Iterated to a fixpoint because quarantining an in-frame
    // schema document removes it from the prospective overlay, which can
    // break refs that resolved through it — the dependents fail closed
    // with it rather than applying against a document that will not be
    // there.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [dep, referrers] of embedded) {
        if (
          deletedInFrame.has(`cid:${dep}`) ||
          !this.#isVerifiedSchemaDocDelivered(dep, overlay)
        ) {
          for (const referrer of referrers) {
            if (quarantined.has(referrer)) continue;
            quarantined.add(referrer);
            overlay.delete(referrer);
            changed = true;
            logger.error("schema-doc-quarantine", () => [
              `Document ${referrer} was delivered with a broken schema ` +
              `ref: cid:${dep} is not delivered and verified in this ` +
              `replica. Every delivered document's refs must resolve ` +
              `within the delivered set ` +
              `(docs/specs/content-addressed-schemas.md). The document ` +
              `is quarantined — this replica keeps its previous state ` +
              `for it until the next reconnect (which declares this ` +
              `replica's holdings, so the server re-delivers it) or ` +
              `watch.set re-delivers it with its closure. This ` +
              `indicates a client-side absorb/ordering defect ` +
              `(verification-coverage.md OW61).`,
            ]);
          }
        }
      }
    }
    return quarantined;
  }

  /**
   * Whether this replica holds SERVER-CONFIRMED verified content for
   * `cid:<hash>` — the emission gate for selector references and the
   * elision seam for staged content-addressed documents: a confirmed
   * document arrived by delivery or by an acknowledged commit, so the
   * space's server holds it, and content addressing means it can never
   * change. The confirmed layer specifically: a pending local write is
   * visible through `getDocument` before the server has it, and a
   * reference emitted on that evidence races the commit and is answered
   * with the loud selector error. Confirmation is replica/host-local: it
   * relies on the provisional route not changing after observable reads
   * (CT-2046 tracks enforcing that broadly).
   */
  isContentAddressedDocPersisted(hash: string): boolean {
    const record = this.#docs.get(docKey(`cid:${hash}` as URI, "space"));
    const doc = record?.confirmed.value;
    if (!isObjectNotArray(doc)) return false;
    const value = doc.value;
    // A content-addressed document's value must hash to the id it sits under.
    return taggedHashStringOf(value) === hash;
  }

  /**
   * Whether the prospective frame (`overlay`) or the stored replica holds
   * content under `cid:<hash>` that IS the schema document that id names —
   * the identity check, not presence.
   */
  #isVerifiedSchemaDocDelivered(
    hash: string,
    overlay: ReadonlyMap<string, unknown>,
  ): boolean {
    const doc = overlay.get(`cid:${hash}`) ??
      this.getDocument(`cid:${hash}` as URI);
    if (!isObjectNotArray(doc)) return false;
    const value = (doc as { value?: unknown }).value;
    return verifySchemaDocument(hash, value) !== undefined;
  }

  /**
   * Applies one session frame to the replica: operation-field deliveries to
   * their sinks, then the frame's upserts and removes, with an entry that
   * fails the delivery guarantee quarantined rather than applied. Throws on
   * a frame that is not the shape the wire promises.
   */
  #applySessionSync(
    sync: SessionSync,
    type: "pull" | "integrate",
  ): void {
    // No read during a frame's integration — the differential checkout's
    // snapshot, the arrived-cfc hydration — starts a store read-through:
    // that would integrate a second frame from inside this one.
    this.#frameApplyDepth += 1;
    try {
      this.#applySessionSyncFrame(sync, type);
    } finally {
      this.#frameApplyDepth -= 1;
    }
  }

  /** Helper for `#applySessionSync()`, which carries the integration
   * itself. */
  #applySessionSyncFrame(
    sync: SessionSync,
    type: "pull" | "integrate",
  ): void {
    for (const delivery of sync.operationFields ?? []) {
      for (const callback of this.#operationSinks.get(delivery.watchId) ?? []) {
        try {
          callback(delivery.field);
        } catch (error) {
          console.error("operation field subscriber failed", error);
        }
      }
    }
    if (
      sync.upserts.length === 0 &&
      sync.removes.length === 0
    ) {
      if (sync.viewPlans !== undefined) this.#publishViewPlans(sync.viewPlans);
      this.#noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);
      return;
    }

    // Validation precedes every record mutation: an entry that fails the
    // delivery guarantee is QUARANTINED (dropped from this frame with a
    // loud diagnostic — never half-installed, never a process kill; see
    // #validateArrivedSchemaDocuments), and the rest of the frame
    // applies.
    const quarantined = this.#validateArrivedSchemaDocuments(sync);
    if (quarantined.size > 0) {
      const suspendedPlans = (sync.viewPlans ?? this.#viewPlans).map((
        plan,
      ) => ({ ...plan, eligibleActions: [] }));
      this.#publishViewPlans(suspendedPlans);
      sync = {
        ...sync,
        ...(sync.viewPlans === undefined ? {} : { viewPlans: suspendedPlans }),
        upserts: sync.upserts.filter((upsert) =>
          typeof upsert.id !== "string" || !quarantined.has(upsert.id)
        ),
      };
    }

    // A keyed frame (a lease-holder session's — server-execution v2 stage
    // A, OW17's wire leg) names each entry's instance; the replica keys
    // the doc under it. An unkeyed frame resolves from the replica's own
    // identity exactly as before.
    const touched: LocalDocAddress[] = [
      ...sync.upserts.map((upsert) => ({
        id: upsert.id as URI,
        scope: upsert.scope,
        ...(upsert.scopeKey !== undefined ? { scopeKey: upsert.scopeKey } : {}),
      })),
      ...sync.removes.map((remove) => ({
        id: remove.id as URI,
        scope: remove.scope,
        ...(remove.scopeKey !== undefined ? { scopeKey: remove.scopeKey } : {}),
      })),
    ];

    const coverageChanges = this.#localCoverageObservers.size === 0
      ? []
      : touched.filter((address) => {
        const key = this.#docKeyOf(address);
        return !this.#delivered.has(key) ||
          sync.removes.some((remove) =>
            this.#docKeyOf({
              id: remove.id as URI,
              scope: remove.scope,
              scopeKey: remove.scopeKey,
            }) === key
          );
      });

    const shouldNotifySubscribers = this.#hasNotificationSubscribers();
    const shouldNotifySinks = this.#hasSinkSubscribers(touched);
    const before = shouldNotifySubscribers
      ? Differential.checkout(
        this,
        touched.map(({ id, scope, scopeKey }) =>
          snapshotState(this, id, scope, scopeKey)
        ),
        this.#scopeKeyIdentity(),
      )
      : undefined;

    // Docs whose CONFIRMED seq this frame moved FORWARD — the arrival
    // wake's payload (stage C tuning T2). Collected only while an
    // observer is installed (a client overlay's), so every other replica
    // pays one undefined check.
    const arrived: LocalDocAddress[] | undefined =
      this.#speculationArrivalObserver !== undefined ? [] : undefined;
    for (const upsert of sync.upserts) {
      const record = this.#record(
        upsert.id as URI,
        upsert.scope,
        undefined,
        upsert.scopeKey,
      );
      // Watch refreshes can arrive after local confirmations. Never move the
      // confirmed base backwards; pending replay depends on monotonic bases.
      if (upsert.seq < record.confirmed.seq) {
        continue;
      }
      const previousConfirmedSeq = record.confirmed.seq;
      const previousCoverClass = record.confirmed.coverClass;
      // The covering commit's class (speculation.md §4's arrival-witness
      // predicate): the frame's annotation when it carries one; on a
      // SAME-SEQ re-upsert without one (a watch-refresh replay, an
      // OFF-arm or pre-predicate frame echo of a commit the promotion
      // path already classed) the cover is the same commit, so the known
      // class survives. A forward move without one is a different
      // commit — the stale class must not ride onto it.
      const coverClass = upsert.coverClass ??
        (upsert.seq === previousConfirmedSeq ? previousCoverClass : undefined);
      record.confirmed = confirmedVersion(
        upsert.seq,
        upsert.deleted === true ? undefined : upsert.doc,
        coverClass,
      );
      record.materialized = undefined;
      // The arrival wake fires on a FORWARD move — and on a same-seq
      // frame whose class arrives LATE (undefined -> defined): an entry
      // failed CLOSED at its floor under an unknown class (a mixed-window
      // frame from a pre-predicate server, or one integrated before this
      // client learned the class) is otherwise never re-swept — the
      // predicate's inputs changed with no covering wake, and the entry
      // stands until an unrelated commit sweeps it.
      if (
        arrived !== undefined &&
        (upsert.seq > previousConfirmedSeq ||
          (upsert.seq === previousConfirmedSeq &&
            previousCoverClass === undefined &&
            coverClass !== undefined))
      ) {
        arrived.push({
          id: upsert.id as URI,
          scope: upsert.scope,
          ...(upsert.scopeKey !== undefined
            ? { scopeKey: upsert.scopeKey }
            : {}),
        });
      }
      const key = docKey(
        upsert.id as URI,
        this.instanceKey(upsert.scope, undefined, upsert.scopeKey),
      );
      this.#watchedIds.add(key);
      this.#delivered.set(key, {
        id: upsert.id as URI,
        scope: upsert.scope,
        scopeKey: upsert.scopeKey,
        branch: upsert.branch,
        seq: upsert.seq,
        deleted: upsert.deleted === true,
      });
      // The settle input barrier's shadow case (Phase 2 revisit (a)):
      // a FOREIGN value integrating UNDER an own pending write is
      // invisible through the materialized view — and the change
      // notification below misses it — until the pending entry promotes
      // or drops. Record the seq so the serving loop's W advance
      // excludes it (`unappliedForeignSeqFloor`). Three exemptions,
      // each a non-novelty shape that would otherwise clamp W forever
      // (or one wave behind) on a serving loop:
      // - GENUINE NOVELTY ONLY — the upsert must move confirmed
      //   FORWARD past what was already visible
      //   (`upsert.seq > previousConfirmedSeq`): a same-seq re-upsert
      //   (a watch-refresh replay, or the frame echo of a SEALED
      //   commit that F1a already confirmed at verdict time) carries
      //   nothing the replica has not integrated;
      // - an OWN ECHO — an upsert whose seq IS one of the pending
      //   accepts' ack seqs is the durable copy of the own write
      //   itself (CT-1927's mixed-provenance frame);
      // - a seq-0 ABSENT-DOC marker (the initial watch pull's "no
      //   confirmed version" answer), which carries no novelty at all.
      if (
        upsert.seq > 0 &&
        upsert.seq > previousConfirmedSeq &&
        record.pending.length > 0 &&
        !record.pending.some((entry) =>
          this.#ackedSeqsByLocalSeq.get(entry.localSeq) === upsert.seq
        )
      ) {
        // Record EVERY hidden seq (review thread r3739139487): the
        // floor reads the doc's lowest — the wave's derivations read
        // the materialized view from BEFORE the earliest hidden input,
        // so W must not advance past it. The previous per-doc
        // `Math.max` let a second foreign update under the same
        // pending write raise the floor and pass the first (a
        // derivedThrough claim over input nothing derived over), and
        // buried a standing remove sentinel the same way.
        let seqs = this.#shadowedForeignSeqs.get(key);
        if (seqs === undefined) {
          seqs = new Set();
          this.#shadowedForeignSeqs.set(key, seqs);
        }
        seqs.add(upsert.seq);
      }
    }
    for (const remove of sync.removes) {
      const id = remove.id as URI;
      const record = this.#record(id, remove.scope, undefined, remove.scopeKey);
      record.confirmed = confirmedVersion(0, undefined);
      record.materialized = undefined;
      const key = docKey(
        id,
        this.instanceKey(remove.scope, undefined, remove.scopeKey),
      );
      this.#watchedIds.delete(key);
      this.#delivered.delete(key);
      if (record.pending.length > 0) {
        // A shadowed remove carries no seq on the wire: the sentinel 1
        // holds W entirely until the shadow clears (see the field doc).
        let seqs = this.#shadowedForeignSeqs.get(key);
        if (seqs === undefined) {
          seqs = new Set();
          this.#shadowedForeignSeqs.set(key, seqs);
        }
        seqs.add(1);
      }
    }

    if (sync.viewPlans !== undefined) this.#publishViewPlans(sync.viewPlans);

    // Parked accepts apply BEFORE the differential compare: when the frame
    // authoritatively covers a doc the session itself wrote (mixed
    // provenance), the integrated base already CONTAINS the parked write,
    // and the notification must reflect the post-promotion view — not a
    // transient double-apply of a still-standing overlay that the parked
    // application then silently removes.
    this.#noteCaughtUpLocalSeq(sync.caughtUpLocalSeq);

    if (before !== undefined) {
      const changes = before.compare(this);
      if (type === "pull" || [...changes].length > 0) {
        this.#subscription.next({
          type,
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifySinks) {
          this.#notifySinks(changes);
        }
      }
    } else if (shouldNotifySinks) {
      this.#notifySinksForIds(touched);
    }
    // The arrival wake (stage C tuning T2, speculation.md §4): AFTER the
    // frame's own notifications, on a consistent replica — the overlay's
    // sweep resolves verdicts (dropping its retired layers through the
    // ordinary rollback path), which must not interleave with the
    // integration above. Same containment posture as the ack observer.
    if (
      arrived !== undefined && arrived.length > 0 &&
      this.#speculationArrivalObserver !== undefined
    ) {
      try {
        this.#speculationArrivalObserver(arrived);
      } catch (error) {
        logger.error("speculation-arrival-observer-error", () => [
          "speculationArrivalObserver threw during frame integration",
          error,
        ]);
      }
    }
    if (coverageChanges.length > 0) {
      for (const observer of this.#localCoverageObservers) {
        try {
          observer(coverageChanges);
        } catch (error) {
          logger.error(
            "local-coverage-observer-error",
            "Local coverage observer failed",
            error,
          );
        }
      }
    }
    this.#hydrateArrivedCfcSchemaRefs(sync);
  }

  /** Schema-hash hydration for arrived metadata (verification-coverage.md
   * OW47's re-close): a frame delivers a doc's `/cfc` metadata WITHOUT its
   * `schemaHash` refs — the delivery validation covers link-position
   * schemas only — so stored metadata can reference a `cid:` document no
   * local source resolves, and the next commit whose CFC prepare consults
   * it (a blind fill's durable verifier read above all) dies on
   * `stored schemaHash … missing or unreadable`. Pull the referenced
   * document as the metadata arrives: deferred a microtask (never
   * re-entrant inside frame application), deduped per replica while a
   * kick is in flight or has DELIVERED. A pull that fails, or that
   * completes WITHOUT the document (not yet installed server-side — a
   * legal state while the stamper's own commit is in flight), re-arms
   * the dedupe so the next frame carrying the reference kicks again —
   * without the re-arm the delivery-gap window was permanent for the
   * session. The empty-completion re-kick is SILENT and frame-paced:
   * one pull per hash per frame batch, no backoff — a permanently
   * absent hash re-pulls once per arriving frame without a log.
   * Failures log HERE: the replica-level pull never crosses the
   * manager's sync-load logging wrappers, so this is the only
   * client-side trace before the prepare abort. */
  #hydrateArrivedCfcSchemaRefs(sync: SessionSync): void {
    for (const upsert of sync.upserts) {
      if (upsert.deleted === true) continue;
      const id = upsert.id;
      if (typeof id !== "string" || id.startsWith("cid:")) continue;
      const doc = upsert.doc;
      if (!isObjectNotArray(doc)) continue;
      const cfc = (doc as { cfc?: unknown }).cfc;
      if (!isObjectNotArray(cfc)) continue;
      const schemaHash = (cfc as { schemaHash?: unknown }).schemaHash;
      if (typeof schemaHash === "string" && schemaHash.length > 0) {
        this.#kickCfcDocumentPull(schemaHash, lookupSchemaDocument);
      }
      // A version-2 envelope is owed its label documents on the same
      // terms: a reader resolves every reference synchronously, and one
      // that arrives without its document fails closed on every read
      // until the document is at hand.
      for (const hash of cfcEnvelopeLabelDocumentHashes(cfc)) {
        this.#kickCfcDocumentPull(hash, lookupCfcLabelDocument);
      }
    }
  }

  /**
   * Helper for `#hydrateArrivedCfcSchemaRefs()`, which pulls one `cid:`
   * document an arrived envelope names, unless the replica or the realm
   * registry `registered` consults already holds it: one pull per hash per
   * frame batch, re-armed on a failure or an empty completion so a later
   * frame carrying the reference retries.
   */
  #kickCfcDocumentPull(
    hash: string,
    registered: (hash: string) => unknown,
  ): void {
    if (this.#kickedCfcSchemaPulls.has(hash)) return;
    if (
      registered(hash) !== undefined ||
      this.getDocument(`cid:${hash}` as URI) !== undefined
    ) {
      return;
    }
    this.#kickedCfcSchemaPulls.add(hash);
    queueMicrotask(() => {
      this.sync(`cid:${hash}` as URI)
        .then((result) => {
          if (result.error !== undefined) {
            logger.warn("cfc-schema-hydration-failed", () => [
              "arrived-metadata document pull failed; a later frame " +
              "carrying the reference re-kicks",
              { hash, error: String(result.error) },
            ]);
            this.#kickedCfcSchemaPulls.delete(hash);
            return;
          }
          if (
            registered(hash) === undefined &&
            this.getDocument(`cid:${hash}` as URI) === undefined
          ) {
            // Completed empty: the document is not installed
            // server-side yet. Re-arm, so the next reference-carrying
            // frame retries instead of the window going permanent.
            this.#kickedCfcSchemaPulls.delete(hash);
          }
        }, (error) => {
          logger.warn("cfc-schema-hydration-failed", () => [
            "arrived-metadata document pull threw; a later frame " +
            "carrying the reference re-kicks",
            { hash, error: String(error) },
          ]);
          this.#kickedCfcSchemaPulls.delete(hash);
        });
    });
  }

  /**
   * Marks every id this conflicted commit touched (reads and writes) stale
   * until the runner observes `caughtUpLocalSeq >= localSeq` — the seq the
   * server stages as the post-conflict catch-up point for these ids.
   */
  #recordStaleFloor(commit: ClientCommit, localSeq: number): void {
    const mark = (id: string, scope?: CellScope) => {
      const key = this.#docKeyOf({ id: id as URI, scope });
      const current = this.#staleFloor.get(key);
      if (current === undefined || current < localSeq) {
        this.#staleFloor.set(key, localSeq);
      }
    };
    for (const operation of commit.operations) {
      if (operation.op === "sqlite") continue; // no entity id
      mark(operation.id, operation.scope);
    }
    for (const read of commit.reads.confirmed) {
      mark(read.id, read.scope);
    }
    for (const read of commit.reads.pending) {
      mark(read.id, read.scope);
    }
  }

  /**
   * Returns the highest stale floor among this commit's reads (a recorded floor
   * above our current caught-up seq) — the seq we must reach before a retry can
   * succeed — or `undefined` when none is stale. Only reads gate admission: a
   * stale read precondition is what the server rejects.
   */
  #preemptThreshold(commit: ClientCommit): number | undefined {
    if (this.#staleFloor.size === 0) {
      return undefined;
    }
    let threshold: number | undefined;
    const consider = (id: string, scope?: CellScope) => {
      const floor = this.#staleFloor.get(
        this.#docKeyOf({ id: id as URI, scope }),
      );
      if (floor !== undefined && floor > this.#caughtUpLocalSeq) {
        threshold = threshold === undefined
          ? floor
          : Math.max(threshold, floor);
      }
    };
    for (const read of commit.reads.confirmed) {
      consider(read.id, read.scope);
    }
    for (const read of commit.reads.pending) {
      consider(read.id, read.scope);
    }
    return threshold;
  }

  #makePreemptRejection(
    commit: ClientCommit,
    threshold: number,
  ): StorageTransactionRejected {
    return {
      name: "ConflictError",
      message:
        `commit preempted: read set stale until caughtUpLocalSeq>=${threshold}`,
      transaction: commit,
      conflict: {
        space: this.#space,
        the: DOCUMENT_MIME,
        of: conflictEntityOf(commit),
      },
      // The catch-up that clears `threshold` is already in flight from the
      // earlier conflict; gate the retry directly on it (no provider round trip
      // to wrap, so we do NOT call attachProviderReadyToRetry here).
      readyToRetry: () => this.#waitForCaughtUpLocalSeq(threshold),
    };
  }

  /**
   * Makes a locally-fabricated rejection for a commit whose doom is provable
   * client-side (dropped pending dependency, dependency rejected but not yet
   * dropped, or replica reset). Modeled on `#makePreemptRejection()`.
   * `readyToRetry` defaults to resolving immediately, which is right once the
   * _primary_ rejection's `#finalizeRejection()` has awaited its read repair
   * (or reset wiped the replica outright): the victim adds no wait of its own.
   * A commit rejected against a layer whose repair is still running passes that
   * repair's completion here instead.
   */
  #makeLocalRejection(
    commit: ClientCommit,
    message: string,
    readyToRetry: () => Promise<void> = () => Promise.resolve(),
  ): StorageTransactionRejected {
    return {
      name: "ConflictError",
      message,
      transaction: commit,
      conflict: {
        space: this.#space,
        the: DOCUMENT_MIME,
        of: conflictEntityOf(commit),
      },
      readyToRetry,
    };
  }

  #makeCascadeRejection(
    entry: InFlightCommit,
    droppedLocalSeq: number,
  ): StorageTransactionRejected {
    return this.#makeLocalRejection(
      entry.commit,
      `pending dependency dropped locally: localSeq=${droppedLocalSeq}`,
    );
  }

  /** The SPECULATIVE overlay layers a commit's read basis names, if any
   * (server-execution v2 Phase 2, speculation.md §6). Non-empty means
   * the commit must not export: those localSeqs exist only in this
   * process, so as wire pending-read dependencies they can NEVER
   * resolve. */
  #speculativeLayersOf(commit: ClientCommit): number[] {
    if (this.#speculativeLocalSeqs.size === 0) return [];
    const named = new Set<number>();
    for (const read of commit.reads.pending) {
      const layers = Array.isArray(read.localSeq)
        ? read.localSeq
        : [read.localSeq];
      for (const layer of layers) {
        if (this.#speculativeLocalSeqs.has(layer)) named.add(layer);
      }
    }
    return [...named].sort((left, right) => left - right);
  }

  /**
   * Makes the loud export refusal (`speculation.md` §6): an authored/pushed
   * commit whose read basis names a speculative overlay layer fails _outright_
   * — terminal, never retried. Only the client can make this call: it knows
   * which of its layers are speculative, while the server cannot distinguish a
   * dependency that is never coming from one that has not arrived yet. Modeled
   * on `toRejectedError()`'s terminal-name arm (`RowLabelCommitError`): a
   * `TransactionError` shape whose name is in `TERMINAL_REJECTION_NAMES`, so
   * the scheduler's disposition is `terminal` instead of a doomed backoff
   * window.
   */
  #makeSpeculativeBasisRefusal(
    commit: ClientCommit,
    speculativeLayers: readonly number[],
  ): StorageTransactionRejected {
    const message =
      `authored commit refused: its read basis names speculative overlay ` +
      `layer(s) ${speculativeLayers.join(", ")} — client speculation ` +
      `entries exist only in this process and can never resolve as wire ` +
      `pending-read dependencies (server-execution v2 speculation.md §6). ` +
      `The write is failed outright instead of retried; re-derivation ` +
      `after the authoritative value lands is the recovery path.`;
    return {
      name: "SpeculativeBasisError",
      message,
      cause: { name: "SystemError", message, code: 409 },
      transaction: commit,
    } as unknown as StorageTransactionRejected;
  }

  /**
   * Returns the rejection that seals `entry`'s fate before it reaches the
   * wire, or undefined when it may still be sent. Two things seal it: a local
   * rejection already recorded on the entry, and a dependency whose own commit
   * has been rejected while its optimistic layer is still standing. The
   * rejection returned for the second carries a readiness gate covering every
   * such layer, so a retry rebuilds against a base repaired of all of them.
   */
  #preSendRejection(
    entry: InFlightCommit,
  ): StorageTransactionRejected | undefined {
    // The first shape comes from cascadeDroppedDependency or from reset.
    if (entry.localRejectionValue !== undefined) {
      return entry.localRejectionValue;
    }
    // The second: the server never gives a rejected layer a commit row, so it
    // can only answer a commit naming one with "pending dependency not
    // resolved". Fabricate that verdict here instead.
    const dead: number[] = [];
    for (const dependency of entry.dependencies) {
      if (this.#rejectedPendingLayers.has(dependency)) {
        dead.push(dependency);
      }
    }
    if (dead.length === 0) {
      return undefined;
    }
    // A commit reading two documents can sit on two dead layers from
    // unrelated conflicts, whose repairs land at different times. Gating on
    // only the first would let the retry re-read through the second and be
    // refused all over again.
    dead.sort((left, right) => left - right);
    const drops = dead.map((dependency) =>
      this.#rejectedPendingLayers.get(dependency)!
    );
    const rejection = this.#makeLocalRejection(
      entry.commit,
      `pending dependency rejected: localSeq=${dead.join(",")}`,
      async () => {
        await Promise.all(drops);
      },
    );
    // Recorded on the entry, so a later drop of one of these dependencies
    // does not cascade over it a second time. It is a ConflictError, so the
    // refused commit's own finalizeRejection awaits the gate too: its
    // optimistic layer, and the revert that removes it, both wait for the
    // drops. The chain terminates because buildReads only names layers below
    // the reader's localSeq.
    this.#rejectInFlightCommitLocally(entry, rejection);
    return rejection;
  }

  /**
   * CT-1872 1b: when a commit's optimistic writes are dropped, every
   * in-flight commit whose pending reads name that localSeq is provably
   * doomed — the dropped commit will never gain a commit row in the
   * per-session commit table, so the server would reject each dependant with
   * "pending dependency not resolved" only after a full round trip (a window
   * of up to 30s+ per commit). Fabricate that rejection locally instead.
   *
   * Commits with no pending reads never enter `#inFlightCommits`, so
   * zero-read mergeable/blind commits are structurally exempt — they are
   * DESIGNED to survive a parent drop (the server materializes their spine
   * via createMissing). Resolving the promises here queues the victims'
   * continuations on later microtasks; each victim snapshots its own revert
   * Differential before its own drop, so the scan itself never re-enters.
   */
  #cascadeDroppedDependency(droppedLocalSeq: number): void {
    for (const entry of [...this.#inFlightCommits.values()]) {
      if (
        entry.settled ||
        entry.localRejectionValue !== undefined ||
        !entry.dependencies.has(droppedLocalSeq)
      ) {
        continue;
      }
      this.#rejectInFlightCommitLocally(
        entry,
        this.#makeCascadeRejection(entry, droppedLocalSeq),
      );
      logger.debug("commit-cascade-rejected", () => [
        `commit locally rejected: pending dependency localSeq=${droppedLocalSeq} was dropped`,
        { localSeq: entry.localSeq, operations: entry.operations.length },
      ]);
    }
  }

  #attachProviderReadyToRetry(
    rejection: StorageTransactionRejected,
    localSeq: number,
  ): void {
    if (rejection.name !== "ConflictError") {
      return;
    }
    const readyToRetry = rejection.readyToRetry;
    if (readyToRetry === undefined) {
      return;
    }
    rejection.readyToRetry = async () => {
      await readyToRetry();
      await this.#waitForCaughtUpLocalSeq(localSeq);
    };
  }

  /**
   * Waits out the read repair a server conflict names, so that a retry of
   * the rejected commit starts from the repaired base.
   */
  async #waitForConflictReadRepair(
    rejection: StorageTransactionRejected,
  ): Promise<void> {
    if (rejection.name !== "ConflictError") {
      return;
    }
    const readyToRetry = rejection.readyToRetry;
    if (readyToRetry === undefined) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(
          "conflict-read-repair-timeout",
          "caught-up sync not received within timeout; surfacing conflict",
        );
        resolve();
      }, CONFLICT_READ_REPAIR_TIMEOUT_MS);
    });
    try {
      await Promise.race([readyToRetry(), timedOut]);
    } catch (error) {
      logger.warn(
        "conflict-read-repair",
        "readyToRetry rejected while preserving original conflict result",
        error,
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * What this replica holds, stated for a reconnect (the wire
   * `SessionHolding`; 04-protocol.md §4.1.2): every watched document at
   * the seq of the last frame this replica ABSORBED for it, a tombstone
   * marked as such, on the branch the frame named. The server takes the
   * list as the delivery diff base in place of its own memory of the
   * session, so a document absent here — never absorbed, quarantined, or
   * wiped with a replaced replica — is delivered again, and one present
   * stays elided. Delivered state only, never `record.confirmed`: a local
   * promotion advances the confirmed seq with a value the server never
   * sent, and claiming that seq would elide the authoritative snapshot
   * (INV-14's over-declare direction). An own write the server elided as
   * this session's echo therefore declares the older delivered seq and is
   * re-delivered — redundant, never a gap. A document delivered under an
   * explicit foreign instance key (lease-holder frames) is left unstated
   * — the wire declares instances by scope name — so it is re-delivered
   * rather than wrongly claimed for the session's own instance.
   */
  holdings(): SessionHolding[] {
    const holdings: SessionHolding[] = [];
    for (const delivered of this.#delivered.values()) {
      if (delivered.scopeKey !== undefined) continue;
      if (delivered.seq <= 0) continue;
      holdings.push({
        id: delivered.id,
        ...(delivered.scope !== undefined ? { scope: delivered.scope } : {}),
        ...(delivered.branch === DEFAULT_BRANCH
          ? {}
          : { branch: delivered.branch }),
        seq: delivered.seq,
        ...(delivered.deleted ? { deleted: true } : {}),
      });
    }
    return holdings;
  }

  #record(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
    explicit?: ScopeKey,
  ): DocumentRecord {
    const key = docKey(id, this.instanceKey(scope, identity, explicit));
    let record = this.#docs.get(key);
    if (!record) {
      record = {
        confirmed: confirmedVersion(0, undefined),
        pending: [],
        materialized: undefined,
      };
      this.#docs.set(key, record);
    }
    return record;
  }

  #applyPending(
    operation: NativeCommitOperation,
    localSeq: number,
    identity?: ScopeKeyIdentity,
  ): void {
    const { id, scope, ...pending } = operation;
    const record = this.#record(id, scope, identity);
    record.pending.push(pendingVersion(localSeq, pending));
  }

  /**
   * Settles an accept verdict. An accept's promotion waits for marker coverage.
   * Immediate application remains for a marker already observed before this
   * replica begins settlement and for servers that predate per-verdict markers
   * (`verdictCatchUpMarkers` absent: an older server stamps markers only for
   * conflicts, so parking would hang).
   *
   * _Pushed_ (socket) commits only: sealed commits — engine-plane commits by
   * the co-hosted executor — settle through `#settleSealedCommit()`, which
   * confirms immediately (no marker is ever staged for an engine-plane commit,
   * so parking them would wedge permanently).
   */
  #settleAccept(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
    resolveAtVerdict = false,
    source?: IStorageTransaction,
  ): Promise<void> {
    // The retirement floor's ack record (speculation.md §4): known at
    // VERDICT time, before any parking — a parked promotion changes when
    // the value becomes visible, not that the origin acked.
    this.#ackedSeqsByLocalSeq.set(localSeq, applied.seq);
    // The same seq, on the transaction that produced the commit: its caller
    // can name the commit after the bounded record above has forgotten it.
    if (source !== undefined) {
      recordCommitSeq(source, this.#space, applied.seq);
    }
    if (
      this.#ackedSeqsByLocalSeq.size > SpaceReplica.#MAX_RETAINED_ACK_SEQS
    ) {
      const oldest = this.#ackedSeqsByLocalSeq.keys().next();
      if (!oldest.done) this.#ackedSeqsByLocalSeq.delete(oldest.value);
    }
    // The input barrier's own-echo race repair (Phase 2 revisit (a)):
    // the frame can OUTRUN this verdict handler on the same socket, so
    // an own-echo upsert may have been mis-recorded as shadowed foreign
    // novelty before the ack above existed. A shadow whose seq IS this
    // accept's seq on a doc this accept wrote is that mis-record — no
    // foreign commit can share the seq — so lift EXACTLY that seq (the
    // set structure keeps genuine foreign shadows recorded around the
    // echo intact — r3739139487), or a quiet serving loop would clamp
    // W forever against its own echo.
    for (const operation of operations) {
      const key = this.#docKeyOf(operation);
      const seqs = this.#shadowedForeignSeqs.get(key);
      if (seqs !== undefined && seqs.delete(applied.seq) && seqs.size === 0) {
        this.#shadowedForeignSeqs.delete(key);
      }
    }
    // The retirement wake for origin accepts (speculation.md §4;
    // leg-C 2026-08-13): a sweep that ran while this verdict was in
    // flight skipped its entries as blocked (unacked layer below), and
    // the covering watermark event has already passed — without this
    // wake a then-quiet space strands them forever. Rejected origins
    // reach the overlay through the dependency cascade; ACCEPTS need
    // this explicit signal. Guarded: an observer throw must not abort
    // accept settlement (same containment posture as notifySinks).
    if (this.speculationAckObserver !== undefined) {
      try {
        this.speculationAckObserver();
      } catch (error) {
        logger.error("speculation-ack-observer-error", () => [
          "speculationAckObserver threw during accept settlement",
          error,
        ]);
      }
    }
    // Parking requires a live marker channel: a server that stages
    // per-verdict markers AND an active sync consumer to deliver them. With
    // no subscribed watch view, no frames arrive at all — there is no
    // novelty stream to order the promotion against, and verdict-time
    // extrapolation is exactly as current as this replica can be.
    const parkable =
      this.#sessionClient?.serverFlags?.verdictCatchUpMarkers === true &&
      this.#subscribedWatchView !== null;
    // Zero-operation commits (scheduler observation batches) carry no state
    // to apply and no view consequences — parking them would only stall
    // synced() on the batch window for nothing.
    //
    // The already-caught-up check is NOT wire-reordering tolerance: since
    // the per-space publication lock (#5529) the marker frame always
    // FOLLOWS its verdict on the socket. It survives for intra-client
    // interleaving — the transact awaiter resumes several microtask hops
    // after its response resolves (request()'s internal awaits), and the
    // marker frame's processing can integrate in that gap — so by the time
    // this runs, the marker may already cover this commit and parking
    // would wait on a frame that has already been consumed.
    if (
      !parkable || operations.length === 0 ||
      this.#caughtUpLocalSeq >= localSeq
    ) {
      // A pushed transact accept: the session admission class, authored.
      this.#confirmPending(localSeq, operations, applied, "authored");
      return Promise.resolve();
    }
    const settled = Promise.withResolvers<void>();
    this.#parkedAccepts.set(localSeq, { operations, applied, settled });
    // synced() holds on the parked application, not just the verdict: its
    // contract is "storage fully settled", which under parking includes the
    // fan-out of this replica's own accepted writes (CT-1950). The push
    // promise resolves at the verdict, so the barrier needs its own hold.
    // A verdict-resolving commit opts out of the hold — its premise is
    // "accepted but not fanned out", which a synced() that forces the
    // fan-out through would destroy — while its SETTLEMENT timeline still
    // drains coverage; only the caller's returned promise resolves early.
    if (!resolveAtVerdict) {
      const hold: Promise<Result<Unit, StorageTransactionRejected>> = settled
        .promise.then(() => ({ ok: {} }));
      this.#commitPromises.add(hold);
      hold.then(() => this.#commitPromises.delete(hold));
    }
    return settled.promise;
  }

  /**
   * Applies everything parked immediately, for when the marker channel died
   * (the subscribed view closed), so promotions never wait on frames that can
   * no longer arrive.
   */
  #applyParkedAcceptsNow(): void {
    if (this.#parkedAccepts.size === 0) {
      return;
    }
    const due = [...this.#parkedAccepts.keys()].sort((left, right) =>
      left - right
    );
    for (const parked of due) {
      const entry = this.#parkedAccepts.get(parked)!;
      this.#parkedAccepts.delete(parked);
      // Parked accepts are pushed transact accepts: authored.
      this.#confirmPending(parked, entry.operations, entry.applied, "authored");
      entry.settled.resolve();
    }
  }

  #confirmPending(
    localSeq: number,
    operations: NativeCommitOperation[],
    applied: AppliedCommit,
    // The commit class the promoted cover records (speculation.md §4's
    // arrival-witness predicate): every promotion here is of a commit
    // THIS replica issued, so its admission class is knowable locally —
    // `authored` for a pushed transact accept, `derived` for a sealed
    // wave commit (settleSealedCommit's arm on a serving runtime).
    coverClass: CommitClass,
    // The identity the operations were sealed under (F1a's sealed-commit
    // confirm; a pushed commit's is the replica's own).
    identity?: ScopeKeyIdentity,
  ): void {
    // The accept is being applied (immediately at verdict, or promoted
    // off the parked set): release any read-barrier waiter (whenApplied).
    this.#resolveAppliedWaiter(localSeq);
    const keys = new Map(
      this.#touchedOf(operations, identity).map((touched) => [
        this.#docKeyOf(touched),
        touched,
      ]),
    );
    // The settle input barrier's SHADOW FLIP (Phase 2 revisit (a), flag
    // ON only): when confirmed advanced PAST this accept while it was
    // pending — foreign novelty integrated under the own overlay — the
    // removal below makes the foreign value visible where the overlay
    // was, and NO other path notifies (`#applySessionSync()`'s differential
    // ran while the overlay still masked the change). Fire the ordinary
    // change notification for exactly the shadowed docs, so scheduler
    // dirtiness registers BEFORE `unappliedForeignSeqFloor` lifts and
    // the serving loop's next wave derives over the foreign value.
    // Flag-gated: the OFF arm keeps today's silent flip byte-for-byte
    // (the residual is self-healing there and the timing delta is not a
    // recorded acceptance — see the Phase-2 PR's Flags).
    const shadowTouched = getServerExecutionConfig()
      ? [...keys.entries()]
        .filter(([key]) => this.#shadowedForeignSeqs.has(key))
        .map(([, address]) => address)
      : [];
    const shouldNotifyShadowSubscribers = shadowTouched.length > 0 &&
      this.#hasNotificationSubscribers();
    const shouldNotifyShadowSinks = shadowTouched.length > 0 &&
      this.#hasSinkSubscribers(shadowTouched);
    const shadowBefore = shouldNotifyShadowSubscribers
      ? Differential.checkout(
        this,
        shadowTouched.map(({ id, scope, scopeKey }) =>
          snapshotState(this, id, scope, scopeKey)
        ),
        this.#scopeKeyIdentity(),
      )
      : undefined;
    for (const { id, scope, scopeKey } of keys.values()) {
      const record = this.#record(id, scope, undefined, scopeKey);
      const pendingIndexes = record.pending.flatMap((entry, index) =>
        entry.localSeq === localSeq ? [index] : []
      );
      if (pendingIndexes.length === 0) {
        logger.warn?.(
          `confirmPending: no pending entry for localSeq=${localSeq} on ${id}`,
        );
        continue;
      }
      const firstPendingIndex = pendingIndexes[0]!;
      const lastPendingIndex = pendingIndexes[pendingIndexes.length - 1]!;
      const pending = record.pending[lastPendingIndex]!;
      const previousConfirmed = record.confirmed;
      let promoted: ConfirmedVersion | undefined;
      let reusedSuffix: PendingMaterializedPrefix[] | undefined;

      const previousWave = record.confirmed.seq === applied.seq
        ? previousConfirmed.localWavePromotion
        : undefined;
      if (
        coverClass === "derived" &&
        (record.confirmed.seq < applied.seq || previousWave !== undefined)
      ) {
        // One wave can accept several local contributions to this document.
        // Their shared seq covers all of them only after each has promoted.
        const base = previousWave ? previousWave.base : previousConfirmed.value;
        const entries = [
          ...(previousWave?.entries ?? []),
          ...pendingIndexes.map((index) => record.pending[index]),
        ].sort((left, right) => left.localSeq - right.localSeq);
        let value = base;
        for (const entry of entries) {
          value = applyPendingVersion(value, entry, {
            space: this.#space,
            id,
            scope,
          });
        }
        promoted = confirmedVersion(applied.seq, value, coverClass);
        const lastApplied = entries.at(-1)!.localSeq;
        const earlierPending = record.pending.some((entry) =>
          entry.localSeq !== localSeq && entry.localSeq < lastApplied
        );
        promoted.localWavePromotion = earlierPending
          ? { base, entries }
          : { base: value, entries: [] };
      } else if (record.confirmed.seq < applied.seq) {
        if (firstPendingIndex === 0) {
          const prefix = materializedVersionThroughPending(
            record,
            { space: this.#space, id, scope },
            lastPendingIndex + 1,
          );
          const cache = ensurePendingMaterializationCache(record);
          promoted = confirmedVersion(
            applied.seq,
            prefix.value,
            coverClass,
          );
          promoted.transactionValue = prefix.transactionValue;
          if (cache.confirmed === previousConfirmed) {
            reusedSuffix = cache.prefixes.slice(lastPendingIndex + 1);
          }
        } else {
          promoted = confirmedVersion(
            applied.seq,
            applyPendingVersion(record.confirmed.value, pending, {
              space: this.#space,
              id,
              scope,
            }),
            coverClass,
          );
        }
      }

      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );

      if (promoted) {
        record.confirmed = promoted;
        record.materialized = reusedSuffix && reusedSuffix.length > 0
          ? {
            confirmed: promoted,
            prefixes: reusedSuffix,
          }
          : undefined;
        continue;
      }

      dropMaterializedSuffix(record, firstPendingIndex);
    }

    // The shadow-flip notification (see the checkout above): compare the
    // post-removal view and notify exactly the docs whose foreign value
    // just became visible. Same pattern as `#applySessionSync()`'s integrate
    // notification.
    if (shadowBefore !== undefined) {
      const changes = shadowBefore.compare(this);
      if ([...changes].length > 0) {
        this.#subscription.next({
          type: "integrate",
          space: this.#space,
          changes,
        } as StorageNotification);
        if (shouldNotifyShadowSinks) {
          this.#notifySinks(changes);
        }
      }
    } else if (shouldNotifyShadowSinks) {
      this.#notifySinksForIds(shadowTouched);
    }
    // The wake (see the field doc): fired on the flip regardless of
    // notification subscribers AND regardless of a value diff — an
    // echo-equal flip still lifts `unappliedForeignSeqFloor`, which is
    // the state the serving loop's clamped wait is parked on. Guarded:
    // the observer is externally installed (SpaceServer), and a throw
    // here would abort the caller's settlement loop over parked
    // accepts mid-batch — some confirmed, others already deleted from
    // the parked set with unresolved whenApplied waiters (same
    // containment posture as notifySinksForIds' per-subscriber guard).
    if (shadowTouched.length > 0) {
      try {
        this.shadowFlipObserver?.();
      } catch (error) {
        logger.error("shadow-flip-observer-error", () => [
          "shadowFlipObserver threw during promotion",
          error,
        ]);
      }
    }
  }

  #dropPending(localSeq: number): void {
    // A drop can LIFT the shadow floor without a promotion (review
    // thread r3739416417): a rejected/rolled-back own write emptying a
    // shadowed doc's pending set makes the foreign value visible and
    // prunes the floor lazily — but only confirmPending fired the
    // serving loop's wake, so a quiet clamped space stayed asleep
    // until the input-wait timeout. Fire the same flag-gated wake when
    // the drop empties a shadowed doc's pending set.
    let shadowLifted = false;
    for (const [key, record] of this.#docs.entries()) {
      const firstPendingIndex = record.pending.findIndex((entry) =>
        entry.localSeq === localSeq
      );
      if (firstPendingIndex === -1) {
        continue;
      }
      record.pending = record.pending.filter((entry) =>
        entry.localSeq !== localSeq
      );
      dropMaterializedSuffix(record, firstPendingIndex);
      const promotion = record.confirmed.localWavePromotion;
      const lastApplied = promotion?.entries.at(-1)?.localSeq;
      if (
        promotion && lastApplied !== undefined &&
        !record.pending.some((entry) => entry.localSeq < lastApplied)
      ) {
        record.confirmed.localWavePromotion = {
          base: record.confirmed.value,
          entries: [],
        };
      }
      if (
        record.pending.length === 0 && this.#shadowedForeignSeqs.has(key)
      ) {
        shadowLifted = true;
      }
    }
    if (shadowLifted && getServerExecutionConfig()) {
      try {
        this.shadowFlipObserver?.();
      } catch (error) {
        logger.error("shadow-flip-observer-error", () => [
          "shadowFlipObserver threw during a pending drop",
          error,
        ]);
      }
    }
  }

  #visibleVersion(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
    explicit?: ScopeKey,
  ): {
    record: DocumentRecord;
    version: MaterializedVersion;
  } | undefined {
    const record = this.#docs.get(
      docKey(id, this.instanceKey(scope, identity, explicit)),
    );
    if (!record) {
      return undefined;
    }
    return {
      record,
      version: materializedVersionThroughPending(record, {
        space: this.#space,
        id,
        scope,
      }),
    };
  }

  #visibleValue(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): FabricValue | undefined {
    const visible = this.#visibleVersion(id, scope, identity);
    if (!visible) {
      return undefined;
    }
    return transactionValueForVersion(visible.version);
  }

  /**
   * Helper for the read entry points, which serves an instance this
   * replica holds no record for from the store read-through, when one is
   * installed. A record already present — confirmed content or a pending
   * own write — is left as it is, and so is an absence the store reported
   * earlier: `integrateStoreWrites()` is what moves either. A scope the
   * identity cannot resolve keys by name, which no store address
   * matches, so it is not served here either.
   */
  #readThroughOnMiss(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
    explicit?: ScopeKey,
  ): void {
    if (this.#frameApplyDepth > 0) return;
    const read = this.#storeReadThrough();
    if (read === undefined) return;
    const instance = this.instanceKey(scope, identity, explicit);
    if (!isScopeKey(instance)) return;
    const key = docKey(id, instance);
    if (this.#docs.has(key) || this.#storeAbsences.has(key)) return;
    const upsert = read({ id, scopeKey: instance });
    if (upsert === undefined) return;
    this.#integrateReadThrough([upsert], "integrate");
  }

  /**
   * Helper for `pull()`, which reads every root this replica does not
   * hold from the store read-through and integrates the results as one
   * `pull` frame, the notification a first load owes its subscribers. A
   * root already held, or read absent earlier, is not read again: the
   * feed's refresh (`integrateStoreWrites()`) is what moves a held
   * record, the way a session's watch moves a covered selector, and a
   * re-sync of one is answered from the replica.
   */
  #pullFromStore(
    read: StoreReadThrough,
    entries: [WatchAddress, SchemaPathSelector | undefined][],
  ): void {
    const upserts: SessionSyncUpsert[] = [];
    for (const [address] of entries) {
      const id = address.id as URI;
      // A scope the identity cannot resolve keys by its name, which names
      // no store row: the store would read the name as the space scope and
      // hand back the wrong document, so such an entry is not read.
      const instance = this.instanceKey(
        address.scope,
        undefined,
        address.scopeKey,
      );
      if (!isScopeKey(instance)) continue;
      const key = docKey(id, instance);
      if (this.#docs.has(key) || this.#storeAbsences.has(key)) continue;
      const upsert = read({ id, scopeKey: instance });
      if (upsert !== undefined) upserts.push(upsert);
    }
    if (upserts.length === 0) return;
    this.#integrateReadThrough(upserts, "pull");
  }

  /**
   * Helper for the read-through paths, which integrates store reads as an
   * inbound frame through the ordinary session-sync apply step, so the
   * confirmed records, the delivered set, the shadow bookkeeping, and the
   * change notifications all take exactly the shape a pushed frame gives
   * them. An address the store holds nothing at — a `deleted` entry at
   * seq 0, which no session frame ever carries — is kept out of the
   * frame and remembered in `#storeAbsences` instead; a document read
   * present clears that memory. A read at the seq of the last delivery
   * this replica absorbed for the instance is kept out of the frame too:
   * the content under a delivered seq cannot differ, so integrating it
   * again would only re-validate and re-notify what the replica holds.
   * The confirmed seq is not that judge: a commit of the replica's own
   * write promotes its record to the commit's seq with the value it
   * materialized locally, and the store's document at that seq may hold
   * more — content the engine merged in beside a mergeable write — so
   * the first read at a seq no delivery has reached integrates.
   */
  #integrateReadThrough(
    upserts: SessionSyncUpsert[],
    type: "pull" | "integrate",
  ): void {
    // Whether a read moves the replica at all; the absence memory is kept
    // as a side effect.
    const moves = (upsert: SessionSyncUpsert): boolean => {
      const key = docKey(
        upsert.id as URI,
        this.instanceKey(upsert.scope, undefined, upsert.scopeKey),
      );
      if (upsert.deleted === true && upsert.seq === 0) {
        this.#storeAbsences.add(key);
        return false;
      }
      this.#storeAbsences.delete(key);
      const delivered = this.#delivered.get(key);
      return delivered === undefined || delivered.seq !== upsert.seq ||
        delivered.deleted !== (upsert.deleted === true);
    };
    const roots = upserts.filter(moves);
    if (roots.length === 0) return;
    const read = this.#storeReadThrough();
    const frame = read === undefined
      ? roots
      : this.#withSchemaDependencies(read, roots).filter(moves);
    const seqs = frame.map((upsert) => upsert.seq);
    this.#applySessionSync({
      type: "sync",
      fromSeq: Math.min(...seqs),
      toSeq: Math.max(...seqs),
      upserts: frame,
      removes: [],
    }, type);
  }

  /**
   * Helper for `#integrateReadThrough()`, which completes a frame of store
   * reads with the schema documents they reference: every `cid:` hash in a
   * document's link positions and in its `schema` metadata member, and in
   * a schema document's own refs, that this replica does not already hold
   * verified is read from the store and added to the frame, to a fixpoint.
   * The delivery guarantee the frame validator enforces is that a
   * document's refs resolve within the delivered set; a session's server
   * walks those references for it, and this is the same chase for a frame
   * read directly. A malformed metadata member names nothing here; the
   * validator quarantines the document for it.
   */
  #withSchemaDependencies(
    read: StoreReadThrough,
    upserts: SessionSyncUpsert[],
  ): SessionSyncUpsert[] {
    const frame = [...upserts];
    const inFrame = new Set(frame.map((upsert) => upsert.id));
    // The hashes a document in the frame obliges it to hold: the
    // document's `schema` metadata member and, for a schema document, its
    // own refs, or otherwise its link positions. Verification is the
    // validator's, not this chase's: a schema-shaped document's refs are
    // followed whether or not it is the document its id names, as its
    // arrival will be judged.
    const obligationsOf = (upsert: SessionSyncUpsert): Set<string> => {
      const hashes = new Set<string>();
      if (upsert.deleted === true || !isObjectNotArray(upsert.doc)) {
        return hashes;
      }
      const metadata = classifySchemaMeta(upsert.doc);
      if (metadata.kind === "malformed") return hashes;
      for (const hash of schemaMetaRefHashes(metadata)) hashes.add(hash);
      if (upsert.id.startsWith("cid:")) {
        const value = (upsert.doc as { value?: unknown }).value;
        if (isSubschema(value)) {
          for (const hash of collectExternalSchemaRefHashes(value)) {
            hashes.add(hash);
          }
        }
      } else {
        mapLinkSchemas(upsert.doc as FabricValue, (schema) => {
          for (
            const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
          ) {
            hashes.add(hash);
          }
          return schema;
        });
      }
      return hashes;
    };
    const roots = new Set<string>();
    for (const upsert of upserts) {
      for (const hash of obligationsOf(upsert)) roots.add(hash);
    }
    walkSchemaDocumentClosure({
      roots,
      load: (hash, walk) => {
        const id = `cid:${hash}` as URI;
        if (inFrame.has(id) || this.isContentAddressedDocPersisted(hash)) {
          return { kind: "settled" };
        }
        inFrame.add(id);
        const dependency = read({ id, scopeKey: "space" as ScopeKey });
        if (dependency === undefined) return undefined;
        frame.push(dependency);
        for (const next of obligationsOf(dependency)) walk.follow(next);
        return { kind: "settled" };
      },
    });
    return frame;
  }

  #getState(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
    explicit?: ScopeKey,
  ): Revision<State> | undefined {
    const visible = this.#visibleVersion(id, scope, identity, explicit);
    if (!visible) {
      return undefined;
    }
    const value = transactionValueForVersion(visible.version);
    if (value === undefined) {
      return undefined;
    }
    return {
      the: DOCUMENT_MIME,
      of: id,
      is: value,
      scope: normalizeCellScope(scope),
      // The explicit instance rides the state ONLY when the caller named
      // one, so the differential keys and addresses it per instance; an
      // own-identity read's state is byte-identical to before.
      ...(explicit !== undefined ? { scopeKey: explicit } : {}),
      since: visible.record.confirmed.seq,
    } as Revision<State>;
  }

  #visibleDocument(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): EntityDocument | undefined {
    return this.#visibleVersion(id, scope, identity)?.version.value;
  }

  #notifySinks(changes: IMergedChanges): void {
    const touched = new Map<string, LocalDocAddress>();
    for (const change of changes) {
      const id = change.address.id as URI;
      const scope = change.address.scope;
      const scopeKey = change.address.scopeKey;
      touched.set(
        this.#docKeyOf({ id, scope, scopeKey }),
        scopeKey === undefined ? { id, scope } : { id, scope, scopeKey },
      );
    }
    this.#notifySinksForIds(touched.values());
  }

  #notifySinksForIds(
    entries: Iterable<LocalDocAddress>,
  ): void {
    for (const { id, scope, scopeKey } of entries) {
      const current = this.#visibleVersion(id, scope, undefined, scopeKey)
        ?.version.value;
      for (
        const callback
          of this.#sinks.get(this.#docKeyOf({ id, scope, scopeKey })) ??
            []
      ) {
        try {
          callback(current);
        } catch (error) {
          logger.error("sink-error", () => [`storage sink failed: ${error}`]);
        }
      }
    }
  }

  #hasNotificationSubscribers(): boolean {
    const candidate = this.#subscription as IStorageSubscription & {
      hasSubscribers?: () => boolean;
    };
    if (typeof candidate.hasSubscribers === "function") {
      return candidate.hasSubscribers();
    }
    return true;
  }

  #hasSinkSubscribers(
    entries: Iterable<LocalDocAddress>,
  ): boolean {
    for (const entry of entries) {
      if ((this.#sinks.get(this.#docKeyOf(entry))?.size ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  #memoizedSessionHandle(): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    if (this.#closed) {
      return Promise.reject(new Error("memory replica closed"));
    }
    // The owed session remount, consumed at the memoization point — the one
    // place every read and commit passes through on its way to a session.
    this.#consumeOwedSessionRemount();
    if (this.#sessionHandle === undefined) {
      // Defer the factory call until after #sessionHandle is installed. Session
      // setup can synchronously re-enter provider work (notably home-space ACL
      // bootstrap); calling the factory inline leaves a window where that work
      // starts a second mount with the same explicit session id and revokes the
      // first mount before it can commit.
      const handle = Promise.resolve().then(() => {
        this.#assertActiveRoute();
        return this.#createSession();
      }).then(
        async (resolved) => {
          try {
            this.#assertActiveRoute();
          } catch (error) {
            await resolved.client.close();
            throw error;
          }
          this.#sessionClient = resolved.client;
          this.#sessionSession = resolved.session;
          this.#lastAuthorizationError = null;
          this.#onAccessChange?.(undefined);
          this.#cancelAccessLoss?.();
          this.#cancelAccessLoss = resolved.session.subscribeAccessLoss(
            (error) => {
              if (!this.#closed && this.#sessionSession === resolved.session) {
                this.#onAccessChange?.(error);
              }
            },
          );
          // Session replacement resets the marker epoch: markers for the
          // parked accepts' localSeqs can never arrive from the fresh
          // session, so apply them immediately (the same rule as consumer
          // teardown). Promotion consumes the pending overlays, so the
          // authoritative reinstall sync that follows replaces — never
          // double-applies — their contribution.
          resolved.session.onSessionReplaced = () => {
            this.#publishViewPlans([]);
            this.#applyParkedAcceptsNow();
            // A replaced session rejected its outstanding commits; queued
            // event intents re-submit under fresh localSeqs (the target's
            // eventId dedupe keeps a landed original sound — events.md §5).
            this.#eventAppendQueue?.kick();
          };
          // A reconnect declares what this replica holds, so the server
          // re-delivers exactly what it lacks (see `holdings`).
          resolved.session.holdingsProvider = () => this.holdings();
          return resolved;
        },
      ).catch((error) => {
        if (this.#sessionHandle === handle) {
          this.#sessionHandle = undefined;
          if (
            !this.#closed && error instanceof Error &&
            error.name === "AuthorizationError" &&
            (error as { retriable?: unknown }).retriable !== true
          ) this.#onAccessChange?.(error);
        }
        throw error;
      });
      this.#sessionHandle = handle;
    }
    return this.#sessionHandle;
  }
}

const snapshotState = (
  replica: SpaceReplica,
  id: URI,
  scope?: CellScope,
  scopeKey?: ScopeKey,
): State => {
  return replica.get({
    id,
    type: DOCUMENT_MIME,
    path: [],
    scope,
    ...(scopeKey !== undefined ? { scopeKey } : {}),
  }) ??
    ({
      the: DOCUMENT_MIME,
      of: id,
      scope: normalizeCellScope(scope),
      ...(scopeKey !== undefined ? { scopeKey } : {}),
    } as State);
};

const toConnectionError = (error: unknown): IConnectionError =>
  ({
    name: "ConnectionError",
    message: error instanceof Error ? error.message : String(error),
    address: "",
    cause: {
      name: "SystemError",
      message: error instanceof Error ? error.message : String(error),
      code: 500,
    },
  }) as IConnectionError;

// Preserve a real AuthorizationError (name, message, and the server's retriable
// marker) instead of flattening it to a generic ConnectionError, so a caller can
// tell an authorization denial apart from a transport failure. Everything else
// remains a ConnectionError.
const toPullError = (error: unknown): PullError => {
  if (!(error instanceof Error) || error.name !== "AuthorizationError") {
    return toConnectionError(error);
  }
  const details = error as unknown as {
    retriable?: unknown;
    permanentEvidence?: unknown;
    aclRevision?: unknown;
  };
  return ({
    name: "AuthorizationError",
    message: error.message,
    ...(details.retriable === true ? { retriable: true } : {}),
    ...(details.permanentEvidence === true ? { permanentEvidence: true } : {}),
    ...(typeof details.aclRevision === "number"
      ? { aclRevision: details.aclRevision }
      : {}),
  }) as unknown as IAuthorizationError;
};

// Rebuild a throwable Error from a stored AuthorizationError result so `synced()`
// rejects with a proper Error instance a caller can match on by name.
const authorizationErrorToThrow = (error: IAuthorizationError): Error => {
  const details = error as unknown as {
    permanentEvidence?: unknown;
    aclRevision?: unknown;
  };
  return Object.assign(new Error(error.message), {
    name: "AuthorizationError",
    ...(details.permanentEvidence === true ? { permanentEvidence: true } : {}),
    ...(typeof details.aclRevision === "number"
      ? { aclRevision: details.aclRevision }
      : {}),
  });
};

const toRejectedError = (
  error: unknown,
  commit: ClientCommit,
  space: MemorySpace,
): StorageTransactionRejected => {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error
    ? error.name
    : (error as { name?: unknown })?.name;
  if (name === "StorageTransactionInconsistent") {
    return error as IStorageTransactionInconsistent;
  }
  // `error` may be a primitive or null — never throw while normalizing a
  // commit failure, that would mask the real rejection.
  const precondition = (error as { precondition?: unknown })?.precondition;
  if (
    name === "PreconditionFailedError" &&
    (precondition === "origin-committed" || precondition === "receipt-exists")
  ) {
    return {
      name: "PreconditionFailedError",
      message,
      precondition,
    } as IPreconditionFailedError;
  }
  if (
    name === "ConflictError" ||
    message.includes("stale confirmed read") ||
    message.includes("pending dependency")
  ) {
    const retryAfterSeq = (error as { retryAfterSeq?: unknown })?.retryAfterSeq;
    const readyToRetry = (error as { readyToRetry?: unknown })?.readyToRetry;
    // Scoped descriptors cross current protocol boundaries structurally.
    // Message-only errors retain default-scope recovery for every named read.
    const toConflicts = (details: unknown): IConflictError["conflict"][] => {
      const { of, scope } = (details ?? {}) as {
        of?: unknown;
        scope?: unknown;
      };
      return typeof of === "string"
        ? [{
          space,
          the: DOCUMENT_MIME,
          of: of as Entity,
          ...(isCellScope(scope) ? { scope } : {}),
        }]
        : [];
    };
    const structuredConflicts = (error as { conflicts?: unknown })?.conflicts;
    let conflicts = Array.isArray(structuredConflicts)
      ? structuredConflicts.flatMap(toConflicts)
      : [];
    if (conflicts.length === 0) {
      conflicts = toConflicts((error as { conflict?: unknown })?.conflict);
    }
    if (conflicts.length === 0) {
      conflicts = toConflicts(error);
    }
    if (conflicts.length === 0) {
      conflicts = Array.from(
        message.matchAll(/stale confirmed read: (\S+) at seq/g),
        (match) => toConflicts({ of: match[1] })[0],
      );
    }
    const firstOperation = commit.operations?.[0];
    const firstOperationId = firstOperation && "id" in firstOperation
      ? firstOperation.id
      : undefined;
    const rejected: IConflictError = {
      name: "ConflictError",
      message,
      transaction: commit,
      // The singular descriptor remains the first conflict for consumers of
      // the legacy interface. `the` remains a placeholder.
      conflict: conflicts[0] ?? {
        space,
        the: DOCUMENT_MIME,
        of: (firstOperationId ?? "of:unknown") as Entity,
      },
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
    // retryAfterSeq is carried for diagnostics; retry gating is by caughtUpLocalSeq
    // (readyToRetry), and downstream only uses retryAfterSeq's presence to mark
    // the conflict retryable.
    if (typeof retryAfterSeq === "number") {
      rejected.retryAfterSeq = retryAfterSeq;
    }
    if (typeof readyToRetry === "function") {
      rejected.readyToRetry = () => Promise.resolve(readyToRetry.call(error));
    }
    return rejected;
  }

  // Preserve the wire name the server chose instead of collapsing it into a
  // generic TransactionError. Every classifier downstream — the scheduler's
  // `classifyCommitDisposition`, `Runtime.editWithRetry`'s retry allow-list
  // (storage/rejection.ts) — keys off `error.name`, so flattening here destroys
  // the only evidence they have. The names:
  //
  //  - `RowLabelCommitError`: a deterministic commit-time row-label refusal
  //    (memory/v2/sqlite/commit-eval.ts), classified terminal by
  //    `isTerminalRejection`. Re-running recomputes the identical refused
  //    write, so the doomed re-runs would only starve sibling commits.
  //  - `ProtocolError`: the server refused the commit rather than losing it.
  //    `#validateAclCommit` (memory/v2/server.ts) raises it both for the SHAPE
  //    of an ACL commit (not a whole-document `set`; more than one operation)
  //    and for its VALUE (malformed, or retaining no concrete OWNER). Neither
  //    changes when the identical function is re-run. The name is broader than
  //    those two, though: the engine also raises it for conditions that are a
  //    function of server log state — a pending read whose basis is ahead of
  //    the log, a commit-replay mismatch — and those CAN converge. Treating the
  //    whole name as terminal is a deliberate over-approximation, open on
  //    #5259 pending a decision on marking retriability at the throw site.
  //  - `AuthorizationError`: the server evaluated the request and denied it.
  //    The server's own `retriable` marker (a session-open anti-replay race a
  //    fresh handshake heals) rides along, as it already does on the pull path
  //    (`toPullError` above) — it is what distinguishes the one denial that can
  //    clear from the ones that cannot.
  //  - `SessionError`: the commit was routed to a session the server no longer
  //    knows. Classified TERMINAL by the retry allow-list — not because the
  //    commit was evaluated (it was not), but because nothing on the retry path
  //    remounts the session: `#memoizedSessionHandle()` memoizes the mount
  //    and clears it on close, and (since 2026-08-26) when the space's ACL
  //    CHANGES — which a
  //    commit retry is not. The name still has to survive normalization here,
  //    or the caller sees a generic TransactionError instead of the real cause.
  //  - `InvalidMessageError`: a frame off the wire would not decode, and the
  //    client's `rejectPending` sweep (memory/v2/client.ts `onMessage`) rejected
  //    every in-flight request with it — including this commit, which may never
  //    have been evaluated. That makes it a liveness failure, classified
  //    retryable by `isTransientCommitRejection`; the name has to survive here
  //    or that classification can never fire. It is raised client-side, so
  //    unlike the names above it is not part of the server's wire contract.
  //
  // The memory server MUST keep emitting the server-side names unchanged
  // (server.ts `transact` catch, and the ACL validation errors it returns
  // directly).
  if (
    name === "RowLabelCommitError" || name === "ProtocolError" ||
    name === "AuthorizationError" || name === "SessionError" ||
    name === "InvalidMessageError"
  ) {
    const retriable = (error as { retriable?: unknown })?.retriable === true;
    const permanentEvidence =
      (error as { permanentEvidence?: unknown })?.permanentEvidence === true;
    const aclRevision = (error as { aclRevision?: unknown })?.aclRevision;
    return {
      name,
      message,
      ...(retriable ? { retriable: true } : {}),
      ...(permanentEvidence ? { permanentEvidence: true } : {}),
      ...(typeof aclRevision === "number" ? { aclRevision } : {}),
      cause: { name: "SystemError", message, code: 500 },
      transaction: commit,
    } as unknown as TransactionError;
  }

  return {
    name: "TransactionError",
    message,
    cause: {
      name: "SystemError",
      message,
      code: 500,
    },
    transaction: commit,
  } as unknown as TransactionError;
};
