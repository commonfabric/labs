import * as FS from "@std/fs";
import * as Path from "@std/path";

import type { FabricValue } from "@commonfabric/api";
import {
  cloneIfNecessary,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/utils/logger";
import { StagedMap } from "@commonfabric/utils/staged-map";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";

import { InboxStore } from "../inbox-store.ts";

import {
  aclDocId,
  ANYONE_USER,
  type Capability,
  hasConcreteOwner,
  isACL,
  isCapable,
} from "../acl.ts";
import {
  canResolveScopeKey,
  type CellScope,
  type ClientCommit,
  type ClientMessage,
  type CommitClass,
  commitPreconditionValueHash,
  dbNeedsColumnProvenance,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityIdListRequest,
  type EntityIdListResult,
  type EntityIdLookupRequest,
  type EntityIdLookupResult,
  type EntitySnapshot,
  EventAppendDuplicateError,
  eventAttentionEntryKey,
  eventAttentionIndexKey,
  type EventAttentionIndexValue,
  type EventAttentionResolveRequest,
  type EventAttentionResolveResult,
  getMemoryProtocolFlags,
  getOwnWriteEchoConfig,
  getServerExecutionConfig,
  type GraphQuery,
  type GraphQueryRequest,
  type GraphQueryResult,
  type HelloMessage,
  isScopeKey,
  MAX_ENTITY_ID_PAGE_SIZE,
  type MemoryProtocolFlags,
  type OpCursor,
  type Operation,
  type OperationFieldQueryRequest,
  type OperationFieldQueryResult,
  type OperationWatchSpec,
  parseMemoryProtocolFlags,
  parseSessionReadCeiling,
  resolveScopeKey,
  type ResponseMessage,
  type ScopeKey,
  scopeKeyApplicableTo,
  type ScopeKeyIdentity,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  type ServerMessage,
  type SessionAckRequest,
  type SessionAckResult,
  type SessionEffectMessage,
  type SessionHolding,
  type SessionOpenAuthMetadata,
  type SessionOpenChallenge,
  type SessionOpenRequest,
  type SessionOpenResult,
  type SessionReadCeiling,
  type SessionRevokedMessage,
  type SessionSync,
  type SessionViewHandle,
  type SessionViewInterest,
  type SqliteDbRef,
  type SqliteNamedParamsWire,
  type SqliteNativeRow,
  type SqliteParamsWire,
  type SqliteQueryRequest,
  type SqliteQueryWireResult,
  type SqliteRegisterDiskSourceRequest,
  type SqliteRegisterDiskSourceResult,
  type SqliteResultColumn,
  sqliteRowToWire,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventsDocValue,
  type StreamLinkRef,
  type TransactRequest,
  type V2Error,
  type ViewInterest,
  type ViewPlan,
  type ViewQuery,
  type WatchAddRequest,
  type WatchAddResult,
  type WatchSetRequest,
  type WatchSetResult,
  type WatchSpec,
  type WireMemoryProtocolFlags,
} from "../v2.ts";
import { classifyCommitTelemetry } from "./commit-telemetry.ts";
import * as Engine from "./engine.ts";
import {
  executeInvite,
  type InviteRequest,
  type InviteResult,
} from "./invites.ts";
import { SpaceInviteError } from "../space-invites.ts";
import { isGenesisRoot, readGenesisRoot } from "./genesis-root.ts";
import {
  executionLeaseHolder,
  liveExecutionLeaseHolder,
} from "./execution-lease.ts";
import { respondToHello } from "./handshake.ts";
import {
  createDefaultOperationCodecRegistry,
  type OperationCodecRegistry,
} from "./operation-codec.ts";
import {
  cloneTrackedGraphState,
  createQueryEvaluationCache,
  extendTrackedGraph,
  fromDirtyKey,
  fromDocKey,
  isGraphQueryCoveredByState,
  type QueryDocKey,
  type QueryEvaluationCache,
  type QueryEvaluationCacheDiagnostics,
  queryEvaluationCacheDiagnostics,
  queryGraph,
  type QueryGraphReuseContext,
  type QueryTraversalStats,
  refreshTrackedGraph,
  type SlowestQueryRoot,
  stageTrackedGraphState,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "./query.ts";
import {
  buildDiffSync,
  buildFullSync,
  cacheKeyForEntity,
  compareSyncAddress,
  groupedQueries,
  holdingsToCacheEntries,
  isEmptySync,
  mergeWatchesById,
  sameSnapshot,
  sameWatchSpec,
  type SessionCacheEntry,
  toCacheEntry,
  toWireRemove,
  toWireUpsert,
  trackedIdsFromEntries,
} from "./server-sync.ts";
import { authorizationError } from "./session-open-auth.ts";
import { SessionRegistry, type SessionState } from "./session-registry.ts";
import {
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "./sqlite/column-origin.ts";
import { RowLabelCommitError } from "./sqlite/commit-eval.ts";
import { DiskSourceRegistry } from "./sqlite/disk-source.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
} from "./sqlite/exec.ts";
import { assertReadOnly } from "./sqlite/guard.ts";
import { ReadConnectionPool } from "./sqlite/read-pool.ts";
import type { TableSchema } from "./sqlite/schema.ts";
import {
  resolveSpaceStoreDirUrl,
  resolveSpaceStoreUrl,
} from "./storage-path.ts";
import { compressServerMessageSchemas } from "./sync-schema-table.ts";
import { type ArmedTurn, armTurn } from "./turn.ts";
import {
  parseViewInterests,
  parseViewQuery,
  viewWatches,
} from "./view-interest.ts";

export { SessionRegistry } from "./session-registry.ts";

/**
 * A space DID pinned tightly enough to name a store. `isDID`
 * (`@commonfabric/identity/did`) answers only whether a string is a DID, so it
 * admits a method-specific identifier of any shape, and this string goes on to
 * name a file on disk. The narrower question is the one
 * `foreignWriteAuthorityFor` has to ask.
 */
const WELL_FORMED_SPACE_DID = /^did:[^:]+:[^:]+$/;

// Global OTel API tracer. Interface-only and inert when no provider is
// registered, so this is a no-op unless the host process (toolshed) has an
// OTLP SDK installed. Spans created here are purely additive observability and
// do not affect write/fan-out behavior.
const tracer = trace.getTracer("memory-server", "1.0.0");
const operationMeter = metrics.getMeter("memory-server", "1.0.0");
const operationApplyCount = operationMeter.createCounter(
  "ct.memory.operation.applies",
  { description: "Accepted apply-op operations." },
);
const operationTransformSuffix = operationMeter.createHistogram(
  "ct.memory.operation.transform_suffix",
  { description: "Canonical operations transformed over per apply-op." },
);
const operationPayloadBytes = operationMeter.createHistogram(
  "ct.memory.operation.payload_bytes",
  { description: "Encoded submitted apply-op payload bytes." },
);
const operationIntegrationDuration = operationMeter.createHistogram(
  "ct.memory.operation.integration.duration_ms",
  { description: "Memory commit persistence time for apply-op commits." },
);
const operationResetCount = operationMeter.createCounter(
  "ct.memory.operation.resets",
  { description: "Operation snapshots requiring canonical client reset." },
);
const operationCodecFailureCount = operationMeter.createCounter(
  "ct.memory.operation.codec_failures",
  { description: "Operation codec or history failures by error class." },
);
const operationActiveWatchCount = operationMeter.createHistogram(
  "ct.memory.operation.active_watches",
  { description: "Active operation watches observed during sync assembly." },
);

/**
 * Timing-only logger. It never logs — the statistics behind `time()` are
 * recorded whether or not a logger is enabled, and `/api/health/stats`
 * reports them as the `timingStats.memory` block — so the frames a
 * connection handles are measurable on a deployed server without turning
 * anything on.
 */
const timing = getLogger("memory", { enabled: false });

const SUBSCRIPTION_REFRESH_DELAY_MS = 5;
const MIN_REFRESH_QUEUE_DRAIN_WAIT_MS = 500;
// Operations slower than this are recorded for `/api/health/stats`. The
// default suits a deployment, where the interesting operations are the ones
// well past it; a local investigation of a fast machine sets
// `CF_SLOW_QUERY_THRESHOLD_MS` lower — to `0` to record every one — so the
// buffer carries the per-operation root, read and upsert counts for
// operations the default would leave invisible.
const SLOW_QUERY_THRESHOLD_MS = (() => {
  try {
    const raw = typeof Deno !== "undefined"
      ? Deno.env.get("CF_SLOW_QUERY_THRESHOLD_MS")
      : undefined;
    const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
  } catch {
    return 100;
  }
})();
const QUERY_EVALUATION_CACHE_MAX_SPACES = 8;
// ~5 board-scale corpora (a full board evaluation retains ~6k entities).
// Entity count is the byte proxy: what an entry holds alive is its cloned
// state's parsed documents, which scale with the entities delivered.
const QUERY_EVALUATION_CACHE_BUDGET = 32_768;
const SLOW_QUERY_BUFFER_SIZE = 100;
const DEFAULT_SESSION_OPEN_CHALLENGE_TTL_SECONDS = 300;
const SESSION_OPEN_CHALLENGE_BYTES = 32;
// SQLite resource caps (mirror the `sqlite.query` wire-parse caps; also applied
// to the folded-write path, which is parsed loosely as part of a `transact`).
const MAX_SQLITE_SQL_LENGTH = 100_000;
const MAX_SQLITE_TABLES = 256;

// Memory v2 wire values may omit scope for default-space entries; storage and
// watch keys need an explicit declared scope.
const declaredScope = (scope: CellScope | undefined): CellScope =>
  scope ?? "space";

export type SlowQuery = {
  timestamp: number;
  elapsed: number;
  operation: string;
  space: string;
  roots?: number;
  watches?: number;

  /** session.watch.refresh only: the refreshed session's principal, so a
   * slow refresh names whose watch set cost it. */
  principal?: string;

  /** transact only: milliseconds the commit waited for the space
   * publication lock before evaluation began. Flush passes hold the same
   * lock, so a large value is head-of-line blocking behind fan-out rather
   * than the commit's own cost. */
  lockWaitMs?: number;

  /** transact only: the commit's operation count. */
  operations?: number;

  /** transact only: the commit's confirmed read count. */
  readsConfirmed?: number;

  /** transact only: the commit's pending read count. */
  readsPending?: number;

  /** transact only: "ok", the response error's name (a rejected commit
   * that took this long is at least as interesting as an applied one), or
   * "threw" when evaluation raised instead of responding. */
  outcome?: string;

  /** Query and watch operations: how many roots the request's evaluations
   * visited across every branch group. Zero means no root was traversed,
   * which has two causes and the same consequence: the evaluation cache
   * served the request, or the session's existing graph already covered
   * every added root. Either way none of the elapsed time was traversal,
   * so a slow entry reporting zero spent it somewhere else — assembling
   * the response, or attaching operation fields.
   *
   * `session.watch.refresh` carries none of these fields. It re-evaluates
   * by dirty document rather than by root, so it has no roots to
   * attribute; absent is the honest answer there, not zero. */
  rootsVisited?: number;

  /** Query and watch operations: summed elapsed time of those root visits.
   * Against the entry's own `elapsed` this is the share of the request
   * that traversal accounts for; the remainder is entity assembly,
   * schema-closure staging, operation-field attachment, and (for
   * `watch.add`, whose `elapsed` runs through response assembly) mapping
   * the delivered snapshots to the wire. */
  rootsElapsedMs?: number;

  /** Query and watch operations: engine document reads across every branch
   * group. Unlike `rootsVisited`, this exposes roots whose declarations fan
   * out over many documents, and unlike `slowestRoot.reads`, it accounts for
   * the complete request rather than only its costliest root. */
  managerReads?: number;

  /** watch.add and watch.refresh: changed entity snapshots delivered to the
   * client. This is the delivered-width counterpart to `watches` and
   * `managerReads`: a wide traversal that yields few upserts is repeated
   * server work, while a wide frame is also transport and client-ingest
   * work. A refresh that produced no upserts answers with an empty catch-up
   * and is not recorded, so a refresh entry never reports zero here. */
  upserts?: number;

  /** Query and watch operations: the costliest single root, which is what
   * a watch COUNT cannot say. A `watch.add` unions the roots of every
   * watch it carries, so 78 watches and 5,377 watches are the same
   * measurement until this names which declaration spent the time.
   *
   * The root that paid, not necessarily the root to blame — see
   * {@link SlowestQueryRoot} for why overlapping closures charge whichever
   * root ran first, and what to check before calling one the cause. */
  slowestRoot?: SlowestQueryRoot;
};

/** The root attribution accumulated across one request's branch groups. */
type RootAttribution = {
  rootsVisited: number;
  rootsElapsedMs: number;
  managerReads: number;
  slowestRoot?: SlowestQueryRoot;
};

const createRootAttribution = (): RootAttribution => ({
  rootsVisited: 0,
  rootsElapsedMs: 0,
  managerReads: 0,
});

/**
 * Fold one evaluation's root attribution into a request's running total.
 *
 * The counts sum because a request's groups are evaluated in sequence; the
 * slowest root is a max rather than a sum, because it names one place in
 * one query and merging two would name neither.
 */
const foldRootAttribution = (
  into: RootAttribution,
  stats: QueryTraversalStats,
): void => {
  into.rootsVisited += stats.rootsVisited;
  into.rootsElapsedMs += stats.rootsElapsedMs;
  into.managerReads += stats.managerReads;
  if (
    stats.slowestRoot !== undefined &&
    (into.slowestRoot === undefined ||
      stats.slowestRoot.elapsedMs > into.slowestRoot.elapsedMs)
  ) {
    into.slowestRoot = stats.slowestRoot;
  }
};

/** The attribution for a request that evaluated exactly one query. */
const rootAttributionOf = (stats: QueryTraversalStats): RootAttribution => {
  const attribution = createRootAttribution();
  foldRootAttribution(attribution, stats);
  return attribution;
};

const slowQueries: SlowQuery[] = [];

const recordSlowQuery = (entry: SlowQuery): void => {
  slowQueries.push(entry);
  if (slowQueries.length > SLOW_QUERY_BUFFER_SIZE) {
    slowQueries.shift();
  }
};

const recordSlowQueryDuration = (
  operation: string,
  space: string,
  startedAt: number,
  details: Omit<SlowQuery, "timestamp" | "elapsed" | "operation" | "space"> =
    {},
): void => {
  const elapsed = performance.now() - startedAt;
  if (elapsed <= SLOW_QUERY_THRESHOLD_MS) {
    return;
  }
  recordSlowQuery({
    timestamp: Date.now(),
    elapsed,
    operation,
    space,
    ...details,
  });
};

/** Returns the last N slow query, watch, and commit operations — those over
 * `CF_SLOW_QUERY_THRESHOLD_MS`, 100 ms unless set. */
export const getSlowQueries = (): readonly SlowQuery[] => slowQueries;

/**
 * Push-priority counters (server-execution v2 Phase 6 — protocol.md §3's
 * "push priority" contract): when one flush batch carries BOTH derived
 * novelty and other content, sessions subscribed to the derived docs are
 * evaluated and sent first; everything else follows. The counters make
 * the reorder observable (testing.md §4: gates assert counters, not
 * logs):
 * - `mixedFlushes` — flush batches where the split was non-vacuous
 *   (both a prioritized and a follower group existed);
 * - `prioritizedSessions` / `followerSessions` — sessions EVALUATED in
 *   each group across those mixed batches (`refreshDirty`'s per-phase
 *   count — a session is counted whether or not its evaluation produced
 *   a frame, so a quiet co-space session counts as a follower). These
 *   are an ORDERING witness, not a delivered-frame metric.
 * All-zero in the OFF arm by construction: only the serving loop's wave
 * commits classify dirty keys as derived. Registered by the Server
 * instance (the newest live server is reported; close() withdraws it);
 * surfaced under the health route's `servingLoop.push` block.
 */
export type PushPriorityStats = {
  prioritizedSessions: number;
  followerSessions: number;
  mixedFlushes: number;
};

/** Live servers' push-priority providers in construction order; a server
 * withdraws its own on close(), so the newest LIVE server is the one
 * reported, and closing one hands back to the one registered before it. */
const pushPriorityStatsProviders: (() => PushPriorityStats)[] = [];

export const getPushPriorityStats = (): PushPriorityStats | undefined =>
  pushPriorityStatsProviders.at(-1)?.();

/** Withdraw one server's health-route provider, leaving every other's. */
const withdrawProvider = <T>(providers: T[], provider: T): void => {
  const index = providers.indexOf(provider);
  if (index >= 0) providers.splice(index, 1);
};

/** Every open engine's decoded-document cache, keyed by space, under the
 * total budget this server holds across them: `bytes` is the total retained
 * now and `totalBudgetEvictions` what holding it has cost, lifetime. */
export type DocumentCachesDiagnostics = {
  totalBudgetBytes: number;
  bytes: number;
  totalBudgetEvictions: number;
  spaces: Record<string, Engine.DocumentCacheDiagnostics>;
};

/**
 * Default bound on decoded documents retained across every space one Server
 * serves: twice the per-space default, room for two active corpora at their
 * full per-space allowance (a Topics-board page load retains 17.7 MB; see
 * DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES for the sizing). Held by the server's
 * `Engine.DocumentCacheCoordinator` on every cache access, least recently
 * used space first and oldest entries first within it. Per Server instance,
 * not per process: the toolshed hosts one memory server, so in deployment
 * this is the process's bound, while a second live server (tests construct
 * them) keeps its own total under its own budget.
 */
export const DOCUMENT_CACHE_TOTAL_BUDGET_BYTES = 256 * 1024 * 1024;

/** Live servers' providers in construction order; a server removes its own
 * on close(), so the newest LIVE server is always the one reported. */
const documentCachesDiagnosticsProviders: (() => DocumentCachesDiagnostics)[] =
  [];

/** The co-hosted memory server's document-cache counters for the health
 * route — the most recently constructed server still open; undefined when
 * none is. */
export const getDocumentCachesDiagnostics = ():
  | DocumentCachesDiagnostics
  | undefined => documentCachesDiagnosticsProviders.at(-1)?.();

const randomHex = (bytes: number): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const toError = (
  name: string,
  message: string,
  details: Pick<V2Error, "permanentEvidence" | "aclRevision"> = {},
): V2Error => ({
  name,
  message,
  ...details,
});

const toPreconditionFailedError = (
  error: unknown,
  message: string,
): V2Error | undefined => {
  if (
    error instanceof Engine.PreconditionFailedError ||
    (error instanceof Error &&
      error.name === "PreconditionFailedError" &&
      typeof (error as { precondition?: unknown }).precondition === "string")
  ) {
    return {
      name: "PreconditionFailedError",
      message,
      precondition: (error as unknown as { precondition: string })
        .precondition,
    };
  }
  return undefined;
};

export type MemoryAclMode = "off" | "observe" | "enforce";

type AclState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; acl: Record<string, Capability | undefined> };

const commitTouchesAclDoc = (
  operations: readonly Operation[],
  space: string,
): boolean => {
  const id = aclDocId(space);
  return operations.some((operation) =>
    "id" in operation && operation.id === id
  );
};

/** Deterministic, collision-resistant-enough token for a filename component
 *  (FNV-1a 32-bit + length). Used to derive cell-db file names from (space,id). */
function hashToken(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}${s.length.toString(16)}`;
}

/** Extract the table name from a SQLite "no such table: <name>" error, or
 *  undefined if the error is not that shape. SQLite reports the *unquoted* name,
 *  which may itself contain spaces or dots (e.g. `CREATE TABLE "my notes"`), so
 *  we take the whole remainder of the message. Only a real `main.`/`temp.`
 *  schema prefix is stripped — a bare table literally named `a.b` is preserved,
 *  so the result matches a declared-table key exactly. */
function missingTableName(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /no such table:\s*(.+)$/i.exec(message);
  if (match === null) return undefined;
  const ref = match[1].trim();
  const dot = ref.indexOf(".");
  if (dot !== -1) {
    const schema = ref.slice(0, dot).toLowerCase();
    if (schema === "main" || schema === "temp") return ref.slice(dot + 1);
  }
  return ref;
}

/** Whether `name` matches a declared table key, using the SAME case-folding
 *  SQLite uses to resolve table identifiers: **ASCII-only** (A–Z ↔ a–z). A
 *  full-Unicode `toLowerCase()` would over-match — SQLite treats e.g. `Ü` and
 *  `ü` as distinct tables, so folding them together here would mask a genuine
 *  "no such table" error as an empty result. */
function isDeclaredTable(
  tables: Record<string, unknown> | undefined,
  name: string,
): boolean {
  if (tables === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(tables, name)) return true;
  const asciiFold = (value: string): string =>
    value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const lowered = asciiFold(name);
  for (const key of Object.keys(tables)) {
    if (asciiFold(key) === lowered) return true;
  }
  return false;
}

const respondTypedError = <Result>(
  requestId: string,
  error: V2Error,
): ResponseMessage<Result> => ({
  type: "response",
  requestId,
  error,
});

const sessionKey = (space: string, sessionId: string): string =>
  `${space}\0${sessionId}`;

type Send = (message: ServerMessage) => void;

type PublishTransactVerdict = (
  response: ResponseMessage<Engine.AppliedCommit>,
) => void;

type TransactDecision = {
  response: ResponseMessage<Engine.AppliedCommit>;
  postCommit?: () => Promise<void>;
};

type SessionOpenAuthContext = {
  audience: string;
  challenge: SessionOpenChallenge;
};

type SessionOpenChallengeState = SessionOpenChallenge & {
  consumed: boolean;
};

type SessionHandle = {
  space: string;
  sessionId: string;
};

/** Kind of the LAST operation an origin commit applied to a doc — decides the
 * own-write echo shape at flush (CT-1965): `set`/`delete` heads are elided
 * (the writer provably holds their outcome), `patch` heads ride the frame as
 * full post-apply documents. */
type DirtyOp = "set" | "patch" | "delete";

type DirtyOrigin = {
  sessionId: string;
  seq: number;
  op: DirtyOp;
};

/**
 * One admitted commit as the serving loop's in-process feed sees it
 * (serving-loop.md §1 planes (b)/(d)): class + holder for the self-echo
 * skip and activation routing, the written doc INSTANCES for dirtiness.
 * Ids and scope keys only — values travel on the ordinary session-sync
 * path; this record never crosses the wire.
 */
export type AdmittedCommitNotice = {
  space: string;
  seq: number;
  class: CommitClass;
  holder?: string;
  sessionId: string;
  writes: Array<{ id: string; scopeKey: ScopeKey }>;

  /** Phase 3 (events-down): the commit's admitted event appends —
   * serving-loop.md §3's "if c.class == event-append: enqueue for
   * handler processing" classification input. Ids only (the sidecar
   * doc instance + the eventId); the SpaceServer's drain reads the
   * stamped entries from the store, never from this record. */
  eventAppends?: Array<{
    id: string;
    scopeKey: ScopeKey;
    eventId: string;
    retryOf?: string;
  }>;

  /** The EXPLICIT WARM REQUEST (serving-loop.md §1's third activation
   * trigger; RULED 2026-08-21): set only by the serving-side
   * provisioning path — a wave's foreign provisioning batch reported
   * through `noteExecutorCommit` — when this authored commit STAGED
   * SETUP into another space (protocol.md §2b's sanctioned crossing).
   * The host activates the target on it even with no live session and
   * no events (the deliberate, scoped signal the notify-only admission
   * hook is not — T11.Q7's write-alone parking stays as designed), and
   * the target's serving loop takes the commit's `writes` as
   * identity-less warm demand so the staged setup derives. Never set on
   * client transacts, system writes, or event deliveries. */
  warm?: true;
};

/**
 * The ExecutorHost's in-process observer (serving-loop.md §1's wiring):
 * plane (b) — `commitAdmitted` is the admission-side activation hook (an
 * authored admission into a space with no live SpaceServer notifies the
 * host; never a poll) — and the activation-on-session-open trigger
 * (`sessionOpened`). Observer errors are shielded: admission never fails
 * because an observer threw.
 */
export type ServerExecutionObserver = {
  commitAdmitted?: (notice: AdmittedCommitNotice) => void;
  sessionOpened?: (space: string) => void;

  /** A session's WATCH SET changed (`session.watch.set` / `.add`) —
   * demand may have changed (server-execution v2 fan-out stage B, design
   * §A's arrival re-arm: a demander's FIRST watch of a root whose nodes
   * already narrowed must reach the SpaceServer's demand pass without
   * waiting for the next input; the session-open trigger fires before
   * any watch exists). Edge-triggered and cheap; the host wakes an
   * active loop's demand pass, nothing else. `principal` is the changed
   * session's principal (undefined for anonymous) so the host can DROP
   * the serving runtime's OWN loopback session — the service principal's
   * tracked-set growth is the serving graph's own reads, not client
   * demand, and must neither wake the loop nor count in `pushGrowthWakes`
   * (W1 review MINOR-4). */
  demandChanged?: (
    space: string,
    reason?: DemandChangeReason,
    principal?: string,
  ) => void;
};

/** (d′): why `demandChanged` fired — `watch` (the pre-existing
 * `session.watch.set` / `.add` sites) or `push-growth` (design §2.8 flag
 * 2: a push pass GREW a session's tracked set — a newly reachable doc
 * entered the closure through the tracker's re-traversal). */
export type DemandChangeReason = "watch" | "push-growth";

/** (d′): one row of a space's demand set (design §2.1's
 * definition; the successor of `watchedRootsForSpace`'s rows): an
 * INSTANCE a client session TRACKS, with the demanding pair. */
export type DemandedInstanceRow = {
  id: string;
  scope: CellScope;
  scopeKey: ScopeKey;
  identity?: { readonly principal?: string; readonly sessionId?: string };

  /** True when the row is a watch ROOT of its session (the structure
   * load's input, unchanged in scope — design §2.8 flag 4). */
  root: boolean;
};

/**
 * One client session's share of a space's demand set: its
 * `DemandedInstanceRow`s, keyed by instance key (`toDirtyKey(id, scopeKey)`).
 * The server replaces the object whenever the session's demand may have
 * changed and hands back the same object while it has not, so a consumer that
 * kept the object it last read can tell an unchanged session by identity
 * alone. Neither the object nor its rows may be mutated.
 */
export type SessionDemand = {
  /** The session the rows belong to. */
  readonly sessionId: string;

  /** The session's rows, keyed by instance key. */
  readonly rows: ReadonlyMap<string, Readonly<DemandedInstanceRow>>;
};

const addOperationWatchTrackedIds = (
  trackedIds: Set<string>,
  watches: readonly WatchSpec[],
  identity: { principal?: string; sessionId: string },
): Set<string> => {
  for (const watch of watches) {
    if (watch.kind === "operation") {
      trackedIds.add(
        toDirtyKey(
          watch.query.id,
          resolveScopeKey(watch.query.scope, identity),
        ),
      );
    }
  }
  return trackedIds;
};

const graphWatchRoots = (watches: readonly WatchSpec[]) =>
  watches
    .filter((watch) => watch.kind !== "operation")
    .flatMap((watch) => watch.query.roots);

type ReadAdmissionRoot = {
  id: string;
  scope?: CellScope;
  entityScopeKey?: ScopeKey;
};

const watchReadRoots = (
  watches: readonly WatchSpec[],
): ReadAdmissionRoot[] => {
  const roots: ReadAdmissionRoot[] = [];
  for (const watch of watches) {
    if (watch.kind === "operation") {
      roots.push({
        id: watch.query.id,
        ...(watch.query.scope === undefined
          ? {}
          : { scope: watch.query.scope }),
      });
    } else {
      roots.push(...watch.query.roots);
    }
  }
  return roots;
};

const graphWatchRootQueries = (watches: readonly WatchSpec[]) =>
  watches
    .filter((watch) => watch.kind !== "operation")
    .flatMap((watch) =>
      watch.query.roots.map((root) => ({
        branch: watch.query.branch ?? "",
        root,
      }))
    );

class Connection {
  #ready = false;
  #closed = false;
  #syncSchemaTable = false;
  #stableExpressionResultIds = false;
  #sessions = new Map<string, SessionHandle>();
  #sessionOpenChallenge: SessionOpenChallengeState | null = null;
  #receiving: Promise<void> = Promise.resolve();
  #pendingReceives = 0;
  #receiveIdle: PromiseWithResolvers<void> | null = null;

  readonly #server: Server;
  readonly #sendRaw: Send;

  constructor(
    readonly id: string,
    server: Server,
    sendRaw: Send,
  ) {
    this.#server = server;
    this.#sendRaw = sendRaw;
  }

  #send(message: ServerMessage): void {
    const schemaStart = performance.now();
    const prepared = this.#syncSchemaTable
      ? compressServerMessageSchemas(message)
      : message;
    timing.time(schemaStart, "memory", "response", "prepareSchemas");
    const sendStart = performance.now();
    this.#sendRaw(prepared);
    timing.time(sendStart, "memory", "response", "sendRaw");
  }

  /** Whether the peer declared the expression result identity contract. */
  get stableExpressionResultIds(): boolean {
    return this.#stableExpressionResultIds;
  }

  hasSession(space: string, sessionId: string): boolean {
    return this.#sessions.has(sessionKey(space, sessionId));
  }

  #shouldSuppressSessionSend(
    space: string,
    sessionId: string,
  ): boolean {
    return this.#server.isAclActive() &&
      (!this.hasSession(space, sessionId) ||
        !this.#server.isSessionAttached(space, sessionId, this.id));
  }

  #sendSessionResponse(
    space: string,
    sessionId: string,
    requestId: string,
    response: ServerMessage,
  ): void {
    if (this.#shouldSuppressSessionSend(space, sessionId)) {
      // session/revoked is a lifecycle notification; it does not settle the
      // generic request promise. Always pair suppression of an in-flight RPC
      // result with a typed response error carrying the original request id.
      this.#send({
        type: "response",
        requestId,
        error: toError(
          "SessionRevokedError",
          "Session was revoked while the request was in flight",
        ),
      });
      return;
    }
    this.#send(response);
  }

  addSession(space: string, sessionId: string): void {
    const key = sessionKey(space, sessionId);
    if (this.#sessions.has(key)) {
      return;
    }
    this.#sessions.set(key, { space, sessionId });
  }

  revokeSession(
    space: string,
    sessionId: string,
    reason: SessionRevokedMessage["reason"],
  ): void {
    const key = sessionKey(space, sessionId);
    if (!this.#sessions.delete(key) || this.#closed) {
      return;
    }
    this.#send({
      type: "session/revoked",
      space,
      sessionId,
      reason,
    });
  }

  issueSessionOpenAuth(): SessionOpenAuthMetadata {
    const sessionOpen = this.#server.sessionOpenHandshake();
    this.#sessionOpenChallenge = {
      ...sessionOpen.challenge,
      consumed: false,
    };
    return sessionOpen;
  }

  sessionOpenAuthContext(message: SessionOpenRequest): SessionOpenAuthContext {
    const audience = this.#server.sessionOpenAudience();
    const invocation = isFabricPlainObject(message.invocation)
      ? message.invocation
      : null;
    if (invocation === null || typeof invocation.aud !== "string") {
      throw authorizationError("memory session.open requires audience");
    }
    if (invocation.aud !== audience) {
      throw authorizationError("memory session.open audience mismatch");
    }

    const challenge = this.#sessionOpenChallenge;
    if (challenge === null) {
      throw authorizationError("memory session.open challenge unavailable", {
        retriable: true,
      });
    }
    if (challenge.consumed) {
      throw authorizationError("memory session.open challenge already used", {
        retriable: true,
      });
    }
    if (challenge.expiresAt <= this.#server.nowSeconds()) {
      throw authorizationError("memory session.open challenge expired", {
        retriable: true,
      });
    }
    if (typeof invocation.challenge !== "string") {
      throw authorizationError("memory session.open requires challenge");
    }
    if (invocation.challenge !== challenge.value) {
      throw authorizationError("memory session.open challenge mismatch", {
        retriable: true,
      });
    }

    return {
      audience,
      challenge: {
        value: challenge.value,
        expiresAt: challenge.expiresAt,
      },
    };
  }

  consumeSessionOpenChallenge(challenge: SessionOpenChallenge): void {
    if (this.#sessionOpenChallenge === null) {
      return;
    }
    if (this.#sessionOpenChallenge.value === challenge.value) {
      this.#sessionOpenChallenge.consumed = true;
    }
  }

  async receive(payload: string): Promise<void> {
    this.#pendingReceives += 1;
    // A connection handles its frames one at a time, so a frame's cost has
    // two halves that are fixed at opposite ends of the stack: how long it
    // WAITED behind the frames already in flight (`memory/frame/queue`), and
    // how long it took once it started (`memory/frame/handle`). Only the
    // second is the frame's own work — a queue time that tracks the handle
    // time of whatever precedes it is head-of-line blocking, and the fix is
    // to make that other frame cheaper rather than this one.
    const arrivedAt = performance.now();
    try {
      const previous = this.#receiving;
      const current = previous.catch(() => undefined).then(async () => {
        const startedAt = performance.now();
        timing.time(arrivedAt, startedAt, "memory", "frame", "queue");
        try {
          await this.#receiveOrdered(payload);
        } finally {
          timing.time(startedAt, "memory", "frame", "handle");
        }
      });
      this.#receiving = current.then(() => undefined, () => undefined);
      return await current;
    } finally {
      this.#pendingReceives = Math.max(0, this.#pendingReceives - 1);
      if (this.#pendingReceives === 0) {
        this.#receiveIdle?.resolve();
        this.#receiveIdle = null;
      }
    }
  }

  hasPendingReceives(): boolean {
    return this.#pendingReceives > 0;
  }

  async waitForReceiveQueueToDrain(deadlineMs: number): Promise<boolean> {
    while (this.#pendingReceives > 0) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      if (this.#receiveIdle === null) {
        this.#receiveIdle = Promise.withResolvers<void>();
      }
      const idle = this.#receiveIdle.promise.then(() => true);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), remainingMs);
      });
      const drained = await Promise.race([idle, timeout]);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (!drained) {
        return this.#pendingReceives === 0;
      }
    }
    return true;
  }

  #requireSession(
    requestId: string,
    space: string,
    sessionId: string,
  ): boolean {
    if (this.hasSession(space, sessionId)) {
      return true;
    }
    this.#send({
      type: "response",
      requestId,
      error: toError(
        "SessionError",
        "Session is not open on this connection",
      ),
    });
    return false;
  }

  async #receiveOrdered(payload: string): Promise<void> {
    if (this.#closed) {
      return;
    }

    const parsed = parseClientMessage(payload);
    if (parsed === null) {
      this.#send({
        type: "response",
        requestId: "invalid",
        error: toError(
          "InvalidMessageError",
          "Unable to parse memory message",
        ),
      });
      return;
    }

    if (!this.#ready) {
      if (parsed.type !== "hello") {
        this.#send({
          type: "response",
          requestId: "handshake",
          error: toError("ProtocolError", "memory hello is required first"),
        });
        return;
      }
      const response = respondToHello(
        parsed,
        this.#server.memoryProtocolFlags(),
      );
      if (response.type === "hello.ok") {
        response.sessionOpen = this.issueSessionOpenAuth();
      }
      this.#send(response);
      if (response.type !== "hello.ok") {
        return;
      }
      const clientFlags = parseMemoryProtocolFlags(parsed.flags);
      const serverFlags = parseMemoryProtocolFlags(response.flags);
      this.#stableExpressionResultIds =
        clientFlags?.stableExpressionResultIds === true;
      this.#syncSchemaTable = clientFlags?.syncSchemaTableV2 === true &&
        serverFlags?.syncSchemaTableV2 === true;
      this.#ready = true;
      return;
    }

    switch (parsed.type) {
      case "hello":
        this.#send({
          type: "response",
          requestId: "handshake",
          error: toError("ProtocolError", "hello may only be sent once"),
        });
        return;
      case "session.open": {
        const response = await this.#server.openSession(parsed, this);
        if (response.ok?.sessionId) {
          this.addSession(parsed.space, response.ok.sessionId);
        }
        this.#send(response);
        return;
      }
      case "transact": {
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        // Publishing inside the per-space transaction lock makes the verdict
        // visible before any fan-out for the same space can acquire that lock.
        await this.#server.transact(parsed, (verdict) => {
          this.#send(verdict);
        });
        // A self-deauthorizing ACL commit defers the writer's terminal
        // session/revoked until after its verdict; deliver it now.
        this.#server.deliverDeferredSelfRevocation(
          parsed.space,
          parsed.sessionId,
        );
        return;
      }
      case "graph.query":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.graphQuery(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "op.query":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.operationFieldQuery(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "entity-id.list":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.listEntityIds(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "entity-id.exists":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.entityIdExists(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "sqlite.query":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.sqliteQuery(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "sqlite.register-disk-source":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.sqliteRegisterDiskSource(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "session.watch.set":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.watchSet(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "session.watch.add":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.watchAdd(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "session.ack":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.ackSession(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
      case "event.attention.resolve":
        if (
          !this.#requireSession(
            parsed.requestId,
            parsed.space,
            parsed.sessionId,
          )
        ) {
          return;
        }
        {
          const response = await this.#server.resolveEventAttention(parsed);
          this.#sendSessionResponse(
            parsed.space,
            parsed.sessionId,
            parsed.requestId,
            response,
          );
        }
        return;
    }
  }

  async refreshDirty(
    space: string,
    dirtyIds?: ReadonlySet<string>,
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
    // Push priority (Phase 6, protocol.md §3): when the flush batch
    // carries derived novelty, the fan-out runs this connection TWICE —
    // a "prioritized" phase over sessions subscribed to the derived
    // keys, then a "followers" phase over the rest — so derived frames
    // clear the whole serialized send chain ahead of bulk evaluation.
    // A session's single frame still carries its whole covered batch:
    // priority orders the chain, never frame content or catch-up-marker
    // semantics. Absent phase = today's single pass. Returns the number
    // of sessions this call evaluated (the split-vacuity witness).
    phase?: {
      derivedDirty: ReadonlySet<string>;
      group: "prioritized" | "followers";
    },
    publicationLocked = false,
  ): Promise<number> {
    if (this.#closed) {
      return 0;
    }

    let processed = 0;
    for (const { space: sessionSpace, sessionId } of this.#sessions.values()) {
      if (this.#closed) {
        return processed;
      }
      // A construction intentionally reuses one authenticated session id in
      // every space. Dirty refresh is still space-specific: syncing that id
      // through a connection mounted in another space would advance the real
      // target session's cursor, then send its effect down the wrong socket.
      if (sessionSpace !== space) {
        continue;
      }
      if (phase !== undefined) {
        // Membership is re-read per phase; a prioritized session keeps
        // tracking its delivered derived docs (trackedIds persist), so
        // the phases stay disjoint across the back-to-back calls.
        const prioritized = this.#server.sessionTracksAny(
          space,
          sessionId,
          phase.derivedDirty,
        );
        if (prioritized !== (phase.group === "prioritized")) {
          continue;
        }
      }
      processed += 1;
      let effect: SessionEffectMessage | null;
      try {
        effect = await this.#server.syncSessionForConnection(
          space,
          sessionId,
          dirtyIds,
          dirtyOrigins,
          publicationLocked,
        );
      } catch (error) {
        // A refresh evaluation failure means one of two things: a bad
        // commit was accepted (the safeguards belong at the commit
        // boundary) or an administrator altered the database, which has
        // no reasonable handling. Log it — the diagnostic is the whole
        // response — skip this session's frame, and keep fanning out.
        // The failed pass may have partially advanced the session's
        // incremental tracking state (an earlier graph's entities, a
        // partly rebuilt tracker), so the session is marked for a full
        // re-evaluation: the next successful pass re-diffs everything
        // rather than trusting increments computed over the failure.
        console.error(
          `memory v2: watch refresh evaluation failed for session ${sessionId} in space ${space}; frame skipped`,
          error,
        );
        this.#server.markSessionForFullResync(space, sessionId);
        continue;
      }
      if (this.#closed) {
        // Evaluation already advanced the session cache past this content;
        // roll the delivery state back so a later pass (or a resumed
        // session) recomputes and redelivers it.
        if (effect !== null) {
          this.#server.rollbackUndeliveredSync(space, sessionId, effect);
        }
        return processed;
      }
      // ACL revocation can remove the session while watch evaluation awaits
      // its engine. Never emit the already-computed effect after that removal
      // (the session is gone from the registry — nothing to roll back into).
      if (this.#shouldSuppressSessionSend(space, sessionId)) {
        continue;
      }
      if (effect !== null) {
        try {
          this.#send(effect);
        } catch (error) {
          // The send boundary is the commit point for sync state. A send
          // that throws is the only delivery failure visible in-process, so
          // no buffering pretends otherwise (a dying socket loses frames
          // silently either way — reconnect hardening owns that case):
          // roll back exactly what evaluation advanced, so the next pass
          // recomputes and redelivers from durable state (CT-1927 review,
          // rounds 5-6).
          this.#server.rollbackUndeliveredSync(space, sessionId, effect);
          console.warn(
            "memory v2: sync send failed; delivery state rolled back for recomputation",
            error,
          );
        }
      }
    }
    return processed;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const { space, sessionId } of this.#sessions.values()) {
      this.#server.detachSession(space, sessionId, this.id);
    }
    this.#server.disconnect(this);
  }
}

/**
 * The engine opener a test supplies in place of `Server`'s own step, which
 * opens the engine for a space or hands back the one already open. It
 * receives that step as `open`, so it can pause before it or fail in its
 * stead, and returns what that step returns.
 */
export type EngineOpener = (
  space: string,
  open: (space: string) => Promise<Engine.Engine>,
) => Promise<Engine.Engine>;

/**
 * The memory v2 server. An instance accepts connections and serves the
 * session protocol over them — opening sessions, admitting transactions,
 * evaluating queries and watches, and fanning out sync frames as spaces
 * change — with one engine per space it serves. Each space's access control
 * is evaluated per the `acl` option: gating every request in `enforce` mode,
 * only counting would-denies in `observe` mode, and not at all in `off` mode,
 * the default. It also reads and writes documents directly, outside any
 * session, for in-process callers such as blob uploads.
 */
export class Server {
  #sessions: SessionRegistry;
  #connections = new Map<string, Connection>();

  /** Whole-evaluation caches, one per space (see QueryEvaluationCache in
   * query.ts for the sharing, purity, and seq-rotation rules), held for at
   * most QUERY_EVALUATION_CACHE_MAX_SPACES spaces in LRU order. */
  #queryEvaluationCaches = new Map<string, QueryEvaluationCache>();

  #engines = new Map<string, Promise<Engine.Engine>>();

  /**
   * The resolved-engine index for the synchronous cross-engine lease lookup
   * in `#liveCoHostedLeaseSpaceFor()`; `#openEngineInner()` populates it.
   */
  #resolvedEngines = new Map<string, Engine.Engine>();

  /**
   * The opener a test supplies around the engine open; `undefined` means the
   * server's own.
   */
  #engineOpener: EngineOpener | undefined = undefined;

  /** Holds `documentCacheTotalBudgetBytes` across this server's engines and
   * keeps their recency; every engine this server opens reports to it. */
  #documentCacheCoordinator: Engine.DocumentCacheCoordinator;

  /**
   * Synthesized session id for direct out-of-band document writes, such as
   * blob uploads.
   */
  #directSessionId = `server:${crypto.randomUUID()}`;

  /** Local sequence counter for the synthesized direct-write session. */
  #directLocalSeq = 0;

  #dirtySpaces = new Set<string>();
  #dirtyDocsBySpace = new Map<string, Set<string>>();
  #dirtyOriginsBySpace = new Map<string, Map<string, DirtyOrigin>>();

  /**
   * Push priority (`protocol.md` §3): the subset of each space's dirty keys
   * whose _latest_ novelty came from a `derived` commit — a _parallel_
   * annotation, deliberately not a `DirtyOrigin` field: the origin record is
   * load-bearing for own-echo suppression and is _deleted_ on mixed
   * provenance, which must not erase the priority class. Populated only by
   * `noteExecutorCommit()` (the wave commits), consumed and cleared with the
   * dirty batch, re-merged by the requeue arm on fan-out failure. A key later
   * re-dirtied by an authored commit stays in the set — the doc still carries
   * derived novelty the subscriber has not seen, and priority is best-effort
   * ordering, never a correctness gate.
   */
  #derivedDirtyBySpace = new Map<string, Set<string>>();

  #pushPriorityStats: PushPriorityStats = {
    prioritizedSessions: 0,
    followerSessions: 0,
    mixedFlushes: 0,
  };
  #refreshTurn: ArmedTurn | null = null;
  #refreshing: Promise<void> | null = null;

  /**
   * The publication turn per space, which transactions and fan-out share. A
   * verdict is sent while its transaction owns the turn, so a sync frame
   * cannot expose the decision first. Different spaces retain independent
   * turns.
   */
  #publicationBySpace = new Map<string, Promise<void>>();

  #lastRefreshDurationMs = 0;

  /**
   * The `ExecutorHost`'s in-process observer (`serving-loop.md` §1, planes (b)
   * and (d)); `undefined` until a host attaches. One observer: there is one
   * host per process.
   */
  #serverExecutionObserver: ServerExecutionObserver | undefined;

  /**
   * Additive watchers of the same admission hook, independent of the host's
   * observer above: any number attach, and each sees every notice.
   */
  #admittedCommitWatchers = new Set<(notice: AdmittedCommitNotice) => void>();

  /**
   * Per-frame delivery record: the wire strips instance keys (frames carry
   * scope _names_), so a delivery rollback cannot recover _which_ instances a
   * frame carried from the frame alone — a lease holder's explicit foreign
   * instances would mis-resolve to its own. Keyed by the frame object
   * (in-process only, never serialized), populated at frame build, consumed by
   * `rollbackUndeliveredSync()`; a `WeakMap` so delivered frames cost nothing.
   */
  #deliveredFrameEntries = new WeakMap<SessionEffectMessage, {
    upserts: SessionCacheEntry[];
    removes: SessionCacheEntry[];
  }>();

  /**
   * Each session's share of its space's demand set, built on first read and
   * kept until `#touchDemand()` drops it. Every write to an input of
   * `#buildSessionDemand()` — the session's watches, views, delivered
   * entities, graph misses, and tracked set — touches the session, so an entry
   * present here is the one a fresh build would produce. Keyed by the
   * registry's object, which a reopen replaces, so a reopened session is built
   * afresh.
   */
  #sessionDemand = new WeakMap<SessionState, SessionDemand>();

  /** How many times `#buildSessionDemand()` has run, for a test to read. */
  #sessionDemandBuilds = 0;

  #store?: URL;
  #inboxStore?: Promise<InboxStore>;
  #operationCodecs: OperationCodecRegistry;

  /**
   * Injected on-disk SQLite sources, keyed by handle cell id. A registered id
   * is attached read-only from its descriptor path instead of the cell-derived
   * per-(space, id) file. In-memory only: a registration does not survive a
   * restart.
   */
  #diskSources = new DiskSourceRegistry();

  /**
   * Pooled read-only connections (keyed by canonical file path) for SQLite
   * reads — injected on-disk sources and cell-derived dbs alike run here,
   * unattached, instead of attach/detach-per-op on the engine connection.
   */
  #readPool = new ReadConnectionPool();

  /**
   * Schemas already created on the write path, keyed by `(space, id, schema)`.
   * `ensureTables()` (additive `CREATE TABLE IF NOT EXISTS` per declared
   * table) runs only the first time a given schema is seen for a cell-db, not
   * on every write. Bounded LRU; a miss (eviction or restart) just re-runs
   * `ensureTables()`, which is idempotent. Keyed by the full schema JSON so a
   * changed declaration re-ensures (additive migration) with no hash-collision
   * risk.
   */
  #ensuredSchemas = new Map<string, true>();

  #ensuredSchemasMax = 4096;

  constructor(
    readonly options: {
      sessions?: SessionRegistry;
      store?: URL;

      operationCodecs?: OperationCodecRegistry;

      /** Engine-owned interval for operation checkpoints and bounded retention. */
      operationCheckpointInterval?: number;

      /**
       * Coalescing delay for the batched subscription fan-out, in
       * milliseconds. `"manual"` never arms the refresh timer: dirty spaces
       * accumulate and fan out only through the explicit synchronization
       * points — `flushSessions()`, or `idle()`, which drains held fan-out
       * to keep its quiescence contract. This is the fan-out gate for
       * controlled-staleness tests, immune to fake-clock auto-advance,
       * which fires any armed timer regardless of its nominal delay. A
       * partial `flushSessions(spaces)` in manual mode leaves the other
       * dirty spaces held for the next explicit call.
       */
      subscriptionRefreshDelayMs?: number | "manual";

      /** Cross-space retained-entity budget for the query evaluation
       * caches (default QUERY_EVALUATION_CACHE_BUDGET). An entry's weight
       * is the entity count of the evaluation it retains — the proxy for
       * the parsed documents kept alive — and eviction removes the
       * least-recently-evaluated spaces' oldest entries until the total
       * fits. A single evaluation heavier than the whole budget is not
       * retained at all. */
      queryEvaluationCacheBudget?: number;

      /** Bounds for each space's decoded-document cache, handed to
       * Engine.open (see DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES there). */
      documentCacheBudgetBytes?: number;
      documentCacheMaxEntries?: number;

      /** Bound on decoded documents retained across every space this
       * server serves (default DOCUMENT_CACHE_TOTAL_BUDGET_BYTES; per
       * instance, see there), held least-recently-used space first. */
      documentCacheTotalBudgetBytes?: number;

      authorizeSessionOpen: (
        message: SessionOpenRequest,
        context: SessionOpenAuthContext,
      ) => Promise<string | undefined> | string | undefined;

      /**
       * Authentication data advertised in `hello.ok` and enforced for
       * `session.open` on this server.
       */
      sessionOpenAuth: {
        /** Audience value clients must sign into `session.open` as `aud`. */
        audience: string;

        /** How long a connection challenge may be used, in seconds. */
        challengeTtlSeconds?: number;

        /** Current unix time in seconds. Tests may inject this. */
        nowSeconds?: () => number;
      };

      /**
       * Space access control. `off` (default) preserves the historical
       * any-authenticated-session-may-do-anything behavior. `observe`
       * evaluates ordinary capability decisions, counts and logs
       * would-denies, but allows those decisions. Invalid ACL state and
       * fresh-space genesis violations remain hard failures. `enforce` denies
       * all capability shortfalls as well.
       *
       * Policy: a session principal has implicit OWNER on a space when it
       * IS the space DID or is listed in `serviceDids`; otherwise the
       * space's ACL document (entity id == the space DID, as managed by the
       * runner's `ACLManager` / `cf acl`) grants per-DID or `"*"`
       * capabilities. A missing ACL on a populated legacy space grants every
       * authenticated principal READ and WRITE (never OWNER). A fresh space
       * grants authenticated READ only: its first write must be a valid ACL
       * initialized by the space identity or a service DID.
       *
       * Requirements: session.open, queries, and watches need READ;
       * transact needs WRITE; ACL-document writes and disk-source
       * registration need OWNER. Enforcement is only meaningful when
       * `authorizeSessionOpen` is configured — without it sessions carry no
       * principal and only `"*"` grants can apply.
       */
      acl?: {
        mode: MemoryAclMode;
        serviceDids?: readonly string[];

        /**
         * Principals allowed to carry a SQLite query reader and whose
         * `session.open` may carry the delegated READ
         * binding `actingAs: "space-owner"` (OW31, READ side RULED
         * 2026-08-19). Such a session's READ-class capability decisions
         * resolve as the space's ACL OWNER — the user whose space it
         * is, resolved by the server from the ACL (the ruled
         * service-identity ACL read) — while WRITE/OWNER-class
         * requirements keep resolving against the ENVELOPE principal
         * (the binding grants no write path; served writes ride the
         * wave's §2b delegated carriage). Distinct from `serviceDids`
         * (the operator's OWNER-class list, whose semantics are
         * untouched): a delegating principal is NOT a service
         * principal, holds no implicit capability of its own, and may
         * NOT initialize a fresh space's genesis ACL. Under the
         * server-execution flag the toolshed lists its own process
         * identity here (the LT5 trust footing already carried by the
         * write plane's delegated actors); OFF the flag the list is
         * empty.
         */
        delegatingDids?: readonly string[];
      };
    },
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#store = options.store;
    this.#operationCodecs = options.operationCodecs ??
      createDefaultOperationCodecRegistry();
    // Every document-cache bound is checked here, where it is configured,
    // not at the first request that opens a space (Engine.open checks the
    // per-space pair again for its own callers) — and before this server
    // registers anything a throw would leave behind.
    Engine.validateDocumentCacheBounds({
      documentCacheBudgetBytes: options.documentCacheBudgetBytes,
      documentCacheMaxEntries: options.documentCacheMaxEntries,
      documentCacheTotalBudgetBytes: options.documentCacheTotalBudgetBytes,
    });
    this.#documentCacheCoordinator = new Engine.DocumentCacheCoordinator(
      options.documentCacheTotalBudgetBytes ??
        DOCUMENT_CACHE_TOTAL_BUDGET_BYTES,
    );
    // Module-level providers for the health route (push-priority counters,
    // Phase 6; document caches): the newest live server is reported, and
    // close() withdraws exactly this server's.
    pushPriorityStatsProviders.push(this.#pushPriorityStatsProvider);
    documentCachesDiagnosticsProviders.push(
      this.#documentCachesDiagnosticsProvider,
    );
  }

  /**
   * The engine opener a test may supply, the timer-driven refresh pass
   * and the per-space publication lock, which a test drives directly, the
   * registry's live sessions of one space, which a test inspects, the
   * demand-set build count and an uncached build, which a test compares the
   * kept demand set against, and the demand-set drop a write makes, which a
   * test applies through a session object of its choosing.
   */
  get accessForTestingOnly(): {
    engineOpener: EngineOpener | undefined;
    flushScheduledSessions(): Promise<void>;
    withSpacePublicationLock<T>(
      space: string,
      run: () => Promise<T>,
    ): Promise<T>;
    sessionsForSpace(space: string): SessionState[];
    readonly sessionDemandBuilds: number;
    buildSessionDemand(session: SessionState): SessionDemand;
    touchDemand(session: SessionState): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get engineOpener() {
        return outerThis.#engineOpener;
      },
      set engineOpener(value) {
        outerThis.#engineOpener = value;
      },
      flushScheduledSessions: () => this.#flushScheduledSessions(),
      withSpacePublicationLock: (space, run) =>
        this.#withSpacePublicationLock(space, run),
      sessionsForSpace: (space) => this.#sessions.sessionsForSpace(space),
      get sessionDemandBuilds() {
        return outerThis.#sessionDemandBuilds;
      },
      buildSessionDemand: (session) => this.#buildSessionDemand(session),
      touchDemand: (session) => this.#touchDemand(session),
    };
  }

  /** This server's health-route providers, kept so close() can withdraw
   * exactly them and no other server's. */
  #pushPriorityStatsProvider = () => this.pushPriorityStats();
  #documentCachesDiagnosticsProvider = () => this.documentCachesDiagnostics();

  /** Every open engine's document-cache counters, keyed by space. A peek:
   * nothing is opened by asking. */
  documentCachesDiagnostics(): DocumentCachesDiagnostics {
    const spaces: Record<string, Engine.DocumentCacheDiagnostics> = {};
    for (const [space, engine] of this.#resolvedEngines) {
      spaces[space] = Engine.documentCacheDiagnostics(engine);
    }
    const coordinator = this.#documentCacheCoordinator;
    return {
      totalBudgetBytes: coordinator.budgetBytes,
      bytes: coordinator.bytes,
      totalBudgetEvictions: coordinator.evictions,
      spaces,
    };
  }

  memoryProtocolFlags(): MemoryProtocolFlags {
    return {
      ...getMemoryProtocolFlags(),
      operationCodecs: this.#operationCodecs.ids(),
    };
  }

  /** A copy of the push-priority counters (Phase 6, protocol.md §3). */
  pushPriorityStats(): PushPriorityStats {
    return { ...this.#pushPriorityStats };
  }

  /** Whether the session currently tracks (has been delivered / watches)
   * ANY of `keys` — the flush loop's cheap admission gate, reused by the
   * push-priority partition (Phase 6). */
  sessionTracksAny(
    space: string,
    sessionId: string,
    keys: ReadonlySet<string>,
  ): boolean {
    const session = this.#sessions.get(space, sessionId);
    if (session === null) return false;
    for (const key of keys) {
      if (session.trackedIds.has(key)) return true;
    }
    return false;
  }

  /** Count one non-vacuous push-priority reorder (Phase 6). Called by the
   * connection's flush loop when a batch produced BOTH a prioritized and
   * a follower group. */
  notePushPrioritySplit(prioritized: number, followers: number): void {
    this.#pushPriorityStats.mixedFlushes += 1;
    this.#pushPriorityStats.prioritizedSessions += prioritized;
    this.#pushPriorityStats.followerSessions += followers;
  }

  nowSeconds(): number {
    return this.options.sessionOpenAuth.nowSeconds?.() ??
      Math.floor(Date.now() / 1000);
  }

  sessionOpenAudience(): string {
    return this.options.sessionOpenAuth.audience;
  }

  sessionOpenHandshake(): SessionOpenAuthMetadata {
    const ttl = this.options.sessionOpenAuth.challengeTtlSeconds ??
      DEFAULT_SESSION_OPEN_CHALLENGE_TTL_SECONDS;
    return {
      audience: this.sessionOpenAudience(),
      challenge: {
        value: randomHex(SESSION_OPEN_CHALLENGE_BYTES),
        expiresAt: this.nowSeconds() + ttl,
      },
    };
  }

  /** Counters for ACL decisions; `wouldDeny` is the observe-mode rollout
   *  signal (a nonzero value on a deployment means flipping to `enforce`
   *  would break that traffic). */
  readonly aclStats = { wouldDeny: 0, denied: 0 };

  /** space → (principal key → capability). Invalidated whenever a commit
   *  touches the space's ACL document. */
  #aclCapabilities = new Map<string, Map<string, Capability | null>>();

  #aclMode(): MemoryAclMode {
    return this.options.acl?.mode ?? "off";
  }

  #isServicePrincipal(principal: string): boolean {
    return this.options.acl?.serviceDids?.includes(principal) ?? false;
  }

  #isDelegatingPrincipal(principal: string): boolean {
    return this.options.acl?.delegatingDids?.includes(principal) ?? false;
  }

  /**
   * Resolve the acting principal a delegated READ binding stands for
   * (OW31; `SessionDescriptor.actingAs: "space-owner"`): the space's ACL
   * OWNER — the space DID itself when self-owned (every home space),
   * else the lexicographically first concrete OWNER (deterministic when
   * an ACL names several). A space with no valid concrete-owner ACL
   * binds nothing: the envelope principal's own capability applies
   * (fresh → READ, populated-legacy → WRITE, malformed → fail closed —
   * today's rules). This resolution IS the ruled "ACL can be read with
   * service identity": the server dereferences the ACL on the
   * delegating principal's behalf.
   */
  #resolveSpaceOwnerBinding(
    engine: Engine.Engine,
    space: string,
  ): string | undefined {
    const state = this.#aclState(engine, space);
    if (state.kind !== "valid") return undefined;
    if (state.acl[space] === "OWNER") return space;
    const owners = Object.entries(state.acl)
      .filter(([principal, capability]) =>
        principal !== ANYONE_USER && capability === "OWNER"
      )
      .map(([principal]) => principal)
      .sort();
    return owners[0];
  }

  /**
   * The space's resolved ACL OWNER, for the executor's server-side
   * space-root ensure (OW45 arm-B server-ensure stage 1, design PR
   * #6209 §4 option (b)): the ensure's creation run carries an
   * owner-resolved per-run CFC trust snapshot — the follow-up OW59's
   * Q3 caveat pre-named — and derives its home-space predicate from
   * the ACL (self-owned = home), because a serving runtime's
   * `userIdentityDID` is the SERVICE DID. This is the same resolution
   * the delegated READ binding uses ({@link #resolveSpaceOwnerBinding}),
   * exposed as a first-class read: it IS the ruled "ACL can be read
   * with service identity" (OW31, RULED 2026-08-19). `undefined` means
   * no valid concrete-owner ACL resolves (missing, invalid, retracted,
   * or ANYONE-only) — callers fail closed, never substitute the
   * service DID (OW53's ruled shape; `homeSpacePrincipalFor`'s
   * posture).
   */
  resolveSpaceOwner(
    engine: Engine.Engine,
    space: string,
  ): string | undefined {
    return this.#resolveSpaceOwnerBinding(engine, space);
  }

  #invalidateAclCapabilities(space: string): void {
    this.#aclCapabilities.delete(space);
  }

  #aclState(engine: Engine.Engine, space: string): AclState {
    const state = Engine.readState(engine, { id: aclDocId(space) });
    if (state === null) return { kind: "missing" };
    // A retracted ACL is not equivalent to a never-created ACL: treating the
    // tombstone as public would turn deletion into an authorization bypass.
    if (state.document === null) return { kind: "invalid" };
    const acl = state.document.value;
    if (!isACL(acl)) return { kind: "invalid" };
    const byPrincipal = acl as Record<string, Capability | undefined>;
    if (!hasConcreteOwner(byPrincipal)) return { kind: "invalid" };
    return { kind: "valid", acl: byPrincipal };
  }

  #resolveCapability(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
  ): Capability | null {
    if (
      principal !== undefined &&
      (principal === space || this.#isServicePrincipal(principal))
    ) {
      return "OWNER";
    }
    const state = this.#aclState(engine, space);
    if (state.kind === "valid") {
      return (principal !== undefined ? state.acl[principal] : undefined) ??
        state.acl[ANYONE_USER] ?? null;
    }
    if (state.kind === "missing" && principal !== undefined) {
      // Temporary pre-launch compatibility: populated spaces without an ACL
      // are public to authenticated principals. Empty spaces remain read-only
      // until their identity (or a service DID) writes a valid genesis ACL.
      return Engine.serverSeq(engine) === 0 ? "READ" : "WRITE";
    }
    // Malformed and ownerless ACLs fail closed. Implicit owners above may
    // still repair them explicitly.
    return null;
  }

  #capabilityFor(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
  ): Capability | null {
    const key = principal ?? "";
    let bySpace = this.#aclCapabilities.get(space);
    if (bySpace !== undefined && bySpace.has(key)) {
      return bySpace.get(key) ?? null;
    }
    const capability = this.#resolveCapability(engine, space, principal);
    if (bySpace === undefined) {
      bySpace = new Map();
      this.#aclCapabilities.set(space, bySpace);
    }
    bySpace.set(key, capability);
    return capability;
  }

  /** Evaluate the ACL policy for a message. Returns `null` when the message
   *  may proceed and a typed error when it must be rejected. In `observe`, an
   *  ordinary capability shortfall is counted and logged; invalid ACL state
   *  still fails closed. */
  #authorizeMessageWithEngine(
    engine: Engine.Engine,
    space: string,
    principal: string | undefined,
    requirement: Capability,
  ): V2Error | null {
    if (this.#aclMode() === "off") return null;
    const capability = this.#capabilityFor(engine, space, principal);
    if (capability !== null && isCapable(capability, requirement)) {
      return null;
    }
    const principalLabel = principal ?? "<anonymous>";
    if (this.#aclState(engine, space).kind === "invalid") {
      this.aclStats.denied += 1;
      return toError(
        "AuthorizationError",
        `Space ${space} has a malformed, ownerless, or retracted ACL`,
        { permanentEvidence: true, aclRevision: Engine.serverSeq(engine) },
      );
    }
    if (this.#aclMode() === "observe") {
      this.aclStats.wouldDeny += 1;
      console.warn(
        `[memory-acl] would deny ${requirement} on ${space} for ` +
          `${principalLabel} (capability: ${capability ?? "none"})`,
      );
      return null;
    }
    this.aclStats.denied += 1;
    return toError(
      "AuthorizationError",
      `Principal ${principalLabel} lacks ${requirement} on space ${space}`,
      { permanentEvidence: true, aclRevision: Engine.serverSeq(engine) },
    );
  }

  async #authorizeMessage(
    space: string,
    principal: string | undefined,
    requirement: Capability,
  ): Promise<V2Error | null> {
    // Keep off mode's historical async shape: callers await this immediate
    // return, then independently await their read engine/evaluation. Some
    // legacy runtime ordering depends on those two yield points.
    if (this.#aclMode() === "off") return null;
    const engine = await this.#openEngine(space);
    return this.#authorizeMessageWithEngine(
      engine,
      space,
      principal,
      requirement,
    );
  }

  #authorizeCurrentSessionWithEngine(
    engine: Engine.Engine,
    space: string,
    sessionId: string,
    session: SessionState,
    requirement: Capability,
  ): V2Error | null {
    if (this.#sessions.get(space, sessionId) !== session) {
      return toError("SessionError", "Unknown session for space");
    }
    // The delegated READ binding (OW31, READ side RULED 2026-08-19): a
    // bound session's READ-class decisions resolve as the ACTING user
    // (the space's owner). WRITE and OWNER requirements resolve against
    // the ENVELOPE principal only — the binding grants no write path;
    // served writes ride the wave's §2b delegated carriage, and a
    // session-plane write by the serving identity stays refused (the
    // observe-mode canary's subject).
    const principal = requirement === "READ"
      ? session.actingPrincipal ?? session.principal
      : session.principal;
    return this.#authorizeMessageWithEngine(
      engine,
      space,
      principal,
      requirement,
    );
  }

  /** Enforce ACL document shape and fresh-space genesis independently of the
   *  observe/enforce access-decision dial. These are storage invariants: an
   *  invalid ACL or an ordinary first write would make later enforcement
   *  ambiguous or impossible. */
  #validateAclCommit(
    engine: Engine.Engine,
    space: string,
    session: SessionState,
    commit: ClientCommit,
  ): V2Error | null {
    const principal = session.principal;
    if (commit.genesisRoot !== undefined) {
      if (!isGenesisRoot(commit.genesisRoot)) {
        return toError("ProtocolError", "Invalid genesis root reservation");
      }
      if (
        principal !== space || Engine.serverSeq(engine) !== 0 ||
        commit.operations.length !== 1 || commit.operations[0].op !== "set" ||
        commit.operations[0].id !== aclDocId(space) ||
        (commit.operations[0].scope !== undefined &&
          commit.operations[0].scope !== "space") ||
        (commit.branch !== undefined && commit.branch !== "") ||
        !isACL(commit.operations[0].value?.value) ||
        !hasConcreteOwner(commit.operations[0].value?.value)
      ) {
        return toError(
          "AuthorizationError",
          "A root reservation requires space-key ACL genesis",
        );
      }
      if (!valueEqual(commit.genesisRoot, session.genesisRoot)) {
        return toError(
          "AuthorizationError",
          "The genesis root must match the authenticated session intent",
        );
      }
    } else if (
      Engine.serverSeq(engine) === 0 && session.genesisRoot !== undefined
    ) {
      return toError(
        "AuthorizationError",
        "The genesis commit must retain the authenticated root intent",
      );
    }
    if (this.#aclMode() === "off") return null;

    const state = this.#aclState(engine, space);
    const aclTouched = commitTouchesAclDoc(commit.operations, space);

    if (!aclTouched) {
      if (state.kind === "missing" && Engine.serverSeq(engine) === 0) {
        return toError(
          "AuthorizationError",
          `Space ${space} requires an ACL genesis commit before ordinary writes`,
        );
      }
      return null;
    }

    if (commit.branch !== undefined && commit.branch !== "") {
      return toError(
        "ProtocolError",
        "ACL mutations are only valid on the default branch",
      );
    }
    if (commit.operations.length !== 1) {
      return toError(
        "ProtocolError",
        "ACL mutations must be an ACL-only commit",
      );
    }
    const operation = commit.operations[0];
    if (
      operation.op !== "set" ||
      operation.id !== aclDocId(space) ||
      (operation.scope !== undefined && operation.scope !== "space")
    ) {
      return toError(
        "ProtocolError",
        "ACL mutations must replace the space-scoped ACL document",
      );
    }
    const acl = operation.value?.value;
    if (!isACL(acl) || !hasConcreteOwner(acl)) {
      return toError(
        "ProtocolError",
        "ACL must be valid and retain at least one concrete OWNER",
      );
    }
    if (
      state.kind === "missing" &&
      (principal === undefined ||
        (principal !== space && !this.#isServicePrincipal(principal)))
    ) {
      return toError(
        "AuthorizationError",
        `Only the space identity or a service DID may initialize ${space}`,
      );
    }
    return null;
  }

  /**
   * Writer sessions that de-authorized themselves in a commit: their
   * `session/revoked` is held until after the transact verdict goes out.
   */
  #deferredSelfRevocations = new Map<string, string | null>();

  deliverDeferredSelfRevocation(space: string, sessionId: string): void {
    const key = `${space}\0${sessionId}`;
    const connectionId = this.#deferredSelfRevocations.get(key);
    if (connectionId === undefined) {
      return;
    }
    this.#deferredSelfRevocations.delete(key);
    if (connectionId !== null) {
      this.#connections.get(connectionId)?.revokeSession(
        space,
        sessionId,
        "unauthorized",
      );
    }
  }

  /**
   * After an ACL change, drop live sessions whose principal no longer holds
   * READ (enforce mode only): per-message gating alone would still let their
   * already-registered subscriptions receive pushes. The owning connection
   * gets a session/revoked("unauthorized"), which the client treats as a
   * terminal session close (no reopen loop — a reopen attempt is denied at
   * session.open). The session that made the triggering ACL write
   * (`writerSessionId`) is still dropped from the registry — so it receives no
   * further pushes — but is NOT sent the terminal revocation, so it gets this
   * transact's response first (a self-removal otherwise reads as a failure).
   * Its next message fails closed as an unknown session.
   */
  #revokeDeauthorizedSessions(
    engine: Engine.Engine,
    space: string,
    writerSessionId?: string,
  ): void {
    if (this.#aclMode() !== "enforce") return;
    for (const session of this.#sessions.sessionsForSpace(space)) {
      // A delegated READ binding (OW31) is judged as its acting user,
      // AND against the CURRENT owner resolution: an ACL change that
      // moves ownership revokes the bound session even when the stale
      // acting principal still holds READ (the self-owned space's
      // implicit-OWNER short-circuit included — the Codex P1 finding
      // on #6156), so the serving plane's next mount re-binds the new
      // owner instead of reading indefinitely under a stale identity.
      if (
        session.actingPrincipal !== undefined &&
        this.#resolveSpaceOwnerBinding(engine, space) !==
          session.actingPrincipal
      ) {
        this.#sessions.remove(space, session.id);
        if (session.ownerConnectionId !== null) {
          this.#connections.get(session.ownerConnectionId)?.revokeSession(
            space,
            session.id,
            "unauthorized",
          );
        }
        continue;
      }
      const capability = this.#capabilityFor(
        engine,
        space,
        session.actingPrincipal ?? session.principal,
      );
      if (capability !== null && isCapable(capability, "READ")) continue;
      // Drop the de-authorized session from the registry: the refresh loop
      // iterates registered sessions, so removal stops all further watch
      // pushes, and its next message fails closed (Unknown session).
      this.#sessions.remove(space, session.id);
      if (session.id === writerSessionId) {
        // The writer's own session — it just removed its own access. Do not
        // send the terminal session/revoked BEFORE its transact response
        // (the client treats it as terminal and would turn this successful
        // self-removal into a reported failure) — but it MUST still arrive
        // after the verdict: the session is detached, so no marker frame
        // can ever reach it, and the revocation is what releases the
        // client's parked accept (consumer-teardown application).
        this.#deferredSelfRevocations.set(
          `${space}\0${session.id}`,
          session.ownerConnectionId,
        );
        continue;
      }
      if (session.ownerConnectionId !== null) {
        this.#connections.get(session.ownerConnectionId)?.revokeSession(
          space,
          session.id,
          "unauthorized",
        );
      }
    }
  }

  connect(send: Send): Connection {
    const connection = new Connection(crypto.randomUUID(), this, send);
    this.#connections.set(connection.id, connection);
    return connection;
  }

  isAclActive(): boolean {
    return this.#aclMode() !== "off";
  }

  isSessionAttached(
    space: string,
    sessionId: string,
    connectionId: string,
  ): boolean {
    return this.#sessions.get(space, sessionId)?.ownerConnectionId ===
      connectionId;
  }

  disconnect(connection: Connection): void {
    this.#connections.delete(connection.id);
    if (this.#connections.size === 0) {
      this.#cancelScheduledRefresh();
    }
  }

  detachSession(
    space: string,
    sessionId: string,
    ownerConnectionId: string,
  ): void {
    this.#sessions.detach(space, sessionId, ownerConnectionId);
  }

  /**
   * Marks a session so its next evaluation runs the full path instead of
   * an incremental refresh — the recovery for incremental tracking state
   * a failed pass may have partially advanced.
   */
  markSessionForFullResync(space: string, sessionId: string): void {
    const session = this.#sessions.get(space, sessionId);
    if (session !== null) {
      session.forceFullResync = true;
    }
  }

  /** Opens this server's private DID inbox database under its owned store. */
  inboxStore(): Promise<InboxStore> {
    return this.#inboxStore ??= (async () => {
      if (this.#store?.protocol !== "file:") return new InboxStore(":memory:");
      const directory = new URL(
        "./inbox/",
        resolveSpaceStoreDirUrl(this.#store),
      );
      await FS.ensureDir(directory);
      return new InboxStore(
        Path.fromFileUrl(new URL("messages.sqlite", directory)),
      );
    })();
  }

  async close(): Promise<void> {
    // Withdraw this server's health-route providers so a closed server is
    // neither reported nor kept alive by the route; synchronous, ahead of
    // the first await, so an un-awaited close still withdraws them at once.
    withdrawProvider(
      pushPriorityStatsProviders,
      this.#pushPriorityStatsProvider,
    );
    withdrawProvider(
      documentCachesDiagnosticsProviders,
      this.#documentCachesDiagnosticsProvider,
    );
    this.#cancelScheduledRefresh();
    await this.#refreshing;
    await this.#drainSpacePublicationLocks();
    for (const engine of this.#engines.values()) {
      Engine.close(await engine);
    }
    this.#engines.clear();
    this.#resolvedEngines.clear();
    this.#connections.clear();
    this.#readPool.close();
    if (this.#inboxStore) (await this.#inboxStore).close();
  }

  /**
   * Drains per-space publication turns and any in-flight or scheduled
   * subscription refresh, returning when the server has no pending work.
   * Tests use this to prevent the module-level singleton's work from
   * leaking across Deno test boundaries.
   *
   * Callers stop submitting work before awaiting this method. A sustained
   * stream of new work can extend the drain indefinitely.
   *
   * `flushSessions()` (called with no `spaces` argument) cancels any
   * pending timer, runs the refresh loop to completion, and intentionally
   * does not reschedule, so a single call is sufficient.
   */
  async idle(): Promise<void> {
    await this.#drainSpacePublicationLocks();
    // Dirty spaces with no timer armed are manual mode's held fan-out.
    // idle() is an explicit synchronization point exactly like
    // flushSessions(), so it drains them rather than returning with
    // pending work — "manual" gates the TIMER, not the explicit calls.
    if (
      this.#refreshTurn !== null || this.#refreshing !== null ||
      this.#dirtySpaces.size > 0
    ) {
      await this.flushSessions();
    }
  }

  /** Executes an authenticated invitation operation with ordinary ACL publication. */
  async invite(request: InviteRequest): Promise<InviteResult["result"]> {
    return await this.#withSpacePublicationLock(request.space, async () => {
      if (!(await this.#spaceStoreExists(request.space))) {
        throw new SpaceInviteError(
          request.operation === "redeem" ? "invite-unavailable" : "not-owner",
        );
      }
      const engine = await this.#openEngine(request.space);
      const { result, commit } = executeInvite(engine, {
        ...request,
        implicitOwner: request.principal === request.space ||
          this.#isServicePrincipal(request.principal),
      });
      if (commit !== undefined) {
        this.#invalidateAclCapabilities(request.space);
        this.#revokeDeauthorizedSessions(engine, request.space);
        this.markSpaceDirty(request.space, [
          toDirtyKey(aclDocId(request.space)),
        ]);
        this.#notifyCommitAdmitted({
          space: request.space,
          seq: commit.seq,
          class: "system",
          sessionId: "invite-service",
          writes: [{ id: aclDocId(request.space), scopeKey: "space" }],
        });
      }
      return result;
    });
  }

  async readDocument(
    space: string,
    id: string,
  ): Promise<EntityDocument | null> {
    const engine = await this.#openEngine(space);
    return Engine.read(engine, { id });
  }

  async writeDocument(
    space: string,
    id: string,
    value: EntityDocument["value"],
  ): Promise<Engine.AppliedCommit> {
    return await this.#withSpacePublicationLock(space, async () => {
      const engine = await this.#openEngine(space);
      if (this.#aclMode() !== "off") {
        if (id === aclDocId(space)) {
          throw new Engine.ProtocolError(
            "direct writes may not mutate the ACL document",
          );
        }
        const aclState = this.#aclState(engine, space);
        if (aclState.kind === "invalid") {
          throw new Engine.ProtocolError(
            `space ${space} has invalid ACL state`,
          );
        }
        if (
          aclState.kind === "missing" &&
          Engine.serverSeq(engine) === 0
        ) {
          throw new Engine.ProtocolError(
            `space ${space} requires an ACL genesis commit before direct writes`,
          );
        }
      }
      const commit = Engine.applyCommit(engine, {
        sessionId: this.#directSessionId,
        space,
        commit: {
          localSeq: ++this.#directLocalSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id,
            value: { value },
          }],
        },
        // The memory server's own direct-write path: `system` class
        // (protocol.md §1's third row — the memory server itself as producer).
        commitClass: "system",
      });
      // An elided direct write changed nothing, and unlike a session
      // transact it owes no catch-up marker — skip the flush entirely.
      if (commit.revisions.length > 0) {
        this.markSpaceDirty(space, [toDirtyKey(id)]);
      }
      // The feed carries system commits too (the loop classifies by class;
      // a system write is ordinary non-authored input — it does not trigger
      // plane (b)'s AUTHORED activation rule, which the host enforces).
      // Notified even when every op elided: the commit was RECORDED (the
      // space log advanced), and the feed carries admitted commits, not
      // novelty — the elision only suppresses the watcher fan-out above.
      this.#notifyCommitAdmitted({
        space,
        seq: commit.seq,
        class: "system",
        sessionId: this.#directSessionId,
        writes: [{ id, scopeKey: "space" }],
      });
      return commit;
    });
  }

  /**
   * Read a cell-derived database on a pooled read-only connection — unattached,
   * like injected on-disk sources. (Writes still ATTACH to the engine connection
   * in `#attachCommitSqliteDbs` for commit atomicity.)
   *
   * A cell-db file is created lazily by the first WRITE (its ATTACH), and that
   * write's `ensureTables` creates the declared tables. So a read can find:
   *   - no file yet (never written) → no rows;
   *   - a file without the queried table (e.g. a newly-declared table not yet
   *     created by a write) → no rows.
   * Both map to an empty result, preserving the previous "read a fresh cell-db
   * returns []" contract without the read needing to create anything.
   */
  async #readCellDb(
    space: string,
    db: SqliteDbRef,
    sql: string,
    params: SqliteParamsWire | undefined,
    scopeKey: string,
    wantColumns: boolean,
  ): Promise<{ rows: SqliteNativeRow[]; columns?: SqliteResultColumn[] }> {
    // Apply the statement guard BEFORE the file-existence short-circuit, so a
    // rejected statement (non-SELECT, core-table/qualified ref, ATTACH/PRAGMA,
    // multi-statement) is refused even against a never-written cell-db rather
    // than silently returning [].
    assertReadOnly(sql);
    const engine = await this.#openEngine(space);
    const path = this.#cellDbPath(engine, space, db.id, scopeKey);
    // A never-written cell-db has no file yet (its schema is created on the
    // first write, via the attach path). Treat a missing file as an empty
    // result — but ONLY a genuinely-absent file: any other stat failure
    // (permissions, I/O) is a real error and must surface, not masquerade as [].
    try {
      Deno.statSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { rows: [] };
      throw error;
    }
    try {
      return wantColumns
        ? this.#readPool.queryWithOrigins(path, sql, params)
        : { rows: this.#readPool.query(path, sql, params) };
    } catch (error) {
      // The file exists (written at least once, so ensureTables created every
      // table declared at that write). A "no such table" therefore means either:
      //   - a DECLARED table not yet materialized (the schema evolved since the
      //     last write; the next write creates it) → behaves like a fresh,
      //     empty table → [].
      //   - an UNDECLARED table (a typo or otherwise undeclared name) → a real
      //     mistake → rethrow.
      // Scoping to the declared schema preserves create-on-read semantics
      // without masking genuine query/schema errors as empty results.
      // SQLite identifiers are case-insensitive (ASCII), so match the missing
      // name against the declared keys case-insensitively — otherwise a table
      // declared `Notes` but queried `notes` would rethrow before its first
      // write yet succeed after (SQLite case-folds), flipping the contract.
      const missing = missingTableName(error);
      if (missing !== undefined && isDeclaredTable(db.tables, missing)) {
        return { rows: [] };
      }
      throw error;
    }
  }

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1) for
   * `(space, id)`. After this, `sqliteQuery` reads the canonical `path` on the
   * read pool (read-only) for that `(space, id)` instead of the cell-derived db.
   * The descriptor is server-side state — never the cell value.
   *
   * The path is validated here because it arrives over the wire (untrusted): it
   * must be absolute and must exist, and is `realpath`-canonicalized and then
   * rejected if it resolves INSIDE the engine's store directory OR names an
   * internal cell-db file — otherwise a caller could point a handle at another
   * space's (or a cell-derived) `.sqlite` file and read it cross-tenant.
   * (Confining injected sources to an operator allowlist, and gating the verb to
   * an operator capability rather than any session, awaits CFC labels —
   * 08-open-questions Q18.)
   */
  async registerDiskSource(
    space: string,
    id: string,
    path: string,
    beforeRegister?: (engine: Engine.Engine) => void,
  ): Promise<void> {
    if (!Path.isAbsolute(path)) {
      throw new Engine.ProtocolError(
        `disk source path must be absolute: ${path}`,
      );
    }
    let canonical: string;
    try {
      canonical = await Deno.realPath(path);
    } catch {
      throw new Engine.ProtocolError(`disk source path not found: ${path}`);
    }
    const engine = await this.#openEngine(space);
    if (engine.url.protocol === "file:") {
      // Canonicalize the store dir too (not just the source path): `canonical`
      // is realpath-resolved, so comparing it against a NON-canonical storeDir
      // lets a symlinked store dir produce a `..`-prefixed relative path for a
      // file that actually lives in the store — defeating the jail. With both
      // sides canonical, containment also covers the `<space>.sqlite` store
      // files (not just `cell-*`).
      let storeDir = Path.dirname(Path.fromFileUrl(engine.url));
      try {
        storeDir = await Deno.realPath(storeDir);
      } catch { /* dir may not exist yet; fall back to the raw path */ }
      const rel = Path.relative(storeDir, canonical);
      const insideStore = rel === "" ||
        (!rel.startsWith("..") && !Path.isAbsolute(rel));
      if (insideStore) {
        throw new Engine.ProtocolError(
          "disk source path may not resolve inside the store directory",
        );
      }
    }
    // Internal cell-db files (`cell-<tag>.sqlite` beside a file store's space db;
    // `cf-cell-<tag>.sqlite` under TMPDIR for a memory store — see #cellDbPath)
    // are never valid injected sources. Reject by name so a memory store (which
    // has no on-disk store directory to jail against) can't be pointed at another
    // space's cell-db sitting in TMPDIR.
    if (/^(?:cf-)?cell-[^/]*\.sqlite$/i.test(Path.basename(canonical))) {
      throw new Engine.ProtocolError(
        "disk source path may not be an internal cell-db file",
      );
    }
    // The RPC path uses this synchronous hook to re-authorize beside the
    // registry mutation after the filesystem awaits above. Direct internal
    // callers do not need to provide it.
    beforeRegister?.(engine);
    this.#diskSources.register(space, id, { path: canonical });
  }

  /**
   * Attach the cell-db(s) referenced by a commit's `sqlite` ops and create their
   * tables, returning a dbId→alias map for `Engine.applyCommit`. Must run BEFORE
   * applyCommit (ATTACH can't run in a transaction); the caller detaches after.
   * Enforces ≤1 cell-db per commit so unqualified names stay unambiguous
   * (decision 1.3.A in plans/atomic-writes.md).
   *
   * The transact-path entry: the db file's scope key resolves from the
   * COMMITTING SESSION (the client-commit identity model, protocol.md §1).
   * The wave path enters through {@link attachWaveCommitSqliteDbs}, whose
   * keys were resolved per RUN by the wave accumulator — the shared core
   * below carries every validation either way.
   */
  #attachCommitSqliteDbs(
    engine: Engine.Engine,
    space: string,
    operations: readonly Operation[],
    scopeContext: { principal?: string; sessionId: string },
  ): Map<string, string> {
    return this.#attachSqliteDbsWithScopeKeys(
      engine,
      space,
      operations,
      (op) =>
        Engine.resolveScopeKey(op.db.scope, {
          principal: scopeContext.principal,
          sessionId: scopeContext.sessionId,
        }),
    );
  }

  /**
   * The wave-path entry (server-execution v2 stage G, discharging the
   * stage-D sqlite bound at engine-wave-sink.ts): attach the cell-db(s)
   * a WAVE batch's folded `sqlite` ops target, keyed by the scope keys
   * the wave accumulator resolved per RUN (M1 — the run's identity, not
   * any committing session's; the wave envelope has no session to
   * resolve scoped files from). Same validations, caps, and ≤1-db rule
   * as the transact path — one core, two identity sources. The caller
   * MUST invoke `detach` after its (synchronous) apply, before any
   * await: the engine connection is shared per space, and a held
   * attachment across an await breaks the ≤1-attached invariant
   * unqualified-name resolution relies on.
   */
  attachWaveCommitSqliteDbs(
    engine: Engine.Engine,
    space: string,
    operations: readonly Operation[],
    scopeKeyByOpIndex: ReadonlyMap<number, string>,
  ): { attachments: Map<string, string>; detach: () => void } {
    const attachments = this.#attachSqliteDbsWithScopeKeys(
      engine,
      space,
      operations,
      (op, opIndex) => {
        const key = scopeKeyByOpIndex.get(opIndex);
        if (key === undefined) {
          throw new Engine.ProtocolError(
            `wave sqlite op ${opIndex} (db ${op.db.id}) carries no ` +
              "resolved scope key: the wave accumulator resolves every " +
              "sqlite op's db scope against its run's identity " +
              "(serving-loop.md §3d; scopes.md §5)",
          );
        }
        return key;
      },
    );
    return {
      attachments,
      detach: () => {
        for (const alias of attachments.values()) {
          detachDatabase(engine.database, alias);
        }
      },
    };
  }

  #attachSqliteDbsWithScopeKeys(
    engine: Engine.Engine,
    space: string,
    operations: readonly Operation[],
    scopeKeyForOp: (
      op: Extract<Operation, { op: "sqlite" }>,
      opIndex: number,
    ) => string,
  ): Map<string, string> {
    const map = new Map<string, string>();
    const tablesById = new Map<string, Record<string, unknown> | undefined>();
    // The db's scope qualifies its on-disk file the same way the read path does
    // (so a write and a read of a user/session-scoped db hit the same file).
    const scopeKeyById = new Map<string, string>();
    for (const [opIndex, op] of operations.entries()) {
      if (op.op !== "sqlite") continue;
      const id = op.db.id;
      // Resource caps for the WRITE path. `sqlite.query` enforces these at parse
      // time, but a folded `sqlite` op rides `transact` (whose commit is parsed
      // loosely), so cap it here — before the guard tokenizes the statement and
      // before ensureTables builds DDL — to bound CPU/DDL work on the shared,
      // single-threaded per-space engine connection.
      if (typeof op.sql === "string" && op.sql.length > MAX_SQLITE_SQL_LENGTH) {
        throw new Engine.ProtocolError(
          "sqlite statement exceeds the maximum length",
        );
      }
      if (
        op.db.tables &&
        Object.keys(op.db.tables).length > MAX_SQLITE_TABLES
      ) {
        throw new Engine.ProtocolError("sqlite db declares too many tables");
      }
      // Phase 7: injected on-disk sources are read-only in v1 — a folded write to
      // one is rejected before it can join the commit (Q13/Q14).
      if (this.#diskSources.has(space, id)) {
        throw new Engine.ProtocolError(
          "injected on-disk SQLite sources are read-only in v1 (db.exec rejected)",
        );
      }
      // Validate the declared scope on the WRITE path too. `sqlite.query`
      // validates scope at parse time, but a folded op rides the loosely-parsed
      // `transact` commit — an invalid value must fail loudly here, not silently
      // degrade to space scoping (which would mis-place the file).
      if (
        op.db.scope !== undefined && op.db.scope !== "space" &&
        op.db.scope !== "user" && op.db.scope !== "session"
      ) {
        throw new Engine.ProtocolError("sqlite op declares an invalid scope");
      }
      const scopeKey = scopeKeyForOp(op, opIndex);
      if (map.has(id)) {
        // Same db id appears twice in one commit: it must resolve to the same
        // scoped file. A differing scope key would mean the second op silently
        // writes into the first op's (different user/session) file — reject it.
        if (scopeKeyById.get(id) !== scopeKey) {
          throw new Engine.ProtocolError(
            "conflicting scope for the same sqlite database in one commit",
          );
        }
        continue;
      }
      if (map.size >= 1) {
        throw new Engine.ProtocolError(
          "a commit may write to at most one sqlite database",
        );
      }
      map.set(id, aliasForDbId(id));
      tablesById.set(id, op.db.tables);
      scopeKeyById.set(id, scopeKey);
    }
    // Attach + create tables. If `ensureTables` throws (e.g. a malformed/hostile
    // `db.tables` payload — DDL validation rejects it), DETACH everything
    // attached so far before rethrowing. This helper runs BEFORE the caller's
    // attach→commit→detach try/finally, and the engine connection is reused per
    // space, so a leaked attachment would make later writes/queries for the same
    // alias fail ("already in use") and corrupt unqualified name resolution.
    const attached: string[] = [];
    try {
      for (const [id, alias] of map) {
        const scopeKey = scopeKeyById.get(id) ?? "space";
        attachDatabase(
          engine.database,
          alias,
          this.#cellDbPath(engine, space, id, scopeKey),
        );
        attached.push(alias);
        const tables = tablesById.get(id);
        if (tables) {
          // Run ensureTables only the first time this (space, id, scope, schema)
          // is seen; record AFTER it succeeds so a throw re-ensures next time.
          // The scope key is part of the identity: a user/session-scoped db has
          // a distinct file per principal/session, so each needs its own DDL run
          // even though (space, id, schema) match.
          const key = `${space}\0${id}\0${scopeKey}\0${JSON.stringify(tables)}`;
          if (!this.#ensuredSchemas.has(key)) {
            ensureTables(
              engine.database,
              tables as Record<string, TableSchema>,
              alias,
            );
            this.#recordSchemaEnsured(key);
          }
        }
      }
    } catch (error) {
      for (const alias of attached) {
        try {
          detachDatabase(engine.database, alias);
        } catch { /* best-effort cleanup on the error path */ }
      }
      throw error;
    }
    return map;
  }

  /** Path for a cell-derived db file. Sibling of the space db for file stores;
   *  a deterministic temp file for in-memory stores (so it survives the
   *  connection, unlike an `:memory:` attach). The space + id are hashed into
   *  the filename so distinct (space, id) pairs never collide.
   *
   *  `scopeKey` is the resolved scope key (`Engine.resolveScopeKey`): `space`
   *  for the default scope (left out of the name, so existing space-scoped files
   *  keep their path — no migration), or `user:<did>` / `session:<did>:<sid>`
   *  for a scoped db, hashed in so each user/session gets its own file. */
  #cellDbPath(
    engine: Engine.Engine,
    space: string,
    id: string,
    scopeKey: string = "space",
  ): string {
    const scopeTag = scopeKey === "space" ? "" : `-${hashToken(scopeKey)}`;
    const tag = `${hashToken(space)}-${hashToken(id)}${scopeTag}`;
    if (engine.url.protocol === "file:") {
      const dir = Path.dirname(Path.fromFileUrl(engine.url));
      return Path.join(dir, `cell-${tag}.sqlite`);
    }
    return Path.join(Deno.env.get("TMPDIR") ?? "/tmp", `cf-cell-${tag}.sqlite`);
  }

  /**
   * Deliver one durable outbox append row to its target space
   * (server-execution v2 stage G; serving-loop.md §5 FP1, protocol.md
   * §2's server-produced authored row, §2b): an authored-class commit
   * under the DELEGATED admission row — the carried acting identity +
   * `capabilityRef` ride the commit metadata and the engine's delegated
   * admission validates completeness. The entry's `firedAt` derives
   * from that SAME carriage the admission validates (events.md §2: the
   * event runs as the session it originated from; deriving it from the
   * delivering envelope would be the silent-empty-instance trap), so a
   * carriage/stamp mismatch is structurally impossible here. The
   * commit's ENVELOPE session is the delivering SpaceServer's service
   * identity (LT5) — admissibility comes from the carriage, never the
   * envelope.
   *
   * Dedupe at the eventId horizon (events.md §4, the spec model's
   * `admitDelegatedAppend`): a duplicate whose eventId already exists
   * ABOVE the stream's `eventWatermark` is acked WITHOUT a commit (the
   * admission-uniqueness CAS); an at-or-below duplicate ADMITS as a new
   * entry and is skipped at processing time — admission must not bless
   * a stronger, permanent dedupe than the contract. Entry `seq`s are
   * ENGINE-STAMPED at apply (Phase 3 — the stage-G obligation
   * discharged): the seq-less arm below covers only stage-G-era rows,
   * and it RETIRES as processing marks those entries consequenced —
   * never a stronger, permanent dedupe than events.md §4 permits.
   *
   * Deterministic admission rejections THROW `Engine.ProtocolError`
   * (LT4: the outbox does not retry those; Phase 3's source-side notice
   * is written BEFORE the row delete — OW14); the caller deletes the
   * row either way it returns.
   */
  async commitDelegatedAppend(entry: {
    targetSpace: string;

    /** The stream SIDECAR doc id (`streamEntriesDocId`). */
    targetStream: string;

    /** The stream link for the delivered entry's self-describing
     * `stream` field; stage-G-era rows fall back to a path-less link
     * at the sidecar id. */
    targetStreamLink?: StreamLinkRef;

    eventId: string;
    payload: unknown;
    actingPrincipal?: string;
    actingSession?: string;

    /** The OW15 sessionless-space-scope declaration (protocol.md §2's
     * Phase-3 floor carve-out): admits an ABSENT acting principal;
     * the entry stamps `firedAt = { session: "server" }`. */
    sessionlessSpaceScope?: boolean;

    capabilityRef: string;

    /** The delivering SpaceServer's service session — the commit's
     * envelope identity (LT5). */
    sessionId: string;

    /** From the delivering host's process-lifetime counter (the same
     * replay-keying discipline as the wave sink — engine-wave-sink.ts):
     * unique per (sessionId, localSeq) on the target engine. NOTE: a
     * RE-SENT row arrives under a FRESH localSeq (the outbox bumps the
     * shared counter per delivery attempt), so the engine's commit
     * replay check never dedupes re-sends — the eventId horizon below
     * is the one and only re-send dedupe. */
    localSeq: number;
  }): Promise<{ seq?: number; deduped: boolean }> {
    const engine = await this.#openEngine(entry.targetSpace);
    // Read-check-append runs synchronously from here (no await), so the
    // horizon check and the commit are atomic on the single-threaded
    // co-hosted engine. The engine's event-append admission re-runs the
    // same check inside the apply transaction (the atomic backstop);
    // this pre-check exists for the deduped-without-error fast path.
    const doc = Engine.read(engine, { id: entry.targetStream });
    const value = (doc?.value ?? {}) as StreamEventsDocValue;
    const entries = Array.isArray(value.entries) ? value.entries : [];
    const horizon = typeof value.eventWatermark === "number"
      ? value.eventWatermark
      : 0;
    const duplicate = entries.some((existing) =>
      existing?.eventId === entry.eventId &&
      (typeof existing.seq === "number"
        ? existing.seq > horizon
        : existing.consequenced !== true)
    );
    if (duplicate) {
      return { deduped: true };
    }
    // The delivered entry's self-describing link MUST derive the target
    // sidecar (events.md §1 — one derivation; the engine's admission
    // re-checks the same binding). A row with NO link (stage-G era) is
    // REFUSED, not patched with a fabricated path-less link: the
    // fabricated link hashes to a DIFFERENT sidecar id, so the target's
    // drain would route the event to a stream nothing fired at —
    // deferred until dropped, handler never run. The deterministic
    // refusal takes the LT4 arm at the source: failure notice (warn log
    // for unsourced legacy rows), row retired.
    const stream: StreamLinkRef | undefined = entry.targetStreamLink;
    if (stream === undefined) {
      throw new Engine.ProtocolError(
        `delegated append ${entry.eventId} carries no target stream ` +
          "link — a legacy (stage-G era) outbox row cannot name the " +
          "stream its entry stands for; refused, never fabricated " +
          "(events.md §1)",
      );
    }
    if (streamEntriesDocId(stream) !== entry.targetStream) {
      throw new Engine.ProtocolError(
        `delegated append ${entry.eventId} carries a stream link that ` +
          `does not derive its target sidecar "${entry.targetStream}" ` +
          "(events.md §1's one derivation)",
      );
    }
    const streamEntry: StreamEventEntry = {
      eventId: entry.eventId,
      stream,
      payload: entry.payload as StreamEventEntry["payload"],
      // events.md §2: the inherited actor; a sessionless chain stamps
      // session "server". Derived from the SAME carriage the delegated
      // admission validates — the engine's stamp agrees by construction
      // (a mismatch would be refused, never corrected).
      firedAt: {
        ...(entry.actingPrincipal === undefined
          ? {}
          : { user: entry.actingPrincipal }),
        session: entry.actingSession ?? "server",
      },
    };
    let applied: Engine.AppliedCommit;
    try {
      applied = Engine.applyCommit(engine, {
        sessionId: entry.sessionId,
        space: entry.targetSpace,
        commit: {
          localSeq: entry.localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: entry.targetStream as never,
            patches: [{
              // The tail-relative merge op (v2.ts's PatchOp): concurrent
              // appends merge against durable state, and the array (and
              // path) create if absent — no whole-doc set, so the
              // engine's authored-shape guard (events.md §1) admits it.
              op: "append",
              path: "/value/entries",
              values: [streamEntry as never],
            }],
          }],
          eventAppends: [{ id: entry.targetStream, eventId: entry.eventId }],
        },
        commitClass: "authored",
        delegated: {
          // OW15: the acting principal passes through as carried —
          // ABSENT for a declared sessionless-space-scope chain (the
          // engine's floor carve-out admits it; the old `?? ""` mapping
          // deterministically destroyed such entries at delivery).
          actingPrincipal: entry.actingPrincipal ?? "",
          ...(entry.actingSession === undefined
            ? {}
            : { actingSession: entry.actingSession }),
          ...(entry.sessionlessSpaceScope === true
            ? { sessionlessSpaceScope: true }
            : {}),
          capabilityRef: entry.capabilityRef,
        },
      });
    } catch (error) {
      if (error instanceof EventAppendDuplicateError) {
        // The engine's atomic horizon check caught a duplicate the
        // fast-path pre-check raced past: delivered, ack the row.
        return { deduped: true };
      }
      throw error;
    }
    // The delivered append is an ordinary authored admission for every
    // observer: push dirtiness (M4 instance keys — the stream doc is
    // space-scoped) and the plane-(b) hook fire exactly as a transact
    // would have fired them.
    const streamDirtyKey = toDirtyKey(entry.targetStream);
    this.markSpaceDirty(entry.targetSpace, [streamDirtyKey], {
      sessionId: entry.sessionId,
      seq: applied.seq,
      // One patch-produced head (CT-1965): classified exactly as the
      // transact path classifies this commit's op — a patch append since
      // Phase 3 (concurrent deliveries merge against durable state), so
      // the head rides flush frames as a full post-apply document, which
      // no observer could extrapolate from its own writes.
      ops: new Map([[streamDirtyKey, "patch"]]),
    });
    this.#notifyCommitAdmitted({
      space: entry.targetSpace,
      seq: applied.seq,
      class: "authored",
      sessionId: entry.sessionId,
      writes: [{ id: entry.targetStream, scopeKey: "space" }],
      eventAppends: [{
        id: entry.targetStream,
        scopeKey: "space",
        eventId: entry.eventId,
      }],
    });
    return { seq: applied.seq, deduped: false };
  }

  async sqliteQuery(
    message: SqliteQueryRequest,
  ): Promise<ResponseMessage<SqliteQueryWireResult>> {
    const queryParams = message.namedParams === undefined
      ? message.params
      : Object.fromEntries(message.namedParams);
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<never>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    if (
      message.reader !== undefined &&
      (session.principal === undefined ||
        !this.#isDelegatingPrincipal(session.principal))
    ) {
      return respondTypedError<never>(
        message.requestId,
        toError(
          "AuthorizationError",
          "SQLite reader carriage requires a delegating principal",
        ),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.#openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        ) ?? (message.reader === undefined
          ? null
          : this.#authorizeMessageWithEngine(
            aclEngine,
            message.space,
            message.reader.principal,
            "READ",
          ));
      if (deny) {
        return respondTypedError<never>(message.requestId, deny);
      }
    }
    try {
      // All reads run unattached on a pooled read-only connection (no ATTACH,
      // real read-only, each file its own `main` namespace). The only
      // per-source difference is path resolution: an injected on-disk source's
      // registered path, else the cell-derived path (which the db's scope
      // qualifies using the carried reader, or the session principal / id
      // when no reader is carried).
      //
      // Capture per-column origin ONLY when the db declares per-column `ifc`
      // (Phase 2) or a per-row label rule (Phase 3 — rule inputs are located
      // by TRUE origin, never output name). Unlabeled dbs — the common case,
      // and all injected on-disk sources — pay nothing.
      const wantColumns = dbNeedsColumnProvenance(message.db.tables);
      // Bind @db/sqlite's column-origin symbols before a labeled read; fail
      // loudly if they can't be bound rather than mislabeling the result.
      if (wantColumns && !(await ensureColumnOriginAvailable())) {
        // The reason names a filesystem path, and this error reaches the query
        // caller, so it goes to the log and the caller gets the bare fact.
        console.warn(
          `[memory-sqlite] column-origin symbols could not be bound: ` +
            `${columnOriginUnavailableReason()}`,
        );
        throw new Error(
          "sqlite: CFC read labeling needs SQLite column-metadata FFI, but " +
            "@db/sqlite's column-origin symbols could not be bound",
        );
      }
      const disk = this.#diskSources.get(message.space, message.db.id);
      const result = disk
        ? (wantColumns
          ? this.#readPool.queryWithOrigins(
            disk.path,
            message.sql,
            queryParams,
          )
          : {
            rows: this.#readPool.query(disk.path, message.sql, queryParams),
          })
        : await this.#readCellDb(
          message.space,
          message.db,
          message.sql,
          queryParams,
          Engine.resolveScopeKey(
            message.db.scope,
            message.reader ?? {
              principal: session.principal,
              sessionId: message.sessionId,
            },
          ),
          wantColumns,
        );
      // SQLite reads necessarily await filesystem work. Re-check both the
      // session identity and its current ACL immediately before exposing the
      // rows, so a revoke during that I/O cannot leak a late result.
      if (aclEngine !== undefined) {
        const deny = this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        ) ?? (message.reader === undefined
          ? null
          : this.#authorizeMessageWithEngine(
            aclEngine,
            message.space,
            message.reader.principal,
            "READ",
          ));
        if (deny) {
          return respondTypedError<never>(message.requestId, deny);
        }
      }
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          rows: result.rows.map(sqliteRowToWire),
          columns: result.columns,
        },
      };
    } catch (error) {
      return respondTypedError<SqliteQueryWireResult>(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "SqliteError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // No `sqliteExecute` handler: there is no standalone SQLite write RPC. Writes
  // arrive as a `sqlite` op inside a `transact` commit and are applied by the
  // engine atomically with the cell ops (#attachCommitSqliteDbs + applyCommit) —
  // which is also where an injected on-disk source's read-only rejection lives.
  // `runWrite` remains the engine helper used by that commit-fold path.

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
   * link <piece> <field> sqlite:<absPath>` issues this so subsequent reads for the
   * handle id resolve against the on-disk file (attached read-only) instead of the
   * cell-derived db. The descriptor is server-side state — never the cell value.
   */
  async sqliteRegisterDiskSource(
    message: SqliteRegisterDiskSourceRequest,
  ): Promise<ResponseMessage<SqliteRegisterDiskSourceResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<SqliteRegisterDiskSourceResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.#openEngine(message.space);
    {
      // Maps a server filesystem path into the space — operator surface.
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "OWNER",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "OWNER",
        );
      if (deny) {
        return respondTypedError<SqliteRegisterDiskSourceResult>(
          message.requestId,
          deny,
        );
      }
    }
    try {
      await this.registerDiskSource(
        message.space,
        message.id,
        message.path,
        aclEngine === undefined ? undefined : (resolvedEngine) => {
          const deny = this.#authorizeCurrentSessionWithEngine(
            resolvedEngine,
            message.space,
            message.sessionId,
            session,
            "OWNER",
          );
          if (deny) {
            throw Object.assign(new Error(deny.message), { name: deny.name });
          }
        },
      );
    } catch (error) {
      return respondTypedError<SqliteRegisterDiskSourceResult>(
        message.requestId,
        toError(
          error instanceof Error ? error.name : "SqliteError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    return {
      type: "response",
      requestId: message.requestId,
      ok: { registered: true },
    };
  }

  async openSession(
    message: SessionOpenRequest,
    connection: Connection,
  ): Promise<ResponseMessage<SessionOpenResult>> {
    try {
      const authContext = connection.sessionOpenAuthContext(message);
      // Refuse at session admission: reconnecting peers understand this verdict
      // as terminal for the session and discard its pending commits and watches.
      if (!connection.stableExpressionResultIds) {
        return respondTypedError<SessionOpenResult>(
          message.requestId,
          toError(
            "SessionRevokedError",
            "This runtime uses incompatible expression result identities. " +
              "Reload the browser tab or update the CLI checkout.",
          ),
        );
      }
      const principal = await this.options.authorizeSessionOpen(
        message,
        authContext,
      );
      connection.consumeSessionOpenChallenge(authContext.challenge);
      const engine = await this.#openEngine(message.space);
      // The delegated READ binding (OW31, READ side RULED 2026-08-19):
      // `actingAs: "space-owner"` is admitted only for a DELEGATING-class
      // envelope (the co-hosted process identity under the flag — the
      // LT5 trust footing), and resolves to the space's ACL OWNER, the
      // user the session's READ-class decisions then run as. Inert in
      // `off` mode (off preserves historical behavior); refused hard in
      // observe AND enforce for a non-delegating envelope — the marker
      // is an admission-validity claim, not a capability shortfall.
      let actingPrincipal: string | undefined;
      const actingAs = message.session.actingAs;
      if (actingAs !== undefined && this.#aclMode() !== "off") {
        if (actingAs !== "space-owner") {
          return respondTypedError<SessionOpenResult>(
            message.requestId,
            toError(
              "ProtocolError",
              `unknown session.open actingAs value "${actingAs}"`,
            ),
          );
        }
        if (
          principal === undefined || !this.#isDelegatingPrincipal(principal)
        ) {
          this.aclStats.denied += 1;
          return respondTypedError<SessionOpenResult>(
            message.requestId,
            toError(
              "AuthorizationError",
              `Principal ${principal ?? "<anonymous>"} may not open a ` +
                `session acting as the owner of ${message.space}: not a ` +
                "delegating principal (memory ACL delegatingDids; OW31)",
            ),
          );
        }
        // An OWNER-class service envelope (the operator listed it in
        // serviceDids — the F1 combination) stores NO binding: its
        // authority is the explicit operator grant, a binding would be
        // wrong-class, and the owner-resolution revocation branch (which
        // skips the writerSessionId deferred-self-revocation carve-out)
        // must never apply to it (delta review D2/D3 on #6156).
        actingPrincipal = this.#isServicePrincipal(principal)
          ? undefined
          : this.#resolveSpaceOwnerBinding(
            engine,
            message.space,
          );
      }
      const deny = this.#authorizeMessageWithEngine(
        engine,
        message.space,
        actingPrincipal ?? principal,
        "READ",
      );
      if (deny) {
        return respondTypedError<SessionOpenResult>(message.requestId, deny);
      }
      const requestedRoot = message.session.genesisRoot;
      if (
        requestedRoot !== undefined &&
        (!isGenesisRoot(requestedRoot) ||
          (Engine.serverSeq(engine) > 0 &&
            !valueEqual(readGenesisRoot(engine), requestedRoot)))
      ) {
        return respondTypedError<SessionOpenResult>(
          message.requestId,
          toError(
            "ProtocolError",
            "The requested root intent differs from the space's immutable genesis",
          ),
        );
      }
      const opened = this.#sessions.open(
        message.space,
        message.session,
        Engine.serverSeq(engine),
        connection.id,
        principal,
        actingPrincipal,
      );
      if (opened.revokedConnectionId !== undefined) {
        this.#connections.get(opened.revokedConnectionId)?.revokeSession(
          message.space,
          opened.sessionId,
          "taken-over",
        );
      }
      // A resuming client that declares its holdings REPLACES the
      // server's delivery memory of it: the catch-up below diffs against
      // what the client says it holds, so a document the server remembers
      // sending but the client never absorbed (or lost with a replaced
      // replica) is delivered again, and everything the client does hold
      // stays elided. Without holdings the memory stands as before.
      if (opened.resumed === true && message.holdings !== undefined) {
        const resumed = this.#sessions.get(message.space, opened.sessionId);
        if (resumed !== null) {
          resumed.entities = holdingsToCacheEntries(
            message.holdings,
            this.#sessionScopeIdentity(resumed),
          );
          resumed.trackedIds = trackedIdsFromEntries(
            resumed.entities.values(),
          );
          this.#touchDemand(resumed);
          // The catch-up below evaluates only when something is dirty or
          // owed; a replaced diff base is neither, so the full evaluation
          // that diffs against it is forced explicitly.
          resumed.forceFullResync = true;
        }
      }
      // A resumed session's catch-up (below) is a FULL watch evaluation,
      // and every evaluation pass judges the lease-holder read exemption
      // against the CURRENT lease before it builds a frame
      // (syncSessionForConnection → #currentLeaseHolderExemption): a
      // resume never inherits foreign-instance delivery across a lapsed
      // or moved lease — the catch-up frame RETRACTS the foreign
      // instances instead, KEYED (the session's wire vocabulary is
      // sticky), so the retraction names exactly them and never the
      // session's own instance.
      const catchup = opened.resumed === true
        ? await this.syncSessionForConnection(
          message.space,
          opened.sessionId,
        )
        : null;
      // A resumed session is registered before catch-up, and catch-up awaits
      // graph evaluation. An ACL commit (or takeover) can remove or replace it
      // during that await, before Connection.#receiveOrdered has added its
      // local handle. In active ACL modes, never return catch-up data or let
      // the connection add a ghost handle unless this exact token is still
      // owned by this connection. Off mode preserves the legacy session timing.
      const current = this.#sessions.get(message.space, opened.sessionId);
      if (
        this.isAclActive() &&
        (current?.ownerConnectionId !== connection.id ||
          current.sessionToken !== opened.sessionToken)
      ) {
        return respondTypedError<SessionOpenResult>(
          message.requestId,
          toError(
            "SessionRevokedError",
            "Session was revoked while opening",
          ),
        );
      }
      const nextSessionOpen = connection.issueSessionOpenAuth();
      // Activation trigger (serving-loop.md §1): session open makes the
      // space ACTIVE-eligible; notify the host after the open succeeded.
      this.#notifySessionOpened(message.space);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
          serverSeq: opened.serverSeq,
          caughtUpLocalSeq: opened.caughtUpLocalSeq,
          ...(opened.resumed === true ? { resumed: true } : {}),
          ...(catchup ? { sync: catchup.effect } : {}),
          sessionOpen: nextSessionOpen,
        },
      };
    } catch (error) {
      const name = error instanceof Error && error.name === "AuthorizationError"
        ? "AuthorizationError"
        : error instanceof Error && error.name === "SessionRevokedError"
        ? "SessionRevokedError"
        : "ProtocolError";
      const wireError = toError(
        name,
        error instanceof Error ? error.message : String(error),
      );
      // Carry the retriable marker (an anti-replay race a fresh handshake heals)
      // so the client distinguishes it from a permanent denial without parsing
      // the message.
      if (
        name === "AuthorizationError" &&
        (error as { retriable?: unknown }).retriable === true
      ) {
        wireError.retriable = true;
      }
      return respondTypedError<SessionOpenResult>(message.requestId, wireError);
    }
  }

  async ackSession(
    message: SessionAckRequest,
  ): Promise<ResponseMessage<SessionAckResult>> {
    const session = this.#sessions.updateSeenSeq(
      message.space,
      message.sessionId,
      message.seenSeq,
    );
    if (session === null) {
      return respondTypedError<SessionAckResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    try {
      const engine = await this.#openEngine(message.space);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
        },
      };
    } catch (error) {
      return respondTypedError<SessionAckResult>(
        message.requestId,
        toError(
          "SessionError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /**
   * Decides a transaction under its space's publication lock.
   *
   * `publishVerdict`, when provided by a live connection, runs while the lock
   * is held and before any post-commit bookkeeping. Fan-out for the space
   * begins only after both steps finish and the lock is released.
   */
  async transact(
    message: TransactRequest,
    publishVerdict?: PublishTransactVerdict,
  ): Promise<ResponseMessage<Engine.AppliedCommit>> {
    const requestedAt = performance.now();
    return await this.#withSpacePublicationLock(message.space, async () => {
      const lockWaitMs = performance.now() - requestedAt;
      let outcome = "threw";
      try {
        const decision = await this.#decideTransaction(message);
        outcome = decision.response.error?.name ?? "ok";
        let verdictError: { value: unknown } | undefined;
        try {
          publishVerdict?.(decision.response);
        } catch (error) {
          verdictError = { value: error };
        }
        try {
          await decision.postCommit?.();
        } catch (postCommitError) {
          if (verdictError !== undefined) {
            throw new AggregateError(
              [verdictError.value, postCommitError],
              "Verdict publication and post-commit bookkeeping both failed",
            );
          }
          throw postCommitError;
        }
        if (verdictError !== undefined) {
          throw verdictError.value;
        }
        return decision.response;
      } finally {
        // The elapsed span deliberately starts at the REQUEST, not at lock
        // acquisition: what a client waits for is both halves, and the
        // lockWaitMs field is what splits them apart on the dashboard.
        // The wire parser validates only the commit's envelope, so the
        // arrays may be absent here; a malformed commit records with its
        // counts missing rather than masking the transaction's own
        // response with a throw from this finally.
        const commit = message.commit as Partial<ClientCommit>;
        const count = (value: unknown): number | undefined =>
          Array.isArray(value) ? value.length : undefined;
        recordSlowQueryDuration("transact", message.space, requestedAt, {
          lockWaitMs: Math.round(lockWaitMs),
          operations: count(commit.operations),
          readsConfirmed: count(commit.reads?.confirmed),
          readsPending: count(commit.reads?.pending),
          outcome,
        });
      }
    });
  }

  /** Resolve one authoritative OW54 notice. The publication lock, exact-value
   * precondition, original-entry resolution, optional append, and index removal
   * form one same-space atomic decision. */
  async resolveEventAttention(
    message: EventAttentionResolveRequest,
  ): Promise<ResponseMessage<EventAttentionResolveResult>> {
    return await this.#withSpacePublicationLock(message.space, async () => {
      try {
        const session = this.#sessions.get(message.space, message.sessionId);
        if (session === null) {
          return respondTypedError<EventAttentionResolveResult>(
            message.requestId,
            toError("SessionError", "Unknown session for space"),
          );
        }
        const engine = await this.#openEngine(message.space);
        if (this.#sessions.get(message.space, message.sessionId) !== session) {
          return respondTypedError<EventAttentionResolveResult>(
            message.requestId,
            toError("SessionError", "Unknown or replaced session for space"),
          );
        }
        const deny = this.#authorizeMessageWithEngine(
          engine,
          message.space,
          session.principal,
          "WRITE",
        );
        if (deny !== null) {
          return respondTypedError<EventAttentionResolveResult>(
            message.requestId,
            deny,
          );
        }
        const indexDocument = Engine.read(engine, {
          id: SERVER_EXECUTION_ATTENTION_DOC_ID as never,
        });
        const indexValue = indexDocument?.value as
          | EventAttentionIndexValue
          | undefined;
        const sidecarKey = eventAttentionIndexKey(message.sidecarId);
        const entryKey = eventAttentionEntryKey(message.eventId, message.seq);
        const indexEntries = indexValue?.entries;
        const sidecarSummaries = indexEntries !== undefined &&
            Object.hasOwn(indexEntries, sidecarKey)
          ? indexEntries[sidecarKey]
          : undefined;
        const summary = sidecarSummaries !== undefined &&
            Object.hasOwn(sidecarSummaries, entryKey)
          ? sidecarSummaries[entryKey]
          : undefined;
        const resolutionSidecars = indexValue?.resolutions;
        const sidecarResolutions = resolutionSidecars !== undefined &&
            Object.hasOwn(resolutionSidecars, sidecarKey)
          ? resolutionSidecars[sidecarKey]
          : undefined;
        const recorded = sidecarResolutions !== undefined &&
            Object.hasOwn(sidecarResolutions, entryKey)
          ? sidecarResolutions[entryKey]
          : undefined;
        const sidecarDocument = Engine.read(engine, {
          id: message.sidecarId as never,
        });
        const sidecarValue = sidecarDocument?.value as
          | StreamEventsDocValue
          | undefined;
        const entryIndex = sidecarValue?.entries?.findIndex((entry) =>
          entry?.eventId === message.eventId &&
          (entry.seq ?? 0) === message.seq
        ) ?? -1;
        const original = entryIndex < 0
          ? undefined
          : sidecarValue!.entries![entryIndex];
        const principal = session.principal;
        if (original === undefined && recorded !== undefined) {
          if (principal === undefined || recorded.principal !== principal) {
            return respondTypedError<EventAttentionResolveResult>(
              message.requestId,
              toError(
                "AuthorizationError",
                "Only the original acting user may resolve this event",
              ),
            );
          }
          return {
            type: "response",
            requestId: message.requestId,
            ok: {
              serverSeq: Engine.serverSeq(engine),
              resolution: recorded.resolution,
            },
          };
        }
        if (
          original?.status !== "needs-attention" ||
          original.attention === undefined ||
          original.consequenced !== true
        ) {
          throw new Engine.ProtocolError(
            `event ${message.eventId} at seq ${message.seq} has no ` +
              "authoritative attention cover",
          );
        }
        const originalUser = original.firedAt?.user;
        if (
          principal === undefined ||
          (originalUser === undefined
            ? message.action === "retry"
            : originalUser !== principal)
        ) {
          return respondTypedError<EventAttentionResolveResult>(
            message.requestId,
            toError(
              "AuthorizationError",
              originalUser === undefined
                ? "A userless event may be dismissed but not retried"
                : "Only the original acting user may resolve this event",
            ),
          );
        }
        if (original.resolution !== undefined) {
          return {
            type: "response",
            requestId: message.requestId,
            ok: {
              serverSeq: Engine.serverSeq(engine),
              resolution: original.resolution,
            },
          };
        }
        if (
          summary === undefined || summary.sidecarId !== message.sidecarId ||
          summary.eventId !== message.eventId || summary.seq !== message.seq
        ) {
          throw new Engine.ProtocolError(
            `event ${message.eventId} at seq ${message.seq} has no ` +
              "unresolved attention notice",
          );
        }
        const retryEventId = message.action === "retry"
          ? crypto.randomUUID()
          : undefined;
        const resolution = retryEventId === undefined
          ? { kind: "dismissed" as const }
          : { kind: "retried" as const, eventId: retryEventId };
        const escapePointer = (value: string) =>
          value.replace(/~/g, "~0").replace(/\//g, "~1");
        const sidecarPatches: Array<
          | { op: "replace"; path: string; value: unknown }
          | { op: "append"; path: string; values: unknown[] }
        > = [{
          op: "replace",
          path: `/value/entries/${entryIndex}/resolution`,
          value: resolution,
        }];
        if (retryEventId !== undefined) {
          sidecarPatches.push({
            op: "append",
            path: "/value/entries",
            values: [{
              eventId: retryEventId,
              stream: original.stream,
              ...(original.payload === undefined
                ? {}
                : { payload: original.payload }),
              firedAt: {
                user: principal,
                session: message.sessionId,
              },
              ...(original.rendererTrusted === true
                ? { rendererTrusted: true as const }
                : {}),
              ...(original.runtimeInjectedEventKeys === undefined ? {} : {
                runtimeInjectedEventKeys: original.runtimeInjectedEventKeys,
              }),
              retryOf: message.eventId,
            }],
          });
        }
        const recordedResolution = {
          eventId: message.eventId,
          seq: message.seq,
          sidecarId: message.sidecarId,
          principal,
          resolution,
        };
        const indexPatches: Array<
          | { op: "remove"; path: string }
          | { op: "add"; path: string; value: FabricValue }
        > = [{
          op: "remove",
          path: Object.keys(sidecarSummaries ?? {}).length === 1
            ? `/value/entries/${escapePointer(sidecarKey)}`
            : `/value/entries/${escapePointer(sidecarKey)}/${
              escapePointer(entryKey)
            }`,
        }];
        if (resolutionSidecars === undefined) {
          indexPatches.push({
            op: "add",
            path: "/value/resolutions",
            value: { [sidecarKey]: { [entryKey]: recordedResolution } },
          });
        } else if (sidecarResolutions === undefined) {
          indexPatches.push({
            op: "add",
            path: `/value/resolutions/${escapePointer(sidecarKey)}`,
            value: { [entryKey]: recordedResolution },
          });
        } else {
          indexPatches.push({
            op: "add",
            path: `/value/resolutions/${escapePointer(sidecarKey)}/${
              escapePointer(entryKey)
            }`,
            value: recordedResolution,
          });
        }
        const commit = Engine.applyCommit(engine, {
          // Server-owned transaction identity: the requesting user's session
          // has its own localSeq namespace, so borrowing it here would collide
          // with ordinary client commits. The copied retry entry separately
          // records the requesting current session in `firedAt`.
          sessionId: this.#directSessionId,
          space: message.space,
          principal,
          commitClass: "system",
          ...(retryEventId === undefined ? {} : {
            systemEventActor: {
              principal,
              sessionId: message.sessionId,
            },
          }),
          commit: {
            localSeq: ++this.#directLocalSeq,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "entity-value-hash",
              id: summary.sidecarId as never,
              valueHash: commitPreconditionValueHash(sidecarValue as never),
            }],
            operations: [{
              op: "patch",
              id: summary.sidecarId as never,
              patches: sidecarPatches as never,
            }, {
              op: "patch",
              id: SERVER_EXECUTION_ATTENTION_DOC_ID as never,
              patches: indexPatches,
            }],
            ...(retryEventId === undefined ? {} : {
              eventAppends: [{
                id: summary.sidecarId as never,
                scope: "space" as const,
                eventId: retryEventId,
              }],
            }),
          },
        });
        this.markSpaceDirty(message.space, [
          toDirtyKey(summary.sidecarId, "space"),
          toDirtyKey(SERVER_EXECUTION_ATTENTION_DOC_ID, "space"),
        ]);
        this.#notifyCommitAdmitted({
          space: message.space,
          seq: commit.seq,
          class: "system",
          sessionId: this.#directSessionId,
          writes: [
            { id: summary.sidecarId, scopeKey: "space" },
            { id: SERVER_EXECUTION_ATTENTION_DOC_ID, scopeKey: "space" },
          ],
          ...(retryEventId === undefined ? {} : {
            eventAppends: [{
              id: summary.sidecarId,
              scopeKey: "space" as const,
              eventId: retryEventId,
              retryOf: message.eventId,
            }],
          }),
        });
        return {
          type: "response",
          requestId: message.requestId,
          ok: { serverSeq: commit.seq, resolution },
        };
      } catch (error) {
        const messageText = error instanceof Error
          ? error.message
          : String(error);
        return respondTypedError<EventAttentionResolveResult>(
          message.requestId,
          toError(
            error instanceof Engine.ConflictError
              ? "ConflictError"
              : error instanceof Engine.ProtocolError
              ? "ProtocolError"
              : "TransactionError",
            messageText,
          ),
        );
      }
    });
  }

  async #decideTransaction(
    message: TransactRequest,
  ): Promise<TransactDecision> {
    let postCommit: (() => Promise<void>) | undefined;
    const response = await tracer.startActiveSpan(
      "memory.transact",
      async (span): Promise<ResponseMessage<Engine.AppliedCommit>> => {
        span.setAttribute("space.did", message.space);
        if (message.requestId !== undefined) {
          span.setAttribute("request.id", message.requestId);
        }
        if (message.commit.branch !== undefined) {
          span.setAttribute("branch", message.commit.branch);
        }
        // (space.did, session.id, commit.local_seq) is the deterministic join
        // to the CLIENT half of this commit (the runner's storage.push span).
        // Unlike request.id — minted per send attempt and re-minted on
        // reconnect resends — localSeq is stable across retries and known
        // before the response, so it also identifies rejected commits.
        if (message.sessionId !== undefined) {
          span.setAttribute("session.id", message.sessionId);
        }
        if (message.commit.localSeq !== undefined) {
          span.setAttribute("commit.local_seq", message.commit.localSeq);
        }
        // Classify the request before any await or validation so conflicts and
        // rejected attempts remain visible in the same dashboard breakdowns as
        // successful transactions. `entity.count` keeps its existing meaning.
        const commitTelemetry = classifyCommitTelemetry(message.commit);
        const applyOperations = message.commit.operations.filter((operation) =>
          operation.op === "apply-op"
        );
        for (const operation of applyOperations) {
          try {
            operationPayloadBytes.record(
              new TextEncoder().encode(encodeMemoryBoundary(operation.payload))
                .byteLength,
              { codec: operation.codec },
            );
          } catch {
            // Admission below reports malformed Fabric values as a typed
            // protocol error. Telemetry must not pre-empt that response.
          }
        }
        span.setAttribute("commit.kind", commitTelemetry.kind);
        span.setAttribute("entity.count", commitTelemetry.entityCount);
        span.setAttribute(
          "scheduler.observation.count",
          commitTelemetry.schedulerObservationCount,
        );
        span.setAttribute(
          "sqlite.operation.count",
          commitTelemetry.sqliteOperationCount,
        );
        const session = this.#sessions.get(message.space, message.sessionId);
        if (session === null) {
          span.end();
          return respondTypedError<Engine.AppliedCommit>(
            message.requestId,
            toError("SessionError", "Unknown session for space"),
          );
        }
        if (
          session.principal !== undefined &&
          session.principal !== ANYONE_USER
        ) {
          span.setAttribute("user.did", session.principal);
        }
        try {
          const engine = await this.#openEngine(message.space);
          // The session may be revoked or replaced while `#openEngine()`
          // awaits.
          // Re-check the exact registry object before using the captured
          // principal so an old connection cannot commit after takeover.
          if (
            this.#sessions.get(message.space, message.sessionId) !== session
          ) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              toError(
                "SessionError",
                "Unknown or replaced session for space",
              ),
            );
          }
          const invalid = this.#validateAclCommit(
            engine,
            message.space,
            session,
            message.commit,
          );
          if (invalid) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              invalid,
            );
          }
          // ACL-document writes change who may access the space — OWNER only.
          const aclTouched = commitTouchesAclDoc(
            message.commit.operations,
            message.space,
          );
          const deny = this.#authorizeMessageWithEngine(
            engine,
            message.space,
            session.principal,
            aclTouched ? "OWNER" : "WRITE",
          );
          if (deny) {
            return respondTypedError<Engine.AppliedCommit>(
              message.requestId,
              deny,
            );
          }
          // Fold-in SQLite writes: ATTACH their cell-db(s) BEFORE applyCommit (ATTACH
          // cannot run inside a transaction); the engine executes them inside the
          // commit txn (atomic with cell ops). Detach in finally.
          const sqliteAttachments = this.#attachCommitSqliteDbs(
            engine,
            message.space,
            message.commit.operations,
            { principal: session.principal, sessionId: message.sessionId },
          );
          let commit: Engine.AppliedCommit;
          const operationIntegrationStartedAt = applyOperations.length === 0
            ? undefined
            : performance.now();
          try {
            commit = tracer.startActiveSpan(
              "memory.commit.persist",
              (persistSpan) => {
                try {
                  return Engine.applyCommit(engine, {
                    sessionId: message.sessionId,
                    space: message.space,
                    principal: session.principal,
                    commit: message.commit,
                    sqliteAttachments,
                    // Session-facing transact admission: `authored`, always.
                    // The class is determined HERE, by the admission path —
                    // never read from the client payload (protocol.md §1).
                    commitClass: "authored",
                  });
                } finally {
                  persistSpan.end();
                }
              },
            );
          } finally {
            if (operationIntegrationStartedAt !== undefined) {
              operationIntegrationDuration.record(
                performance.now() - operationIntegrationStartedAt,
                { apply_count: applyOperations.length },
              );
            }
            // Detach BEFORE any await. `engine.database` is shared per space, so
            // holding a cell-db attached across the post-commit await would let a
            // concurrent connection's commit attach a SECOND cell-db — breaking the
            // ≤1-attached invariant that unqualified-name resolution relies on
            // (B1). `applyCommit` is synchronous and is the only step that needs the
            // attachments.
            for (const alias of sqliteAttachments.values()) {
              detachDatabase(engine.database, alias);
            }
          }
          for (const resolution of commit.operationResolutions ?? []) {
            const operation =
              message.commit.operations[resolution.operationIndex];
            if (operation?.op === "apply-op") {
              const attributes = {
                codec: resolution.codec,
                duplicate: resolution.duplicate,
              };
              operationApplyCount.add(1, attributes);
              operationTransformSuffix.record(
                resolution.from.version - (operation.base?.version ?? 0),
                attributes,
              );
            }
          }
          // Mark dirty immediately after the durable apply so the next batch
          // reflects this write and can carry its catch-up marker. Keys are
          // per scope INSTANCE (M4): resolved from the committing session's
          // identity — the same resolution admission keyed the rows with, so
          // the dirty key names exactly the row written. Each dirty key is
          // classified by the LAST op this commit applied to it: that op
          // produced the head this commit leaves behind, so it alone
          // decides the flush-time echo shape.
          const committedWrites: Array<{ id: string; scopeKey: ScopeKey }> = [];
          const dirtyOps = new Map<string, DirtyOp>();
          for (const revision of commit.revisions) {
            const scopeKey = revision.scopeKey as ScopeKey;
            committedWrites.push({ id: revision.id, scopeKey });
            dirtyOps.set(
              toDirtyKey(revision.id, scopeKey),
              revision.op,
            );
          }
          if (dirtyOps.size > 0) {
            this.markSpaceDirty(message.space, dirtyOps.keys(), {
              sessionId: message.sessionId,
              seq: commit.seq,
              ops: dirtyOps,
            });
          } else {
            // Every operation elided: nothing was written, so no document
            // turns dirty — but the accept still owes this session its
            // catch-up marker, and the marker rides the batched flush.
            // Schedule the pass without dirtying anything.
            this.markSpaceDirty(message.space);
          }
          // Plane (b): the admission-side activation hook — synchronous
          // with the dirty marking, observer errors shielded. An
          // event-append commit carries its declarations so the serving
          // loop classifies it (serving-loop.md §3) and the host's
          // undelivered-events activation criterion fires even with no
          // live session (serving-loop.md §1). Fires even when every op
          // elided: the commit was RECORDED (the space log advanced) —
          // the feed carries admitted commits; `writes` names only the
          // non-elided ops, so activation still follows novelty.
          const admittedEventAppends = (message.commit.eventAppends ?? []).map((
            decl,
          ) => ({
            id: decl.id,
            scopeKey: resolveScopeKey(decl.scope, {
              principal: session.principal,
              sessionId: message.sessionId,
            }),
            eventId: decl.eventId,
          }));
          this.#notifyCommitAdmitted({
            space: message.space,
            seq: commit.seq,
            class: "authored",
            sessionId: message.sessionId,
            writes: committedWrites,
            ...(admittedEventAppends.length > 0
              ? { eventAppends: admittedEventAppends }
              : {}),
          });
          // Stage the accept's catch-up obligation with the dirty mark. The
          // verdict response leaves this request before the independently
          // scheduled batch can send its covering frame. The batched fan-out
          // stamps `caughtUpLocalSeq >= this localSeq` on the next frame to
          // this session (an otherwise-empty frame if nothing it watches is
          // dirty), and the CLIENT holds the accepted commit's promotion —
          // pending overlay to confirmed mirror — until that marker arrives.
          // The frame therefore reflects every decided outcome ≤ W for the
          // docs it covers.
          // Dirty-origin tracking decides the echo shape for the session's
          // own accepted writes (CT-1965): set- and delete-produced heads are
          // elided from the frame — the writer provably holds their outcome,
          // and the verdict plus marker promote it — while patch-produced
          // heads ride the frame as full post-apply documents, since merged
          // state is truth the writer cannot extrapolate. REJECTED commits'
          // docs are staged origin-less (stageConflictRefreshDirtyIds), so
          // repair frames DO cover them.
          session.pendingCaughtUpLocalSeq = Math.max(
            session.pendingCaughtUpLocalSeq,
            message.commit.localSeq,
          );
          if (aclTouched) {
            this.#invalidateAclCapabilities(message.space);
            // Pass the writing session so it isn't sent the terminal revocation
            // before its own transact response (the client treats session/revoked
            // as terminal). It is dropped from the registry immediately —
            // fan-out resolves registered sessions only — and its terminal
            // session/revoked is DEFERRED until after the verdict is sent
            // (deliverDeferredSelfRevocation): the revocation is what tells
            // the client its marker channel is gone, so its parked accept
            // applies immediately instead of waiting for a marker no
            // detached session will ever be delivered.
            this.#revokeDeauthorizedSessions(
              engine,
              message.space,
              message.sessionId,
            );
          }
          span.setAttribute("commit.seq", commit.seq);
          return {
            type: "response",
            requestId: message.requestId,
            ok: commit,
          };
        } catch (error) {
          if (
            error instanceof Engine.OpCodecError ||
            error instanceof Engine.UnsupportedOpCodecError
          ) {
            operationCodecFailureCount.add(1, {
              error: error.name,
              codec: applyOperations[0]?.codec ?? "unknown",
            });
          }
          let retryAfterSeq: number | undefined;
          if (error instanceof Engine.ConflictError) {
            span.setAttribute("ct.conflict", true);
            this.#stageConflictRefreshDirtyIds(
              message.space,
              session,
              message.commit,
            );
            const engine = await this.#openEngine(message.space);
            retryAfterSeq = Engine.serverSeq(engine);
          }
          const messageText = error instanceof Error
            ? error.message
            : String(error);
          const preconditionError = toPreconditionFailedError(
            error,
            messageText,
          );
          const responseError = preconditionError ? preconditionError : toError(
            error instanceof Engine.ConflictError
              ? "ConflictError"
              // The eventId dedupe-horizon CAS (events.md §4, §5): the name
              // must survive the wire UNCHANGED — a client discharging its
              // offline event queue classifies by it, treating "already
              // appended" as DELIVERED rather than as a failure to surface
              // (re-raising would re-discharge forever). Checked before its
              // ProtocolError parent so the subclass name wins.
              : error instanceof EventAppendDuplicateError
              ? "EventAppendDuplicateError"
              : error instanceof Engine.ProtocolError
              ? error.name
              // A RowLabelCommitError (Phase 3.c commit-time row-label refusal,
              // sqlite/commit-eval.ts) is TERMINAL: re-running recomputes the
              // identical refused write, so the client must not retry it.
              // Preserve the class name unchanged — the runner classifies by it
              // (storage/rejection.ts `isTerminalRejection`); collapsing it into
              // a generic TransactionError would let the doomed handler burn its
              // retry budget and starve concurrent siblings.
              : error instanceof RowLabelCommitError
              ? "RowLabelCommitError"
              : "TransactionError",
            messageText,
          );
          if (retryAfterSeq !== undefined) {
            responseError.retryAfterSeq = retryAfterSeq;
          }
          if (
            error instanceof Engine.ConflictError &&
            error.conflicts !== undefined &&
            error.conflicts.length > 0
          ) {
            responseError.conflicts = [...error.conflicts];
          }
          span.recordException(
            error instanceof Error ? error : new Error(messageText),
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: messageText,
          });
          return respondTypedError<Engine.AppliedCommit>(
            message.requestId,
            responseError,
          );
        } finally {
          span.end();
        }
      },
    );
    return { response, postCommit };
  }

  async graphQuery(
    message: GraphQueryRequest,
  ): Promise<ResponseMessage<GraphQueryResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.#openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<GraphQueryResult>(message.requestId, deny);
      }
    }
    if ((message.query as GraphQuery & { subscribe?: boolean }).subscribe) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError(
          "ProtocolError",
          "live graph.query subscriptions were removed; use session.watch.set",
        ),
      );
    }
    {
      // Phase 5's fail-closed twin (sync — no added await on the
      // unnamed path): a foreign serving session's UNNAMED scoped root
      // refuses rather than silently resolving the service instance.
      const denyForeign = this.#denyForeignServingScopedRead(
        message.space,
        session,
        message.query.roots,
      );
      if (denyForeign) {
        return respondTypedError<GraphQueryResult>(
          message.requestId,
          denyForeign,
        );
      }
    }
    if (this.#namesExplicitInstance(message.query.roots)) {
      // protocol.md §2's read row: explicit entity_scope_key roots are
      // lease-holder-only. Gated on the sync scan so the no-key path
      // adds no await between authorization and evaluation.
      const deny = await this.#denyExplicitInstanceReads(
        message.space,
        session,
        message.query.roots.map((root) => ({
          branch: message.query.branch ?? "",
          root,
        })),
      );
      if (deny) {
        return respondTypedError<GraphQueryResult>(message.requestId, deny);
      }
    }

    try {
      return {
        type: "response",
        requestId: message.requestId,
        ok: await this.evaluateGraphQuery(
          message.space,
          message.query,
          aclEngine,
          undefined,
          {
            principal: session.principal,
            sessionId: message.sessionId,
            // Stage A (OW17's wire leg): a live lease holder's snapshots
            // carry their instance key (it may name two instances of one
            // doc); every other session's result is byte-identical.
            ...(session.leaseHolderReads === true
              ? { keyedSnapshots: true }
              : {}),
          },
        ),
      };
    } catch (error) {
      return respondTypedError<GraphQueryResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async operationFieldQuery(
    message: OperationFieldQueryRequest,
  ): Promise<ResponseMessage<OperationFieldQueryResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<OperationFieldQueryResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    try {
      const engine = await this.#openEngine(message.space);
      const deny = this.#authorizeCurrentSessionWithEngine(
        engine,
        message.space,
        message.sessionId,
        session,
        "READ",
      );
      if (deny) {
        return respondTypedError<OperationFieldQueryResult>(
          message.requestId,
          deny,
        );
      }
      const denyForeign = this.#denyForeignServingScopedRead(
        message.space,
        session,
        [{ id: message.query.id, scope: message.query.scope }],
      );
      if (denyForeign) {
        return respondTypedError<OperationFieldQueryResult>(
          message.requestId,
          denyForeign,
        );
      }
      const field = Engine.queryOperationField(engine, {
        ...message.query,
        principal: session.principal,
        sessionId: message.sessionId,
      });
      if (field.reset === true) {
        operationResetCount.add(1, { source: "query", codec: field.codec! });
      }
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          field,
        },
      };
    } catch (error) {
      return respondTypedError<OperationFieldQueryResult>(
        message.requestId,
        toError(
          error instanceof Engine.ProtocolError ? error.name : "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async listEntityIds(
    message: EntityIdListRequest,
  ): Promise<ResponseMessage<EntityIdListResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<EntityIdListResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.#openEngine(message.space);
      const deny = this.#authorizeCurrentSessionWithEngine(
        engine,
        message.space,
        message.sessionId,
        session,
        "READ",
      );
      if (deny) {
        return respondTypedError<EntityIdListResult>(message.requestId, deny);
      }

      const serverSeq = Engine.serverSeq(engine);
      if (
        message.expectedServerSeq !== undefined &&
        message.expectedServerSeq !== serverSeq
      ) {
        return respondTypedError<EntityIdListResult>(
          message.requestId,
          toError(
            "SnapshotChangedError",
            `entity identifier snapshot changed from server sequence ${message.expectedServerSeq} to ${serverSeq}`,
          ),
        );
      }

      if (
        message.after === undefined && message.limit === undefined &&
        message.expectedServerSeq === undefined
      ) {
        const ids = Engine.listEntityIdPage(engine, {
          limit: MAX_ENTITY_ID_PAGE_SIZE + 1,
        });
        if (ids.length > MAX_ENTITY_ID_PAGE_SIZE) {
          return respondTypedError<EntityIdListResult>(
            message.requestId,
            toError(
              "ProtocolError",
              `unpaginated entity identifier listing exceeds ${MAX_ENTITY_ID_PAGE_SIZE} entries; use pagination`,
            ),
          );
        }
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq,
            ids,
          },
        };
      }

      const limit = Math.min(
        message.limit ?? MAX_ENTITY_ID_PAGE_SIZE,
        MAX_ENTITY_ID_PAGE_SIZE,
      );
      const rows = Engine.listEntityIdPage(engine, {
        after: message.after,
        limit: limit + 1,
      });
      const ids = rows.slice(0, limit);
      const nextAfter = rows.length > limit ? ids.at(-1) : undefined;

      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          ids,
          ...(nextAfter === undefined ? {} : { nextAfter }),
        },
      };
    } catch (error) {
      return respondTypedError<EntityIdListResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  async entityIdExists(
    message: EntityIdLookupRequest,
  ): Promise<ResponseMessage<EntityIdLookupResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<EntityIdLookupResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }

    try {
      const engine = await this.#openEngine(message.space);
      const deny = this.#authorizeCurrentSessionWithEngine(
        engine,
        message.space,
        message.sessionId,
        session,
        "READ",
      );
      if (deny) {
        return respondTypedError<EntityIdLookupResult>(message.requestId, deny);
      }

      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq: Engine.serverSeq(engine),
          exists: Engine.entityIdExists(engine, message.id),
        },
      };
    } catch (error) {
      return respondTypedError<EntityIdLookupResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /** Lists live authenticated views for the co-hosted execution planner. */
  viewInterestsForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): readonly SessionViewInterest[] {
    return this.#sessions.sessionsForSpace(space).flatMap((session) => {
      if (
        options.excludePrincipal !== undefined &&
        session.principal === options.excludePrincipal
      ) return [];
      return session.views.map((view) => ({
        handle: {
          sessionId: session.id,
          sessionEpoch: session.viewEpoch,
          viewEpoch: session.viewEpochs.get(view.id)!,
          viewId: view.id,
          revision: view.revision,
        },
        principal: session.principal,
        attached: session.ownerConnectionId !== null,
        view,
        selectionGeneration: session.viewSelections.get(view.id)?.generation,
      }));
    });
  }

  /** Installs delivery roots for a still-current view under its READ authority. */
  async setViewSelection(space: string, handle: SessionViewHandle, selection: {
    generation: number;
    delivery: readonly ViewQuery[];
    eligibleActions?: readonly string[];
    pieces?: ViewPlan["pieces"];
    inputs?: ViewPlan["inputs"];
    producers?: ViewPlan["producers"];
    errors?: ViewPlan["errors"];
  }): Promise<boolean> {
    selection = cloneIfNecessary(selection, { frozen: false });
    return await this.#withSpacePublicationLock(space, async () => {
      const session = this.#sessions.get(space, handle.sessionId);
      const current = () =>
        session !== null &&
        this.#sessions.get(space, handle.sessionId) === session &&
        session.viewEpoch === handle.sessionEpoch &&
        session.viewEpochs.get(handle.viewId) === handle.viewEpoch &&
        session.views.some((view) =>
          view.id === handle.viewId && view.revision === handle.revision
        );
      if (!current()) return false;
      if (
        !Number.isSafeInteger(selection.generation) ||
        selection.generation < 0 ||
        selection.delivery.some((query) => parseViewQuery(query) === null)
      ) {
        throw new Error("Invalid view selection");
      }
      const engine = await this.#openEngine(space);
      if (
        !current() || this.#authorizeCurrentSessionWithEngine(
          engine,
          space,
          handle.sessionId,
          session!,
          "READ",
        )
      ) return false;
      const denyForeign = this.#denyForeignServingScopedRead(
        space,
        session!,
        watchReadRoots(selection.delivery.map((query, index) => ({
          id: `selection:${index}`,
          kind: "graph" as const,
          query,
        }))),
      );
      if (denyForeign) return false;
      // Resolve schema and graph closure before publishing planner output.
      // A failed selection leaves the session's existing delivery intact.
      await this.evaluateWatchSet(
        space,
        selection.delivery.map((query, index) => ({
          id: `selection:${index}`,
          kind: "graph" as const,
          query,
        })),
        engine,
        { principal: session!.principal, sessionId: session!.id },
      );
      if (!current()) return false;
      const previous = session!.viewSelections.get(handle.viewId);
      if (
        previous !== undefined && selection.generation <= previous.generation
      ) {
        return selection.generation === previous.generation &&
          valueEqual(previous, { ...selection, revision: handle.revision });
      }
      session!.viewSelections.set(handle.viewId, {
        ...selection,
        revision: handle.revision,
      });
      session!.forceFullResync = true;
      this.markSpaceDirty(space, []);
      return true;
    });
  }

  /** Publishes eligibility only with the document frame that supplies its inputs. */
  #attachViewPlans(session: SessionState, sync: SessionSync): void {
    sync.viewPlans = session.views.map((view) => {
      const selection = session.viewSelections.get(view.id);
      return {
        id: view.id,
        revision: view.revision,
        generation: selection?.generation ?? 0,
        eligibleActions: [...(selection?.eligibleActions ?? [])],
        pieces: [...(selection?.pieces ?? [])],
        inputs: [...(selection?.inputs ?? [])],
        producers: [...(selection?.producers ?? [])],
        errors: [...(selection?.errors ?? [])],
      };
    });
  }

  /** Evaluates demand independently from delivery-only supporting roots. */
  async #evaluateViewWatchSet(
    session: SessionState,
    watches: readonly WatchSpec[],
    views: readonly ViewInterest[],
    engine?: Engine.Engine,
  ) {
    engine ??= await this.#openEngine(session.space);
    const identity = { principal: session.principal, sessionId: session.id };
    const renderWatches = views.length === 0
      ? [...watches]
      : [...watches, ...viewWatches(views)].map((watch, index) => ({
        ...watch,
        id: `view-demand:${index}`,
      }));
    const demand = await this.evaluateWatchSet(
      session.space,
      renderWatches,
      engine,
      identity,
    );
    const selected: WatchSpec[] = [];
    for (const view of views) {
      const selection = session.viewSelections.get(view.id);
      if (selection?.revision !== view.revision) continue;
      for (const [index, query] of selection.delivery.entries()) {
        selected.push({
          id: `view-support:${view.id}:${index}`,
          kind: "graph",
          query,
        });
      }
    }
    const delivery = selected.length === 0
      ? demand
      : await this.evaluateWatchSet(
        session.space,
        selected,
        engine,
        identity,
      );
    const graphs = new Map([...demand.graphs].map(([branch, graph]) => [
      views.length === 0 ? branch : `view-demand:${branch}`,
      graph,
    ]));
    if (delivery !== demand) {
      for (const [branch, graph] of delivery.graphs) {
        graphs.set(`view-support:${branch}`, graph);
      }
    }
    return {
      ...delivery,
      graphs,
      entities: this.#entriesFromGraphs(graphs.values(), identity),
      demandGraphs: demand.graphs,
      demandEntities: demand.entities,
    };
  }

  /** Extends ordinary demand while retaining the view's rendered and support graphs. */
  async #extendViewWatchSet(
    session: SessionState,
    watches: readonly WatchSpec[],
    engine?: Engine.Engine,
  ) {
    engine ??= await this.#openEngine(session.space);
    const existing = new Set(session.watches.map((watch) => watch.id));
    const { graphs: demandGraphs } = this.#extendWatchGraphs(
      session,
      engine,
      watches.filter((watch) => !existing.has(watch.id)),
      session.viewDemandGraphs,
    );
    const graphs = new Map(session.graphs);
    for (const [branch, graph] of demandGraphs) {
      graphs.set(`view-demand:${branch}`, graph);
    }
    const identity = this.#sessionScopeIdentity(session);
    return {
      serverSeq: Engine.serverSeq(engine),
      graphs,
      entities: this.#entriesFromGraphs(graphs.values(), identity),
      demandGraphs,
      demandEntities: this.#entriesFromGraphs(demandGraphs.values(), identity),
    };
  }

  async watchSet(
    message: WatchSetRequest,
  ): Promise<ResponseMessage<WatchSetResult>> {
    if (
      message.views !== undefined ||
      (this.#sessions.get(message.space, message.sessionId)?.views.length ??
          0) > 0
    ) {
      return await this.#withSpacePublicationLock(
        message.space,
        () => this.#watchSet(message),
      );
    }
    return await this.#watchSet(message);
  }

  /** Helper for watchSet(), which stages and installs one watch union. */
  async #watchSet(
    message: WatchSetRequest,
    incremental = false,
  ): Promise<ResponseMessage<WatchSetResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<WatchSetResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    if (incremental) {
      for (const watch of message.watches) {
        const previous = session.watches.find((candidate) =>
          candidate.id === watch.id
        );
        if (previous !== undefined && !sameWatchSpec(previous, watch)) {
          return respondTypedError<WatchSetResult>(
            message.requestId,
            toError(
              "ProtocolError",
              "session.watch.add may not replace an existing watch id",
            ),
          );
        }
      }
      message = {
        ...message,
        watches: mergeWatchesById(session.watches, message.watches),
      };
    }
    const parsedViews = parseViewInterests(message.views);
    if (
      parsedViews === null ||
      ((parsedViews?.length ?? 0) > 0 && !getServerExecutionConfig())
    ) {
      return respondTypedError<WatchSetResult>(
        message.requestId,
        toError(
          "ProtocolError",
          "View replication requires valid interests and server execution",
        ),
      );
    }
    const views = parsedViews ?? session.views;
    for (const view of views) {
      const previous = session.views.find((candidate) =>
        candidate.id === view.id
      );
      if (
        previous !== undefined && (view.revision < previous.revision ||
          (view.revision === previous.revision && !valueEqual(view, previous)))
      ) {
        return respondTypedError<WatchSetResult>(
          message.requestId,
          toError("ProtocolError", "A changed view requires a newer revision"),
        );
      }
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.#openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<WatchSetResult>(message.requestId, deny);
      }
    }
    {
      // Phase 5's fail-closed twin (sync — see graphQuery's site).
      const denyForeign = this.#denyForeignServingScopedRead(
        message.space,
        session,
        watchReadRoots([...message.watches, ...viewWatches(views)]),
      );
      if (denyForeign) {
        return respondTypedError<WatchSetResult>(
          message.requestId,
          denyForeign,
        );
      }
    }
    if (
      this.#namesExplicitInstance(
        graphWatchRoots(message.watches),
      )
    ) {
      // protocol.md §2's read row: explicit entity_scope_key roots are
      // lease-holder-only. Gated on the sync scan so the no-key path
      // adds no await between authorization and evaluation.
      const deny = await this.#denyExplicitInstanceReads(
        message.space,
        session,
        graphWatchRootQueries(message.watches),
      );
      if (deny) {
        return respondTypedError<WatchSetResult>(message.requestId, deny);
      }
    }

    try {
      const nextOperationCursors = incremental
        ? new Map(session.operationCursors)
        : new Map<string, OpCursor>();
      const evaluated: Awaited<ReturnType<Server["evaluateWatchSet"]>> & {
        demandGraphs?: typeof session.graphs;
        demandEntities?: typeof session.entities;
      } = views.length === 0
        ? await this.evaluateWatchSet(
          message.space,
          message.watches,
          aclEngine,
          {
            principal: session.principal,
            sessionId: message.sessionId,
          },
        )
        : incremental && !session.forceFullResync
        ? await this.#extendViewWatchSet(session, message.watches, aclEngine)
        : await this.#evaluateViewWatchSet(
          session,
          message.watches,
          views,
          aclEngine,
        );
      const { serverSeq, graphs, entities } = evaluated;
      const demandGraphs = evaluated.demandGraphs ?? graphs;
      const demandEntities = evaluated.demandEntities ?? entities;
      // Stage A (OW17's wire leg): a session whose lease-holder read
      // exemption is live receives instance-KEYED frames — it may
      // name two instances of one (branch, id, scope), which the
      // scope name alone cannot distinguish. Every other session's
      // frames are byte-identical to before.
      const keyed = session.leaseHolderReads === true;
      // Additions diff against this session's delivery state. Replacements
      // use the client's declared holdings, or supply the full union when
      // it declares none. A re-established session can therefore recover
      // missing documents without assuming that its client holds them.
      const sync = incremental
        ? buildDiffSync(
          session.entities,
          entities,
          session.lastSyncedSeq,
          serverSeq,
          undefined,
          keyed,
        )
        : message.holdings === undefined
        ? buildFullSync(
          session.entities,
          entities,
          session.seenSeq,
          serverSeq,
          keyed,
        )
        : buildDiffSync(
          holdingsToCacheEntries(
            message.holdings,
            this.#sessionScopeIdentity(session),
          ),
          entities,
          session.seenSeq,
          serverSeq,
          undefined,
          keyed,
        );
      await this.#attachOperationFields(
        message.space,
        message.sessionId,
        sync,
        message.watches,
        nextOperationCursors,
      );
      if (
        (message.views !== undefined || views.length > 0) &&
        this.#sessions.get(message.space, message.sessionId) !== session
      ) {
        return respondTypedError<WatchSetResult>(
          message.requestId,
          toError(
            "SessionError",
            "View session was replaced during evaluation",
          ),
        );
      }
      const viewEpochs = new Map<string, string>();
      for (const view of views) {
        const previous = session.views.find((candidate) =>
          candidate.id === view.id
        );
        viewEpochs.set(
          view.id,
          previous?.revision === view.revision
            ? session.viewEpochs.get(view.id) ?? crypto.randomUUID()
            : crypto.randomUUID(),
        );
      }
      session.viewEpochs = viewEpochs;
      session.views = views;
      session.viewSelections = new Map(
        [...session.viewSelections].filter(([id, selection]) =>
          views.some((view) =>
            view.id === id && view.revision === selection.revision
          )
        ),
      );
      session.forceFullResync = false;
      session.viewDemandGraphs = demandGraphs;
      session.viewDemandEntities = demandEntities;
      session.watches = [...message.watches];
      session.operationWatches = message.watches.filter((watch) =>
        watch.kind === "operation"
      );
      session.watchIndex = new Map(
        message.watches.map((watch) => [watch.id, watch]),
      );
      session.operationTrackedIds = addOperationWatchTrackedIds(
        new Set(),
        message.watches,
        { principal: session.principal, sessionId: session.id },
      );
      session.operationCursors = nextOperationCursors;
      session.graphs = graphs;
      session.entities = entities;
      session.trackedIds = addOperationWatchTrackedIds(
        trackedIdsFromEntries(entities.values()),
        message.watches,
        { principal: session.principal, sessionId: message.sessionId },
      );
      this.#addMissedToTrackedIds(session.trackedIds, graphs.values());
      for (const key of trackedIdsFromEntries(demandEntities.values())) {
        session.trackedIds.add(key);
      }
      this.#addMissedToTrackedIds(session.trackedIds, demandGraphs.values());
      this.#touchDemand(session);
      session.lastSyncedSeq = serverSeq;
      if (message.views !== undefined || views.length > 0) {
        this.#attachViewPlans(session, sync);
      }
      this.#notifyDemandChanged(message.space, "watch", session.principal);
      return {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          sync,
        },
      };
    } catch (error) {
      // Evaluation state is staged (the session's graphs and watches are
      // assigned only on success), so a failure answers the requester —
      // a malformed or unevaluable query is the caller's diagnostic, not
      // a reason to tear the connection down.
      return respondTypedError<WatchSetResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /** Stages additions without re-evaluating roots already covered by a graph. */
  #extendWatchGraphs(
    session: SessionState,
    engine: Engine.Engine,
    watches: readonly WatchSpec[],
    previous: SessionState["graphs"],
  ) {
    const graphs = new Map(previous);
    const identity = this.#sessionScopeIdentity(session);

    const updates = new Map<string, SessionCacheEntry>();
    const recordUpdate = (docKey: QueryDocKey, entity: EntitySnapshot) => {
      const { scopeKey } = fromDocKey(docKey);
      const entry = toCacheEntry(entity, identity, scopeKey);
      updates.set(
        cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
        entry,
      );
    };
    const attribution = createRootAttribution();
    for (const [branch, query] of groupedQueries(watches)) {
      const existing = graphs.get(branch);
      if (existing === undefined) {
        const tracked = trackGraph(
          session.space,
          engine,
          query,
          undefined,
          {
            principal: session.principal,
            sessionId: session.id,
            evaluationCache: this.#evaluationCacheFor(session.space),
          },
        );
        foldRootAttribution(attribution, tracked.stats);
        // Enforced per evaluation, not per request: a later group's
        // failure (or a failing operation-field attachment) must not
        // leave an already-inserted entry over budget.
        this.#enforceEvaluationCacheBudget();
        graphs.set(branch, tracked.state);
        for (const [docKey, entity] of tracked.state.entities) {
          recordUpdate(docKey, entity);
        }
        continue;
      }

      if (isGraphQueryCoveredByState(session.space, existing, query)) {
        continue;
      }

      const staged = cloneTrackedGraphState(engine, existing);
      graphs.set(branch, staged);
      const extended = extendTrackedGraph(
        session.space,
        engine,
        staged,
        query,
      );
      foldRootAttribution(attribution, extended.stats);
      for (const [docKey, entity] of extended.updates) {
        recordUpdate(docKey, entity);
      }
    }

    return { graphs, updates, attribution };
  }

  /** Add session watches, timing admission through the handler's completion. */
  async watchAdd(
    message: WatchAddRequest,
  ): Promise<ResponseMessage<WatchAddResult>> {
    const startedAt = performance.now();
    try {
      return await this.#watchAdd(message);
    } finally {
      timing.time(startedAt, "memory", "watchAdd", "total");
    }
  }

  /** Helper for watchAdd(), which authorizes, evaluates, and installs watches. */
  async #watchAdd(
    message: WatchAddRequest,
  ): Promise<ResponseMessage<WatchAddResult>> {
    const session = this.#sessions.get(message.space, message.sessionId);
    if (session === null) {
      return respondTypedError<WatchAddResult>(
        message.requestId,
        toError("SessionError", "Unknown session for space"),
      );
    }
    if (session.views.length > 0) {
      return await this.#withSpacePublicationLock(
        message.space,
        () =>
          this.#watchSet({
            ...message,
            type: "session.watch.set",
          }, true),
      );
    }
    const aclEngine = this.#aclMode() === "off"
      ? undefined
      : await this.#openEngine(message.space);
    {
      const deny = aclEngine === undefined
        ? await this.#authorizeMessage(
          message.space,
          session.principal,
          "READ",
        )
        : this.#authorizeCurrentSessionWithEngine(
          aclEngine,
          message.space,
          message.sessionId,
          session,
          "READ",
        );
      if (deny) {
        return respondTypedError<WatchAddResult>(message.requestId, deny);
      }
    }
    {
      // Phase 5's fail-closed twin (sync — see graphQuery's site).
      const denyForeign = this.#denyForeignServingScopedRead(
        message.space,
        session,
        watchReadRoots(message.watches),
      );
      if (denyForeign) {
        return respondTypedError<WatchAddResult>(
          message.requestId,
          denyForeign,
        );
      }
    }
    if (
      this.#namesExplicitInstance(
        graphWatchRoots(message.watches),
      )
    ) {
      // protocol.md §2's read row: explicit entity_scope_key roots are
      // lease-holder-only. Gated on the sync scan so the no-key path
      // adds no await between authorization and evaluation. watch.add
      // EXTENDS the session's watch set, so the wire-collapse guard
      // inside the deny must see the UNION — an instance conflict
      // between an added root and an existing watch's root is the same
      // ambiguity as within one message.
      const deny = await this.#denyExplicitInstanceReads(
        message.space,
        session,
        graphWatchRootQueries([...message.watches, ...session.watches]),
      );
      if (deny) {
        return respondTypedError<WatchAddResult>(message.requestId, deny);
      }
    }

    try {
      const startedAt = performance.now();
      const engine = aclEngine ?? await this.#openEngine(message.space);
      // Resume can share watch containers with an older registry object. Only
      // the current registry object may publish into those containers.
      if (this.#sessions.get(message.space, message.sessionId) !== session) {
        return respondTypedError<WatchAddResult>(
          message.requestId,
          toError("SessionError", "Unknown session for space"),
        );
      }
      const nextOperationCursors = new StagedMap(session.operationCursors);
      const existingById = new StagedMap(session.watchIndex);
      const newWatches: WatchSpec[] = [];
      for (const watch of message.watches) {
        const existing = session.watchIndex.get(watch.id);
        if (existing !== undefined && !sameWatchSpec(existing, watch)) {
          return respondTypedError<WatchAddResult>(
            message.requestId,
            toError(
              "ProtocolError",
              "session.watch.add may not replace an existing watch id; use session.watch.set",
            ),
          );
        }
        if (existing === undefined) {
          newWatches.push(watch);
          existingById.set(watch.id, watch);
        }
      }

      if (newWatches.length === 0) {
        const serverSeq = Engine.serverSeq(engine);
        return {
          type: "response",
          requestId: message.requestId,
          ok: {
            serverSeq,
            sync: {
              type: "sync",
              fromSeq: session.lastSyncedSeq,
              toSeq: serverSeq,
              upserts: [],
              removes: [],
            },
          },
        };
      }

      const addedWatches = [...existingById.changedKeys()].map((id) =>
        existingById.get(id)!
      );
      const normalizesDuplicates =
        session.watchIndex.size !== session.watches.length;
      const nextWatches = !normalizesDuplicates
        ? session.watches
        : [...session.watchIndex.values()];
      const nextOperationWatches = normalizesDuplicates
        ? nextWatches.filter((watch) => watch.kind === "operation")
        : session.operationWatches;
      const addedOperationWatches = addedWatches.filter((watch) =>
        watch.kind === "operation"
      );
      const graphs = new StagedMap(session.graphs);
      const graphCommits: Array<() => void> = [];
      const addedInterests = addOperationWatchTrackedIds(
        new Set(),
        addedWatches,
        { principal: session.principal, sessionId: session.id },
      );
      const identity = this.#sessionScopeIdentity(session);

      const updates = new Map<string, SessionCacheEntry>();
      const recordUpdate = (docKey: QueryDocKey, entity: EntitySnapshot) => {
        const { scopeKey } = fromDocKey(docKey);
        const entry = toCacheEntry(entity, identity, scopeKey);
        updates.set(
          cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
          entry,
        );
      };
      const attribution = createRootAttribution();
      for (const [branch, query] of groupedQueries(newWatches)) {
        const existing = graphs.get(branch);
        if (existing === undefined) {
          const tracked = trackGraph(
            message.space,
            engine,
            query,
            undefined,
            {
              principal: session.principal,
              sessionId: message.sessionId,
              evaluationCache: this.#evaluationCacheFor(message.space),
            },
          );
          foldRootAttribution(attribution, tracked.stats);
          // Enforced per evaluation, not per request: a later group's
          // failure (or a failing operation-field attachment) must not
          // leave an already-inserted entry over budget.
          this.#enforceEvaluationCacheBudget();
          graphs.set(branch, tracked.state);
          this.#addMissedToTrackedIds(addedInterests, [tracked.state]);
          for (const [docKey, entity] of tracked.state.entities) {
            recordUpdate(docKey, entity);
          }
          continue;
        }

        if (isGraphQueryCoveredByState(message.space, existing, query)) {
          continue;
        }

        const staged = stageTrackedGraphState(engine, existing);
        graphCommits.push(staged.commit);
        const extended = extendTrackedGraph(
          message.space,
          engine,
          staged.value,
          query,
        );
        foldRootAttribution(attribution, extended.stats);
        for (const [docKey, entity] of extended.updates) {
          recordUpdate(docKey, entity);
        }
        for (const key of staged.changedMisses()) {
          const { id, scopeKey } = fromDocKey(key as QueryDocKey);
          addedInterests.add(toDirtyKey(id, scopeKey));
        }
      }

      // Build the complete result before mutating the session. Its entity
      // cache is the delivered-entry diff base, and operation snapshot
      // attachment can reject a stale or future cursor. A failed watch.add
      // must leave both kinds of delivery state untouched or later syncs can
      // omit data the requester never received.
      const upserts: SessionCacheEntry[] = [];
      for (const [key, entry] of updates) {
        if (!sameSnapshot(session.entities.get(key), entry)) {
          upserts.push(entry);
        }
      }
      const serverSeq = Engine.serverSeq(engine);
      const fromSeq = session.lastSyncedSeq;
      const sync: SessionSync = {
        type: "sync",
        fromSeq,
        toSeq: serverSeq,
        upserts: upserts.toSorted((left, right) =>
          left.branch.localeCompare(right.branch) ||
          left.id.localeCompare(right.id)
        ),
        removes: [],
      };
      this.#attachOperationFieldsWithEngine(
        engine,
        session,
        sync,
        newWatches.filter((watch) => watch.kind === "operation"),
        nextOperationCursors,
      );
      const response: ResponseMessage<WatchAddResult> = {
        type: "response",
        requestId: message.requestId,
        ok: {
          serverSeq,
          sync: {
            ...sync,
            upserts: upserts.toSorted((left, right) =>
              left.branch.localeCompare(right.branch) ||
              left.id.localeCompare(right.id)
            ).map((entry) =>
              toWireUpsert(entry, session.leaseHolderReads === true)
            ),
          },
        },
      };
      // There is no await between graph staging and publication. Evaluation,
      // operation cursors, and wire conversion can all fail before this point.
      for (const commit of graphCommits) commit();
      graphs.commit();
      nextOperationCursors.commit();
      existingById.commit();
      for (const watch of addedWatches) nextWatches.push(watch);
      session.watches = nextWatches;
      for (const watch of addedOperationWatches) {
        nextOperationWatches.push(watch);
      }
      session.operationWatches = nextOperationWatches;
      if (normalizesDuplicates) session.operationTrackedIds = new Set();
      addOperationWatchTrackedIds(
        session.operationTrackedIds,
        normalizesDuplicates ? nextWatches : addedWatches,
        {
          principal: session.principal,
          sessionId: session.id,
        },
      );
      for (const [key, entry] of updates) {
        session.entities.set(key, entry);
        addedInterests.add(toDirtyKey(entry.id, entry.scopeKey));
      }
      // Extension only adds ownership. Refresh retires changed misses against
      // all remaining owners; watch replacement rebuilds the complete set.
      for (const key of addedInterests) session.trackedIds.add(key);
      // Accepted replacement lists can contain duplicate ids. Normalizing such
      // a list on addition can remove an operation owner; this exceptional
      // path rebuilds complete provenance, including any delivered holdings.
      if (normalizesDuplicates) {
        session.trackedIds = addOperationWatchTrackedIds(
          trackedIdsFromEntries(session.entities.values()),
          nextWatches,
          { principal: session.principal, sessionId: session.id },
        );
        this.#addMissedToTrackedIds(
          session.trackedIds,
          session.graphs.values(),
        );
      }
      this.#touchDemand(session);
      session.lastSyncedSeq = serverSeq;
      this.#notifyDemandChanged(message.space, "watch", session.principal);
      recordSlowQueryDuration(
        "session.watch.add",
        message.space,
        startedAt,
        {
          watches: message.watches.length,
          upserts: upserts.length,
          ...attribution,
        },
      );
      return response;
    } catch (error) {
      // Evaluation state is staged (the session's graphs and watches are
      // assigned only on success), so a failure answers the requester —
      // a malformed or unevaluable query is the caller's diagnostic, not
      // a reason to tear the connection down.
      return respondTypedError<WatchAddResult>(
        message.requestId,
        toError(
          "QueryError",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  #evaluationCacheFor(space: string): QueryEvaluationCache {
    let cache = this.#queryEvaluationCaches.get(space);
    if (cache !== undefined) {
      // Recency bump: insertion order is the LRU order.
      this.#queryEvaluationCaches.delete(space);
      this.#queryEvaluationCaches.set(space, cache);
      return cache;
    }
    cache = createQueryEvaluationCache();
    this.#queryEvaluationCaches.set(space, cache);
    // An inactive space's cache would otherwise linger until that space's
    // next commit — which may never come. The space bound is the
    // cardinality backstop; the memory bound is the weight budget below.
    if (this.#queryEvaluationCaches.size > QUERY_EVALUATION_CACHE_MAX_SPACES) {
      const oldest = this.#queryEvaluationCaches.keys().next().value;
      if (oldest !== undefined) {
        this.#queryEvaluationCaches.delete(oldest);
      }
    }
    return cache;
  }

  /** Evict least-recently-evaluated spaces' oldest entries until the
   * caches' total retained weight fits the budget. Runs after every
   * evaluation that may have inserted; an entry heavier than the whole
   * budget is therefore never retained past its own evaluation. */
  #enforceEvaluationCacheBudget(): void {
    const budget = this.options.queryEvaluationCacheBudget ??
      QUERY_EVALUATION_CACHE_BUDGET;
    let total = 0;
    for (const cache of this.#queryEvaluationCaches.values()) {
      total += cache.weight;
    }
    if (total <= budget) return;
    // Entry-less leftovers (drained by an earlier pass, or rotation-
    // cleared and idle since) drop before eviction: an empty cache holds
    // no weight, only a stale LRU slot. The rebuild preserves order.
    this.#queryEvaluationCaches = new Map(
      [...this.#queryEvaluationCaches].filter(
        ([, cache]) => cache.entries.size > 0,
      ),
    );
    // Least-recently-evaluated spaces first (map insertion order IS the
    // LRU order), oldest entry first within each. A space drained by THIS
    // pass keeps its cache — its counters and LRU position belong to a
    // live space — and is swept as a leftover by the next enforcement.
    for (const cache of [...this.#queryEvaluationCaches.values()]) {
      while (total > budget && cache.entries.size > 0) {
        const oldestEntry = cache.entries.keys().next().value!;
        const entry = cache.entries.get(oldestEntry)!;
        cache.entries.delete(oldestEntry);
        cache.weight -= entry.weight;
        total -= entry.weight;
      }
      if (total <= budget) return;
    }
  }

  /** The space's evaluation-cache counters, for diagnostics and tests.
   * A peek: an absent (never-evaluated or evicted) space reads as empty
   * rather than being created or recency-bumped by the question. */
  evaluationCacheDiagnostics(
    space: string,
  ): QueryEvaluationCacheDiagnostics {
    const cache = this.#queryEvaluationCaches.get(space);
    return queryEvaluationCacheDiagnostics(
      cache ?? createQueryEvaluationCache(),
    );
  }

  async evaluateGraphQuery(
    space: string,
    query: GraphQuery,
    engine?: Engine.Engine,
    reuse?: QueryGraphReuseContext,
    scopeContext: {
      principal?: string;
      sessionId?: string;
      keyedSnapshots?: boolean;
    } = {},
  ): Promise<GraphQueryResult> {
    const startedAt = performance.now();
    // Cache eligibility decided BEFORE touching the LRU: a historical or
    // lease-holder-exempt query neither serves nor records an entry, and
    // must not create a cache or evict a live space's on its way through.
    const cacheEligible = query.atSeq === undefined &&
      scopeContext.keyedSnapshots !== true;
    try {
      // `stats` is diagnostics, not wire: split it off here so the
      // response carries exactly the declared result shape.
      const { stats, ...result } = queryGraph(
        space,
        engine ?? await this.#openEngine(space),
        query,
        reuse,
        {
          ...scopeContext,
          ...(cacheEligible
            ? { evaluationCache: this.#evaluationCacheFor(space) }
            : {}),
        },
      );
      recordSlowQueryDuration("graph.query", space, startedAt, {
        roots: query.roots.length,
        ...rootAttributionOf(stats),
      });
      return result;
    } finally {
      // The insert precedes the snapshot mapping, so enforcement must
      // cover the throw path too.
      if (cacheEligible) {
        this.#enforceEvaluationCacheBudget();
      }
    }
  }

  async evaluateWatchSet(
    space: string,
    watches: readonly WatchSpec[],
    engine?: Engine.Engine,
    scopeContext: { principal?: string; sessionId?: string } = {},
  ): Promise<{
    serverSeq: number;
    graphs: Map<string, TrackedGraphState>;
    entities: Map<string, SessionCacheEntry>;
  }> {
    const startedAt = performance.now();
    const resolvedEngine = engine ?? await this.#openEngine(space);
    const reuse: QueryGraphReuseContext = {
      managers: new Map(),
    };
    const graphs = new Map<string, TrackedGraphState>();
    let serverSeq = Engine.serverSeq(resolvedEngine);

    const attribution = createRootAttribution();
    for (const [branch, query] of groupedQueries(watches)) {
      const result = trackGraph(
        space,
        resolvedEngine,
        query,
        reuse,
        {
          ...scopeContext,
          evaluationCache: this.#evaluationCacheFor(space),
        },
      );
      foldRootAttribution(attribution, result.stats);
      serverSeq = result.serverSeq;
      this.#enforceEvaluationCacheBudget();
      graphs.set(branch, result.state);
    }

    recordSlowQueryDuration("session.watch.set", space, startedAt, {
      watches: watches.length,
      ...attribution,
    });
    return {
      serverSeq,
      graphs,
      entities: this.#entriesFromGraphs(graphs.values(), scopeContext),
    };
  }

  /** Merges document snapshots without merging demand and delivery provenance. */
  #entriesFromGraphs(
    graphs: Iterable<TrackedGraphState>,
    scopeContext: { principal?: string; sessionId?: string },
  ): Map<string, SessionCacheEntry> {
    const entities = new Map<string, SessionCacheEntry>();
    for (const graph of graphs) {
      for (const [docKey, entity] of graph.entities) {
        const { scopeKey } = fromDocKey(docKey);
        const entry = toCacheEntry(entity, scopeContext, scopeKey);
        const key = cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey);
        const existing = entities.get(key);
        if (
          existing === undefined ||
          entry.seq > existing.seq ||
          (entry.seq === existing.seq && existing.deleted && !entry.deleted)
        ) {
          entities.set(key, entry);
        }
      }
    }
    return entities;
  }

  /** Returns execution demand, including absent dependencies, for a view session. */
  #viewDemandIds(session: SessionState): Set<string> {
    const ids = trackedIdsFromEntries(session.viewDemandEntities.values());
    this.#addMissedToTrackedIds(ids, session.viewDemandGraphs.values());
    return ids;
  }

  /**
   * Helper for `demandForSpace()`, which builds `session`'s share of the
   * demand set from its current state: the tracked keys its graph watches
   * reach, and its watch roots whether reached or not.
   */
  #buildSessionDemand(session: SessionState): SessionDemand {
    const rows = new Map<string, DemandedInstanceRow>();
    const identity = {
      ...(session.principal === undefined
        ? {}
        : { principal: session.principal }),
      sessionId: session.id,
    };
    // The session's watch ROOT keys (instance-keyed like trackedIds).
    const rootKeys = new Set<string>();
    for (const watch of [...session.watches, ...viewWatches(session.views)]) {
      if (watch.kind === "operation") continue;
      for (const root of watch.query.roots) {
        const scope = root.scope ?? "space";
        if (scope === "space") {
          rootKeys.add(toDirtyKey(root.id, "space"));
          continue;
        }
        try {
          rootKeys.add(
            toDirtyKey(
              root.id,
              resolveScopeKey(scope, {
                principal: session.principal,
                sessionId: session.id,
              }),
            ),
          );
        } catch {
          // unresolvable scope: not demand for that instance
        }
      }
    }
    // Operation watches share session dirtiness tracking so their updates
    // wake the push loop, but they are not graph execution demand. Rebuild
    // the graph-only provenance from delivered entries plus traversal misses
    // before producing demand rows.
    const graphTrackedIds = trackedIdsFromEntries(
      (session.views.length === 0
        ? session.entities
        : session.viewDemandEntities).values(),
    );
    this.#addMissedToTrackedIds(
      graphTrackedIds,
      (session.views.length === 0 ? session.graphs : session.viewDemandGraphs)
        .values(),
    );
    const emit = (dirtyKey: string, root: boolean) => {
      const existing = rows.get(dirtyKey);
      if (existing !== undefined) {
        if (root) existing.root = true;
        return;
      }
      let parsed: { id: string; scopeKey: ScopeKey; scope: CellScope };
      try {
        parsed = fromDirtyKey(dirtyKey);
      } catch {
        return;
      }
      rows.set(dirtyKey, {
        id: parsed.id,
        scope: parsed.scope,
        scopeKey: parsed.scopeKey,
        identity,
        root,
      });
    };
    for (const dirtyKey of session.trackedIds) {
      if (graphTrackedIds.has(dirtyKey)) {
        emit(dirtyKey, rootKeys.has(dirtyKey));
      }
    }
    for (const dirtyKey of rootKeys) emit(dirtyKey, true);
    return { sessionId: session.id, rows };
  }

  /**
   * Drops `session`'s kept share of the demand set, so the next
   * `demandForSpace()` builds it again. Called at every write to an input of
   * `#buildSessionDemand()`, and harmless at a write that turns out to change
   * nothing: the next read pays for one rebuild and returns equal rows.
   */
  #touchDemand(session: SessionState): void {
    this.#sessionDemand.delete(session);
    // A reopen registers a new object that shares this one's watch list,
    // entity map, tracked set, and graphs, so a write made through an object
    // the registry has since replaced — by a pass that read it before the
    // reopen — changes the replacement's demand as well.
    const current = this.#sessions.peek(session.space, session.id);
    if (current !== undefined) this.#sessionDemand.delete(current);
  }

  /** Roll back the delivery state a computed-but-undelivered sync frame
   * advanced: forget the frame's docs from the session cache (so the next
   * evaluation cannot elide them as already-snapshotted), re-stage its
   * marker obligation, and re-dirty its ids origin-less so a pass is
   * scheduled and the docs fan out authoritatively. Rollback rather than
   * buffering: only a locally-throwing send is visible in-process, and a
   * dying socket loses "successfully sent" frames just the same — the
   * durable repair for that is resume-time catch-up, not a server-side
   * buffer. A doc REMOVED by the lost frame is the accepted residue: its
   * cache entry is already gone and cannot be re-diffed; the client keeps
   * it until a full re-evaluation or reconnect (watch-shrink removes are
   * advisory today). */
  rollbackUndeliveredSync(
    space: string,
    sessionId: string,
    undelivered: SessionEffectMessage,
  ): void {
    const session = this.#sessions.get(space, sessionId);
    if (session === null) {
      return;
    }
    const sync = undelivered.effect;
    if (sync.viewPlans !== undefined) session.forceFullResync = true;
    // Both arms below rewrite the delivered entities and the tracked set.
    this.#touchDemand(session);
    const identity = this.#sessionScopeIdentity(session);
    const ids: string[] = [];
    // The frame's OWN delivery record carries the exact instance-keyed
    // entries it was built from (#deliveredFrameEntries — the wire form
    // strips scope keys, so the frame alone cannot name its instances:
    // a lease holder's explicit foreign instances would mis-resolve to
    // its own here). The session-identity recovery below remains as the
    // fallback for frames without a record (none are built today).
    const record = this.#deliveredFrameEntries.get(undelivered);
    for (const delivery of sync.operationFields ?? []) {
      // A failed send did not advance the client. Forget the delivery cursor so
      // the recomputed frame includes a complete safe snapshot rather than
      // risking a gap. Mixed document/operation frames also carry a delivery
      // record, so this rollback belongs before either document path returns.
      session.operationCursors.delete(delivery.watchId);
    }
    // Wire frames carry scope NAMES; the session's own identity recovers
    // the instance keys (M4). An unresolvable scope cannot have been in a
    // frame built FOR this session — skip defensively rather than throw
    // on the rollback path.
    const instanceKeyFor = (
      scope: CellScope | undefined,
    ): ScopeKey | undefined =>
      canResolveScopeKey(scope, identity)
        ? resolveScopeKey(scope, identity)
        : undefined;
    if (record !== undefined) {
      for (const entry of record.upserts) {
        session.entities.delete(
          cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
        );
        ids.push(toDirtyKey(entry.id, entry.scopeKey));
      }
      for (const entry of record.removes) {
        // The remove's cache entry died when the frame was built;
        // re-insert a tombstone claiming the client still holds the doc,
        // and force the next sync through a FULL evaluation — the
        // incremental path never emits removes, so only a full re-diff
        // (tombstone present, entity absent) regenerates the removal.
        session.entities.set(
          cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
          {
            branch: entry.branch,
            id: entry.id,
            scope: entry.scope,
            scopeKey: entry.scopeKey,
            seq: 0,
            deleted: true,
          },
        );
        session.trackedIds.add(toDirtyKey(entry.id, entry.scopeKey));
        session.forceFullResync = true;
        ids.push(toDirtyKey(entry.id, entry.scopeKey));
      }
      this.#rollbackCaughtUpMarker(session, sync);
      this.markSpaceDirty(space, ids);
      return;
    }
    for (const upsert of sync.upserts) {
      // A keyed frame (stage A: lease-holder frames carry the instance)
      // names its own instance; the session-identity recovery is the
      // fallback for unkeyed frames.
      const scopeKey = upsert.scopeKey ?? instanceKeyFor(upsert.scope);
      if (scopeKey === undefined) continue;
      session.entities.delete(
        cacheKeyForEntity(upsert.branch, upsert.id, scopeKey),
      );
      ids.push(toDirtyKey(upsert.id, scopeKey));
      // A lease-holder session's explicit foreign instances mis-resolve
      // to its own under this session-identity recovery (the wire frame
      // carries scope NAMES): force the full re-evaluation, which
      // re-diffs every instance from the graph's own instance keys.
      if (
        session.leaseHolderReads === true &&
        upsert.scope !== undefined && upsert.scope !== "space"
      ) {
        session.forceFullResync = true;
      }
    }
    for (const remove of sync.removes) {
      // The remove's cache entry died when the frame was built; re-insert a
      // tombstone claiming the client still holds the doc, and force the
      // next sync through a FULL evaluation — the incremental path never
      // emits removes, so only a full re-diff (tombstone present, entity
      // absent) regenerates the removal for the client.
      const scope = declaredScope(remove.scope);
      const scopeKey = remove.scopeKey ?? instanceKeyFor(remove.scope);
      if (scopeKey === undefined) continue;
      session.entities.set(
        cacheKeyForEntity(remove.branch, remove.id, scopeKey),
        {
          branch: remove.branch,
          id: remove.id,
          scope,
          scopeKey,
          seq: 0,
          deleted: true,
        },
      );
      session.trackedIds.add(toDirtyKey(remove.id, scopeKey));
      session.forceFullResync = true;
      ids.push(toDirtyKey(remove.id, scopeKey));
    }
    this.#rollbackCaughtUpMarker(session, sync);
    this.markSpaceDirty(space, ids);
  }

  /** The marker half of a delivery rollback: the marker was consumed
   * into `caughtUpLocalSeq` when the frame was built; rewind BOTH
   * counters or the re-staged obligation compares as already-satisfied
   * and never re-fires. A temporarily lowered caughtUpLocalSeq is safe
   * to expose (resume reporting is client-side monotonic). */
  #rollbackCaughtUpMarker(session: SessionState, sync: SessionSync): void {
    if (sync.caughtUpLocalSeq === undefined) return;
    session.pendingCaughtUpLocalSeq = Math.max(
      session.pendingCaughtUpLocalSeq,
      sync.caughtUpLocalSeq,
    );
    session.caughtUpLocalSeq = Math.min(
      session.caughtUpLocalSeq,
      sync.caughtUpLocalSeq - 1,
    );
  }

  /** Union a session's graph MISS keys into a tracked-id set (the
   * dead-end reads its walks found absent — TrackedGraphState.missed):
   * the wake pass must treat a commit to a missed doc as touching the
   * session, or the doc's CREATION never re-fires the query and a quiet
   * space starves every read that dead-ended on it (OW45 arm B). Misses
   * are wake-reactivity only — they are never delivered, so they flow
   * into `trackedIds` beside the delivered entities at every site that
   * rebuilds or folds that set. */
  #addMissedToTrackedIds(
    trackedIds: Set<string>,
    graphs: Iterable<TrackedGraphState>,
  ): void {
    for (const graph of graphs) {
      for (const [key] of graph.missed) {
        let parsed: { id: string; scopeKey: ScopeKey };
        try {
          parsed = fromDocKey(key as QueryDocKey);
        } catch {
          continue;
        }
        trackedIds.add(toDirtyKey(parsed.id, parsed.scopeKey));
      }
    }
  }

  /**
   * Reconciles changed interests against delivered entries, operation watches,
   * and remaining misses on every branch. A last-owner departure retires the
   * key; overlapping owners keep it reactive. Full replacement handles removal
   * of delivered entries and any client-declared holdings outside the graphs.
   */
  #reconcileTrackedInterests(
    session: SessionState,
    keys: Iterable<string>,
  ): boolean {
    let changed = false;
    for (const key of keys) {
      const { id, scopeKey } = fromDirtyKey(key);
      let owned = session.operationTrackedIds.has(key);
      if (!owned) {
        const docKey: QueryDocKey = `${session.space}/${scopeKey}/${id}`;
        for (const graph of session.graphs.values()) {
          if (
            session.entities.has(
              cacheKeyForEntity(graph.branch, id, scopeKey),
            ) ||
            graph.missed.has(docKey)
          ) {
            owned = true;
            break;
          }
        }
      }
      if (owned) {
        if (!session.trackedIds.has(key)) {
          session.trackedIds.add(key);
          changed = true;
        }
      } else if (session.trackedIds.delete(key)) changed = true;
    }
    return changed;
  }

  /** Evaluates a frame under the same publication turn as its view manifest. */
  syncSessionForConnection(
    space: string,
    sessionId: string,
    dirtyIds?: ReadonlySet<string>,
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
    publicationLocked = false,
  ): Promise<SessionEffectMessage | null> {
    if (
      !publicationLocked &&
      (this.#sessions.get(space, sessionId)?.views.length ?? 0) > 0
    ) {
      return this.#withSpacePublicationLock(
        space,
        () =>
          this.#syncSessionForConnection(
            space,
            sessionId,
            dirtyIds,
            dirtyOrigins,
          ),
      );
    }
    return this.#syncSessionForConnection(
      space,
      sessionId,
      dirtyIds,
      dirtyOrigins,
    );
  }

  #syncSessionForConnection(
    space: string,
    sessionId: string,
    dirtyIds?: ReadonlySet<string>,
    dirtyOrigins?: ReadonlyMap<string, DirtyOrigin>,
  ): Promise<SessionEffectMessage | null> {
    const session = this.#sessions.get(space, sessionId);
    if (session === null) {
      return Promise.resolve(null);
    }
    // The catch-up marker is consumed into `session.caughtUpLocalSeq` (and
    // stamped on the frame) DURING evaluation; capture the pre-call values
    // so a throwing evaluation can restore them — the marker is the one
    // piece of delivery state a lost frame cannot regenerate through the
    // dirty-batch requeue (CT-1927 review, round 6).
    const preCallCaughtUp = session.caughtUpLocalSeq;
    const preCallPending = session.pendingCaughtUpLocalSeq;
    const preCallForceFullResync = session.forceFullResync;
    // Whether THIS pass re-armed a lapsed lease-holder exemption (see
    // below); restored on a throw so the re-arm's full evaluation is
    // not lost with the failed pass.
    let rearmedLeaseHolder = false;
    if (session.forceFullResync) {
      // Rollback re-inserted tombstones for a lost frame's removes; only a
      // full evaluation re-diffs them out. Self-clearing (restored by the
      // catch below if evaluation throws).
      session.forceFullResync = false;
      dirtyIds = undefined;
      dirtyOrigins = undefined;
    }
    return tracer.startActiveSpan(
      "memory.subscriber.sync",
      async (span): Promise<SessionEffectMessage | null> => {
        span.setAttribute("space.did", space);
        if (
          session.principal !== undefined &&
          session.principal !== ANYONE_USER
        ) {
          span.setAttribute("user.did", session.principal);
        }
        span.setAttribute("watch.count", session.watches.length);
        try {
          const pendingCaughtUpLocalSeq = session.pendingCaughtUpLocalSeq;
          const hasPendingCatchUp =
            pendingCaughtUpLocalSeq > session.caughtUpLocalSeq;
          const finishCatchUp = async (
            sync: SessionSync,
          ): Promise<SessionEffectMessage> => {
            if (hasPendingCatchUp) {
              session.caughtUpLocalSeq = Math.max(
                session.caughtUpLocalSeq,
                pendingCaughtUpLocalSeq,
              );
              if (session.pendingCaughtUpLocalSeq <= session.caughtUpLocalSeq) {
                session.pendingCaughtUpLocalSeq = 0;
              }
              sync.caughtUpLocalSeq = session.caughtUpLocalSeq;
            }
            await this.#attachOperationFields(space, sessionId, sync);
            if (session.views.length > 0) this.#attachViewPlans(session, sync);
            return {
              type: "session/effect",
              space,
              sessionId,
              effect: sync,
            };
          };
          const emptyCatchUp = async (
            fromSeq = session.lastSyncedSeq,
            toSeq?: number,
          ): Promise<SessionEffectMessage | null> => {
            const serverSeq = toSeq ??
              Engine.serverSeq(await this.#openEngine(space));
            const mayCarryOperations = session.operationWatches.length > 0 &&
              serverSeq > fromSeq;
            if (
              !hasPendingCatchUp && !mayCarryOperations &&
              (session.views.length === 0 || !preCallForceFullResync)
            ) {
              return null;
            }
            session.lastSyncedSeq = Math.max(session.lastSyncedSeq, serverSeq);
            const sync: SessionSync = {
              type: "sync",
              fromSeq,
              toSeq: serverSeq,
              upserts: [],
              removes: [],
            };
            const message = await finishCatchUp(sync);
            if (
              !hasPendingCatchUp &&
              (sync.operationFields?.length ?? 0) === 0 &&
              sync.viewPlans === undefined
            ) {
              return null;
            }
            return message;
          };
          if (session.watches.length === 0 && session.views.length === 0) {
            // A session with no watches covers nothing: whatever its
            // delivery memory still lists — a lost frame's rolled-back
            // tombstones, a resuming client's declared holdings — is
            // retracted, and the memory and the tracked set are cleared,
            // so nothing outside the empty union lingers as demand.
            if (session.entities.size === 0) {
              return await emptyCatchUp();
            }
            const serverSeq = Engine.serverSeq(await this.#openEngine(space));
            const sync: SessionSync = {
              type: "sync",
              fromSeq: session.lastSyncedSeq,
              toSeq: serverSeq,
              upserts: [],
              removes: [...session.entities.values()]
                .map((entry) =>
                  toWireRemove(entry, session.leaseHolderReads === true)
                )
                .sort(compareSyncAddress),
            };
            session.entities = new Map();
            session.trackedIds = new Set();
            this.#touchDemand(session);
            session.lastSyncedSeq = Math.max(session.lastSyncedSeq, serverSeq);
            return await finishCatchUp(sync);
          }
          // The lease-holder read exemption for THIS pass, judged ONCE
          // on CURRENT holdership (protocol.md §2's read row is
          // live-lease admission) and BEFORE the branch choice: it
          // decides whether FOREIGN instances are delivered on either
          // branch, and a lapse it ends is what forces the full
          // evaluation below. A session never admitted explicit-instance
          // reads takes the synchronous fast path — no added await on
          // the ordinary push path.
          const leaseHolderExempt = session.leaseHolderReads === true
            ? await this.#currentLeaseHolderExemption(space, session)
            : false;
          if (leaseHolderExempt && session.leaseHolderReadsLapsed === true) {
            // The RE-ARM (fan-out stage A's independent review, finding
            // 1): an earlier pass found the lease lapsed and withheld or
            // retracted this session's foreign instances; the lease is
            // live again (a renewal blip the SpaceServer survived
            // in-process, or a reacquire), so run a FULL evaluation
            // NOW — the incremental branch would re-deliver only what
            // becomes dirty from here on, leaving every instance the
            // lapse withheld silently stale in the serving replica.
            session.leaseHolderReadsLapsed = false;
            rearmedLeaseHolder = true;
            dirtyIds = undefined;
            dirtyOrigins = undefined;
          }
          // The session's WIRE VOCABULARY (fan-out stage A, OW17's wire
          // leg; protocol.md §3): a session admitted explicit-instance
          // reads is keyed for its life — upserts AND removes — so an
          // instance delivered keyed is always retracted keyed. Keying
          // never hangs from the live verdict above: a former holder's
          // catch-up must retract its foreign instances BY KEY (an
          // unkeyed remove names the session's own instance in its
          // replica — the wipe). Every other session's frames are
          // byte-identical to before.
          const keyed = session.leaseHolderReads === true;
          if (dirtyIds !== undefined) {
            // Bound once for the closures below (the re-arm above is the
            // one assignment after this point, and it never runs on this
            // branch).
            const batchDirtyIds = dirtyIds;
            const startedAt = performance.now();
            // Per-session refresh rows (`memory/refresh/session/{untouched,
            // touched}`) and, for a touched session, the phase rows
            // (`memory/refresh/phase/{walk,diff,tracked,frame}`):
            // `memory/flush/refresh`
            // is a whole pass over every session, so this is what says
            // which sessions a commit cost and where in one session the
            // time went. Every row closes in a `finally`: a refresh that
            // throws is skipped and requeued by the caller, and an
            // expensive failure is the one most worth attributing.
            let sessionKind: "untouched" | "touched" = "untouched";
            try {
              let touched = false;
              for (const dirtyId of batchDirtyIds) {
                if (session.trackedIds.has(dirtyId)) {
                  touched = true;
                  break;
                }
              }
              span.setAttribute("ct.touched", touched);
              if (!touched) {
                return await emptyCatchUp();
              }
              sessionKind = "touched";
              const previousViewDemand = session.views.length > 0 &&
                  this.#serverExecutionObserver?.demandChanged !== undefined
                ? this.#viewDemandIds(session)
                : undefined;

              const engine = await this.#openEngine(space);
              const fromSeq = session.lastSyncedSeq;
              const identity = this.#sessionScopeIdentity(session);
              const updates = new Map<string, SessionCacheEntry>();
              const changedInterests = new Set<string>();
              const walkStartedAt = performance.now();

              // Evaluation exceptions — schema-closure corruption included —
              // propagate to refreshDirty's catch, which logs, skips this
              // session's frame, and marks it for a full re-evaluation.
              try {
                for (const graph of session.graphs.values()) {
                  const refreshed = tracer.startActiveSpan(
                    "memory.watch.refresh",
                    (watchSpan) => {
                      watchSpan.setAttribute("space.did", space);
                      try {
                        return refreshTrackedGraph(
                          space,
                          engine,
                          graph,
                          batchDirtyIds,
                        );
                      } finally {
                        watchSpan.end();
                      }
                    },
                  );
                  if (refreshed === null) {
                    continue;
                  }
                  // The refresh edits the graph's misses in place, and they
                  // are an input to the session's demand.
                  if (refreshed.changedMisses.size > 0) {
                    this.#touchDemand(session);
                  }
                  for (const key of refreshed.changedMisses) {
                    const { id, scopeKey } = fromDocKey(key as QueryDocKey);
                    changedInterests.add(toDirtyKey(id, scopeKey));
                  }
                  for (const [docKey, entity] of refreshed.updates) {
                    const { scopeKey } = fromDocKey(docKey);
                    const entry = toCacheEntry(entity, identity, scopeKey);
                    changedInterests.add(toDirtyKey(entry.id, entry.scopeKey));
                    updates.set(
                      cacheKeyForEntity(entry.branch, entry.id, entry.scopeKey),
                      entry,
                    );
                  }
                }
              } finally {
                timing.time(
                  walkStartedAt,
                  "memory",
                  "refresh",
                  "phase",
                  "walk",
                );
              }
              if (
                updates.size === 0 && changedInterests.size === 0 &&
                session.views.length === 0
              ) {
                return await emptyCatchUp();
              }

              const diffStartedAt = performance.now();
              const filteredKeys: string[] = [];
              const upserts: SessionCacheEntry[] = [];
              try {
                // The lease-holder exemption was judged on CURRENT holdership
                // above, once per pass: a former holder's foreign instances
                // are filtered like any other session's (protocol.md §2's
                // read row is live-lease admission).
                for (const [key, entry] of updates) {
                  const previous = session.entities.get(key);
                  if (!sameSnapshot(previous, entry)) {
                    // protocol.md §3's applicable-set filter, as
                    // defense-in-depth: a session's graph evaluates under
                    // its own identity, so an inapplicable instance here is
                    // structurally unreachable — unless the session is a
                    // CURRENT lease holder with explicit-instance reads
                    // admitted (protocol.md §2's read row), which is exempt
                    // by design (the server legitimately receives every
                    // instance it serves).
                    if (
                      !leaseHolderExempt &&
                      !scopeKeyApplicableTo(entry.scopeKey, identity)
                    ) {
                      // Never cache a filtered entry as delivered: a later
                      // re-admission must still see the client's cache as
                      // NOT holding it, or the withheld update is elided
                      // forever.
                      filteredKeys.push(key);
                      continue;
                    }
                    const dirtyKey = toDirtyKey(entry.id, entry.scopeKey);
                    const origin = dirtyOrigins?.get(dirtyKey);
                    // Include the doc unless the writer provably holds it
                    // (CT-1965). An origin matching this session AND the head seq
                    // means the head is exactly this session's own accepted
                    // write; under the per-space publication lock nothing can
                    // have moved it since, so `entry.doc` IS that commit's
                    // post-apply document. A `set`/`delete` head is then elided —
                    // the client supplied the bytes (or the absence) and the
                    // verdict + marker promote them — while a `patch` head is
                    // delivered in full: its post-apply state can contain merged
                    // foreign content the writer's own ops cannot reproduce.
                    const held = origin !== undefined &&
                      origin.sessionId === sessionId &&
                      origin.seq === entry.seq &&
                      (origin.op !== "patch" || !getOwnWriteEchoConfig());
                    if (!held) {
                      upserts.push(entry);
                    }
                  }
                }
                for (const key of filteredKeys) {
                  updates.delete(key);
                }
              } finally {
                timing.time(
                  diffStartedAt,
                  "memory",
                  "refresh",
                  "phase",
                  "diff",
                );
              }
              // The session cache commits only after the frame is fully
              // built: a throw during marker/adoption attachment must leave
              // the diff recomputable, or the requeued batch would elide the
              // lost frame's docs as already-snapshotted (CT-1927 review,
              // round 6).
              const commitEntities = () => {
                const trackedStartedAt = performance.now();
                try {
                  // A new delivered entity adds a key to the session's
                  // demand; a changed snapshot of a held one does not.
                  let enteredEntity = false;
                  for (const [key, entry] of updates) {
                    if (!session.entities.has(key)) enteredEntity = true;
                    session.entities.set(key, entry);
                  }
                  let changed = this.#reconcileTrackedInterests(
                    session,
                    changedInterests,
                  );
                  if (
                    enteredEntity || changed || session.views.length > 0
                  ) {
                    this.#touchDemand(session);
                  }
                  if (session.views.length > 0) {
                    session.viewDemandEntities = this.#entriesFromGraphs(
                      session.viewDemandGraphs.values(),
                      identity,
                    );
                  }
                  if (previousViewDemand !== undefined) {
                    const next = this.#viewDemandIds(session);
                    changed = previousViewDemand.size !== next.size;
                    if (!changed) {
                      for (const key of next) {
                        if (!previousViewDemand.has(key)) {
                          changed = true;
                          break;
                        }
                      }
                    }
                  }
                  if (changed) {
                    this.#notifyDemandChanged(
                      space,
                      "push-growth",
                      session.principal,
                    );
                  }
                } finally {
                  timing.time(
                    trackedStartedAt,
                    "memory",
                    "refresh",
                    "phase",
                    "tracked",
                  );
                }
              };
              const toSeq = Engine.serverSeq(engine);
              if (upserts.length === 0) {
                // The watched set was re-evaluated current as of toSeq even though it
                // produced no net upserts; advance the watermark so a later default
                // fromSeq is not stale. emptyCatchUp receives the original fromSeq
                // explicitly, so this does not mutate the bounds of this sync (the
                // Cubic fix keeps fromSeq pinned to the pre-refresh value).
                commitEntities();
                session.lastSyncedSeq = Math.max(session.lastSyncedSeq, toSeq);
                return await emptyCatchUp(fromSeq, toSeq);
              }
              recordSlowQueryDuration(
                "session.watch.refresh",
                space,
                startedAt,
                {
                  watches: session.watches.length,
                  upserts: upserts.length,
                  principal: session.principal,
                },
              );
              const frameStartedAt = performance.now();
              let message: SessionEffectMessage;
              try {
                message = await finishCatchUp({
                  type: "sync",
                  fromSeq,
                  toSeq,
                  upserts: upserts.toSorted((left, right) =>
                    left.branch.localeCompare(right.branch) ||
                    left.id.localeCompare(right.id)
                  ).map((entry) =>
                    // Keyed by the session's wire vocabulary (stage A, OW17's
                    // wire leg — see `keyed` above): the key is what keeps
                    // two instances of one (branch, id, scope) apart in the
                    // serving replica. Unkeyed frames are byte-identical to
                    // before.
                    toWireUpsert(entry, keyed)
                  ),
                  removes: [],
                });
                // An unkeyed wire frame strips instance keys; retain the
                // frame's true instance-keyed entries so a delivery failure
                // rolls back the EXACT instances (rollbackUndeliveredSync).
                this.#deliveredFrameEntries.set(message, {
                  upserts: [...upserts],
                  removes: [],
                });
              } finally {
                timing.time(
                  frameStartedAt,
                  "memory",
                  "refresh",
                  "phase",
                  "frame",
                );
              }
              commitEntities();
              session.lastSyncedSeq = toSeq;
              return message;
            } finally {
              timing.time(
                startedAt,
                "memory",
                "refresh",
                "session",
                sessionKind,
              );
            }
          }

          const { serverSeq, graphs, entities, demandGraphs, demandEntities } =
            await this.#evaluateViewWatchSet(
              session,
              session.watches,
              session.views,
            );
          // protocol.md §3's applicable-set filter on the FULL
          // evaluation path: explicit foreign instances enter `entities`
          // only through admitted lease-holder reads, and the exemption
          // is keyed on CURRENT holdership (judged above) — a former
          // holder's foreign entries are dropped here, and their
          // previously delivered predecessors diff out as removes below,
          // KEYED (`keyed`, the session's sticky wire vocabulary), so
          // the client retracts exactly those instances and its own
          // instance survives.
          if (!leaseHolderExempt) {
            const identity = this.#sessionScopeIdentity(session);
            for (const [key, entry] of [...entities]) {
              if (!scopeKeyApplicableTo(entry.scopeKey, identity)) {
                entities.delete(key);
              }
            }
          }
          const delivered = {
            upserts: [] as SessionCacheEntry[],
            removes: [] as SessionCacheEntry[],
          };
          const sync = buildDiffSync(
            session.entities,
            entities,
            session.lastSyncedSeq,
            serverSeq,
            delivered,
            keyed,
          );
          // As above: commit the re-evaluated watch state only once the
          // frame is built, so a throw leaves the diff recomputable. The
          // empty-sync branch commits first — its frame carries no doc
          // novelty, and the marker counters are restored by the catch.
          // (A lapsed holder's retracted foreign entries leave its
          // tracked set here; the re-arm above runs on the session's
          // NEXT pass regardless of what dirtied it — every session of
          // the space is offered every batch — so no tracked key is
          // needed to bring the withheld instances back.)
          const evaluatedTrackedIds = trackedIdsFromEntries(entities.values());
          this.#addMissedToTrackedIds(
            evaluatedTrackedIds,
            graphs.values(),
          );
          addOperationWatchTrackedIds(
            evaluatedTrackedIds,
            session.watches,
            { principal: session.principal, sessionId },
          );
          for (const key of trackedIdsFromEntries(demandEntities.values())) {
            evaluatedTrackedIds.add(key);
          }
          this.#addMissedToTrackedIds(
            evaluatedTrackedIds,
            demandGraphs.values(),
          );
          const evaluatedDemandIds = trackedIdsFromEntries(
            demandEntities.values(),
          );
          this.#addMissedToTrackedIds(
            evaluatedDemandIds,
            demandGraphs.values(),
          );
          const commitWatchState = () => {
            // (d′) — flag 2, the full-evaluation branch: the
            // set is REPLACED (this is where it can shrink — R-D's coarse
            // boundary); a key that entered or left is a demand change.
            // NIT-6: the notify's reason is `push-growth` even for a
            // SHRINK (a departed key) — a benign misnomer: it only wakes a
            // demand pass, which retires departed keys SOONER than the
            // next input would. A distinct `push-shrink` reason would buy
            // nothing the pass does not already handle.
            // MINOR-8: the change detection is a Set-membership scan
            // (O(tracked)); compute it ONLY when a demand observer is
            // attached (the serving posture). OFF-arm — no observer — it
            // is dead work, so skip it and commit the state directly.
            const wantsDemandNotify =
              this.#serverExecutionObserver?.demandChanged !== undefined;
            let changed = false;
            if (wantsDemandNotify) {
              const previous = session.views.length === 0
                ? session.trackedIds
                : trackedIdsFromEntries(session.viewDemandEntities.values());
              if (session.views.length > 0) {
                this.#addMissedToTrackedIds(
                  previous,
                  session.viewDemandGraphs.values(),
                );
              }
              const next = session.views.length === 0
                ? evaluatedTrackedIds
                : evaluatedDemandIds;
              changed = previous.size !== next.size;
              if (!changed) {
                for (const key of next) {
                  if (!previous.has(key)) {
                    changed = true;
                    break;
                  }
                }
              }
            }
            session.viewDemandGraphs = demandGraphs;
            session.viewDemandEntities = demandEntities;
            session.graphs = graphs;
            session.entities = entities;
            session.trackedIds = evaluatedTrackedIds;
            this.#touchDemand(session);
            session.lastSyncedSeq = serverSeq;
            if (changed) {
              this.#notifyDemandChanged(
                space,
                "push-growth",
                session.principal,
              );
            }
          };
          if (isEmptySync(sync)) {
            commitWatchState();
            return await emptyCatchUp(sync.fromSeq, sync.toSeq);
          }
          const message = await finishCatchUp(sync);
          // As on the incremental branch: retain the frame's true
          // instance-keyed entries for exact delivery rollback.
          this.#deliveredFrameEntries.set(message, delivered);
          commitWatchState();
          return message;
        } catch (error) {
          // A throwing evaluation may have consumed the marker obligation
          // (finishCatchUp advances caughtUpLocalSeq before the frame is
          // returned). Roll both counters back to
          // their pre-call values so the obligation re-stages and a later
          // pass re-emits the marker; document state needs no restore here
          // — the caller's requeue machinery re-dirties the batch.
          session.caughtUpLocalSeq = preCallCaughtUp;
          session.pendingCaughtUpLocalSeq = Math.max(
            session.pendingCaughtUpLocalSeq,
            preCallPending,
          );
          session.forceFullResync = session.forceFullResync ||
            preCallForceFullResync;
          // A re-arm consumed by a throwing pass re-stages: the next
          // pass runs the full evaluation the lapse still owes.
          if (rearmedLeaseHolder) session.leaseHolderReadsLapsed = true;
          // A refresh that threw may have edited a graph's misses in place
          // before it could report them.
          this.#touchDemand(session);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async #attachOperationFields(
    space: string,
    sessionId: string,
    sync: SessionSync,
    watches?: readonly WatchSpec[],
    operationCursors?: Map<string, OpCursor>,
  ): Promise<void> {
    const session = this.#sessions.get(space, sessionId);
    if (session === null) return;
    const operationWatches = watches === undefined
      ? session.operationWatches.slice()
      : watches.filter((watch) => watch.kind === "operation");
    if (operationWatches.length === 0) return;
    const cursors = operationCursors ?? session.operationCursors;
    const engine = await this.#openEngine(space);
    this.#attachOperationFieldsWithEngine(
      engine,
      session,
      sync,
      operationWatches,
      cursors,
    );
  }

  /** Attaches operation snapshots synchronously within watch publication. */
  #attachOperationFieldsWithEngine(
    engine: Engine.Engine,
    session: SessionState,
    sync: SessionSync,
    watches: readonly OperationWatchSpec[],
    operationCursors: Map<string, OpCursor>,
  ): void {
    if (watches.length === 0) return;
    operationActiveWatchCount.record(watches.length);
    const cursors = operationCursors;
    sync.operationFields = watches.map((watch) => {
      const after = cursors.get(watch.id) ?? watch.query.after;
      const field = Engine.queryOperationField(engine, {
        ...watch.query,
        ...(after === undefined ? {} : { after }),
        principal: session.principal,
        sessionId: session.id,
      });
      if (field.reset === true) {
        operationResetCount.add(1, { source: "watch", codec: field.codec! });
      }
      if (field.cursor === null) {
        cursors.delete(watch.id);
      } else {
        cursors.set(watch.id, field.cursor);
      }
      return { watchId: watch.id, field };
    });
  }

  markSpaceDirty(
    space: string,
    dirtyIds?: Iterable<string>,
    // Op kinds are per-doc (one commit can set A and patch B), so the origin
    // carries a per-dirty-key map; absent keys classify as "patch" — the
    // never-elide shape.
    origin?: {
      sessionId: string;
      seq: number;
      ops: ReadonlyMap<string, DirtyOp>;
    },
  ): void {
    if (dirtyIds !== undefined) {
      let ids = this.#dirtyDocsBySpace.get(space);
      if (ids === undefined) {
        ids = new Set();
        this.#dirtyDocsBySpace.set(space, ids);
      }
      let origins = this.#dirtyOriginsBySpace.get(space);
      if (origin !== undefined && origins === undefined) {
        origins = new Map();
        this.#dirtyOriginsBySpace.set(space, origins);
      }
      for (const id of dirtyIds) {
        const alreadyDirty = ids.has(id);
        ids.add(id);
        if (origin === undefined) {
          origins?.delete(id);
        } else if (
          alreadyDirty &&
          origins?.get(id)?.sessionId !== origin.sessionId
        ) {
          // Mixed provenance (CT-1927): the doc already carries UNDELIVERED
          // novelty from a different origin (a foreign write, or an
          // unattributed staging). Overwriting the origin would let the new
          // writer's echo suppression hide that foreign novelty from the
          // writer itself while its sync cursor still advances past it.
          // Clear the origin instead: mixed docs fan out authoritatively to
          // every session, the writer included.
          origins?.delete(id);
        } else {
          origins?.set(id, {
            sessionId: origin.sessionId,
            seq: origin.seq,
            op: origin.ops.get(id) ?? "patch",
          });
        }
      }
      if (origins?.size === 0) {
        this.#dirtyOriginsBySpace.delete(space);
      }
    }
    this.#dirtySpaces.add(space);
    this.#scheduleRefresh();
  }

  /** Whether the space has ≥1 live client session (serving-loop.md §1's
   * ACTIVE criterion; the SpaceServer's parking policy reads it). The
   * SpaceServer's own loopback session is not a CLIENT session — the
   * parking policy excludes the service principal, or an active space
   * could never park. */
  hasLiveSessionsForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): boolean {
    return this.#sessions.sessionsForSpace(space).some((session) =>
      options.excludePrincipal === undefined ||
      session.principal !== options.excludePrincipal
    );
  }

  /** Whether ONE specific (principal, sessionId) pair holds a live
   * session on the space — the served `navigateTo` connectivity check
   * (server-execution v2 Phase 4; builtins.md §4's LT3 ruling: the
   * intent write requires the acting session to be a CONNECTED session
   * of the COMPUTING space, else there is no channel to deliver the
   * intent on). The per-session twin of `hasLiveSessionsForSpace`. */
  hasLiveSessionFor(
    space: string,
    principal: string,
    sessionId: string,
  ): boolean {
    return this.#sessions.sessionsForSpace(space).some((session) =>
      session.id === sessionId && session.principal === principal
    );
  }

  /**
   * @deprecated (W1 review NIT-3) Production-DEAD since (d′): the
   * SpaceServer's demand pass reads `demandForSpace` (the tracked-ids
   * closure, per session), never this. Retained only as a witness in a few
   * tests (`executor-serving-loop`, `instance-keyed-replica`, `fan-out`);
   * migrate those to `demandedInstancesForSpace` and remove this, or keep
   * it explicitly as the roots-only projection. No production caller.
   *
   * The space's demanded roots (serving-loop.md §1: demand is
   * value-granular client pull — a subscription names what to serve).
   * Distinct (id, scope) pairs across every live session's watch specs;
   * the SpaceServer loads graph structure sufficient to resolve them.
   *
   * `entityScopeKey` is deliberately NOT part of a demand record, and
   * that is an INVARIANT, not an omission (PR #5439 thread
   * r3731191476): explicit-instance roots are admissible only to
   * sessions whose principal is the live lease holder's service
   * identity (#denyExplicitInstanceReads), and every session of that
   * principal is EXCLUDED here (the serving loop's own reads are not
   * client demand). So no root that survives the exclusion can carry an
   * explicit key — client watches cannot express one. If a later phase
   * admits explicit-instance CLIENT demand (Phase 2's per-instance
   * demand mapping), the record must grow the key WITH the SpaceServer
   * side that consumes it; silently dropping it here would serve the
   * service's own instance in place of the named one.
   */
  watchedRootsForSpace(
    space: string,
    options: {
      /** Sessions of this principal are NOT demand (the SpaceServer's
       * own loopback session watches whatever its graph reads; mapping
       * those back into demand would make the loop demand its own
       * reads, recursively). */
      excludePrincipal?: string;
    } = {},
  ): Array<{
    id: string;
    scope?: CellScope;

    /** The DEMANDING session's identity (server-execution v2 Phase 2,
     * scopes.md §5: a derivation runs per demanded instance and the
     * DEMAND supplies the identity; fan-out stage B, RULED 2026-08-16 —
     * scopes.md §2's mechanism sentence: a principal's demand at a
     * BROAD address is demand for that principal's instance of every
     * node that narrows beneath it). Present on EVERY root a
     * principal-bearing session watches, space-scoped roots included:
     * one row per (root, scope, principal, session) — the SpaceServer's
     * registry keeps every demanding pair per root (two sessions of one
     * user are two demanders — a node beneath the root may narrow to
     * session for that user; two users are two). Absent only for an
     * anonymous session's space-scoped root (it names the root — the
     * structure still loads for it — but owns no instance). A session
     * that cannot resolve a scoped root's instance (no principal on a
     * user-scoped root) is not demand for that root. */
    identity?: { principal?: string; sessionId?: string };
  }> {
    const roots = new Map<string, {
      id: string;
      scope?: CellScope;
      identity?: { principal?: string; sessionId?: string };
    }>();
    for (const session of this.#sessions.sessionsForSpace(space)) {
      if (
        options.excludePrincipal !== undefined &&
        session.principal === options.excludePrincipal
      ) {
        continue;
      }
      for (const watch of [...session.watches, ...viewWatches(session.views)]) {
        if (watch.kind === "operation") continue;
        for (const root of watch.query.roots) {
          const scope = root.scope ?? "space";
          if (scope === "space") {
            if (session.principal === undefined) {
              const key = `space\0${root.id}`;
              if (!roots.has(key)) {
                roots.set(key, { id: root.id });
              }
              continue;
            }
            const key =
              `space\0${root.id}\0${session.principal}\0${session.id}`;
            if (!roots.has(key)) {
              roots.set(key, {
                id: root.id,
                identity: {
                  principal: session.principal,
                  sessionId: session.id,
                },
              });
            }
            continue;
          }
          const identity = {
            ...(session.principal === undefined
              ? {}
              : { principal: session.principal }),
            sessionId: session.id,
          };
          let instanceKey: string;
          try {
            instanceKey = resolveScopeKey(scope, {
              principal: session.principal,
              sessionId: session.id,
            });
          } catch {
            // A session that cannot resolve the scope (no principal on a
            // user-scoped root) is not demand for that instance.
            continue;
          }
          const key = `${instanceKey}\0${root.id}\0${session.id}`;
          if (!roots.has(key)) {
            roots.set(key, {
              id: root.id,
              scope: root.scope,
              identity,
            });
          }
        }
      }
    }
    return [...roots.values()];
  }

  /**
   * The read ceiling `sessionId` declared at its last open
   * (`SessionDescriptor.readCeiling`), or `undefined` for a session that
   * declared none or is not live. What the SpaceServer stamps onto every
   * run it serves AS that session, so the runs of a bounded client read
   * under the client's ceiling.
   */
  sessionReadCeiling(
    space: string,
    sessionId: string,
  ): SessionReadCeiling | undefined {
    return this.#sessions.get(space, sessionId)?.readCeiling;
  }

  /**
   * (d′) — the space's DEMAND SET (design §2.1's definition;
   * the successor of `watchedRootsForSpace`): the union over the space's
   * CLIENT sessions of each graph watch's schema-narrowed, instance-keyed
   * closure (roots and every doc the selectors' schemas reach, absent targets
   * included) — one row per
   * (instance key, session), each carrying the session's demanding
   * identity, `root: true` on the rows that are watch ROOTS. The service
   * principal's sessions are excluded (their watches are the serving
   * graph's own reads). Anonymous sessions contribute keys but no
   * demander (identity without principal); a session that cannot resolve
   * a scoped root's instance is not demand for it (the tracker never
   * keyed one for it). Roots are UNIONED in from the watch specs so a
   * root the tracker has not (yet) keyed still carries what
   * `watchedRootsForSpace` carried — parity with today's structure load.
   *
   * The flat form of `demandForSpace()`, holding the same rows in session
   * order as copies a caller may keep. It costs a pass over every row, where
   * `demandForSpace()` costs one step per session whose demand is unchanged.
   */
  demandedInstancesForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): DemandedInstanceRow[] {
    return this.demandForSpace(space, options).flatMap((session) =>
      [...session.rows.values()].map((row) => ({
        ...row,
        ...(row.identity === undefined
          ? {}
          : { identity: { ...row.identity } }),
      }))
    );
  }

  /**
   * The space's demand set, as `demandedInstancesForSpace()` defines it,
   * split into one `SessionDemand` per client session in registry order.
   *
   * A session's share is built once and handed back unchanged, as the same
   * object, until something that decides it is written: its watches or views,
   * the entities delivered to it, its graphs' misses, or its tracked set. So
   * a read with no such write since the last one does no per-row work at all,
   * and a consumer compares what it holds against what it reads by identity to
   * find the sessions whose rows may differ.
   */
  demandForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): SessionDemand[] {
    const demand: SessionDemand[] = [];
    for (const session of this.#sessions.sessionsForSpace(space)) {
      if (
        options.excludePrincipal !== undefined &&
        session.principal === options.excludePrincipal
      ) {
        continue;
      }
      let share = this.#sessionDemand.get(session);
      if (share === undefined) {
        share = this.#buildSessionDemand(session);
        this.#sessionDemand.set(session, share);
        this.#sessionDemandBuilds += 1;
      }
      demand.push(share);
    }
    return demand;
  }

  /** (d′) DIAGNOSTIC: per-session `trackedIds.size` for a
   * space's client sessions, plus the union size (design §2.6 — the
   * demand-set size and its drift are measured, not assumed). */
  demandSetSizesForSpace(
    space: string,
    options: { excludePrincipal?: string } = {},
  ): {
    perSession: Array<
      {
        sessionId: string;
        principal?: string;
        tracked: number;
        watches: number;
      }
    >;
    unionKeys: number;
  } {
    const perSession: Array<
      {
        sessionId: string;
        principal?: string;
        tracked: number;
        watches: number;
      }
    > = [];
    const union = new Set<string>();
    for (const session of this.#sessions.sessionsForSpace(space)) {
      if (
        options.excludePrincipal !== undefined &&
        session.principal === options.excludePrincipal
      ) {
        continue;
      }
      perSession.push({
        sessionId: session.id,
        ...(session.principal === undefined
          ? {}
          : { principal: session.principal }),
        tracked: session.trackedIds.size,
        watches: session.watches.length,
      });
      for (const key of session.trackedIds) union.add(key);
    }
    return { perSession, unionKeys: union.size };
  }

  /**
   * Attach (or clear) the ExecutorHost's in-process observer
   * (serving-loop.md §1 planes (b)/(d)). One observer per server: a
   * second attach replaces the first, which only the one host per
   * process should ever do.
   */
  setServerExecutionObserver(
    observer: ServerExecutionObserver | undefined,
  ): void {
    this.#serverExecutionObserver = observer;
  }

  /**
   * Watch every commit this server admits: a session transact, a
   * delegated append, the server's own direct write, and the serving
   * loop's wave commits, each reported after the engine has applied it.
   * Any number of watchers attach — the host's own observer above is
   * separate and unaffected — and the returned function detaches one.
   *
   * This is the store's "something landed" edge, and it reports the
   * commits a client's own subscription does not: a doc outside every
   * replica's watch set, and the serving loop's own bookkeeping.
   * `docs/development/waiting-in-tests.md` covers what a test does
   * with it.
   */
  watchAdmittedCommits(
    watcher: (notice: AdmittedCommitNotice) => void,
  ): () => void {
    this.#admittedCommitWatchers.add(watcher);
    return () => {
      this.#admittedCommitWatchers.delete(watcher);
    };
  }

  #notifyCommitAdmitted(notice: AdmittedCommitNotice): void {
    const observer = this.#serverExecutionObserver;
    if (observer?.commitAdmitted !== undefined) {
      try {
        observer.commitAdmitted(notice);
      } catch (error) {
        // Admission never fails because the observer threw; the host's
        // catch-up scan (selectCommitsSince) covers a dropped notice.
        console.warn(
          "memory v2: server-execution observer threw on commitAdmitted",
          error,
        );
      }
    }
    for (const watcher of this.#admittedCommitWatchers) {
      try {
        watcher(notice);
      } catch (error) {
        console.warn(
          "memory v2: admitted-commit watcher threw",
          error,
        );
      }
    }
  }

  #notifySessionOpened(space: string): void {
    const observer = this.#serverExecutionObserver;
    if (observer?.sessionOpened === undefined) return;
    try {
      observer.sessionOpened(space);
    } catch (error) {
      console.warn(
        "memory v2: server-execution observer threw on sessionOpened",
        error,
      );
    }
  }

  #notifyDemandChanged(
    space: string,
    reason: DemandChangeReason = "watch",
    principal?: string,
  ): void {
    const observer = this.#serverExecutionObserver;
    if (observer?.demandChanged === undefined) return;
    try {
      observer.demandChanged(space, reason, principal);
    } catch (error) {
      console.warn(
        "memory v2: server-execution observer threw on demandChanged",
        error,
      );
    }
  }

  /**
   * The serving loop reports its own wave commit (which entered the store
   * through the co-hosted engine plane, not through any session) so push
   * fires for it: dirtiness keyed by scope INSTANCE (M4), no origin — a
   * derived commit fans out authoritatively to every subscriber — and the
   * feed record reaches the observer like any admission (the SpaceServer
   * skips its own by class + holder — serving-loop.md §3's self-echo).
   */
  noteExecutorCommit(notice: AdmittedCommitNotice): void {
    const keys = notice.writes.map((write) =>
      toDirtyKey(write.id, write.scopeKey)
    );
    // Push priority (Phase 6, protocol.md §3): the wave's derived rows
    // are the content subscribers wait on — classify their dirty keys so
    // the flush loop can order sessions carrying them ahead of bulk.
    if (notice.class === "derived" && keys.length > 0) {
      let derived = this.#derivedDirtyBySpace.get(notice.space);
      if (derived === undefined) {
        derived = new Set();
        this.#derivedDirtyBySpace.set(notice.space, derived);
      }
      for (const key of keys) derived.add(key);
    }
    this.markSpaceDirty(notice.space, keys);
    this.#notifyCommitAdmitted(notice);
  }

  /**
   * The read-side admission row (protocol.md §2, ratified LD5): a read
   * naming an explicit `entity_scope_key` is admissible only for a live
   * lease holder on this co-hosted memory server. Phase 5 landed both
   * halves the Phase-1 bounds deferred (verification-coverage.md's
   * stage-F read-row entry):
   *
   * - FP2's WIDENING (RULED 2026-08-03): the requester holds A live
   *   `execution_lease` on this co-hosted memory server — its OWN
   *   space's lease, not necessarily the read space's — so a home
   *   SpaceServer's cross-space serving reads can name a FOREIGN
   *   space's instances instead of silently resolving
   *   `user:<serviceDID>`. The read space's own lease is checked
   *   first; the fallback is the sync cross-engine scan
   *   (#liveCoHostedLeaseSpaceFor).
   * - The PER-PROCESS sharpening: equality is against the FULL DR1
   *   holder minted by THIS process (`executionLeaseHolder`, binding
   *   the module-level process-instance component), never the
   *   service-identity component alone — a second process sharing the
   *   service DID no longer passes on this process's lease rows.
   *
   * A non-holder naming a key is REJECTED; an ordinary read naming
   * none resolves from the session as today. The one NEW unnamed-read
   * refusal is the delegated-scoped-read fail-closed rule (protocol.md
   * §2's grant-scoped read design, the RULED 2026-08-13 Phase-5
   * precondition): a session that IS a co-hosted serving session (its
   * principal holds a live lease on some space of this server) reading
   * a SCOPED root of a space whose lease it does NOT hold, WITHOUT an
   * explicit instance name, would silently resolve the service
   * identity's (empty) instance — the FP2 silent-empty-instance trap,
   * cross-space edition. That shape REFUSES loudly instead; the
   * serving runtime names foreign instances explicitly or does not
   * read them.
   */
  async #denyExplicitInstanceReads(
    space: string,
    session: SessionState,
    entries: Iterable<{
      branch: string;
      root: GraphQuery["roots"][number];
    }>,
  ): Promise<V2Error | undefined> {
    // Synchronous fast path first: a read naming NO instance adds no
    // microtask boundary — the request's authorization and evaluation
    // keep sharing one engine turn (the ACL revocation-race invariant).
    let named = false;
    // The wire collapse guard, NON-holders only (server-execution v2
    // stage A, OW17's wire leg): a non-holder's frames and query results
    // carry scope NAMES, so two instances of one (branch, id, scope)
    // would be indistinguishable on its wire and its client cache would
    // keep only one (WatchView keys by branch/id/scope) — refused loudly
    // at admission instead of silently losing an instance. A LIVE lease
    // holder is exempt: its frames carry `scope_key` per entry (the
    // exemption armed below is what keys them), and its query results
    // carry `scopeKey` per snapshot, so it may legitimately name two
    // instances of one doc — that IS the serving replica holding both
    // the service instance and a demander's instance of one doc.
    // Keyless roots resolve to the session's own instance, so an
    // explicit key equal to it is fine — only two DIFFERENT effective
    // instances conflict. Evaluated synchronously (before the holdership
    // await) and RAISED only on the non-holder arm.
    const identity = this.#sessionScopeIdentity(session);
    const instanceByAddress = new Map<string, string>();
    let collapse: V2Error | undefined;
    for (const { branch, root } of entries) {
      if (root.entityScopeKey !== undefined) {
        named = true;
        if (!isScopeKey(root.entityScopeKey)) {
          return toError(
            "ProtocolError",
            `malformed entity_scope_key "${root.entityScopeKey}" on read ` +
              `root ${root.id}`,
          );
        }
      }
      if (collapse !== undefined) continue;
      const scopeName = root.scope ?? "space";
      const instanceKey = root.entityScopeKey ??
        (canResolveScopeKey(root.scope, identity)
          ? resolveScopeKey(root.scope, identity)
          : undefined);
      if (instanceKey === undefined) continue;
      const addressKey = `${branch}\0${scopeName}\0${root.id}`;
      const existing = instanceByAddress.get(addressKey);
      if (existing === undefined) {
        instanceByAddress.set(addressKey, instanceKey);
      } else if (existing !== instanceKey) {
        collapse = toError(
          "ProtocolError",
          `read set resolves two instances of (${root.id}, ${scopeName}) ` +
            `— "${existing}" and "${instanceKey}" — which this session's ` +
            "wire cannot distinguish (frames carry scope names for a " +
            "non-holder, protocol.md §1); name one instance per (branch, " +
            "id, scope), or hold the execution lease (protocol.md §2's " +
            "read row: lease-holder frames carry scope_key)",
        );
      }
    }
    if (!named) return collapse;
    if (!getServerExecutionConfig()) {
      return toError(
        "ProtocolError",
        "reads naming an entity_scope_key are unclaimable while " +
          "EXPERIMENTAL_SERVER_EXECUTION is off (protocol.md §2)",
      );
    }
    const engine = await this.#openEngine(space);
    const fullHolder = session.principal === undefined
      ? undefined
      : executionLeaseHolder(session.principal);
    const readSpaceHolder = liveExecutionLeaseHolder(engine, space);
    const holdsReadSpace = fullHolder !== undefined &&
      readSpaceHolder === fullHolder;
    // FP2's widened acceptance: a live lease on ANY space of this
    // co-hosted server admits (the home SpaceServer naming a foreign
    // instance for a cross-space serving read).
    const holdsCoHosted = holdsReadSpace ||
      (session.principal !== undefined &&
        this.#liveCoHostedLeaseSpaceFor(session.principal) !== undefined);
    if (!holdsCoHosted) {
      // The collapse refusal is the more specific message for a
      // non-holder whose read set is ambiguous on its (unkeyed) wire.
      return collapse ?? toError(
        "ProtocolError",
        "read naming an entity_scope_key rejected: requester does not " +
          "hold a live execution_lease on this memory server " +
          "(protocol.md §2's read row)",
      );
    }
    session.leaseHolderReads = true;
    return undefined;
  }

  /**
   * Whether the session's lease-holder read exemption (protocol.md §2's
   * read row) is valid NOW. The exemption is an authorization tied to
   * holding a LIVE execution lease, so every use re-keys on CURRENT
   * holdership: a lapsed or moved lease means NO foreign instance is
   * delivered — the push pass filters (incremental) or retracts (full
   * evaluation) them — until the lease is live again. Consulted once
   * per push pass (syncSessionForConnection, before the branch choice;
   * a session resume's catch-up is such a pass), so a former holder
   * receives no foreign scoped instances anywhere.
   *
   * What a lapse does NOT do (fan-out stage A's independent review,
   * finding 1): it does not clear `leaseHolderReads`. That bit is the
   * session's sticky WIRE VOCABULARY — its frames stay keyed so the
   * retraction of a keyed-delivered foreign instance is keyed too (an
   * unkeyed remove would wipe the session's OWN instance in its
   * replica) — and it is what lets the exemption RE-ARM: the lapse is
   * recorded (`leaseHolderReadsLapsed`), and the first pass that finds
   * the lease live again runs a full evaluation that re-delivers what
   * the lapse withheld (a renewal blip survived in-process, or a
   * reacquire; `noteLeaseReacquired` schedules that pass promptly). A
   * fresh explicit-instance admission (#denyExplicitInstanceReads) is
   * no longer the only way back.
   */
  async #currentLeaseHolderExemption(
    space: string,
    session: SessionState,
  ): Promise<boolean> {
    if (session.leaseHolderReads !== true) return false;
    // Unreachable for an admitted session (admission needs a principal
    // to build the full holder); a principal-less bit is simply inert.
    if (session.principal === undefined) return false;
    // The same holdership the admission accepts (Phase 5): the read
    // space's own lease, or — FP2's widening — any live co-hosted
    // lease held by THIS process's full DR1 holder (a home SpaceServer
    // keeps receiving the foreign instances its cross-space serving
    // reads named). Full-holder equality throughout (the per-process
    // sharpening).
    const engine = await this.#openEngine(space);
    const fullHolder = executionLeaseHolder(session.principal);
    const holdsReadSpace = liveExecutionLeaseHolder(engine, space) ===
      fullHolder;
    if (
      !holdsReadSpace &&
      this.#liveCoHostedLeaseSpaceFor(session.principal) === undefined
    ) {
      session.leaseHolderReadsLapsed = true;
      return false;
    }
    return true;
  }

  /**
   * The co-hosted SpaceServer reports it (re)acquired a space's lease
   * after a renewal blip (serving-loop.md §2's same-process reacquire).
   * A push pass that ran inside the blip found the serving identity's
   * lease-holder sessions lapsed and withheld or retracted their foreign
   * instances; their exemption re-arms on the next pass — schedule that
   * pass NOW (an empty dirty batch: every other session of the space
   * evaluates as untouched, the lapsed sessions run their full
   * evaluation) instead of waiting for an unrelated write to touch them.
   * Covers the identity's sessions on every space (FP2's cross-space
   * serving reads hang from the same lease). Nothing to do when no
   * session lapsed — the common case, and every OFF-arm call.
   */
  noteLeaseReacquired(
    notice: { space: string; principal: string },
  ): void {
    const lapsedSpaces = new Set<string>();
    for (
      const session of this.#sessions.sessionsForPrincipal(notice.principal)
    ) {
      if (
        session.leaseHolderReads === true &&
        session.leaseHolderReadsLapsed === true
      ) {
        lapsedSpaces.add(session.space);
      }
    }
    for (const space of lapsedSpaces) {
      this.markSpaceDirty(space, []);
    }
  }

  /** Whether any read root names an explicit instance — the sync gate
   * that keeps the no-key path free of added awaits. */
  #namesExplicitInstance(
    roots: Iterable<GraphQuery["roots"][number]>,
  ): boolean {
    for (const root of roots) {
      if (root.entityScopeKey !== undefined) return true;
    }
    return false;
  }

  /**
   * The delegated-scoped-read fail-closed refusal (Phase 5; protocol.md
   * §2's grant-scoped read design — RULED 2026-08-13: the design, or an
   * explicit fail-closed admission refusal, lands BEFORE any
   * delegated-scoped-read producer ships). A co-hosted SERVING session
   * (its principal holds a live lease on some space of this server)
   * reading a SCOPED root of a space whose lease it does NOT hold,
   * without naming an `entity_scope_key`, would silently resolve the
   * delegating service envelope's (empty) instance — the FP2
   * silent-empty-instance trap, cross-space edition. Refused loudly.
   *
   * FULLY SYNCHRONOUS (called without await at the three read sites):
   * ordinary client reads keep sharing one engine turn with their
   * authorization (the ACL revocation-race invariant). Ordinary
   * sessions hold no lease and exit at the scan; a serving session's
   * HOME reads (it holds the read space's lease) keep today's
   * tolerated collapsed-view behavior (the OW17 residual).
   */
  #denyForeignServingScopedRead(
    space: string,
    session: SessionState,
    roots: Iterable<ReadAdmissionRoot>,
  ): V2Error | undefined {
    if (!getServerExecutionConfig()) return undefined;
    if (session.principal === undefined) return undefined;
    let unnamedScopedRoot: string | undefined;
    for (const root of roots) {
      if (
        root.entityScopeKey === undefined && (root.scope ?? "space") !== "space"
      ) {
        unnamedScopedRoot = `${root.id} (scope "${root.scope}")`;
        break;
      }
    }
    if (unnamedScopedRoot === undefined) return undefined;
    const fullHolder = executionLeaseHolder(session.principal);
    // Home holdership short-circuits: only a RESOLVED engine can hold a
    // lease row (a never-opened engine has none), so the sync map is
    // authoritative here.
    const readEngine = this.#resolvedEngines.get(space);
    if (
      readEngine !== undefined &&
      liveExecutionLeaseHolder(readEngine, space) === fullHolder
    ) {
      return undefined;
    }
    const leaseSpace = this.#liveCoHostedLeaseSpaceFor(session.principal);
    if (leaseSpace === undefined || leaseSpace === space) return undefined;
    return toError(
      "ProtocolError",
      `scoped read of ${unnamedScopedRoot} refused: the requesting ` +
        `session is a co-hosted serving session (live lease on ` +
        `${leaseSpace}) reading foreign space ${space} without naming ` +
        "an entity_scope_key — resolving it from the delegating " +
        "envelope would silently read an empty instance (protocol.md " +
        "§2's grant-scoped read design; delegated scoped reads are " +
        "fail-closed until grant resolution lands)",
    );
  }

  /** The identity a session's scoped reads and cache keys resolve
   * against (the querying session's own — protocol.md §1). */
  #sessionScopeIdentity(session: SessionState): ScopeKeyIdentity {
    return {
      ...(session.principal === undefined
        ? {}
        : { principal: session.principal }),
      sessionId: session.id,
    };
  }

  #stageConflictRefreshDirtyIds(
    space: string,
    session: SessionState,
    commit: ClientCommit,
  ): void {
    session.pendingCaughtUpLocalSeq = Math.max(
      session.pendingCaughtUpLocalSeq,
      commit.localSeq,
    );
    const identity = this.#sessionScopeIdentity(session);
    const ids = new Set<string>();
    const addInstanceKey = (id: string, scope: CellScope | undefined) => {
      // A rejected commit's scoped addresses resolve against the
      // rejected session's own identity (M4 instance keys). A scope the
      // session holds no identity for could not have applied or been
      // read by it — skip rather than throw on the repair path.
      if (!canResolveScopeKey(scope, identity)) return;
      ids.add(toDirtyKey(id, resolveScopeKey(scope, identity)));
    };
    for (const operation of commit.operations) {
      if (operation.op === "sqlite") continue; // no entity id
      addInstanceKey(operation.id, operation.scope);
    }
    for (const read of commit.reads.confirmed) {
      addInstanceKey(read.id, read.scope);
    }
    for (const read of commit.reads.pending) {
      addInstanceKey(read.id, read.scope);
    }
    this.markSpaceDirty(space, ids);
  }

  async flushSessions(spaces?: Iterable<string>): Promise<void> {
    this.#cancelScheduledRefresh();
    // The same waiting-against-working split the connection's receive keeps,
    // one level coarser: a flush PASS, not a frame. `memory/flush/queue` is
    // how long this pass waited for the flush in front of it,
    // `memory/flush/refresh` how long its own evaluation and sending took —
    // across every dirty space the pass selected and every frame those
    // sessions were owed, so it is a batch cost and dividing it by anything
    // to recover a per-frame one is unsound. What it does bound is how long
    // a client's push can sit behind the server's own fan-out: push latency
    // is at least the refresh delay plus these two.
    const requestedAt = performance.now();
    const run = async () => {
      const refreshStart = Date.now();
      const startedAt = performance.now();
      timing.time(requestedAt, startedAt, "memory", "flush", "queue");
      try {
        await this.#refreshLoop(
          spaces === undefined ? undefined : new Set(spaces),
        );
      } finally {
        timing.time(startedAt, "memory", "flush", "refresh");
        this.#lastRefreshDurationMs = Math.max(
          0,
          Date.now() - refreshStart,
        );
        if (spaces !== undefined && this.#dirtySpaces.size > 0) {
          this.#scheduleRefresh();
        }
      }
    };

    const queued = this.#refreshing?.then(run, run) ?? run();
    this.#refreshing = queued.finally(() => {
      if (this.#refreshing === queued) {
        this.#refreshing = null;
      }
    });
    await this.#refreshing;
  }

  #scheduleRefresh(): void {
    if (
      this.options.subscriptionRefreshDelayMs === "manual" ||
      this.#dirtySpaces.size === 0 || this.#refreshTurn !== null
    ) {
      return;
    }
    this.#refreshTurn = armTurn(
      () => {
        this.#refreshTurn = null;
        void this.#flushScheduledSessions();
      },
      this.options.subscriptionRefreshDelayMs ?? SUBSCRIPTION_REFRESH_DELAY_MS,
    );
  }

  /**
   * Helper for the refresh timer, which waits for the connection queues to
   * drain and then flushes the scheduled sessions, logging a failure rather
   * than throwing it, since the timer has no caller to surface one to.
   */
  async #flushScheduledSessions(): Promise<void> {
    await this.#waitForConnectionQueuesToDrain(
      Math.max(
        MIN_REFRESH_QUEUE_DRAIN_WAIT_MS,
        this.#lastRefreshDurationMs * 2,
      ),
    );
    try {
      await this.flushSessions();
    } catch (error) {
      // The failed batch was requeued and rescheduled by refreshLoop; a
      // timer-driven pass has no caller to surface to, so log rather than
      // leak an unhandled rejection.
      console.warn("memory v2: scheduled refresh failed; requeued", error);
    }
  }

  async #waitForConnectionQueuesToDrain(
    maxWaitMs: number,
  ): Promise<void> {
    const deadlineMs = Date.now() + maxWaitMs;
    while (true) {
      const pending = [...this.#connections.values()].filter((connection) =>
        connection.hasPendingReceives()
      );
      if (pending.length === 0) {
        return;
      }
      if (Date.now() >= deadlineMs) {
        return;
      }
      const drained = await Promise.all(
        pending.map((connection) =>
          connection.waitForReceiveQueueToDrain(deadlineMs)
        ),
      );
      if (drained.every(Boolean)) {
        return;
      }
      if (Date.now() >= deadlineMs) {
        return;
      }
    }
  }

  #cancelScheduledRefresh(): void {
    if (this.#refreshTurn !== null) {
      this.#refreshTurn.cancel();
      this.#refreshTurn = null;
    }
    if (this.#connections.size === 0) {
      this.#dirtySpaces.clear();
      this.#dirtyDocsBySpace.clear();
      this.#dirtyOriginsBySpace.clear();
      this.#derivedDirtyBySpace.clear();
    }
  }

  /**
   * Runs one transaction or fan-out turn at a time for `space`.
   *
   * A transaction arriving during fan-out waits for that turn to finish. Locks
   * for other spaces remain independent, so the latency coupling is local to
   * one space.
   */
  async #withSpacePublicationLock<T>(
    space: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#publicationBySpace.get(space) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const queued = previous.then(() => release.promise);
    this.#publicationBySpace.set(space, queued);

    await previous;
    try {
      return await run();
    } finally {
      release.resolve();
      if (this.#publicationBySpace.get(space) === queued) {
        this.#publicationBySpace.delete(space);
      }
    }
  }

  /** Waits until every queued per-space publication turn has settled. */
  async #drainSpacePublicationLocks(): Promise<void> {
    while (this.#publicationBySpace.size > 0) {
      await Promise.all(this.#publicationBySpace.values());
    }
  }

  async #refreshLoop(initial?: Set<string>): Promise<void> {
    let pending = initial;
    while (true) {
      if (initial === undefined && this.#dirtySpaces.size > 0) {
        await this.#waitForConnectionQueuesToDrain(
          Math.max(
            MIN_REFRESH_QUEUE_DRAIN_WAIT_MS,
            this.#lastRefreshDurationMs * 2,
          ),
        );
      }
      const spaces = pending ? [...pending] : [...this.#dirtySpaces];
      if (spaces.length === 0) {
        return;
      }

      pending = undefined;

      // Push priority (Phase 6, protocol.md §3): spaces carrying derived
      // novelty flush ahead of spaces with only bulk/authored content —
      // the cross-space half of "derived commits flush first" (the
      // per-session half is refreshDirty's two-pass). Stable partition:
      // insertion order is preserved within each group.
      spaces.sort((left, right) => {
        const leftDerived = (this.#derivedDirtyBySpace.get(left)?.size ?? 0) > 0
          ? 0
          : 1;
        const rightDerived =
          (this.#derivedDirtyBySpace.get(right)?.size ?? 0) > 0 ? 0 : 1;
        return leftDerived - rightDerived;
      });

      for (const space of spaces) {
        await this.#withSpacePublicationLock(space, async () => {
          // Removed at its own processing turn (CT-1927): pre-deleting the
          // whole selection meant a failure mid-batch stranded every
          // not-yet-processed space — dirty maps intact but the space no
          // longer discoverable.
          this.#dirtySpaces.delete(space);
          const dirtyIds = this.#dirtyDocsBySpace.get(space);
          if (dirtyIds !== undefined) {
            this.#dirtyDocsBySpace.delete(space);
          }
          const dirtyOrigins = this.#dirtyOriginsBySpace.get(space);
          if (dirtyOrigins !== undefined) {
            this.#dirtyOriginsBySpace.delete(space);
          }
          // Push priority (Phase 6): consume the batch's derived-key
          // classification with the batch.
          const derivedDirty = this.#derivedDirtyBySpace.get(space);
          if (derivedDirty !== undefined) {
            this.#derivedDirtyBySpace.delete(space);
          }
          // Fan-out is a scheduled/batched timer decoupled from transact, so it
          // must be its own root span. `root: true` makes that explicit — the
          // context manager propagates the active context into timer callbacks,
          // so without it this span could parent under whichever memory.transact
          // happened to schedule the refresh.
          try {
            await tracer.startActiveSpan(
              "memory.fanout",
              { root: true },
              async (span) => {
                span.setAttribute("space.did", space);
                span.setAttribute("subscriber.count", this.#connections.size);
                span.setAttribute("dirty.count", dirtyIds?.size ?? 0);
                try {
                  if (derivedDirty !== undefined && derivedDirty.size > 0) {
                    // Push priority (Phase 6, protocol.md §3): two-phase
                    // fan-out — every connection's derived-subscribed
                    // sessions evaluate and send BEFORE any connection's
                    // bulk-only sessions, so a big authored blob's
                    // evaluation never heads-of-line a derived frame
                    // anywhere in the serialized chain.
                    let prioritized = 0;
                    for (const connection of this.#connections.values()) {
                      prioritized += await connection.refreshDirty(
                        space,
                        dirtyIds,
                        dirtyOrigins,
                        { derivedDirty, group: "prioritized" },
                        true,
                      );
                    }
                    let followers = 0;
                    for (const connection of this.#connections.values()) {
                      followers += await connection.refreshDirty(
                        space,
                        dirtyIds,
                        dirtyOrigins,
                        { derivedDirty, group: "followers" },
                        true,
                      );
                    }
                    if (prioritized > 0 && followers > 0) {
                      this.notePushPrioritySplit(prioritized, followers);
                    }
                  } else {
                    for (const connection of this.#connections.values()) {
                      await connection.refreshDirty(
                        space,
                        dirtyIds,
                        dirtyOrigins,
                        undefined,
                        true,
                      );
                    }
                  }
                } finally {
                  span.end();
                }
              },
            );
          } catch (error) {
            // Requeue the consumed batch (CT-1927): the dirty state was taken
            // before fan-out, so a failure here would otherwise orphan it —
            // no later refresh fires unless another write happens, and the
            // batched refresh is the delivery path the staged catch-up
            // markers rely on. Merge UNDER anything that accrued meanwhile
            // (newer provenance wins), reschedule, and rethrow so callers
            // see the failure.
            this.#dirtySpaces.add(space);
            if (dirtyIds !== undefined) {
              let current = this.#dirtyDocsBySpace.get(space);
              if (current === undefined) {
                current = new Set();
                this.#dirtyDocsBySpace.set(space, current);
              }
              let currentOrigins = this.#dirtyOriginsBySpace.get(space);
              for (const id of dirtyIds) {
                if (current.has(id)) {
                  // The id was re-dirtied while the failed batch was in
                  // flight. Provenance survives only when BOTH batches agree
                  // on the same session; otherwise the merged novelty is
                  // mixed and must fan out authoritatively — restoring the
                  // newer origin alone would echo-suppress the consumed
                  // batch's foreign/unattributed novelty (CT-1927 review).
                  const restoredOrigin = dirtyOrigins?.get(id);
                  const currentOrigin = currentOrigins?.get(id);
                  if (
                    currentOrigin !== undefined &&
                    restoredOrigin?.sessionId !== currentOrigin.sessionId
                  ) {
                    currentOrigins?.delete(id);
                  }
                  continue;
                }
                current.add(id);
                const origin = dirtyOrigins?.get(id);
                if (origin !== undefined) {
                  if (currentOrigins === undefined) {
                    currentOrigins = new Map();
                    this.#dirtyOriginsBySpace.set(space, currentOrigins);
                  }
                  currentOrigins.set(id, origin);
                }
              }
            }
            // Push priority (Phase 6): re-merge the consumed batch's
            // derived classification alongside the requeued ids (union —
            // a key derived in EITHER batch still carries undelivered
            // derived novelty).
            if (derivedDirty !== undefined && derivedDirty.size > 0) {
              let currentDerived = this.#derivedDirtyBySpace.get(space);
              if (currentDerived === undefined) {
                currentDerived = new Set();
                this.#derivedDirtyBySpace.set(space, currentDerived);
              }
              for (const id of derivedDirty) currentDerived.add(id);
            }
            this.#scheduleRefresh();
            throw error;
          }
        });
      }

      if (initial !== undefined) {
        return;
      }
    }
  }

  respond(payload: string): Promise<string | null> {
    const parsed = parseClientMessage(payload);
    if (parsed?.type === "hello") {
      const response = respondToHello(parsed, this.memoryProtocolFlags());
      if (response.type !== "hello.ok") {
        return Promise.resolve(encodeMemoryBoundary(response));
      }
      return Promise.resolve(encodeMemoryBoundary({
        type: "response",
        requestId: "handshake",
        error: toError(
          "ProtocolError",
          "memory Server.respond cannot issue session.open authentication metadata",
        ),
      }));
    }
    return Promise.resolve(null);
  }

  /**
   * The co-hosted direct-engine access of server-execution v2
   * (serving-loop.md §1): the ExecutorHost's lease writes ride plane (c)
   * as direct table updates, and the wave commit step's sink runs its
   * store transaction (per-doc re-verification + derived-class apply +
   * basis rows) against this same engine. Server-internal machinery and
   * tests only — nothing session-facing reaches an engine directly.
   */
  engineForSpace(space: string): Promise<Engine.Engine> {
    return this.#openEngine(space);
  }

  /**
   * The structural write grant for a FOREIGN provisioning write
   * (server-execution v2 Phase 5; protocol.md §2b; serving-loop.md
   * §3d's accept gate): whether `principal` — the CARRIED acting
   * identity of a served run — holds authority to write `space`. The
   * wave's accumulation gate consults this per crossing, so "admitted
   * iff carriage" becomes a real authorization predicate instead of a
   * vacuous shape check (carriage is minted for every acting run).
   *
   * The grants, in check order — each a structural fact this process
   * holds, never a trust widening:
   *
   * - **owner-by-identity**: the target space IS the principal's own
   *   DID (a user's home space — the demanded wish bootstrap's
   *   sanctioned target, builtins.md §5).
   * - **creation**: the target store does not exist — §2b's sanctioned
   *   provisioning ("provision a foreign/NEW space"), where the
   *   creating commit is what makes it the actor's (CT-1650's
   *   deterministic per-user-per-event DIDs; quota attribution stays
   *   the recorded residual, README §3.8). Probed WITHOUT creating:
   *   the open-engine map first, then the store path — `#openEngine()`
   *   materializes a store as a side effect, which is exactly what an
   *   ungranted probe must not do.
   * - **acl**: the target's OWN ACL document grants the principal (or
   *   `ANYONE`) WRITE/OWNER — the same per-space grant structure the
   *   client session path enforces. Checked mode-independently: this
   *   gate is the serving plane's normative fail-closed interim
   *   (protocol.md §2's posture), not the client ACL rollout, so
   *   `acl.mode: "off"` does not disable it, the service-DID blanket
   *   (`#isServicePrincipal`) does NOT apply (resolving ambient
   *   service authority is the lunch-wall class), and the
   *   missing-ACL-populated-legacy compat arm does not apply either
   *   (fail closed; the per-DOC grant resolution stays OW13's owed
   *   hardening).
   *
   * Anything else refuses — including a malformed space name, so a
   * carriage-bearing write to a garbage space string can never
   * silently provision a store on the co-hosted server.
   */
  async foreignWriteAuthorityFor(
    space: string,
    principal: string | undefined,
  ): Promise<
    | { granted: true; via: "owner" | "creation" | "acl" }
    | { granted: false; reason: string }
  > {
    if (!WELL_FORMED_SPACE_DID.test(space)) {
      return {
        granted: false,
        reason: `"${space}" is not a space DID — refusing to resolve (or ` +
          "provision) a store for a malformed space name (protocol.md §2b)",
      };
    }
    if (principal === undefined || principal === "") {
      return {
        granted: false,
        reason: "no acting principal — a foreign provisioning write is " +
          "admitted only under a carried actor's grant (protocol.md §2b)",
      };
    }
    if (principal === space) {
      return { granted: true, via: "owner" };
    }
    if (!(await this.#spaceStoreExists(space))) {
      return { granted: true, via: "creation" };
    }
    const engine = await this.#openEngine(space);
    const state = this.#aclState(engine, space);
    if (state.kind === "valid") {
      const capability = state.acl[principal] ?? state.acl[ANYONE_USER] ??
        null;
      if (capability !== null && isCapable(capability, "WRITE")) {
        return { granted: true, via: "acl" };
      }
      return {
        granted: false,
        reason: `the ACL of ${space} grants ${principal} ` +
          `${capability ?? "nothing"} (WRITE required)`,
      };
    }
    return {
      granted: false,
      reason: state.kind === "missing"
        ? `${space} exists with no ACL document — the serving plane fails ` +
          "closed (protocol.md §2's interim; the client path's legacy " +
          "compat arm is a rollout accommodation, not a grant)"
        : `${space} has a malformed, ownerless, or retracted ACL`,
    };
  }

  /** Whether a store for `space` already exists, WITHOUT creating one
   * (the foreignWriteAuthorityFor probe's creation arm — `#openEngine()`
   * materializes stores as a side effect). An open (or opening) engine
   * exists by definition; a file-backed store exists iff its file
   * does; a memory-backed store exists only while an engine holds it. */
  async #spaceStoreExists(space: string): Promise<boolean> {
    if (this.#engines.has(space)) return true;
    if (this.#store === undefined) return false;
    const url = resolveSpaceStoreUrl(
      this.#store,
      space as `did:${string}:${string}`,
    );
    if (url.protocol !== "file:") return false;
    try {
      return await FS.exists(Path.fromFileUrl(url));
    } catch {
      return false;
    }
  }

  /**
   * Opens the engine for `space`, or hands back the one already open or
   * opening. An opener a test supplied wraps the whole step.
   */
  #openEngine(space: string): Promise<Engine.Engine> {
    const opener = this.#engineOpener;
    if (opener !== undefined) {
      return opener(space, (space) => this.#openEngineInner(space));
    }
    return this.#openEngineInner(space);
  }

  /**
   * Helper for `#openEngine()`, which does the opening: an engine already
   * open or opening is handed back; otherwise one is opened at the space's
   * store URL, its directory created first when the store is a file, and
   * indexed while it opens.
   */
  #openEngineInner(space: string): Promise<Engine.Engine> {
    const existing = this.#engines.get(space);
    if (existing !== undefined) {
      return existing;
    }

    const url = this.#store
      ? resolveSpaceStoreUrl(
        this.#store,
        space as `did:${string}:${string}`,
      )
      : new URL(`memory:///${encodeURIComponent(space)}`);
    const opened = (async () => {
      if (url.protocol === "file:") {
        await FS.ensureDir(Path.toFileUrl(Path.dirname(Path.fromFileUrl(url))));
      }
      return await Engine.open({
        url,
        operationCodecs: this.#operationCodecs,
        operationCheckpointInterval: this.options.operationCheckpointInterval,
        documentCacheBudgetBytes: this.options.documentCacheBudgetBytes,
        documentCacheMaxEntries: this.options.documentCacheMaxEntries,
        documentCacheCoordinator: this.#documentCacheCoordinator,
      });
    })();
    // The SYNC engine view (server-execution v2 Phase 5): the read-row
    // admission's cross-engine lease lookup (protocol.md §2, FP2) must
    // stay synchronous on the unnamed read path (the ACL revocation-race
    // invariant — no added microtask boundary), so resolved engines are
    // indexed here for the sync scan. A lease can only exist on an OPEN
    // engine (co-hosted activation opens it before acquiring), so the
    // resolved map sees every live lease.
    opened.then((engine) => {
      if (this.#engines.get(space) === opened) {
        this.#resolvedEngines.set(space, engine);
      }
    }, () => {
      if (this.#engines.get(space) === opened) {
        this.#engines.delete(space);
        this.#resolvedEngines.delete(space);
      }
    });
    this.#engines.set(space, opened);
    return opened;
  }

  /**
   * The live co-hosted execution lease held by `principal`'s serving
   * process, if any (server-execution v2 Phase 5; protocol.md §2's read
   * row as widened by FP2, RULED 2026-08-03). Two properties, both
   * deliberate:
   *
   * - PER-PROCESS sharpening (the Phase-1 recorded acceptance's
   *   follow-up, verification-coverage.md's stage-F read-row entry):
   *   equality is against the FULL DR1 holder minted by THIS process —
   *   `executionLeaseHolder(principal)` binds the module-level
   *   process-instance component the co-hosted ExecutorHost mints
   *   holders from — so a second process authenticated as the same
   *   service DID no longer passes on this process's lease rows.
   * - SYNCHRONOUS: scans the RESOLVED engine map only (see
   *   `#openEngineInner()`), so callers on the read path add no microtask
   *   boundary. Sound because a lease row can only be written through an
   *   open co-hosted engine.
   */
  #liveCoHostedLeaseSpaceFor(principal: string): string | undefined {
    const holder = executionLeaseHolder(principal);
    for (const [space, engine] of this.#resolvedEngines) {
      if (liveExecutionLeaseHolder(engine, space) === holder) return space;
    }
    return undefined;
  }

  /**
   * Records `key` in `#ensuredSchemas`, evicting the oldest entry once the
   * map exceeds `#ensuredSchemasMax`.
   */
  #recordSchemaEnsured(key: string): void {
    this.#ensuredSchemas.set(key, true);
    if (this.#ensuredSchemas.size > this.#ensuredSchemasMax) {
      const oldest = this.#ensuredSchemas.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.#ensuredSchemas.delete(oldest);
    }
  }
}

