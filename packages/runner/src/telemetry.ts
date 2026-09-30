// RuntimeTelemetry is used throughout the runtime
// to record events that can be subscribed to in other
// contexts to visualize or log events inside the runtime.

import type { CfcRefusalDetail } from "./cfc/refusal-detail.ts";
import type { ReadAttemptCounts } from "./read-stats.ts";
import type { FabricValue } from "@commonfabric/data-model";

import { IMemoryChange } from "./storage/interface.ts";

/** Read work performed by one action run, or summed across runs. */
export type ActionReadStats = {
  /** Reactive property and element reads, including cached reads. */
  proxyAccesses: number;

  /** Stored-link traversal attempts, including repeated fallback reads. */
  linkResolutions: number;

  /** Distinct replica documents read, counted separately in each run. */
  distinctDocuments: number;

  /** Compacted deep and shallow scheduling reads before commit preparation. */
  registeredDependencies: number;
};

/**
 * Statistics tracked for each action's execution performance.
 */
export type ActionStats = {
  /** Read counts summed over measured runs only. */
  reads?: ActionReadStats;

  /** Read counts from the latest run, absent when accounting is disabled. */
  lastRunReads?: ActionReadStats;

  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number; // When the action last ran (performance.now())
};

// Types for scheduler graph visualization
export type SchedulerGraphNode = {
  id: string; // actionId or "input:space/entity" for inputs
  type: "effect" | "computation" | "input" | "inactive"; // inactive = has stats but no longer registered
  stats?: ActionStats;
  isDirty: boolean;
  isPending: boolean;
  isDemanded?: boolean;
  isLiveEffect?: boolean;
  isPullDemandRoot?: boolean;
  isConditionallyScheduled?: boolean;
  isDebouncedWaiting?: boolean;
  hasActiveDebounceTimer?: boolean;
  nextDebounceRunInMs?: number;
  nextEligibleRunInMs?: number;
  parentId?: string; // ID of parent action if this was created during parent's execution
  childCount?: number; // Number of child actions created during this action's execution
  preview?: string; // First ~200 chars of function body for hover tooltips
  // Where the action's implementation was authored, as
  // `cf:module/<identity>/<path>:<line>:<col>`. The transformer records the
  // line and column of each hoisted builder call, so this names the `lift`,
  // `computed` or `handler` site itself rather than the module. Present for an
  // implementation the engine verified; absent for the builtins and for host
  // and dynamic builders, which have no authored site.
  src?: string;
  // Diagnostic info: what cells this action reads and writes
  reads?: string[]; // space/entity paths this action reads
  shallowReads?: string[]; // non-recursive reads used for structural invalidation
  writes?: string[]; // space/entity paths this action writes (mightWrite)
  // Timing controls
  debounceMs?: number; // Current debounce delay in ms (if set)
  throttleMs?: number; // Current throttle period in ms (if set)
  // Pattern association: the content-addressed { identity, symbol } of the
  // pattern this action belongs to (the only pattern pointer post-patternId
  // retirement). `identity` is a module content hash; `symbol` distinguishes
  // co-located patterns of one module (the export vs hoisted sub-patterns).
  patternIdentity?: { identity: string; symbol: string };
};

export type SchedulerGraphEdge = {
  from: string; // actionId of source
  to: string; // actionId of target
  cells: string[]; // Cell IDs creating this dependency
  edgeType?: "data" | "parent"; // data = dependency, parent = parent-child relationship
};

export type SchedulerGraphSnapshot = {
  nodes: SchedulerGraphNode[];
  edges: SchedulerGraphEdge[];
  timestamp: number;
};

export type SchedulerActionInfo = {
  patternName?: string;
  moduleName?: string;
  reads?: string[];
  writes?: string[];
};

export type SchedulerEventPreflightStats = {
  visitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  workSetAddCount: number;
  reverseDependencyActionCount: number;
  reverseDependencyEdgeCount: number;
  logReadCount: number;
  logShallowReadCount: number;
  writerCandidateCount: number;
  writerOverlapCount: number;
  directWriterCount: number;
  hotActions?: SchedulerEventPreflightActionSummary[];
  hotFanoutActions?: SchedulerEventPreflightActionSummary[];
  rootDirectWriters?: SchedulerEventPreflightActionSummary[];
};