/**
 * The `holdings` a request may carry (`SessionHolding[]`): absent stays
 * absent; a present value must be a list of well-formed holdings, and a
 * malformed one fails the whole message as unparseable — a client that
 * declares holdings it cannot spell is not silently delivered in full.
 */
const parseHoldings = (
  value: FabricValue,
): SessionHolding[] | undefined | null => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const holdings: SessionHolding[] = [];
  for (const entry of value) {
    if (
      !isFabricPlainObject(entry) ||
      typeof entry.id !== "string" ||
      !isNonNegativeInteger(entry.seq) ||
      (entry.scope !== undefined && !isCellScope(entry.scope)) ||
      (entry.branch !== undefined && typeof entry.branch !== "string") ||
      (entry.deleted !== undefined && entry.deleted !== true)
    ) {
      return null;
    }
    holdings.push({
      id: entry.id as SessionHolding["id"],
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
      seq: entry.seq,
      ...(entry.deleted === true ? { deleted: true } : {}),
    });
  }
  return holdings;
};

const isCellScope = (value: unknown): value is CellScope =>
  value === "space" || value === "user" || value === "session";

function isSqliteNamedParamEntries(
  value: unknown,
): value is SqliteNamedParamsWire {
  return Array.isArray(value) &&
    value.every((entry) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
    );
}