export type SchedulerEventPreflightActionSummary = {
  actionId: string;
  actionType: "effect" | "computation" | "unknown";
  visitCount: number;
  dirtyInputCount: number;
  resultTrueCount: number;
  reverseDependencyEdgeCount: number;
  maxDirectWriterCount: number;
  dirty: boolean;
  pending: boolean;
  readCount: number;
  shallowReadCount: number;
  writeCount: number;
};

//
// Diagnosis types for non-settling / non-idempotent detection
//

/**
 * Report for a single action detected as non-idempotent.
 * Same inputs (reads) produced different outputs (writes) across runs.
 */
export type NonIdempotentReport = {
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  runs: {
    timestamp: number;
    reads: Record<string, FabricValue>;
    writes: Record<string, FabricValue>;
  }[];
  differingWriteKeys: string[];
};

/**
 * A cycle found in the causal chain of action triggers.
 * e.g. A writes cell X -> triggers B, B writes cell Y -> triggers A.
 */
export type CycleReport = {
  cycle: { actionId: string; writesCell: string }[];
  timestamp: number;
};

/**
 * Aggregated result from a diagnosis run.
 */
export type SchedulerDiagnosisResult = {
  nonIdempotent: NonIdempotentReport[];
  cycles: CycleReport[];
  duration: number;
  busyTime: number;
};

// Types of markers that can be submitted by the runtime.
export type RuntimeTelemetryMarker = {
  type: "scheduler.run";
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  error?: string;
} | {
  type: "scheduler.read-attempt";
  kind:
    | "reactive"
    | "event"
    | "presync"
    | "preflight"
    | "initialization"
    | "editWithRetry";
  actionId?: string;
  reads: ReadAttemptCounts;
} | {
  // Emitted when an action run finishes, next to the ActionStats recording —
  // the same wall-clock measurement, surfaced as a marker so consumers (OTel
  // bridge, debugger) get per-run durations without polling getActionStats().
  type: "scheduler.run.complete";
  actionId: string;
  actionInfo?: SchedulerActionInfo;
  durationMs: number;

  /** Read work for this run, when accounting is enabled. */
  reads?: ActionReadStats;

  /** Authored file, line, and column for the measured action. */
  src?: string;

  error?: string;
} | {
  // Emitted as the runner begins installing a piece's registration under
  // `key`, BEFORE the registration is set: a listener reads the registry as
  // it stood when the install began.
  type: "runner.piece.install";
  key: string;
} | {
  // Emitted as a commit-gated start for the result under `key` enters the
  // runner's pending index, where a stop arriving before the commit finds it.
  // One marker per entry into the index: a key can hold several attempts at
  // once, and an attempt that recovers from a refused commit re-enters.
  type: "runner.deferred-start.pending";
  key: string;
} | {
  // Emitted as a pending commit-gated start leaves the index: `installed`
  // once the attempt has installed its registration, which happens before
  // its own transaction commits, and `cancelled` when the attempt ended
  // before installing one. Pairs one-to-one with
  // `runner.deferred-start.pending` for the same entry.
  type: "runner.deferred-start.settled";
  key: string;
  outcome: "installed" | "cancelled";
} | {
  // Emitted as the runner memoizes which pattern the result doc under `key`
  // holds for the scope instance `scopeKey`, the memo that lets the next run
  // of the same computation skip materializing its child again.
  type: "runner.result-pattern.memoize";
  key: string;
  scopeKey: string;
} | {
  // Emitted as a result-pattern memo leaves the runner: for every instance of
  // the doc under `key` when a storage notification names that doc or resets
  // the space holding it (no `scopeKey`), and for one instance when the
  // commit that wrote its child is rejected. The sweep in `stopAll()` drops
  // the whole memo without one.
  type: "runner.result-pattern.evict";
  key: string;
  scopeKey?: string;
} | {
  // Emitted as the engine records a verified module's implementation under
  // its content-addressed `{ identity, symbol }`, with the binding path of
  // the module-scope declaration it was bound to when the transformer
  // annotated one. A host-trusted value registers without one.
  type: "harness.implementation.register";
  identity: string;
  symbol: string;
  bindingPath?: string[];
} | {
  // Emitted as the pattern manager begins a tracked compile-cache write-back
  // into `space` for the closure rooted at `entryIdentity`: a closure
  // persistence or a source write-back, the writes replication waits on
  // before reading its origin space.
  type: "pattern.cache-write-back.start";
  space: string;
  entryIdentity: string;
} | {
  // Emitted as a tracked compile-cache write-back settles, whichever way it
  // settled. Pairs one-to-one with `pattern.cache-write-back.start`.
  type: "pattern.cache-write-back.complete";
  space: string;
  entryIdentity: string;
} | {
  // Emitted each time the scheduler decides an action's materializer
  // registration, on subscribe and on resubscribe. `writes` are the compacted
  // write envelopes the action is registered under, as `space/id/path`
  // strings; an action registered under none is not a materializer.
  type: "scheduler.materializer.register";
  actionId: string;
  writes: string[];
} | {
  // Emitted as diagnosis mode switches on, whether by an explicit run or by
  // the non-settling auto-trigger, with the window it will capture for.
  type: "scheduler.diagnosis.start";
  durationMs: number;
} | {
  // Emitted once per settle pass, unconditionally (unlike SettleStats, which
  // is opt-in): the user-facing "event → stable graph" number.
  type: "scheduler.settle";
  durationMs: number;
  iterations: number;
  settledEarly: boolean;
  seedCount: number;
  workSetSize: number;
} | {
  type: "cell.update";
  change: IMemoryChange;
  error?: string;
} | {
  type: "scheduler.invocation";
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  error?: string;
} | {
  type: "scheduler.event.commit";
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  readCount: number;
  writeCount: number;
  changedWriteCount: number;
  writes: string[];
  writesTruncated?: boolean;
  error?: string;
  permanentRejection?: "origin-committed" | "receipt-exists";

  /** Backpressure attempt count (1-based) for a transient-conflict retry. */
  retryAttempt?: number;

  /** Backoff delay applied before the next retry, in milliseconds. */
  backoffMs?: number;

  /**
   * Set when the commit reached a terminal outcome: `permanent` for a
   * never-retried precondition failure, `convergence` for a transient conflict
   * that exhausted the retry window and surfaced a terminal error, `rule` for a
   * deterministic server-side commit-rule refusal (never retried).
   */
  terminal?: "permanent" | "convergence" | "rule";
} | {
  type: "scheduler.event.preflight";
  handlerId: string;
  handlerInfo?: SchedulerActionInfo;
  readCount: number;
  shallowReadCount: number;
  dirtySizeBefore: number;
  pendingSizeBefore: number;
  dirtyDependencyCount: number;
  hasDirtyDependencies: boolean;
  skipped: boolean;
  populateMs: number;
  txToLogMs: number;
  depCommitMs: number;
  collectMs: number;
  scheduleMs: number;
  stats: SchedulerEventPreflightStats;
  error?: string;
} | {
  type: "storage.push.start";
  id: string;
  operation: string;
  // Client-side commit sequence + space: the join keys to the memory
  // server's `memory.transact` span (commit.local_seq / space.did attrs).
  localSeq?: number;
  spaceDid?: string;
  error?: string;
} | {
  type: "storage.push.complete";
  id: string;
  // Session is only known once the connection is established, so the
  // session-scoped join key rides the completion rather than the start.
  sessionId?: string;
  error?: string;
} | {
  type: "storage.push.error";
  id: string;
  sessionId?: string;
  error: string;
  /**
   * The rejection's own text. A stale read names the document it went
   * stale on and the two sequence numbers: "stale confirmed read:
   * <entity> at seq N conflicted with seq M", or "stale pending read"
   * against a pending layer. A commit refused because one it stacked on
   * was refused names no document, reading "pending dependency" and then
   * how that dependency ended.
   */
  message: string;

  /**
   * The addresses in the commit's conflict set: entity, then `@user` or
   * `@session` for a scoped instance, then the path within the document.
   * A whole-document read is the entity alone. An entity or a path segment
   * holding a separator carries it escaped, the way a JSON Pointer segment
   * does, so no address can spell another.
   *
   * This is the set as `commitReadActivities` left it, so a read the
   * commit made and a mergeable operation then covered is absent. Commit
   * preconditions are a different mechanism and appear nowhere here.
   */
  reads: string[];

  /**
   * The entities the commit's operations address. A SQLite operation
   * names none.
   */
  writes: string[];
} | {
  type: "storage.pull.start";
  id: string;
  operation: string;
  error?: string;
} | {
  type: "storage.pull.complete";
  id: string;
  error?: string;
} | {
  type: "storage.pull.error";
  id: string;
  error: string;
} | {
  type: "scheduler.graph.snapshot";
  graph: SchedulerGraphSnapshot;
} | {
  type: "scheduler.subscribe";
  actionId: string;
  isEffect: boolean;
} | {
  type: "scheduler.dependencies.update";
  actionId: string;
  reads: string[]; // cell paths this action reads
  writes: string[]; // cell paths this action writes
} | {
  // Emitted for every settle episode whose convergence budget deferred work,
  // and for a busy window that crosses the wall-clock heuristic. The deferred
  // fields are present on the convergence-budget path and describe the
  // actions the pass held back. A wave that converges over several passes
  // exhausts a budget too, so a marker reports a bounded pass rather than a
  // graph that will never settle.
  type: "scheduler.non-settling";
  busyTime: number;
  windowDuration: number;
  busyRatio: number;
  deferredActions?: NonSettlingDeferredAction[];
  deferredActionCount?: number;
} | {
  // Emitted every time CFC prepare refuses a transaction, BEFORE the commit
  // boundary decides what that refusal is worth. That ordering is the point:
  // a refusal is terminal — and reaches the scheduler's error channel — only
  // when every reason is a verdict (cfc/verdict-reason.ts), so a refusal
  // mixing a verdict with an unevaluable input is retried instead, and the
  // only trace it leaves upstream is a graph that stops converging. This
  // marker is the trace it leaves either way, so a host can name the cause of
  // a non-settling episode rather than guess at a reactive cycle.
  //
  // It reports; it decides nothing. `terminal` says which arm the commit
  // boundary will take, so a consumer can tell the refusal that will also
  // arrive on the error channel from the one that will not.
  type: "cfc.prepare-reject";
  reasons: string[];
  refusals: CfcRefusalDetail[];
  terminal: boolean;
};

/**
 * One deferred action in a non-settling marker. `label` is the action's
 * display identity — `cf:module/<identity>:<symbol>:<key>` for pattern
 * actions, `raw:<builtin>:<key>` for builtins, which names no piece.
 * `pieceId`/`space` carry the action's scheduler observation identity when it
 * has one: the id of the result cell whose piece the action serves, which is
 * the attribution a builtin's label cannot provide.
 */
export type NonSettlingDeferredAction = {
  label: string;
  pieceId?: string;
  space?: string;
};

export type RuntimeTelemetryMarkerResult = RuntimeTelemetryMarker & {
  timeStamp: number;
};

export class RuntimeTelemetryEvent
  extends CustomEvent<{ marker: RuntimeTelemetryMarker }> {
  readonly marker: RuntimeTelemetryMarkerResult;

  constructor(marker: RuntimeTelemetryMarker) {
    super("telemetry", {
      detail: {
        marker,
      },
    });
    this.marker = { ...marker, timeStamp: this.timeStamp };
  }
}

export class RuntimeTelemetry extends EventTarget {
  submit(marker: RuntimeTelemetryMarker) {
    this.dispatchEvent(new RuntimeTelemetryEvent(marker));
  }
}