export const parseClientMessage = (
  payload: string,
): ClientMessage | null => {
  let parsed: FabricValue;
  try {
    parsed = decodeMemoryBoundary(payload);
  } catch {
    return null;
  }

  if (!isFabricPlainObject(parsed)) {
    return null;
  }

  if (
    parsed.type === "hello" &&
    typeof parsed.protocol === "string"
  ) {
    if (parseMemoryProtocolFlags(parsed.flags) === null) {
      return null;
    }
    return {
      type: "hello",
      protocol: parsed.protocol as HelloMessage["protocol"],
      flags: parsed.flags as WireMemoryProtocolFlags,
    };
  }

  if (
    parsed.type === "session.open" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    isFabricPlainObject(parsed.session)
  ) {
    const holdings = parseHoldings(parsed.holdings);
    if (holdings === null) return null;
    if (
      parsed.session.genesisRoot !== undefined &&
      !isGenesisRoot(parsed.session.genesisRoot)
    ) return null;
    // A malformed ceiling refuses the message: a session opened without the
    // ceiling its client asked for would read unbounded, silently.
    const readCeiling = parseSessionReadCeiling(parsed.session.readCeiling);
    if (readCeiling === null) return null;
    return {
      type: "session.open",
      requestId: parsed.requestId,
      space: parsed.space,
      ...(holdings === undefined ? {} : { holdings }),
      session: {
        sessionId: typeof parsed.session.sessionId === "string"
          ? parsed.session.sessionId
          : undefined,
        seenSeq: typeof parsed.session.seenSeq === "number"
          ? parsed.session.seenSeq
          : undefined,
        sessionToken: typeof parsed.session.sessionToken === "string"
          ? parsed.session.sessionToken
          : undefined,
        // The delegated READ binding (OW31): parsed as the LITERAL
        // marker only — any other string reaches openSession's
        // unknown-value refusal rather than being silently dropped.
        actingAs: parsed.session.actingAs === "space-owner"
          ? "space-owner"
          : typeof parsed.session.actingAs === "string"
          ? (parsed.session.actingAs as "space-owner")
          : undefined,
        ...(readCeiling !== undefined ? { readCeiling } : {}),
        ...(isGenesisRoot(parsed.session.genesisRoot)
          ? { genesisRoot: parsed.session.genesisRoot }
          : {}),
      },
      invocation: isFabricPlainObject(parsed.invocation)
        ? parsed.invocation
        : undefined,
      authorization: parsed
        .authorization as SessionOpenRequest["authorization"],
    };
  }

  if (
    parsed.type === "transact" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isFabricPlainObject(parsed.commit)
  ) {
    return {
      type: "transact",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      commit: parsed.commit as unknown as TransactRequest["commit"],
    };
  }

  if (
    parsed.type === "graph.query" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isFabricPlainObject(parsed.query) &&
    Array.isArray(parsed.query.roots)
  ) {
    return {
      type: "graph.query",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      query: parsed.query as unknown as GraphQueryRequest["query"],
    };
  }

  if (
    parsed.type === "op.query" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    isFabricPlainObject(parsed.query) &&
    typeof parsed.query.id === "string" &&
    Array.isArray(parsed.query.path)
  ) {
    return {
      type: "op.query",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      query: parsed.query as unknown as OperationFieldQueryRequest["query"],
    };
  }

  if (
    parsed.type === "entity-id.list" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    (parsed.after === undefined || typeof parsed.after === "string") &&
    (parsed.limit === undefined ||
      (isNonNegativeInteger(parsed.limit) && parsed.limit > 0)) &&
    (parsed.expectedServerSeq === undefined ||
      isNonNegativeInteger(parsed.expectedServerSeq))
  ) {
    return {
      type: "entity-id.list",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      ...(parsed.after === undefined
        ? {}
        : { after: parsed.after as EntityIdListRequest["after"] }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.expectedServerSeq === undefined
        ? {}
        : { expectedServerSeq: parsed.expectedServerSeq }),
    };
  }

  if (
    parsed.type === "entity-id.exists" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.id === "string"
  ) {
    return {
      type: "entity-id.exists",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      id: parsed.id as EntityIdLookupRequest["id"],
    };
  }

  if (
    parsed.type === "sqlite.query" &&
    (parsed.reader === undefined ||
      (isFabricPlainObject(parsed.reader) &&
        typeof parsed.reader.principal === "string" &&
        parsed.reader.principal.length > 0 &&
        (parsed.reader.sessionId === undefined ||
          (typeof parsed.reader.sessionId === "string" &&
            parsed.reader.sessionId.length > 0)))) &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.sql === "string" &&
    parsed.sql.length <= 100_000 &&
    isFabricPlainObject(parsed.db) &&
    typeof parsed.db.id === "string" &&
    parsed.db.id.length > 0 && parsed.db.id.length <= 256 &&
    (parsed.db.tables === undefined ||
      (isFabricPlainObject(parsed.db.tables) &&
        Object.keys(parsed.db.tables).length <= 256)) &&
    (parsed.db.scope === undefined || parsed.db.scope === "space" ||
      parsed.db.scope === "user" || parsed.db.scope === "session") &&
    !(parsed.params !== undefined && parsed.namedParams !== undefined) &&
    (parsed.namedParams === undefined ||
      isSqliteNamedParamEntries(parsed.namedParams))
  ) {
    const db = {
      id: parsed.db.id,
      tables: isFabricPlainObject(parsed.db.tables)
        ? parsed.db.tables
        : undefined,
      scope: parsed.db.scope as CellScope | undefined,
    };
    const params = isSqliteNamedParamEntries(parsed.namedParams)
      ? Object.fromEntries(parsed.namedParams)
      : Array.isArray(parsed.params) || isFabricPlainObject(parsed.params)
      ? parsed.params as SqliteParamsWire
      : undefined;
    return {
      type: parsed.type,
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      db,
      sql: parsed.sql,
      params,
      ...(parsed.reader === undefined ? {} : { reader: parsed.reader }),
    } as SqliteQueryRequest;
  }

  if (
    parsed.type === "sqlite.register-disk-source" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.id === "string" &&
    parsed.id.length > 0 && parsed.id.length <= 256 &&
    typeof parsed.path === "string" &&
    parsed.path.length > 0 && parsed.path.length <= 4096
  ) {
    return {
      type: "sqlite.register-disk-source",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      id: parsed.id,
      path: parsed.path,
    } as SqliteRegisterDiskSourceRequest;
  }

  if (
    parsed.type === "session.watch.set" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    Array.isArray(parsed.watches)
  ) {
    const views = parseViewInterests(parsed.views);
    if (views === null) return null;
    const holdings = parseHoldings(parsed.holdings);
    if (holdings === null) return null;
    return {
      type: "session.watch.set",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      watches: parsed.watches as WatchSpec[],
      ...(views === undefined ? {} : { views }),
      ...(holdings === undefined ? {} : { holdings }),
    };
  }

  if (
    parsed.type === "event.attention.resolve" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.eventId === "string" && parsed.eventId.length > 0 &&
    typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) &&
    parsed.seq >= 0 &&
    typeof parsed.sidecarId === "string" && parsed.sidecarId.length > 0 &&
    (parsed.action === "retry" || parsed.action === "dismiss")
  ) {
    return {
      type: "event.attention.resolve",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      eventId: parsed.eventId,
      seq: parsed.seq,
      sidecarId: parsed.sidecarId,
      action: parsed.action,
    };
  }

  if (
    parsed.type === "session.watch.add" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    Array.isArray(parsed.watches)
  ) {
    return {
      type: "session.watch.add",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      watches: parsed.watches as WatchSpec[],
    };
  }

  if (
    parsed.type === "session.ack" &&
    typeof parsed.requestId === "string" &&
    typeof parsed.space === "string" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.seenSeq === "number"
  ) {
    return {
      type: "session.ack",
      requestId: parsed.requestId,
      space: parsed.space,
      sessionId: parsed.sessionId,
      seenSeq: parsed.seenSeq,
    };
  }

  return null;
};
