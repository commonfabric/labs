import type { CellScope, ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { getTopFrame } from "../builder/pattern.ts";
import type { Cancel } from "../cancel.ts";
import { waveRunContextOf, waveSettlementOf } from "../executor/wave.ts";
import { ConsoleEvent } from "../harness/console.ts";
import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "../runtime.ts";
import { startReadStats } from "../read-stats.ts";
import { getCommitLocalSeq } from "../storage/commit-identity.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  MemorySpace,
  StorageNotification,
} from "../storage/interface.ts";
import { ReplicaLoadFailureError } from "../storage/interface.ts";
import {
  recordLocalReadWake,
  requireLocalReadCondition,
  restrictToLocalReads,
  usesLocalReads,
} from "../storage/local-read-policy.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  isRendererInputTx,
  markReadAsAttemptedWrite,
} from "../storage/reactivity-log.ts";
import type {
  ActionStats,
  NonIdempotentReport,
  NonSettlingDeferredAction,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
} from "../telemetry.ts";
import type { ViewExecutionNode } from "../view-replication.ts";
import {
  CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
  INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS,
  MAX_ACTION_STATS,
  MAX_SETTLE_STATS_HISTORY,
} from "./constants.ts";
import {
  applyPullExecuteContinuation,
  type ExecuteContinuationState,
} from "./continuation.ts";
import { CooperativeYield } from "./cooperative-yield.ts";
import {
  collectDirectWritersForLog,
  type DependencyGraphState,
  isLive,
  notifyNodeLivenessChange,
  registerDependentsForWriterSurface,
  setNodeProvisionalDemand,
  updateDependentEdgesForLog,
} from "./dependency-graph.ts";
import type { DependencyUpdateState } from "./dependency-updates.ts";
import {
  type DiagnosisRecord,
  runSchedulerDiagnosis,
  runSchedulerIdempotencyCheck,
  type SchedulerDiagnosisControlState,
  startSchedulerDiagnosis,
  stopSchedulerDiagnosis,
} from "./diagnosis.ts";
import {
  getPieceMetadataFromFrame,
  getSchedulerActionId,
  getSchedulerActionTelemetryInfo,
  handleSchedulerError,
  queueTask,
  recordTriggerTrace as recordTriggerTraceState,
  type SchedulerActionIdentityState,
} from "./diagnostics.ts";
import {
  collectInvalidUpstreamForLog as collectInvalidUpstreamForLogState,
  collectPendingLoadParkKeys as collectPendingLoadParkKeysState,
  type EventPreflightDependencyState,
  snapshotEventPreflightTraceContext,
} from "./event-preflight-dependencies.ts";
import {
  addSchedulerEventHandler,
  dropQueuedEvent,
  eventHandlerImplementations,
  isHeadEventParked as isHeadEventParkedState,
  processPullQueuedEventDuringExecute,
  queueSchedulerEvent,
  type SchedulerEventExecutionState,
  type SchedulerEventQueueState,
  selectEventImplementation,
} from "./events.ts";
import {
  buildPullInitialSeeds,
  createSettlingTracker,
  markExecuteStart,
  markNonSettlingEpisode,
  pushBoundedHistory,
  recordExecuteEnd,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  type SettlingTracker,
  summarizeNonSettlingWindow,
} from "./execution.ts";
import { keyAtRatchet } from "./fan-out.ts";
import { SchedulerGates } from "./gates.ts";
import {
  buildSchedulerGraphSnapshot,
  type SchedulerGraphSnapshotState,
} from "./graph-snapshot.ts";
import {
  markInvalid as markInvalidRecord,
  type MarkInvalidOptions,
  processStorageNotification,
  type StorageNotificationState,
} from "./invalidation.ts";
import { entityKey, entityNameKey } from "./keys.ts";
import { SpeculationLineage } from "./lineage.ts";
import { SchedulerMaterializers } from "./materializers.ts";
import { NodeRegistry, type SchedulerNode } from "./node-record.ts";
import {
  resolveRegistrationSurface,
  resubscribePullSchedulerAction,
  type SchedulerSubscribeActionState,
  type SchedulerSubscriptionState,
  type SchedulerUnsubscribeActionState,
  subscribePullSchedulerAction,
  unsubscribeSchedulerAction,
} from "./registration.ts";
import { runSchedulerAction, type SchedulerActionRunState } from "./run.ts";
import {
  readsOverlapWrites,
  SchedulerWriteIndex,
} from "./scheduling-writes.ts";
import {
  collectPullIterationSeeds as collectPullIterationSeedsState,
  runPullSchedulerSettleLoop,
} from "./settle.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
} from "./timing.ts";
import {
  SchedulerTriggerIndex,
  SchedulerTriggerSubscriptions,
  type TriggerSubscriptionState,
} from "./trigger-index.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  EventPreflightTraceContext,
  QueuedEvent,
  ReactivityLog,
  SchedulerObservationIdentity,
  ServedEventDispatch,
  ServedEventFailureOutcome,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  TelemetryAnnotations,
  TriggerTraceEntry,
} from "./types.ts";
import {
  CELL_GROUP_PREFIX,
  type DeliverFn,
  holdShapedCell,
  holdShapedEvent,
  shaperInstanceGroupKey,
  shouldShapeDelivery,
  WakeShaper,
} from "./wake-shaping.ts";
import {
  type DirtyPullRunnableState,
  type DirtyPullRunnableStateWithDebounce,
  hasIdleBlockingDeferredPullWork as hasIdleBlockingDeferredPullWorkState,
  hasRunnablePullWork as hasRunnablePullWorkState,
  type PendingPullRunnableState,
  type PullSchedulingState,
} from "./work-oracle.ts";
ensureNotRenderThread();

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

type FilterStatsState = { filtered: number; executed: number };

/** What the scheduler's quiescence barrier waits on before checking again. */
type QuiescenceBlocker =
  /** Work whose settling is observed through `settled`. */
  | { readonly kind: "settle"; readonly settled: () => Promise<unknown> }
  /** Work that only the execute loop's drain of `#idlePromises` releases. */
  | { readonly kind: "drain" }
  /** Runnable pull work, which needs an execution pass queued to drain it. */
  | { readonly kind: "pull" };

type SchedulerRegistrationInput = ReactivityLog;
type SchedulerRegisterOptions = {
  /** Request initial currency from the server plan for this bound source. */
  adoptViewIdentity?: string;

  /** Skips provisional parent demand; requires declared outputs and a computation. */
  deferUntilDemand?: boolean;

  isEffect?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
  changeGroup?: ChangeGroup;
  // Hold the action's initial run until its space finishes syncing (bounded by
  // timeoutMs), so a resumed re-derivation reads confirmed-loaded inputs
  // instead of racing the data. See runner.ts.
  awaitSyncBeforeInitialRun?: { space: MemorySpace; timeoutMs?: number };
  // Tag the action with its owning pattern instance without rehydrating from
  // storage. Pattern readers then always carry a pieceId, used to group shaped
  // cell-flip wakes by instance and to distinguish pattern readers from
  // internal machinery (plan B).
  observationIdentity?: SchedulerObservationIdentity & {
    space?: MemorySpace;
  };
};

function isReactivityLog(value: unknown): value is ReactivityLog {
  const candidate = value as Partial<ReactivityLog> | null;
  return isObjectOrArray(candidate) &&
    Array.isArray(candidate.reads) &&
    Array.isArray(candidate.shallowReads) &&
    Array.isArray(candidate.writes);
}

function normalizeRegistrationArgs(
  dependenciesOrOptions?: SchedulerRegistrationInput | SchedulerRegisterOptions,
  options: SchedulerRegisterOptions = {},
): {
  dependencies?: SchedulerRegistrationInput;
  options: SchedulerRegisterOptions;
} {
  if (
    dependenciesOrOptions === undefined ||
    !isReactivityLog(dependenciesOrOptions)
  ) {
    return {
      options: dependenciesOrOptions ?? options,
    };
  }

  return {
    dependencies: dependenciesOrOptions,
    options,
  };
}

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };
export type {
  Action,
  ActionRunTraceAddress,
  ActionRunTraceEntry,
  AnnotatedAction,
  AnnotatedEventHandler,
  EventHandler,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  SpaceScopeURIAndType,
  TelemetryAnnotations,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./types.ts";
export { txToReactivityLog } from "./reactivity.ts";

export {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
};

export class Scheduler {
  readonly #eventQueue: QueuedEvent[] = [];
  #eventHandlers: [NormalizedFullLink, EventHandler][] = [];
  readonly #lineage = new SpeculationLineage({
    dropQueuedEvent: (event, reason) => this.#dropEvent(event, reason),
    queueExecution: () => this.queueExecution(),
    onError: (error) => logger.error("lineage", () => [error]),
  });

  readonly #pending = new Set<Action>();
  #dependencies = new WeakMap<Action, ReactivityLog>();
  #viewConsumers = new Map<MemorySpace, Set<string>>();
  #viewOutcomes = new WeakMap<
    Action,
    Map<string, {
      log?: ReactivityLog;
      settled: boolean;
      confirmed: boolean;
      registration: object;
      error?: ViewExecutionNode["error"];
    }>
  >();
  #viewRunning = new WeakSet<Action>();
  #viewHandlerLogs = new WeakMap<EventHandler, Map<string, ReactivityLog>>();
  readonly #cancels = new WeakMap<Action, Cancel>();

  /**
   * The trigger index, handed a thunk rather than a captured value: keys must
   * always resolve against the runtime's _current_ authenticated session (one
   * source of truth), and a field initializer runs before constructor parameter
   * properties assign.
   */
  #triggerIndex = new SchedulerTriggerIndex(
    () => this.runtime.scopeKeyIdentity,
  );

  #actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  readonly #retries = new WeakMap<Action, number>();
  #offBudgetRetries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  readonly #nodes = new NodeRegistry();
  #dependents = new WeakMap<Action, Set<Action>>();
  #reverseDependencies = new WeakMap<Action, Set<Action>>();
  #passCounter = 0;
  #activePassId: number | undefined;
  #provisionalDemandThisPass = new Set<SchedulerNode>();

  /**
   * Debugger breakpoints: action ids that should trigger `debugger` before
   * execution.
   */
  #breakpoints = new Set<string>();

  /**
   * Compute-time stats for auto-debounce and diagnostics, keyed by action id
   * (source location) to persist stats across action recreation.
   */
  readonly #actionStats = new BoundedKeyMap<string, ActionStats>(
    MAX_ACTION_STATS,
  );

  #collectReadStats = false;
  #readAttemptAccountingEnabled = false;

  #actionTimingState: ActionTimingState = {
    actionStats: this.#actionStats,
    getActionId: (action) => this.#getActionId(action),
  };
  #actionIdentityState: SchedulerActionIdentityState = {
    anonymousActionIds: new WeakMap<Action | EventHandler, string>(),
    anonymousActionCounter: 0,
  };
  #eventPreflightTraceContext?: EventPreflightTraceContext;

  #rerunAfterCurrentExecute = false;

  /** The non-settling heuristic, which detects when the system is churning. */
  #settlingTracker: SettlingTracker = createSettlingTracker();

  #autoTriggerDiagnosis = false;

  /**
   * Whether idempotency diagnosis, which captures read/write values per action
   * run, is enabled.
   */
  #diagnosisEnabled = false;

  #diagnosisTimeout: ReturnType<typeof setTimeout> | null = null;
  #diagnosisStartTime = 0;
  #diagnosisBusyTime = 0;
  #diagnosisResolve:
    | ((result: SchedulerDiagnosisResult) => void)
    | null = null;
  #diagnosisHistory = new Map<string, DiagnosisRecord[]>();
  #diagnosisNonIdempotent: NonIdempotentReport[] = [];

  /**
   * Whether inline idempotency check mode is on: when it is, every computation
   * re-run in `run()` is followed by a second synchronous run for comparison.
   */
  #idempotencyCheckMode = false;

  #idempotencyViolations: NonIdempotentReport[] = [];

  /** Causal edges between actions, tracked for cycle detection. */
  #causalEdges: {
    writer: string;
    cell: string;
    triggered: string;
    timestamp: number;
  }[] = [];

  #changeGroupToActionId = new Map<ChangeGroup, string>();
  #diagnosisControlState!: SchedulerDiagnosisControlState;

  // Debounce infrastructure for throttling slow actions
  #pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null = null;
  #eventQueueState!: SchedulerEventQueueState;
  #eventExecutionState!: SchedulerEventExecutionState;
  readonly #gates = new SchedulerGates({
    nodes: this.#nodes,
    actionStats: this.#actionStats,
    getActionId: (action) => this.#getActionId(action),
    isDisposed: () => this.#disposed,
    queueExecution: () => this.queueExecution(),
  });
  #writeIndex!: SchedulerWriteIndex;
  readonly #materializers = new SchedulerMaterializers(
    this.#nodes.effects,
    () => this.runtime.scopeKeyIdentity,
  );
  #eventPreflightDependencyState!: EventPreflightDependencyState;

  /** Filter stats, for diagnostics. */
  #filterStats: FilterStatsState = { filtered: 0, executed: 0 };

  /**
   * Whether to collect settle stats for performance analysis (opt-in via
   * `enableSettleStats()`).
   */
  #collectSettleStats = false;

  #lastSettleStats: SettleStats | null = null;
  #settleStatsHistory: SettleStatsHistoryEntry[] = [];
  #collectActionRunTrace = false;
  #actionRunTrace: ActionRunTraceEntry[] = [];
  #collectTriggerTrace = false;
  #triggerTrace: TriggerTraceEntry[] = [];
  #eventPreflightTelemetryEnabled = false;
  #eventPassDemandRefresh?: (demand: Set<Action>) => void;
  #storageNotificationState!: StorageNotificationState;

  /**
   * The action currently executing, tracked for parent-child ordering: when a
   * child action is created during the parent's execution, the parent must run
   * first.
   */
  #executingAction: Action | null = null;

  #currentActionId?: string;
  #dependencyGraphState!: DependencyGraphState;
  #dependencyUpdateState!: DependencyUpdateState;
  #triggerSubscriptionState!: TriggerSubscriptionState;
  #pendingPullRunnableState!: PendingPullRunnableState;
  #dirtyPullRunnableState!: DirtyPullRunnableState;
  #dirtyPullRunnableStateWithDebounce!: DirtyPullRunnableStateWithDebounce;
  #pullSchedulingState!: PullSchedulingState;
  #subscriptionState!: SchedulerSubscriptionState;
  #subscribeActionState!: SchedulerSubscribeActionState;
  #unsubscribeState!: SchedulerUnsubscribeActionState;

  /** The storage subscriber registered in the constructor, kept so `dispose`
   * can hand it back. */
  readonly #storageSubscription: IStorageSubscription;

  #idlePromises: (() => void)[] = [];
  #backgroundTasks = new Set<Promise<unknown>>();

  /**
   * The single wake-shaping choke point: holds renderer-originated input events
   * out of the event queue and shapable cell-flip wakes out of the
   * reactive-notification path, coarsening the cadence a pattern can observe.
   * Fed via `queueEvent()`'s shaping interception and
   * `holdShapedCellNotification()` from the `invalidation.ts` routing of
   * renderer `$value` writes and server pushes. See
   * `docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md`.
   */
  #wakeShaper = new WakeShaper();

  /**
   * Head event parked on in-flight document loads. Keyed by event id; released
   * by `loadsSettled()`, which either re-queues execution on success or drops
   * the at-most-once event on an explicit load failure.
   */
  #headEventLoadPark: {
    eventId: string;
    keys: readonly string[];
    generations: ReadonlyMap<string, number>;
  } | null = null;

  /**
   * Keys whose loads already settled while this event was head. Preflight
   * itself kicks fire-and-forget pulls (`populateDependencies()` cold reads),
   * so an address can be freshly in flight on every pass; without this memo the
   * park re-arms per pass and the event never dispatches. Once a key settled
   * for this event its replica is warm — a refresh is an ordinary concurrent
   * update, not a provisional snapshot.
   */
  #headEventLoadParkHistory: {
    eventId: string;
    generations: Map<string, number>;
  } | null = null;

  /**
   * Generations already pending before the current event preflight. Used to
   * distinguish a genuine concurrent refresh from a load kicked by preflight
   * itself (the latter must not re-arm the same event forever).
   */
  #preflightPendingLoadGenerations = new Map<string, number>();

  readonly #errorHandlers = new Set<ErrorHandler>();
  #consoleHandler: ConsoleHandler;
  #running: Promise<unknown> | undefined = undefined;
  #scheduled = false;
  #disposed = false;
  #actionRunState!: SchedulerActionRunState;
  #graphSnapshotState!: SchedulerGraphSnapshotState;
  #settleLoopState!: SchedulerSettleLoopState;
  #executeContinuationState!: ExecuteContinuationState;

  /**
   * The serving posture's cooperative macrotask yield (`cooperative-yield.ts`):
   * constructed _only_ for a serving runtime, so the OFF arm and flag-ON
   * clients keep their settle loops' exact microtask shape. Its observer is the
   * runtime's `servingYieldObserver` seam — the `SpaceServer`'s mid-wave lease
   * renew.
   */
  readonly #cooperativeYield: CooperativeYield | undefined;

  //
  // Public API
  //

  constructor(
    readonly runtime: Runtime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    if (runtime.servingPosture) {
      const yielder = new CooperativeYield();
      yielder.onYield = () => runtime.servingYieldObserver?.();
      this.#cooperativeYield = yielder;
    }
    this.#initializeSchedulerState();

    this.#consoleHandler = consoleHandler ||
      function (data) {
        // Default console handler returns arguments unaffected.
        return data.args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.#errorHandlers.add(handler));
    }

    // Subscribe to storage notifications. The subscriber is retained because
    // `subscribe` returns nothing — the argument is the only handle disposal
    // will ever have to hand back, and one built inline is unreachable.
    this.#storageSubscription = this.#createStorageSubscription();
    this.runtime.storageManager.subscribe(this.#storageSubscription);

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getPieceMetadataFromFrame();
      const result = this.#consoleHandler({ metadata, method, args });
      const output = Array.isArray(result) ? { method, args: result } : result;
      const target = output.target ?? console;
      target[output.method].apply(target, output.args);
    });
  }

  /**
   * The scheduler's tables, states, and collaborators, its wake timer and
   * flags, and the steps of a pass, which the scheduler suites drive
   * directly.
   */
  get accessForTestingOnly(): {
    readonly actionStats: BoundedKeyMap<string, ActionStats>;
    readonly dependencyUpdateState: DependencyUpdateState;
    readonly eventExecutionState: SchedulerEventExecutionState;
    readonly eventQueue: QueuedEvent[];
    readonly eventQueueState: SchedulerEventQueueState;
    readonly gates: SchedulerGates;
    readonly nodes: NodeRegistry;
    readonly pending: Set<Action>;
    pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null;
    scheduled: boolean;
    readonly settlingTracker: SettlingTracker;
    clearBackoffForCleanNodes(): void;
    execute(): Promise<void>;
    getActionId(action: Action | EventHandler): string;
    isDemandedPullComputation(action: Action): boolean;
    markAndScheduleInvalidAction(
      action: Action,
      cause?: IMemorySpaceAddress,
    ): void;
    maybeAutoDebounce(action: Action): void;
    recordBudgetBackoffTelemetry(settleResult: SchedulerSettleResult): void;
    recordExecuteEndTelemetry(): void;
    updateDependents(action: Action, log: ReactivityLog): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      actionStats: this.#actionStats,
      get dependencyUpdateState() {
        return outerThis.#dependencyUpdateState;
      },
      get eventExecutionState() {
        return outerThis.#eventExecutionState;
      },
      eventQueue: this.#eventQueue,
      get eventQueueState() {
        return outerThis.#eventQueueState;
      },
      gates: this.#gates,
      nodes: this.#nodes,
      pending: this.#pending,
      get pendingQueueTaskTimer() {
        return outerThis.#pendingQueueTaskTimer;
      },
      set pendingQueueTaskTimer(value) {
        outerThis.#pendingQueueTaskTimer = value;
      },
      get scheduled() {
        return outerThis.#scheduled;
      },
      set scheduled(value) {
        outerThis.#scheduled = value;
      },
      get settlingTracker() {
        return outerThis.#settlingTracker;
      },
      clearBackoffForCleanNodes: () => this.#clearBackoffForCleanNodes(),
      execute: () => this.#execute(),
      getActionId: (action) => this.#getActionId(action),
      isDemandedPullComputation: (action) =>
        this.#isDemandedPullComputation(action),
      markAndScheduleInvalidAction: (action, cause) =>
        this.#markAndScheduleInvalidAction(action, cause),
      maybeAutoDebounce: (action) => this.#maybeAutoDebounce(action),
      recordBudgetBackoffTelemetry: (settleResult) =>
        this.#recordBudgetBackoffTelemetry(settleResult),
      recordExecuteEndTelemetry: () => this.#recordExecuteEndTelemetry(),
      updateDependents: (action, log) => this.#updateDependents(action, log),
    };
  }

  /** The speculation lineage this scheduler records queued events into. */
  get lineage(): SpeculationLineage {
    return this.#lineage;
  }

  /** Id of the action executing right now, if one is. */
  get currentActionId(): string | undefined {
    return this.#currentActionId;
  }

  /**
   * Per-runtime enter, leave, and re-arm tallies of demand roots. The space
   * server reads the enter and leave delta per pass and folds it into its
   * space-lived `stats.demand` accumulators; these reset with the runtime on
   * a reactivation, so they are a per-tenure source, not the total.
   */
  get demandRootCounters(): {
    enters: number;
    leaves: number;
    notCurrentRearms: number;
  } {
    return this.#demandRootCounters;
  }

  /**
   * Size of the standing demanded-writer root set; empty off the serving
   * posture.
   */
  get demandedWriterCount(): number {
    return this.#nodes.demandedWriters.size;
  }

  /** Size of the demanded entity refcount map. */
  get demandedEntityCount(): number {
    return this.#demandedEntityRefs.size;
  }

  /** The serving posture's cooperative yielder, if this scheduler has one. */
  get servingYield(): CooperativeYield | undefined {
    return this.#cooperativeYield;
  }

  get runningPromise(): Promise<unknown> | undefined {
    return this.#running;
  }

  set runningPromise(promise: Promise<unknown> | undefined) {
    if (this.#running !== undefined) {
      throw new Error(
        "Cannot set running while another promise is in progress",
      );
    }
    if (promise !== undefined) {
      this.#running = promise.finally(() => {
        this.#running = undefined;
      });
    }
  }

  /**
   * Temporarily set the executing action so that any child actions created
   * during `fn` are registered as children of `action`. Restores the previous
   * executing action afterwards (stack-like nesting).
   */
  withExecutingAction<T>(action: Action, fn: () => T): T {
    const prev = this.#executingAction;
    this.#executingAction = action;
    try {
      return fn();
    } finally {
      this.#executingAction = prev;
    }
  }

  /**
   * Subscribes an action to run when its dependencies change.
   *
   * Computations run when demanded. A live parent provisionally demands a new
   * child unless `deferUntilDemand` is set with a declared write surface.
   * A matching settled view basis establishes initial currency and wake
   * dependencies without running the computation.
   * Effects and idempotency diagnostics retain their execution policy. After
   * running, the scheduler re-subscribes using the recorded reactivity log.
   *
   * @param action The action to subscribe
   * @param dependencies Optional callback or immediate ReactivityLog for
   *   backwards compatibility
   * @param options Configuration options for the subscription
   * @returns A cancel function to unsubscribe
   */
  register(
    action: Action,
    dependenciesOrOptions?:
      | SchedulerRegistrationInput
      | SchedulerRegisterOptions,
    maybeOptions: SchedulerRegisterOptions = {},
  ): Cancel {
    const { dependencies, options } = normalizeRegistrationArgs(
      dependenciesOrOptions,
      maybeOptions,
    );
    if (options.deferUntilDemand) {
      if (options.isEffect || this.#nodes.isKnownEffect(action)) {
        throw new Error("`deferUntilDemand` requires a computation");
      }
      if (resolveRegistrationSurface(action, dependencies).length === 0) {
        throw new Error("`deferUntilDemand` requires a declared write surface");
      }
    }
    // Tag the action with its owning pattern instance so pattern readers
    // always carry a pieceId (used to group shaped cell-flip wakes by
    // instance and to distinguish pattern readers from internal machinery —
    // plan B).
    if (options.observationIdentity) {
      this.#setActionObservationIdentity(action, options.observationIdentity);
    }
    const initialDependencies = options.adoptViewIdentity === undefined ||
        options.isEffect === true || this.#nodes.get(action) !== undefined
      ? undefined
      : this.#initialViewDependencies(action, options.adoptViewIdentity);
    const subscribeOptions = {
      initialViewState: initialDependencies === undefined ? undefined : {
        dependencies: initialDependencies,
        identity: options.adoptViewIdentity!,
      },
      deferUntilDemand: options.deferUntilDemand,
      isEffect: options.isEffect,
      debounce: options.debounce,
      noDebounce: options.noDebounce,
      throttle: options.throttle,
      changeGroup: options.changeGroup,
    };
    this.#updateMaterializerRegistration(action);
    const cancel = subscribePullSchedulerAction(
      this.#subscribeActionState,
      action,
      dependencies,
      subscribeOptions,
    );
    if (options.awaitSyncBeforeInitialRun) {
      this.#holdInitialRunUntilSynced(
        action,
        options.awaitSyncBeforeInitialRun,
      );
    }
    return cancel;
  }

  /**
   * Holds a resumed action's initial run until its space finishes syncing. The
   * hold is a bounded time gate (worst case the timeout releases it); the sync
   * completing releases it early. The awaiting task joins `#backgroundTasks` so
   * `idle()` waits for the release decision.
   */
  #holdInitialRunUntilSynced(
    action: Action,
    options: { space: MemorySpace; timeoutMs?: number },
  ): void {
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS,
    );
    this.#gates.holdInitialRun(action, performance.now() + timeoutMs);
    const task = (async () => {
      const provider = this.runtime.storageManager.open(options.space);
      const synced = provider?.synced?.bind(provider);
      if (!synced) return;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
      });
      const syncedPromise = synced();
      // If the timeout wins the race the sync promise is left pending; swallow
      // a later rejection so it doesn't surface as unhandled.
      syncedPromise.catch(() => {});
      try {
        await Promise.race([syncedPromise, timeout]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    })().catch((error) => {
      logger.warn("scheduler-initial-sync-hold", () => [
        "Failed to await sync before initial run; releasing the hold",
        this.#getActionId(action),
        error,
      ]);
    }).finally(() => {
      // Release even on error/timeout: the gate exists to sequence the common
      // case, not to block the action forever behind a stuck sync.
      if (this.#nodes.get(action)) {
        this.#gates.releaseInitialRunHold(action);
      }
    });
    this.trackBackgroundTask(task);
  }

  /**
   * @deprecated Use register(). Kept while runner internals and tests still
   * exercise the v1 scheduler surface.
   */
  subscribe(
    action: Action,
    dependenciesOrOptions?:
      | SchedulerRegistrationInput
      | SchedulerRegisterOptions,
    maybeOptions: SchedulerRegisterOptions = {},
  ): Cancel {
    return this.register(action, dependenciesOrOptions, maybeOptions);
  }

  /**
   * Re-subscribes an action after it has already run, using the reactivity log
   * from the completed run. This sets up triggers for future changes without
   * scheduling the action to run immediately.
   *
   * Use this method when:
   * - An action has just completed running and you have its reactivity log
   * - You want to register triggers for future changes
   *
   * @param action The action to re-subscribe
   * @param log The reactivity log from the action's previous run
   * @param options Optional configuration (e.g., isEffect to mark as side-effectful)
   */
  resubscribe(
    action: Action,
    log: ReactivityLog,
    options: {
      isEffect?: boolean;
      changeGroup?: ChangeGroup;
    } = {},
  ): void {
    const record = this.#nodes.get(action);
    const wasLiveBeforeRootRegistration = record !== undefined &&
      isLive(this.#dependencyGraphState, record);
    this.#updateMaterializerRegistration(action);
    resubscribePullSchedulerAction(
      this.#subscribeActionState,
      action,
      log,
      options,
      { wasLiveBeforeRootRegistration },
    );
  }

  #setActionObservationIdentity(
    action: Action,
    identity: SchedulerObservationIdentity & { space?: MemorySpace },
  ): void {
    (action as Partial<TelemetryAnnotations>).schedulerObservationIdentity = {
      ownerSpace: identity.ownerSpace ?? identity.space,
      pieceId: identity.pieceId,
      ...(identity.branch !== undefined ? { branch: identity.branch } : {}),
      ...(identity.processGeneration !== undefined
        ? { processGeneration: identity.processGeneration }
        : {}),
      ...(identity.pieceRootId !== undefined
        ? { pieceRootId: identity.pieceRootId }
        : {}),
      // Phase 7: the ancestor chain the run supply resolves a nested
      // piece's demanded instances through (scheduler/types.ts).
      ...(identity.demandRootIds !== undefined
        ? { demandRootIds: identity.demandRootIds }
        : {}),
    };
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    unsubscribeSchedulerAction(this.#unsubscribeState, action, options);
    this.#materializers.clearAction(action);
  }

  async run(action: Action): Promise<any> {
    return await runSchedulerAction(this.#actionRunState, action);
  }

  /**
   * Count `work` as outstanding scheduler work until it settles: `idle()` waits
   * for it and then re-checks every quiescence condition from scratch, so work
   * that schedules actions, and the commits it issues, are covered as well.
   *
   * This is for work the runtime has already undertaken and whose result the
   * reactive graph is waiting on — a system pattern being fetched so the
   * surface a builtin has already emitted into the view can be filled in, a
   * piece being started so a queued event can be delivered. While such work is
   * in flight the graph is quiet because it is waiting, not because it is
   * finished, and a caller that reads quiet as finished reads it wrongly.
   *
   * It is not for work whose result the graph does not depend on. An LLM call
   * or an outbound fetch a pattern kicked off leaves the view interactive while
   * it runs, and holding `idle()` open for it would put every caller behind the
   * network; `Runtime.trackAsyncWork` and `Runtime.settled()` are that barrier.
   *
   * A rejection ends the work as surely as a result does, so it releases the
   * barrier rather than propagating. Observing it is what makes it this
   * method's to report: attaching a handler is the only way to learn that the
   * work settled, and it is also what stops the runtime from reporting the
   * rejection as unhandled, so the warning below is the account of a failure
   * that would otherwise vanish. The entry is dropped once the work settles, so
   * nothing accumulates.
   */
  trackBackgroundTask(work: Promise<unknown>): void {
    const task = work.then(() => {}, (error) => {
      logger.warn("scheduler-background-task", () => [
        "A tracked background task failed",
        error,
      ]);
    });
    this.#backgroundTasks.add(task);
    task.finally(() => {
      this.#backgroundTasks.delete(task);
    });
  }

  idle(): Promise<void> {
    return this.#waitForQuiescence(false);
  }

  /**
   * Returns a promise for client-facing quiescence: reactive quiescence _and_
   * durability of in-flight commits. Commits are issued fire-and-forget (event
   * handlers, direct cell writes over IPC, reactive recomputation write-backs),
   * so plain `idle()` reports quiescence while a commit is still traveling to
   * the server; a client that reads idle as a safe point to navigate or reload
   * would then drop that write when the page and its worker are torn down. The
   * pending set is sourced from the storage manager — the single chokepoint
   * every commit flows through — so no write path can be forgotten. A landed
   * commit also dirties readers of the committed write, which can re-trigger
   * scheduler work that produces further commits, so durability and reactive
   * quiescence are one joint fixpoint; this reuses the same recursive
   * convergence `idle()` uses (no separate retry loop, no round cap) and, like
   * `idle()`, never resolves for a system that genuinely never settles.
   */
  idleWithPendingCommits(): Promise<void> {
    return this.#waitForQuiescence(true);
  }

  /**
   * Returns whether `idleWithPendingCommits()` has nothing to wait on right
   * now, which is exactly when a call to it would resolve without waiting. A
   * caller that awaits that barrier and then awaits something else checks this
   * afterwards: work queued during the second wait is work the barrier had
   * already stopped watching.
   */
  isIdleWithPendingCommits(): boolean {
    return this.#quiescenceBlocker(true) === undefined;
  }

  /**
   * Whether the scheduler is quiescent RIGHT NOW (server-execution v2
   * stage F): nothing running, nothing scheduled, no queued events, no
   * held wakes, no background tasks, no runnable pull work. The serving
   * loop's settle cycle probes this between idle() and synced() passes
   * — idle() alone can resolve while a sync frame is mid-flight, and
   * the frame's notification re-dirties the graph.
   */
  isIdle(): boolean {
    return !this.runningPromise &&
      this.#backgroundTasks.size === 0 &&
      !this.#wakeShaper.hasPending() &&
      this.#eventQueue.length === 0 &&
      !this.#scheduled &&
      !this.#hasRunnablePullWork();
  }

  /**
   * Whether a time-gate wake timer is armed (server-execution v2
   * stage F; runtime-mapping N9): the SpaceServer's parking policy
   * treats a pending gate wake as "not idle" rather than losing
   * trailing debounce flushes on park.
   */
  hasArmedGateWake(): boolean {
    return this.#gates.hasWakeTimer();
  }

  #waitForQuiescence(awaitPendingCommits: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const blocker = this.#quiescenceBlocker(awaitPendingCommits);
      if (blocker === undefined) {
        this.#resetConvergenceHoldPasses();
        resolve();
        return;
      }
      // Re-evaluate every condition from scratch once the thing we are waiting
      // on settles.
      const recheck = () =>
        this.#waitForQuiescence(awaitPendingCommits).then(resolve);
      // A parked waiter (idlePromises) is released when the scheduler drains,
      // and draining settles only the conditions the execute loop owns. Two
      // things can still be outstanding at that moment: a commit in flight,
      // which is why the commit-aware variant re-checks rather than resolving,
      // and a background task registered after this waiter parked, which is
      // what a builtin starting one from inside a pass produces. A re-check is
      // deferred to a microtask so it does not re-enter waitForQuiescence
      // synchronously while resolveIdlePromises is iterating idlePromises.
      //
      // Plain idle re-checks only when there is tracked work to re-check for.
      // Re-checking unconditionally costs a fresh promise chain per drain, and
      // a graph that never converges drains without end — which turns that cost
      // into unbounded growth rather than a slow path (measured: the
      // non-converging cycle in scheduler-convergence.test.ts exhausts the heap).
      const park = awaitPendingCommits ? () => queueMicrotask(recheck) : () => {
        if (this.#backgroundTasks.size === 0) resolve();
        else queueMicrotask(recheck);
      };
      switch (blocker.kind) {
        case "settle":
          blocker.settled().then(recheck);
          break;
        case "pull":
          this.queueExecution();
          this.#idlePromises.push(park);
          break;
        case "drain":
          this.#idlePromises.push(park);
          break;
      }
    });
  }

  /**
   * Helper for `#waitForQuiescence()` and `isIdleWithPendingCommits()`, which
   * returns what the barrier has to wait on before it can resolve, or
   * `undefined` when it has nothing to wait on. `awaitPendingCommits` adds
   * in-flight commits and pattern work to what it waits on. A disposed
   * scheduler has nothing to wait on once its running pass, background tasks,
   * held wakes and those commits are done, even with work still queued, since
   * it never runs anything again. Pending computations with no effect to pull
   * them do not count either, since in pull mode they do not run.
   */
  #quiescenceBlocker(
    awaitPendingCommits: boolean,
  ): QuiescenceBlocker | undefined {
    const running = this.runningPromise;
    if (running) {
      // Something is currently running - wait for it then check again
      return { kind: "settle", settled: () => running };
    }
    if (this.#backgroundTasks.size > 0) {
      // Async scheduler work, such as event-triggered auto-start, is still in
      // flight. Wait for it to settle and then re-check the scheduler state.
      return {
        kind: "settle",
        settled: () => Promise.allSettled([...this.#backgroundTasks]),
      };
    }
    if (this.#wakeShaper.hasPending()) {
      // Input events (W3) or cell-flip notifications (plan B) are being held
      // for wake shaping. Wait for them to release (which re-queues the
      // events and delivers the notifications) and then re-check. Draining
      // before the pending-commit branch means idleWithPendingCommits()
      // releases the held wakes first, then awaits the commits they produce.
      return { kind: "settle", settled: () => this.#wakeShaper.whenDrained() };
    }
    if (
      awaitPendingCommits && this.runtime.storageManager.hasPendingCommits()
    ) {
      // In-flight commits. Wait for them to settle (server confirmation or
      // terminal failure) and then re-check: a landed commit can dirty
      // readers and re-trigger scheduler work.
      return {
        kind: "settle",
        settled: () => this.runtime.storageManager.pendingCommitsSettled(),
      };
    }
    if (
      awaitPendingCommits &&
      this.runtime.patternManager.hasPendingPatternWork()
    ) {
      // In-flight PATTERN work: a by-identity load (whose cold-load
      // arm recompiles and re-persists a space's program docs) or a
      // compile-cache write-back — the program-materialization
      // commit itself (verification-coverage.md OW45, seat S-B).
      // This barrier is the client's "safe to navigate or reload"
      // checkpoint, and a program commit issued from a post-arrival
      // load chain is exactly a write a reload would otherwise kill:
      // the home-profile create's program commit died with the
      // reload, nothing re-issued it, and the created space served
      // nothing forever. Same recheck-from-scratch structure as
      // pending commits — a load that registers its write-back
      // mid-await is seen by the next pass, and the write-back's own
      // storage commits land in the pending-commit branch above.
      // Commit-aware callers only: plain idle() stays reactive-only
      // (the serving loop's settle probes must not chase client
      // persistence).
      return {
        kind: "settle",
        settled: () => this.runtime.patternManager.pendingPatternWorkSettled(),
      };
    }
    // Everything below waits on `#idlePromises`, which only the execute loop
    // drains, and `#execute()` returns immediately once disposed. Each check
    // above has a wake source of its own, so it still settles on a disposed
    // scheduler. This is what keeps `Runtime.dispose()` from hanging on
    // `scheduler.idle()` after a caller disposed the scheduler by hand.
    if (this.#disposed) return undefined;
    if (
      this.#gates.hasWakeTimer() &&
      ((this.#eventQueue.length > 0 &&
        isHeadEventParkedState({ eventQueue: this.#eventQueue })) ||
        this.#hasIdleBlockingDeferredPullWork())
    ) {
      // A queued event or idle-blocking pull node is parked behind a time
      // gate. Wait for the wake timer to re-schedule the queue and re-check.
      return { kind: "drain" };
    }
    if (
      this.#hasPendingLineageHeadEvent() || this.#hasLoadParkedHeadEvent() ||
      this.#eventQueue[0]?.retryReadinessPending === true
    ) {
      // A cross-space lineage head has no timer — its origin commit callback
      // is the wake source; a load-parked head wakes on load completion or
      // drops on an explicit load failure; a head requeued by a stale-basis
      // retry wakes once the retry's readiness resolves. Either way idle
      // must stay open until the callback re-queues execution.
      return { kind: "drain" };
    }
    // Execution is scheduled - wait for it to complete
    if (this.#scheduled) return { kind: "drain" };
    if (this.#hasRunnablePullWork()) return { kind: "pull" };
    // Nothing is scheduled to run - we're idle.
    return undefined;
  }

  /**
   * Marks a subscribed action invalid and schedules an execution pass, exactly
   * as a change to one of its journaled reads would. For an asynchronous
   * completion whose terminal step writes nothing the action journals — the
   * only remaining signal that the action must run again is the completion
   * itself (e.g. a list coordinator's owed element setup after every awaited
   * result document confirmed absent). Set `retry` when resuming an unfinished
   * computation after a wait: its wait supplies the delay, so debounce and
   * throttle must not strand a one-shot pull. No-op for an unsubscribed action.
   */
  invalidateAction(
    action: Action,
    options?: Pick<MarkInvalidOptions, "retry">,
  ): void {
    this.#markAndScheduleInvalidAction(action, undefined, options);
  }

  /**
   * The ARRIVAL RE-ARM (server-execution v2 fan-out stage B, design §A/
   * §B3): a demander who arrives after a node has narrowed finds no
   * instance of their own — a clean node never re-runs for a demander
   * that did not exist when it last ran — so the SpaceServer calls this
   * when its demand registry gains a (principal, session) pair for a
   * root. Every NARROWED node whose demand roots intersect `rootIds` is
   * marked invalid and queued, with its per-instance record KEPT: only
   * the arriving principal's instances are not clean, so only those run
   * (B7 — the siblings stay current). A node that ran with demanders and
   * did not narrow needs nothing (its one output is shared). A node that
   * ran with NO demander reachable — the wave-level fallback, before the
   * first demand reached its roots — has no fan-out record and no known
   * scope, so it re-arms too: its next run is the probe that learns
   * whether it narrows for the arriving principal. A node that never ran
   * has no fan-out record either and is left alone: whether it runs is the
   * pull scheduler's demand decision, and its first run is that probe
   * whenever it comes. Returns the number of nodes re-armed.
   */
  invalidateActionsForDemandRoots(rootIds: readonly string[]): number {
    const roots = new Set(rootIds);
    let rearmed = 0;
    for (const record of this.#nodes.nodes()) {
      const identity = (record.action as Partial<TelemetryAnnotations>)
        .schedulerObservationIdentity;
      const demandRootIds = identity?.demandRootIds ??
        (identity?.pieceRootId !== undefined
          ? [identity.pieceRootId]
          : undefined);
      if (demandRootIds === undefined) continue;
      if (!demandRootIds.some((id) => roots.has(id))) continue;
      if (record.fanOut === undefined) {
        if (record.status === "never-ran") continue;
      } else if (!record.fanOut.narrowed) continue;
      this.#markActionInvalid(record.action, undefined, {
        fanOutInstances: "keep",
      });
      this.#pending.add(record.action);
      rearmed += 1;
    }
    if (rearmed > 0) this.queueExecution();
    return rearmed;
  }

  /**
   * The event actor as a TRANSIENT demander (server-execution v2 fan-out
   * stage B, RULED 2026-08-16 — design §B5/§I.5): the `firedAt` pairs of
   * the SERVED events currently queued whose handler's demand roots
   * intersect `rootIds`. The SpaceServer's demander resolver folds them
   * in, so a dispatch's preflight recompute of a dirty scoped input
   * materializes the ACTOR's own instance even when the actor watches
   * nothing (the actor holds append authority on the stream — never
   * another principal's instance). Empty off the serving posture (no
   * queued event carries `served`).
   */
  transientEventDemandersFor(
    rootIds: readonly string[],
  ): ScopeKeyIdentity[] {
    if (this.#eventQueue.length === 0) return [];
    const roots = new Set(rootIds);
    const demanders: ScopeKeyIdentity[] = [];
    for (const queued of this.#eventQueue) {
      const firedAt = queued.served?.firedAt;
      if (firedAt?.user === undefined) continue;
      const identity = (queued.handler as Partial<TelemetryAnnotations>)
        .schedulerObservationIdentity;
      const demandRootIds = identity?.demandRootIds ??
        (identity?.pieceRootId !== undefined
          ? [identity.pieceRootId]
          : undefined);
      if (demandRootIds === undefined) continue;
      if (!demandRootIds.some((id) => roots.has(id))) continue;
      demanders.push({
        principal: firedAt.user,
        ...(firedAt.session !== undefined && firedAt.session !== "server"
          ? { sessionId: firedAt.session as never }
          : {}),
      });
    }
    return demanders;
  }

  /**
   * The transient-demander PREFLIGHT (server-execution v2 fan-out stage
   * B, design §B5's motivating case; independent review F2): before a
   * SERVED event's handler runs, re-arm every fanned-out node in the
   * handler's dependency closure whose instance FOR THE ACTOR is NOT
   * CURRENT — never run at the node's ratchet for that principal. B7 made
   * cleanliness per instance, so a node the watchers made node-level
   * clean can still be missing the actor's instance entirely; the
   * node-level preflight (`#collectInvalidUpstreamForLog`) asks only
   * whether the NODE is invalid, so the actor's own per-user derivation
   * was never materialized and her handler read an empty instance —
   * refused as a schema mismatch and, until the mark/effects-atomicity
   * fix (events.ts's finalize withdrawal, RULED 2026-08-27), sealed
   * consequenced with no error: silent event loss. A skipped served
   * dispatch now withdraws and re-drains, so a miss here costs a
   * deferral cycle rather than the event — this preflight remains what
   * makes the FIRST delivery succeed. This is the arrival re-arm applied to the
   * event's transient demander (already folded into the demanders by
   * `transientEventDemandersFor`, pinned by (j)): mark the node invalid
   * KEEPING the sibling instances clean, so its next run derives the
   * instance set — now including the actor's transient demand — and runs
   * only the actor's uncomputed instance (B7). Returns the re-armed
   * nodes; the caller holds the event until they run (its handler then
   * reads a current instance). Empty when the actor's instances are all
   * current (or the actor cannot key an instance — a sessionless actor
   * at session depth, which resolveScopeKey fails closed on downstream).
   *
   * Direct writers of the handler's reads only — the shape the ruling
   * names (a handler reading a per-user derivation). A per-user node
   * TRANSITIVELY upstream of the handler's closure (read through an
   * intervening derivation) is not reached here; that broader cone is
   * the node-level path's inverted walk, which this does not duplicate
   * (the transitive not-current-for-actor case stays a documented gap,
   * scopes.md §2 — narrow in practice, the watchers' walk covers the
   * rendering shape). No-op off the serving posture: only a served
   * event carries an actor, and only a served node has a `fanOut`
   * record.
   */
  rearmNotCurrentFanOutForActor(
    deps: ReactivityLog,
    actor: ScopeKeyIdentity,
  ): Action[] {
    const directWriters = collectDirectWritersForLog({
      scopeKeyIdentity: () => this.runtime.scopeKeyIdentity,
      writersByEntity: this.#writeIndex.writersByEntity,
      effects: this.#nodes.effects,
      getSchedulingWrites: (action) =>
        this.#writeIndex.getSchedulingWrites(action),
    }, deps);
    const rearmed: Action[] = [];
    for (const writer of directWriters) {
      const record = this.#nodes.get(writer);
      if (record?.fanOut === undefined) continue;
      const actorKey = keyAtRatchet(record.fanOut, actor);
      if (actorKey === undefined) continue;
      // Current for the actor: her instance ran at the ratchet and no
      // cause dirtied it — nothing to materialize.
      if (record.fanOut.clean.has(actorKey)) continue;
      this.#markActionInvalid(writer, undefined, { fanOutInstances: "keep" });
      this.#pending.add(writer);
      rearmed.push(writer);
    }
    if (rearmed.length > 0) this.queueExecution();
    return rearmed;
  }

  // The (d′) standing `demandedWriters` root kind and the
  // per-(instance, demander) currency check (stage-C design §2.2 / §2.4;
  // serving-loop.md §1). The SpaceServer's demand pass calls these on
  // registry DELTAS; nothing here is reached off the serving posture (the
  // registration hook installs lazily on the first `enterDemandedEntity`,
  // so a plain client runtime's `demandedWriters` set stays empty — T9′).

  /** Refcount per demanded ENTITY (scope-NAME keyed, `entityNameKey` —
   * the writer index's vocabulary: two instances of one doc, `user:alice`
   * and `user:bob`, name ONE entity whose one node writes both). The
   * count is the number of registry instance keys naming the entity. */
  readonly #demandedEntityRefs = new Map<SpaceScopeAndURI, number>();

  readonly #demandRootCounters = { enters: 0, leaves: 0, notCurrentRearms: 0 };

  #demandedWriterHookInstalled = false;

  #installDemandedWriterHook(): void {
    if (this.#demandedWriterHookInstalled) return;
    this.#demandedWriterHookInstalled = true;
    // The REGISTRATION / UNREGISTRATION bracket (§2.4): a writer whose
    // surface gains a demanded entity enters the root set; one that loses
    // its last demanded entity leaves it. Bracketed like every other root
    // flip (serving-loop.md §8: capture wasLive → flip → notify).
    this.#writeIndex.onWriterEntitiesChanged = (action, added, removed) => {
      let touchesDemand = false;
      for (const entity of added) {
        if ((this.#demandedEntityRefs.get(entity) ?? 0) > 0) {
          touchesDemand = true;
          break;
        }
      }
      if (!touchesDemand) {
        for (const entity of removed) {
          if ((this.#demandedEntityRefs.get(entity) ?? 0) > 0) {
            touchesDemand = true;
            break;
          }
        }
      }
      if (!touchesDemand) return;
      this.#reconcileDemandedWriter(action);
    };
  }

  /** Recompute whether `action` is a demanded writer from its CURRENT
   * write entities and the demanded entity refs; bracket the flip. */
  #reconcileDemandedWriter(action: Action): void {
    const entities = this.#writeIndex.actionWriteEntities.get(action);
    let shouldBeRoot = false;
    if (entities !== undefined) {
      for (const entity of entities) {
        if ((this.#demandedEntityRefs.get(entity) ?? 0) > 0) {
          shouldBeRoot = true;
          break;
        }
      }
    }
    const isRoot = this.#nodes.isDemandedWriter(action);
    if (shouldBeRoot === isRoot) return;
    const record = this.#nodes.get(action);
    const wasLive = record !== undefined &&
      isLive(this.#dependencyGraphState, record);
    if (shouldBeRoot) {
      this.#nodes.demandedWriters.add(action);
      this.#demandRootCounters.enters += 1;
    } else {
      this.#nodes.demandedWriters.delete(action);
      this.#demandRootCounters.leaves += 1;
    }
    if (record === undefined) return;
    notifyNodeLivenessChange(this.#dependencyGraphState, action, wasLive);
    if (
      shouldBeRoot && this.#isLiveAction(action) &&
      this.#isInvalidAction(action)
    ) {
      // A dirty / never-ran node that just became live is a runnable seed
      // (work-oracle: dirty ∧ live); make sure the loop wakes for it.
      this.#pending.add(action);
      this.queueExecution();
    }
  }

  /** ENTER: a demanded instance key `(space, id, scope)` entered the
   * SpaceServer's registry (design §2.2 step 2). Refcounted per entity;
   * the 0→1 transition marks every current writer of the entity a demand
   * root (bracketed). Returns the writers (for the currency check). The
   * entity is counted before any writer is marked, so a throw leaves it
   * counted, and `leaveDemandedEntity()` takes the count back. */
  enterDemandedEntity(
    address: { space: MemorySpace; id: string; scope: CellScope },
  ): Action[] {
    this.#installDemandedWriterHook();
    const entity = entityNameKey(address as never);
    const before = this.#demandedEntityRefs.get(entity) ?? 0;
    this.#demandedEntityRefs.set(entity, before + 1);
    const writers = [...(this.#writeIndex.writersByEntity.get(entity) ?? [])];
    if (before === 0) {
      for (const writer of writers) this.#reconcileDemandedWriter(writer);
    }
    return writers;
  }

  /** LEAVE: the last session tracking the instance key left (R-D's
   * coarse boundary — never early). The 1→0 transition releases the
   * writers' root status (bracketed; `withdrawDemandFrom` re-derives from
   * the remaining roots). */
  leaveDemandedEntity(
    address: { space: MemorySpace; id: string; scope: CellScope },
  ): void {
    const entity = entityNameKey(address as never);
    const before = this.#demandedEntityRefs.get(entity) ?? 0;
    if (before <= 1) {
      this.#demandedEntityRefs.delete(entity);
      for (const writer of this.#writeIndex.writersByEntity.get(entity) ?? []) {
        this.#reconcileDemandedWriter(writer);
      }
    } else {
      this.#demandedEntityRefs.set(entity, before - 1);
    }
  }

  /** The CURRENCY CHECK for one (instance key, demanding pair) row
   * (design §2.2 step 3): for each writer of the entity, is the writer's
   * instance FOR THIS PAIR current — ran at the ratchet and no cause
   * dirtied it since (B7's clean bit)? Not current ⇒ re-arm with the
   * sibling instances kept — the `rearmNotCurrentFanOutForActor` shape
   * applied to a demanding pair. A writer with NO fan-out record is
   * current iff clean (it never ran under the serving posture with a
   * principal-bearing demander, or ran unnarrowed); a dirty/never-ran one
   * is already a runnable seed once live (enter made it live). Returns
   * the number of writers re-armed. */
  rearmNotCurrentForDemander(
    address: { space: MemorySpace; id: string; scope: CellScope },
    demander: ScopeKeyIdentity,
  ): number {
    const entity = entityNameKey(address as never);
    const writers = this.#writeIndex.writersByEntity.get(entity);
    if (writers === undefined || writers.size === 0) return 0;
    let rearmed = 0;
    for (const writer of writers) {
      const record = this.#nodes.get(writer);
      if (record === undefined) continue;
      if (record.fanOut === undefined) continue;
      const pairKey = keyAtRatchet(record.fanOut, demander);
      if (pairKey === undefined) continue;
      if (record.fanOut.clean.has(pairKey)) continue;
      this.#markActionInvalid(writer, undefined, { fanOutInstances: "keep" });
      this.#pending.add(writer);
      rearmed += 1;
    }
    if (rearmed > 0) {
      this.#demandRootCounters.notCurrentRearms += rearmed;
      this.queueExecution();
    }
    return rearmed;
  }

  /** DIAGNOSTIC (tests): a node's fan-out record — the known-scope
   * ratchet and per-instance state — or undefined off the fan-out path.
   * Takes the action or its id (the trace's `actionId`). */
  fanOutStateOf(action: Action | string): {
    narrowed: boolean;
    sessionPrincipals: string[];
    instanceKeys: string[];
    cleanKeys: string[];
  } | undefined {
    const record = typeof action === "string"
      ? [...this.#nodes.nodes()].find((candidate) =>
        this.#getActionId(candidate.action) === action
      )
      : this.#nodes.get(action);
    const state = record?.fanOut;
    if (state === undefined) return undefined;
    return {
      narrowed: state.narrowed,
      sessionPrincipals: [...state.sessionPrincipals],
      instanceKeys: [...state.instances.keys()],
      cleanKeys: [...state.clean],
    };
  }

  /** The bound yield hook handed to the settle loop (stage C tuning T3):
   * a promise to await when the slice is spent, else undefined. Defined
   * only when `#cooperativeYield` exists. */
  readonly #cooperativeYieldBetweenRuns = ():
    | Promise<void>
    | undefined => this.#cooperativeYield?.maybeYield();

  /**
   * Schedules an execution pass. While one is pending or running, the running
   * pass is marked to run again instead, so at most one is ever scheduled.
   */
  queueExecution(): void {
    if (this.#disposed) return;
    if (this.#scheduled) {
      if (this.#pendingQueueTaskTimer === null) {
        this.#rerunAfterCurrentExecute = true;
      }
      return;
    }
    this.#pendingQueueTaskTimer = queueTask(() => {
      this.#pendingQueueTaskTimer = null;
      this.#execute();
    });
    this.#scheduled = true;
  }

  queueEvent(
    eventLink: NormalizedFullLink,
    event: any,
    // Whether a transient commit failure converges via the backoff window (and
    // the inSpace-name resolution path re-runs an unserved handler). `false`
    // opts out: the event drops on the first failure without retrying. A served
    // RetryImmediately still re-runs in its current wave; commit retry remains
    // disabled. Defaults to `true` so every real user event through `cell.send`
    // gets backpressure.
    retries: boolean = true,
    // Internal-only commit callback. This runs after the final commit result,
    // including a dropped failure, so it must not perform external side
    // effects. Use the post-commit outbox for success-only effect release.
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    doNotLoadPieceIfNotRunning: boolean = false,
    opts: {
      eventId?: string;
      originTx?: IExtendedStorageTransaction;
      time?: number;

      /**
       * Payload keys the RUNTIME itself injected into `event`'s value —
       * provenance for the closed-world gate, forwarded from the send's
       * internal options (never derivable from payload data). See
       * `StreamSendOptions` (cell.ts).
       */
      runtimeInjectedEventKeys?: readonly string[];

      /** Server-execution v2 Phase 3: the serving drain's per-event
       * carriage — acting identity, the durable stream entry, and the
       * failure hook (QueuedEvent.served). Passed only by the
       * SpaceServer's drain; absent everywhere client-side. */
      served?: ServedEventDispatch;

      /** The client-echo cascade thread (QueuedEvent.parentEventId):
       * the emitting run's event id, passed by cell.ts's plain
       * queueEvent for a send from within a speculation-stamped
       * handler run. Kept OFF `served` — see QueuedEvent. */
      parentEventId?: string;
    } = {},
  ): void {
    // Bind the event's wall-clock time at its causal origin. A pre-supplied time
    // (a shaper release re-queueing a held event, a piece-load re-queue) is kept
    // as-is so the instant is captured once at the original send. A send from
    // INSIDE a handler carries that handler's frozen instant forward, so a whole
    // cascade from one gesture shares one time — the handler frame always has an
    // instant (createPatternFrame sets it), so this branch never falls through
    // to the clock. Only a root/renderer send, outside any handler frame, reads
    // the wall clock here to birth a fresh instant. This raw value is never
    // exposed to a pattern un-coarsened: the dispatching handler reads it only
    // through sandboxDateNow, which floors it to one second.
    const frame = getTopFrame();
    const time = opts.time ??
      (frame?.inHandler === true ? frame.eventTime : undefined) ??
      Date.now();
    // Coarsen the delivery cadence of user-input events (W3). The piece-loading
    // re-queue (doNotLoadPieceIfNotRunning) is an internal retry, not fresh
    // input, so it is never reshaped.
    if (!doNotLoadPieceIfNotRunning && shouldShapeDelivery(event)) {
      holdShapedEvent(
        this.#wakeShaper,
        this.#shapedEventDeliver,
        this.#pieceIdForEventLink(eventLink),
        eventLink,
        this.runtime.scopeKeyIdentity,
        event,
        retries,
        onCommit,
        {
          eventId: opts.eventId,
          originTx: opts.originTx,
          time,
          runtimeInjectedEventKeys: opts.runtimeInjectedEventKeys,
          served: opts.served,
          parentEventId: opts.parentEventId,
        },
      );
      return;
    }
    queueSchedulerEvent(this.#eventQueueState, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning,
      eventId: opts.eventId,
      originTx: opts.originTx,
      time,
      runtimeInjectedEventKeys: opts.runtimeInjectedEventKeys,
      served: opts.served,
      parentEventId: opts.parentEventId,
    });
  }

  /**
   * Delivery for a released shaped event, which re-enters the ordinary queue
   * path; the shaper reads `eventQueueState` at release time, so it stays
   * correct across state re-init.
   */
  #shapedEventDeliver: DeliverFn = (
    eventLink,
    event,
    retries,
    onCommit,
    opts,
  ) =>
    queueSchedulerEvent(this.#eventQueueState, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning: false,
      eventId: opts.eventId,
      originTx: opts.originTx,
      time: opts.time,
      runtimeInjectedEventKeys: opts.runtimeInjectedEventKeys,
      served: opts.served,
      parentEventId: opts.parentEventId,
    });

  /**
   * Returns the id of the owning pattern instance for an input stream, used to
   * group a pattern's input across its several streams into one
   * delivery-shaping window (per-pattern coalescing). The wake shaper's
   * `hold()` runs before the handler is resolved, so we find it here from the
   * registered handlers; `undefined` when none is registered yet (the shaper
   * then falls back to per-stream grouping). The key includes the owning space
   * so two instances of one pattern in different spaces (same content-addressed
   * `pieceId`) do not share a bucket (see `shaperInstanceGroupKey()`).
   */
  #pieceIdForEventLink(
    eventLink: NormalizedFullLink,
  ): string | undefined {
    for (const [link, handler] of this.#eventHandlers) {
      if (areNormalizedLinksSame(link, eventLink)) {
        return shaperInstanceGroupKey(
          (handler as {
            schedulerObservationIdentity?: SchedulerObservationIdentity;
          }).schedulerObservationIdentity,
        );
      }
    }
    return undefined;
  }

  /**
   * Plan B seam: hold a shapable cell-flip notification so a watching lift/sink
   * observes it coalesced and jittered rather than at the instant the cell
   * changed. `groupKey` must identify the observing pattern instance (so all of
   * one pattern's shaped cell flips share a release window — the property that
   * defeats the over-sampling attack); `itemKey` identifies the changed cell
   * within the group (the coalescing unit); `deliver` performs the already
   * committed notification (never holds a transaction). Only real-world-timing
   * notifications may be routed here — never ordinary internal computation, or
   * all reactivity would stall.
   *
   * The shaper is owned and its lifecycle wired (idle-drain, dispose). Its two
   * high-value sources ARE routed here, at the invalidation.ts per-change
   * loop via shapableWakeGroupKey: renderer `$value` keystroke writes (a commit
   * whose transaction carries the renderer-input mark set by markRendererInputTx
   * in storage/reactivity-log.ts, stamped from runtime-client's blind CellSet)
   * and server pushes (notification.type "pull"/"integrate"). Each is coalesced
   * PER CELL (last-wins) so distinct cells are never dropped, and interactive
   * input and passive pushes use separate per-pattern buckets so background
   * chatter cannot drain the interactive burst. Only real-world-timing
   * notifications are routed — never ordinary internal computation.
   *
   * Deferred / open sources:
   * TODO(timing/plan-B/now): channel 4. `#now` ticks (builtins/wish.ts, a
   *   wall-clock-boundary interval timer) are deliberately NOT routed here — the
   *   value is already >=1s and grid-aligned and W1 denies the fine clock needed
   *   to read its phase, so the ~1s latency it would add to every clock read is
   *   not worth it. To wire it, recognize the `#now` cell link-keys at the
   *   notification point (its URI is a content hash, so intent is otherwise lost).
   */
  holdShapedCellNotification(
    groupKey: string,
    itemKey: string,
    chargeKey: object,
    deliver: () => void,
  ): void {
    holdShapedCell(this.#wakeShaper, groupKey, itemKey, chargeKey, deliver);
  }

  /**
   * Returns whether any shapable cell-flip wake is currently held out of the
   * scheduler. Exposed for tests that need to observe that a change was routed
   * through the wake shaper's cell path before `idle()` drains it.
   */
  hasPendingShapedCellNotifications(): boolean {
    return this.#wakeShaper.hasPending(CELL_GROUP_PREFIX);
  }

  addEventHandler(
    handler: EventHandler,
    ref: NormalizedFullLink,
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void,
  ): Cancel {
    return addSchedulerEventHandler({
      eventHandlers: this.#eventHandlers,
    }, {
      handler,
      ref,
      populateDependencies,
    });
  }

  onConsole(fn: ConsoleHandler): void {
    this.#consoleHandler = fn;
  }

  onError(fn: ErrorHandler): void {
    this.#errorHandlers.add(fn);
  }

  /** Reports an action's asynchronous failure through the ordinary error handlers. */
  reportError(error: Error, action: Action): void {
    this.#handleError(error, action);
  }

  setEventPreflightTelemetryEnabled(enabled: boolean): void {
    this.#eventPreflightTelemetryEnabled = enabled;
  }

  isEventPreflightTelemetryEnabled(): boolean {
    return this.#eventPreflightTelemetryEnabled;
  }

  //
  // Debounce infrastructure for throttling slow actions
  //

  /**
   * Sets a debounce delay for an action.
   * When the action is triggered, it will wait for the specified delay before running.
   * If triggered again during the delay, the timer resets.
   */
  setDebounce(action: Action, ms: number): void {
    this.#gates.setDebounce(action, ms);
    // Configuring a debounce on an already-invalid computation starts its
    // trailing window now — the same re-arm an invalidation would do
    // (arming is otherwise the invalidation path's job; queries stay pure).
    const record = this.#nodes.get(action);
    if (
      ms > 0 && record?.kind === "computation" && this.#isInvalidAction(action)
    ) {
      this.#gates.onInvalidated(
        record,
        performance.now(),
        this.#createDebouncedComputationContext(),
      );
    }
  }

  /**
   * Gets the current debounce delay for an action, if set.
   */
  getDebounce(action: Action): number | undefined {
    return this.#gates.getDebounce(action);
  }

  /**
   * Clears the debounce setting for an action.
   */
  clearDebounce(action: Action): void {
    this.#gates.clearDebounce(action);
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   * By default, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    this.#gates.setNoDebounce(action, optOut);
  }

  //
  // Throttle infrastructure - "value may be outdated by T ms"
  //

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   * Unlike debounce, throttled actions stay dirty and will be pulled
   * by effects when the throttle period expires. Event handlers whose head
   * dependencies are throttled are parked until the earliest eligible wake time.
   */
  setThrottle(action: Action, ms: number): void {
    this.#gates.setThrottle(action, ms);
  }

  /**
   * Gets the current throttle period for an action, if set.
   */
  getThrottle(action: Action): number | undefined {
    return this.#gates.getThrottle(action);
  }

  /**
   * Clears the throttle setting for an action.
   */
  clearThrottle(action: Action): void {
    this.#gates.clearThrottle(action);
  }

  /**
   * Set action IDs that should trigger a debugger breakpoint before execution.
   */
  setBreakpoints(actionIds: readonly string[]): void {
    this.#breakpoints.clear();
    for (const id of actionIds) {
      this.#breakpoints.add(id);
    }
  }

  /**
   * Get currently set breakpoint action IDs.
   */
  getBreakpoints(): string[] {
    return Array.from(this.#breakpoints);
  }

  /**
   * Check if an action ID has a breakpoint set.
   */
  hasBreakpoint(actionId: string): boolean {
    return this.#breakpoints.has(actionId);
  }

  /**
   * Returns diagnostic statistics about the scheduler state.
   * Useful for debugging and monitoring pull-based scheduling behavior.
   */
  getStats(): { effects: number; computations: number; pending: number } {
    return {
      effects: this.#nodes.effects.size,
      computations: this.#nodes.computations.size,
      pending: this.#pending.size,
    };
  }

  /**
   * Returns whether an action is registered as an effect.
   */
  isEffect(action: Action): boolean {
    return this.#nodes.effects.has(action);
  }

  /**
   * Returns whether an action is registered as a computation.
   */
  isComputation(action: Action): boolean {
    return this.#nodes.computations.has(action);
  }

  /**
   * Returns whether an action is marked as dirty.
   */
  isDirty(action: Action): boolean {
    return this.#isInvalidAction(action);
  }

  /**
   * Returns the set of actions that depend on this action's output.
   */
  getDependents(action: Action): Set<Action> {
    return this.#dependents.get(action) ?? new Set();
  }

  /** Applies negotiated eligibility, replica coverage, and local producer currency. */
  prepareViewAction(
    tx: IExtendedStorageTransaction,
    action: Action | EventHandler,
  ): void {
    const metadata = action as Partial<TelemetryAnnotations>;
    const piece = metadata.viewPiece;
    const id = metadata.viewNodeId;
    if (piece === undefined || id === undefined) return;
    if (
      metadata.viewLocalOnly !== true &&
      (!this.runtime.viewScopedReplicationRequested ||
        !this.runtime.viewReplication.active(piece.space))
    ) return;
    const views = this.runtime.viewReplication;
    const generation = views.version(piece.space);
    const producers = new Map([...this.#nodes.nodes()].flatMap((node) => {
      const annotated = node.action as Partial<TelemetryAnnotations>;
      return annotated.viewPiece?.space === piece.space &&
          annotated.viewNodeId !== undefined
        ? [[annotated.viewNodeId, node] as const]
        : [];
    }));
    if (!usesLocalReads(tx)) {
      restrictToLocalReads(tx.tx, () => {
        const producerCurrent = views.createProducerCheck(
          piece.space,
          (candidate) =>
            this.#viewActionCurrent(producers.get(candidate)?.action),
          (dependency) => recordLocalReadWake(tx, dependency),
        );
        return (address) => {
          if (
            views.version(piece.space) !== generation ||
            !views.eligible(piece.space, id) || !views.permits(address)
          ) return false;
          for (const producer of views.producers(address)) {
            if (producer === id) continue;
            if (!producerCurrent(producer)) return false;
          }
          const writers = this.#writeIndex.writersByEntity.get(
            entityNameKey(address),
          );
          for (const writer of writers ?? []) {
            if (writer === action) continue;
            const writerId =
              (writer as Partial<TelemetryAnnotations>).viewNodeId;
            if (writerId === undefined) continue;
            const node = this.#nodes.get(writer);
            if (
              !this.#viewActionCurrent(node?.action) &&
              readsOverlapWrites(
                [address],
                [],
                this.getMightWrite(writer) ?? [],
              ) &&
              !producerCurrent(writerId)
            ) return false;
          }
          return true;
        };
      });
    }
    requireLocalReadCondition(
      tx.tx,
      toMemorySpaceAddress(piece),
      () =>
        views.version(piece.space) === generation &&
        views.eligible(piece.space, id) && views.pieceCurrent(piece),
    );
  }

  /** A local producer is current only after a successful completed attempt. */
  #viewActionCurrent(action: Action | undefined): boolean {
    if (action === undefined || this.#viewRunning.has(action)) return false;
    const node = this.#nodes.get(action);
    const outcome = this.#viewOutcomes.get(action)?.get("*");
    return node?.status === "clean" && outcome?.settled === true &&
      outcome.registration === node.registrationToken;
  }

  /** Collects server currency only for negotiated view computations. */
  #initialViewDependencies(
    action: Action,
    identity: string,
  ): ReactivityLog | undefined {
    const { viewPiece, viewNodeId, viewLocalOnly } = action as Partial<
      TelemetryAnnotations
    >;
    if (
      !this.runtime.viewScopedReplicationRequested || viewLocalOnly !== true ||
      viewPiece === undefined || viewNodeId === undefined
    ) return undefined;
    return this.runtime.viewReplication.initialViewDependencies(
      viewPiece,
      viewNodeId,
      identity,
    );
  }

  /** Rechecks adopted evidence and parked work when plans or coverage change. */
  wakeViewReplication(
    space: MemorySpace,
    { parked = true }: { parked?: boolean } = {},
  ): void {
    for (const node of this.#nodes.nodes()) {
      const metadata = node.action as Partial<TelemetryAnnotations>;
      if (metadata.viewPiece?.space !== space) continue;
      if (node.adoptedViewIdentity !== undefined) {
        const log = this.#initialViewDependencies(
          node.action,
          node.adoptedViewIdentity,
        );
        if (log !== undefined) {
          const writes = sortAndCompactPaths([
            ...resolveRegistrationSurface(node.action, log),
            ...log.writes,
          ]);
          this.#writeIndex.setSurface(node.action, writes);
          for (const dependent of [...this.getDependents(node.action)]) {
            const dependencies = this.#dependencies.get(dependent);
            if (dependencies !== undefined) {
              updateDependentEdgesForLog(
                this.#dependencyGraphState,
                dependent,
                dependencies,
              );
            }
          }
          registerDependentsForWriterSurface(
            this.#dependencyGraphState,
            node.action,
            writes,
          );
          this.resubscribe(node.action, log);
          continue;
        }
      } else if (!parked || node.status !== "unavailable") continue;
      this.#markActionInvalid(node.action);
      this.#pending.add(node.action);
    }
    this.queueExecution();
  }

  /** Wakes blocked consumers even when a successful producer kept the same value. */
  noteViewActionCurrent(action: Action): void {
    if (
      !this.runtime.viewScopedReplicationRequested ||
      this.#nodes.get(action)?.status !== "clean"
    ) return;
    let woke = false;
    for (const dependent of this.getDependents(action)) {
      if (this.#nodes.get(dependent)?.status !== "unavailable") continue;
      this.#markActionInvalid(dependent);
      this.#pending.add(dependent);
      woke = true;
    }
    if (woke) this.queueExecution();
  }

  /** Revokes authority evidence while the next invocation is unresolved. */
  beginViewAction(action: Action): void {
    const node = this.#nodes.get(action);
    if (node !== undefined) node.adoptedViewIdentity = undefined;
    const metadata = action as Partial<TelemetryAnnotations>;
    if (
      metadata.viewNodeId !== undefined &&
      (this.runtime.servingPosture ||
        this.runtime.viewScopedReplicationRequested ||
        (metadata.viewPiece !== undefined &&
          this.#viewConsumers.has(metadata.viewPiece.space)))
    ) this.#viewRunning.add(action);
  }

  /** Records authored outcomes after their transaction and wave become durable. */
  recordViewActionOutcome(
    action: Action,
    tx: IExtendedStorageTransaction,
    log: ReactivityLog,
    succeeded: boolean,
    commit: ReturnType<IExtendedStorageTransaction["commit"]>,
    failure?: unknown,
  ): void {
    if (!this.#viewRunning.delete(action)) return;
    const node = this.#nodes.get(action);
    if (
      node === undefined ||
      (action as Partial<TelemetryAnnotations>).viewNodeId === undefined
    ) return;
    const identity = waveRunContextOf(tx)?.scopeKeyIdentity ??
      this.runtime.scopeKeyIdentity;
    const key = node.fanOut === undefined
      ? "*"
      : keyAtRatchet(node.fanOut, identity);
    if (key === undefined) return;
    let outcomes = this.#viewOutcomes.get(action);
    if (outcomes === undefined) {
      this.#viewOutcomes.set(action, outcomes = new Map());
    }
    const metadata = action as Partial<TelemetryAnnotations>;
    const error = succeeded
      ? undefined
      : failure instanceof Error
      ? failure as ErrorWithContext
      : new Error(String(failure)) as ErrorWithContext;
    const outcome = {
      log,
      settled: false,
      confirmed: false,
      registration: node.registrationToken,
      ...(error !== undefined && metadata.viewPiece !== undefined
        ? {
          error: {
            nodeId: metadata.viewNodeId!,
            pieceId: metadata.viewPiece.id,
            message: error.message,
            ...(error.stack === undefined ? {} : { stack: error.stack }),
            ...(error.patternId === undefined
              ? {}
              : { patternId: error.patternId }),
            ...(error.spellId === undefined ? {} : { spellId: error.spellId }),
          },
        }
        : {}),
    };
    outcomes.set(key, outcome);
    void commit.then(async (result) => {
      if (result.error !== undefined) return;
      const settlement = waveSettlementOf(tx);
      if (settlement !== undefined && (await settlement).error !== undefined) {
        return;
      }
      if (
        outcomes.get(key) === outcome &&
        node.registrationToken === outcome.registration
      ) {
        outcome.confirmed = true;
        outcome.settled = succeeded;
      }
    }).catch(() => {});
  }

  /** Retains observations only for sessions with live renderer demand. */
  setViewConsumers(
    space: MemorySpace,
    identities: readonly ScopeKeyIdentity[],
  ): void {
    const keys = new Set(
      identities.map((identity) =>
        `${identity.principal ?? ""}\0${identity.sessionId ?? ""}`
      ),
    );
    if (keys.size === 0) this.#viewConsumers.delete(space);
    else this.#viewConsumers.set(space, keys);
    for (const [, registered] of this.#eventHandlers) {
      for (const handler of eventHandlerImplementations(registered)) {
        if (
          (handler as Partial<TelemetryAnnotations>).viewPiece?.space !== space
        ) continue;
        const logs = this.#viewHandlerLogs.get(handler);
        for (const key of logs?.keys() ?? []) {
          if (!keys.has(key)) logs!.delete(key);
        }
      }
    }
  }

  /** Records handler reads until publication prunes inactive viewing identities. */
  recordViewHandlerLog(
    handler: EventHandler,
    identity: ScopeKeyIdentity,
    log: ReactivityLog,
  ): void {
    const space = (handler as Partial<TelemetryAnnotations>).viewPiece?.space;
    const key = `${identity.principal ?? ""}\0${identity.sessionId ?? ""}`;
    if (space === undefined) return;
    let logs = this.#viewHandlerLogs.get(handler);
    if (logs === undefined) {
      this.#viewHandlerLogs.set(handler, logs = new Map());
    }
    logs.set(key, log);
  }

  /**
   * Observed reads for a viewing session; per-instance logs never cross identities.
   * Logs and write surfaces are replaced when observations change. Callers retain
   * those identities to detect changes and must not mutate the returned records.
   */
  viewExecutionNodes(
    space: MemorySpace,
    identity: ScopeKeyIdentity,
  ): ViewExecutionNode[] {
    const result: ViewExecutionNode[] = [];
    for (const node of this.#nodes.nodes()) {
      const annotated = node.action as Partial<TelemetryAnnotations>;
      if (
        annotated.viewPiece?.space !== space ||
        annotated.viewNodeId === undefined
      ) continue;
      const instanceKey = node.fanOut === undefined
        ? undefined
        : keyAtRatchet(node.fanOut, identity);
      const outcome = this.#viewOutcomes.get(node.action)?.get(
        instanceKey ?? "*",
      );
      const log = node.fanOut === undefined
        ? outcome?.log ?? this.#dependencies.get(node.action)
        : instanceKey === undefined
        ? undefined
        : node.fanOut.instances.get(instanceKey)?.log;
      if (log === undefined) continue;
      const outcomeCurrent = !this.#viewRunning.has(node.action) &&
        outcome?.registration === node.registrationToken &&
        node.status === "clean" &&
        (node.fanOut === undefined ||
          (instanceKey !== undefined && node.fanOut.clean.has(instanceKey)));
      result.push({
        id: annotated.viewNodeId,
        piece: annotated.viewPiece,
        kind: annotated.module?.type === "javascript"
          ? "computation"
          : "boundary",
        current: outcomeCurrent && outcome?.settled === true,
        ...(outcomeCurrent && outcome?.confirmed && outcome.error !== undefined
          ? { error: outcome.error }
          : {}),
        log,
        writes: this.getMightWrite(node.action) ?? log.writes,
      });
    }
    let selectionTx: IExtendedStorageTransaction | undefined;
    try {
      for (const [stream, registered] of this.#eventHandlers) {
        if (stream.space !== space) continue;
        if (selectionTx === undefined) {
          selectionTx = this.runtime.readTx();
          selectionTx.tx.scopeKeyIdentity = identity;
        }
        const handler = selectEventImplementation(registered, selectionTx);
        if (handler === undefined) continue;
        const annotated = handler as Partial<TelemetryAnnotations>;
        if (
          annotated.viewPiece?.space !== space ||
          annotated.viewNodeId === undefined
        ) continue;
        const log = this.#viewHandlerLogs.get(handler)?.get(
          `${identity.principal ?? ""}\0${identity.sessionId ?? ""}`,
        );
        if (log === undefined) continue;
        result.push({
          id: annotated.viewNodeId,
          piece: annotated.viewPiece,
          kind: "handler",
          stream,
          log,
          writes: log.writes,
        });
      }
    } finally {
      selectionTx?.clearReadOnly?.();
      selectionTx?.abort("view handler selection complete");
    }
    return result;
  }

  /**
   * Returns a snapshot of the current dependency graph for visualization.
   * Uses getActionId for the identifier (includes code location).
   */
  getGraphSnapshot(): SchedulerGraphSnapshot {
    return buildSchedulerGraphSnapshot(this.#graphSnapshotState);
  }

  //
  // Push-triggered filtering
  //

  /**
   * Returns the action's static write surface.
   */
  getMightWrite(action: Action): IMemorySpaceAddress[] | undefined {
    return this.#writeIndex.getSchedulingWrites(action);
  }

  //
  // Compute time tracking for cycle-aware scheduling
  //

  /**
   * Returns the execution statistics for an action, if available.
   * Useful for diagnostics and determining cycle convergence strategy.
   * Accepts either an Action or an action ID string.
   */
  getActionStats(action: Action | string): ActionStats | undefined {
    return getActionStatsFromState(this.#actionTimingState, action);
  }

  /**
   * Returns filter statistics for the current/last execution cycle.
   */
  getFilterStats(): { filtered: number; executed: number } {
    return { ...this.#filterStats };
  }

  /**
   * Resets filter statistics.
   */
  resetFilterStats(): void {
    this.#filterStats.filtered = 0;
    this.#filterStats.executed = 0;
  }

  /** Enables or disables per-action read accounting for subsequent runs. */
  setReadStatsEnabled(
    enabled: boolean,
    options: { attempts?: boolean } = {},
  ): void {
    this.#collectReadStats = enabled;
    this.#readAttemptAccountingEnabled = enabled && options.attempts === true;
  }

  /** Starts opt-in accounting for a transaction outside a reactive body. */
  beginReadAttempt(
    tx: IExtendedStorageTransaction,
    kind:
      | "event"
      | "presync"
      | "preflight"
      | "initialization"
      | "editWithRetry",
    actionId?: string,
  ): void {
    if (!this.#readAttemptAccountingEnabled) return;
    startReadStats(tx, (reads) => {
      this.runtime.telemetry.submit({
        type: "scheduler.read-attempt",
        kind,
        actionId,
        reads,
      });
    });
  }

  /**
   * Enables collection of per-iteration settle stats during `#execute()`.
   * Call this once before running patterns to opt in to the overhead.
   */
  enableSettleStats(): void {
    this.setSettleStatsEnabled(true);
  }

  /**
   * Enables or disables collection of per-iteration settle stats during `#execute()`.
   * Disabling also clears the last collected stats to avoid outdated reads.
   */
  setSettleStatsEnabled(enabled: boolean): void {
    this.#collectSettleStats = enabled;
    if (!enabled) {
      this.#lastSettleStats = null;
      this.#settleStatsHistory = [];
    }
  }

  /**
   * Returns settle stats from the last `#execute()` call, or null if not enabled/collected.
   */
  getSettleStats(): SettleStats | null {
    return this.#lastSettleStats;
  }

  /**
   * Returns recent settle stats history from `#execute()` calls, oldest first.
   */
  getSettleStatsHistory(): SettleStatsHistoryEntry[] {
    return [...this.#settleStatsHistory];
  }

  /**
   * Enables or disables collection of exact action-run history.
   * Disabling clears the current ring buffer to avoid outdated reads.
   */
  setActionRunTraceEnabled(enabled: boolean): void {
    this.#collectActionRunTrace = enabled;
    if (!enabled) {
      this.#actionRunTrace.length = 0;
    }
  }

  /**
   * Returns recent exact action-run history, oldest first.
   */
  getActionRunTrace(): ActionRunTraceEntry[] {
    return [...this.#actionRunTrace];
  }

  /**
   * Enables or disables collection of structured trigger-trace entries.
   * Disabling clears the current ring buffer to avoid outdated reads.
   */
  setTriggerTraceEnabled(enabled: boolean): void {
    this.#collectTriggerTrace = enabled;
    if (!enabled) {
      this.#triggerTrace = [];
    }
  }

  /**
   * Returns recent structured trigger-trace entries, oldest first.
   */
  getTriggerTrace(): TriggerTraceEntry[] {
    return [...this.#triggerTrace];
  }

  //
  // Non-settling detection API
  //

  /**
   * Returns whether the scheduler has detected a non-settling condition.
   * This means `#execute()` is consuming a high fraction of wall-clock time,
   * indicating the system is churning.
   */
  isNonSettling(): boolean {
    return this.#settlingTracker.nonSettlingDetected;
  }

  /**
   * Enables or disables automatic triggering of diagnosis when non-settling
   * is detected. Off by default.
   */
  setAutoTriggerDiagnosis(enabled: boolean): void {
    this.#autoTriggerDiagnosis = enabled;
  }

  /**
   * Runs a diagnosis for the specified duration and returns the result.
   * This is the main entry point for external callers (IPC, console).
   */
  runDiagnosis(durationMs = 5000): Promise<SchedulerDiagnosisResult> {
    return runSchedulerDiagnosis(this.#diagnosisControlState, durationMs);
  }

  //
  // Inline idempotency check mode
  //

  enableIdempotencyCheck(): void {
    this.#idempotencyCheckMode = true;
    this.#idempotencyViolations.length = 0;
    this.queueExecution();
  }

  disableIdempotencyCheck(): void {
    this.#idempotencyCheckMode = false;
  }

  getIdempotencyViolations(): NonIdempotentReport[] {
    return [...this.#idempotencyViolations];
  }

  /**
   * Checks all computations for idempotency by enabling inline mode
   * and force-running each computation through run(). Each run()
   * automatically gets a second synchronous run for comparison.
   */
  async runIdempotencyCheck(): Promise<SchedulerDiagnosisResult> {
    return await runSchedulerIdempotencyCheck(this.#diagnosisControlState);
  }

  /**
   * Clean up all pending timers and resources.
   * Should be called when the scheduler is being torn down.
   */
  dispose(): void {
    // A storage manager outliving this scheduler keeps every subscriber it was
    // given, and each holds its scheduler reachable. The subscription does not
    // retire itself: its `next` returns `{ done: false }` unconditionally, and
    // `{ done: true }` is the only self-cancelling answer the contract has.
    // `unsubscribe` is optional on the capability, so a manager without one is
    // left as it was rather than crashing a disposal.
    this.runtime.storageManager.unsubscribe?.(this.#storageSubscription);
    this.#headEventLoadPark = null;
    this.#headEventLoadParkHistory = null;
    this.#disposed = true;
    for (const record of this.#nodes.nodes()) {
      record.cancelLocalReadWake?.();
      record.cancelLocalReadWake = undefined;
    }
    this.#gates.cancelWake();
    if (this.#pendingQueueTaskTimer !== null) {
      clearTimeout(this.#pendingQueueTaskTimer);
      this.#pendingQueueTaskTimer = null;
    }
    this.#triggerIndex.clear();
    this.#wakeShaper.dispose();
    // Release waiters already parked when dispose arrived. The disposed check
    // in `#quiescenceBlocker()` covers idle() calls made AFTER this point; it
    // cannot reach these, and nothing else will — `#execute()` is the only
    // other drain and it is now a no-op. Same contract the wake shaper's own
    // dispose keeps for its drain waiters, one line up. Drained in place
    // rather than by reassigning the field: createExecuteContinuationState()
    // hands this exact array out, so a swap would leave any live continuation
    // state draining the detached one.
    //
    // Routed back through waitForQuiescence rather than resolved here, because
    // dispose does NOT cancel a run already under way — `#execute()` tests
    // `#disposed` only on entry. Every parking branch is reached with
    // `runningPromise` unset, so a waiter parked while execution was merely
    // SCHEDULED is still parked once the run begins; resolving it directly
    // would report quiescence with an action, and its commit, still going. The
    // re-check waits on that promise and only then reaches the disposed check,
    // which is exactly the guarantee the check documents. It cannot re-park:
    // the disposed check comes before every blocker that pushes to this list.
    const parked = this.#idlePromises.splice(0);
    if (parked.length > 0) {
      this.#waitForQuiescence(false).then(() => {
        for (const resolve of parked) resolve();
      });
    }
    // Clean up diagnosis state
    if (this.#diagnosisTimeout) {
      clearTimeout(this.#diagnosisTimeout);
      this.#diagnosisTimeout = null;
    }
    this.#diagnosisEnabled = false;
  }

  //
  // Execution orchestration
  //

  #handleError(error: Error, action: any) {
    handleSchedulerError(
      {
        errorHandlers: this.#errorHandlers,
        parseStack: (stack) => this.runtime.harness.parseStack(stack),
      },
      error,
      action,
    );
  }

  /** Runs one scheduler pass. */
  async #execute(): Promise<void> {
    if (this.#disposed) return;
    logger.timeStart("scheduler", "execute");
    // Each execute pass starts in a fresh macrotask (queueTask): restart
    // the serving posture's yield slice so idle time between passes never
    // reads as spent work (stage C tuning T3).
    this.#cooperativeYield?.noteMacrotaskBoundary();

    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    this.#beginExecuteCycle();
    const eventBlockingDeps = await this.#processExecuteEventPhase();
    const initialSeeds = this.#buildInitialExecuteSeeds(eventBlockingDeps);

    const settleResult = await this.#runSettleLoop(initialSeeds);
    this.#recordBudgetBackoffTelemetry(settleResult);
    this.#recordExecuteEndTelemetry();
    this.#applyExecuteContinuation();
    logger.timeEnd("scheduler", "execute");
  }

  #beginExecuteCycle(): void {
    this.#activePassId = ++this.#passCounter;
    this.#provisionalDemandThisPass.clear();
    for (const record of this.#nodes.nodes()) {
      record.passRuns = 0;
    }

    // Non-settling heuristic: record `#execute()` start
    markExecuteStart(this.#settlingTracker);
  }

  async #processExecuteEventPhase(): Promise<Set<Action>> {
    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();
    this.#eventPassDemandRefresh = undefined;

    logger.timeStart("scheduler", "execute", "event");
    try {
      await processPullQueuedEventDuringExecute(
        this.#eventExecutionState,
        eventBlockingDeps,
      );
      return eventBlockingDeps;
    } finally {
      logger.timeEnd("scheduler", "execute", "event");
    }
  }

  #buildInitialExecuteSeeds(
    eventBlockingDeps: Iterable<Action>,
  ): Set<Action> {
    // Capture the head event's transient demand roots for this settle pass.
    return buildPullInitialSeeds({
      eventBlockingDeps,
    });
  }

  async #runSettleLoop(
    initialSeeds: ReadonlySet<Action>,
  ): Promise<SchedulerSettleResult> {
    const settleResult = await runPullSchedulerSettleLoop(
      this.#settleLoopState,
      initialSeeds,
    );

    if (settleResult.settleStats) {
      this.#lastSettleStats = settleResult.settleStats;
      pushBoundedHistory(
        this.#settleStatsHistory,
        { recordedAt: performance.now(), stats: settleResult.settleStats },
        MAX_SETTLE_STATS_HISTORY,
      );
    }

    this.runtime.telemetry.submit({
      type: "scheduler.settle",
      durationMs: settleResult.settleDurationMs,
      iterations: settleResult.iterationsRun,
      settledEarly: settleResult.settledEarly,
      seedCount: initialSeeds.size,
      workSetSize: settleResult.workSetSize,
    });

    this.#clearProvisionalDemandAtPassEnd();
    this.#clearBackoffForCleanNodes();
    this.#activePassId = undefined;

    return settleResult;
  }

  #applyExecuteContinuation(): void {
    applyPullExecuteContinuation(this.#executeContinuationState);
  }

  #recordBudgetBackoffTelemetry(
    settleResult: SchedulerSettleResult,
  ): void {
    if (!settleResult.backoffApplied) return;

    const deferredActions = this.#describeDeferredActions(
      settleResult.backoffActions,
    );
    this.runtime.telemetry.submit({
      type: "scheduler.non-settling",
      ...summarizeNonSettlingWindow(this.#settlingTracker),
      deferredActions,
      deferredActionCount: settleResult.backoffActions.length,
    });

    // The marker carries every episode; the warning is a latched
    // summary so a permanently non-converging graph does not flood the log.
    if (markNonSettlingEpisode(this.#settlingTracker)) {
      this.#warnNonSettlingActions(
        settleResult.backoffActions,
        deferredActions,
      );
    }
  }

  /**
   * Describes the first few deferred actions: readable label, plus the piece
   * the action serves when its scheduler observation identity says — the
   * attribution a builtin's `raw:` label cannot provide. The identity's
   * pieceId is `<scope>:<id>` of the piece's result cell; the marker carries
   * the id alone, the form consumers compare against.
   */
  #describeDeferredActions(
    actions: readonly Action[],
  ): NonSettlingDeferredAction[] {
    const maxListedActions = 10;
    return actions.slice(0, maxListedActions).map((action) => {
      const actionId = this.#getActionId(action);
      const info = getSchedulerActionTelemetryInfo(action);
      const readableName = info?.moduleName ?? info?.patternName;
      const label = readableName && readableName !== actionId
        ? `${readableName} (${actionId})`
        : actionId;
      const identity = (action as Partial<TelemetryAnnotations>)
        .schedulerObservationIdentity;
      // `pieceRootId` is the raw result-cell id; `pieceId` prefixes it with a
      // scope KEY, and `user:`/`session:` keys carry their own colons, so
      // slicing at the first one misattributes a scoped piece.
      const rootId = identity?.pieceRootId;
      if (identity === undefined || rootId === undefined) return { label };
      return {
        label,
        pieceId: rootId,
        ...(identity.ownerSpace !== undefined
          ? { space: identity.ownerSpace }
          : {}),
      };
    });
  }

  #warnNonSettlingActions(
    actions: readonly Action[],
    deferredActions: readonly NonSettlingDeferredAction[],
  ): void {
    const labels = deferredActions.map((entry) => entry.label);
    const omittedCount = actions.length - labels.length;
    const actionList = labels.length > 0
      ? labels.join(", ") +
        (omittedCount > 0 ? `, and ${omittedCount} more` : "")
      : "unknown";

    logger.warn("scheduler-non-settling", () => [
      "Reactive graph did not settle within a scheduler pass; " +
      "retrying with backoff. Check for a reactive cycle or non-idempotent " +
      `computation. Actions: ${actionList}. ` +
      "Run commonfabric.detectNonIdempotent() for details.",
    ]);
  }

  #recordExecuteEndTelemetry(): void {
    // Non-settling heuristic: accumulate busy time at end of `#execute()`
    const executeEnd = recordExecuteEnd(this.#settlingTracker);
    if (this.#diagnosisEnabled) {
      this.#diagnosisBusyTime += executeEnd.diagnosisBusyTimeMs;
    }
    if (executeEnd.nonSettlingTelemetry) {
      this.runtime.telemetry.submit({
        type: "scheduler.non-settling",
        ...executeEnd.nonSettlingTelemetry,
      });
      // Auto-trigger diagnosis if enabled
      if (this.#autoTriggerDiagnosis && !this.#diagnosisEnabled) {
        this.#startDiagnosis();
      }
    }
  }

  //
  // Idempotency diagnosis API (Phase 2 + 3)
  //

  /**
   * Starts diagnosis mode: captures read/write values and causal edges.
   * Automatically stops after durationMs.
   */
  #startDiagnosis(durationMs = 5000): void {
    startSchedulerDiagnosis(this.#diagnosisControlState, durationMs);
  }

  /**
   * Stops diagnosis mode and finalizes results.
   */
  #stopDiagnosis(): void {
    stopSchedulerDiagnosis(this.#diagnosisControlState);
  }

  /**
   * Updates the reverse dependency graph (dependents map).
   * For each action that writes to paths this action reads, add this action as a dependent.
   */
  #updateDependents(action: Action, log: ReactivityLog): void {
    const actionId = this.#getActionId(action);
    updateDependentEdgesForLog(this.#dependencyGraphState, action, log);

    // Emit telemetry for dependency updates
    this.runtime.telemetry.submit({
      type: "scheduler.dependencies.update",
      actionId,
      reads: [...log.reads, ...log.shallowReads].map((r) =>
        `${r.space}/${r.id}/${r.path.join("/")}`
      ),
      writes: log.writes.map((w) => `${w.space}/${w.id}/${w.path.join("/")}`),
    });
  }

  //
  // State wiring
  //

  /**
   * Wires the state bundles. Kept explicit here so the field declarations do
   * not read like one large object graph.
   */
  #initializeSchedulerState(): void {
    this.#diagnosisControlState = this.#createDiagnosisControlState();
    this.#writeIndex = this.#createWriteIndex();
    this.#eventPreflightDependencyState = this
      .#createEventPreflightDependencyState();
    this.#dependencyGraphState = this.#createDependencyGraphState();
    this.#dependencyUpdateState = this.#createDependencyUpdateState();
    this.#triggerSubscriptionState = this.#createTriggerSubscriptionState();
    this.#storageNotificationState = this.#createStorageNotificationState();
    this.#pendingPullRunnableState = this.#createPendingPullRunnableState();
    this.#dirtyPullRunnableState = this.#createDirtyPullRunnableState();
    this.#dirtyPullRunnableStateWithDebounce = this
      .#createDirtyPullRunnableStateWithDebounce();
    this.#pullSchedulingState = this.#createPullSchedulingState();
    this.#subscriptionState = this.#createSubscriptionState();
    this.#subscribeActionState = this.#createSubscribeActionState();
    this.#unsubscribeState = this.#createUnsubscribeState();
    this.#settleLoopState = this.#createSettleLoopState();
    this.#executeContinuationState = this.#createExecuteContinuationState();
    this.#eventQueueState = this.#createEventQueueState();
    this.#eventExecutionState = this.#createEventExecutionState();
    this.#actionRunState = this.#createActionRunState();
    this.#graphSnapshotState = this.#createGraphSnapshotState();
  }

  #createDiagnosisControlState(): SchedulerDiagnosisControlState {
    return {
      telemetry: this.runtime.telemetry,
      getDiagnosisEnabled: () => this.#diagnosisEnabled,
      setDiagnosisEnabled: (enabled) => {
        this.#diagnosisEnabled = enabled;
      },
      getDiagnosisTimeout: () => this.#diagnosisTimeout,
      setDiagnosisTimeout: (timeout) => {
        this.#diagnosisTimeout = timeout;
      },
      getDiagnosisStartTime: () => this.#diagnosisStartTime,
      setDiagnosisStartTime: (time) => {
        this.#diagnosisStartTime = time;
      },
      getDiagnosisBusyTime: () => this.#diagnosisBusyTime,
      setDiagnosisBusyTime: (time) => {
        this.#diagnosisBusyTime = time;
      },
      getDiagnosisResolve: () => this.#diagnosisResolve,
      setDiagnosisResolve: (resolve) => {
        this.#diagnosisResolve = resolve;
      },
      diagnosisHistory: this.#diagnosisHistory,
      diagnosisNonIdempotent: this.#diagnosisNonIdempotent,
      causalEdges: this.#causalEdges,
      idempotencyViolations: this.#idempotencyViolations,
      computations: this.#nodes.computations,
      setIdempotencyCheckMode: (enabled) => {
        this.#idempotencyCheckMode = enabled;
      },
      runAction: (action) => this.run(action),
    };
  }

  #createWriteIndex(): SchedulerWriteIndex {
    return new SchedulerWriteIndex(() => this.runtime.scopeKeyIdentity);
  }

  #createEventPreflightDependencyState(): EventPreflightDependencyState {
    return {
      scopeKeyIdentity: () => this.runtime.scopeKeyIdentity,
      getTrace: () => this.#eventPreflightTraceContext,
      nodes: this.#nodes,
      pending: this.#pending,
      reverseDependencies: this.#reverseDependencies,
      dependents: this.#dependents,
      dependencies: this.#dependencies,
      writersByEntity: this.#writeIndex.writersByEntity,
      effects: this.#nodes.effects,
      materializerIndex: this.#materializers,
      triggerIndex: this.#triggerIndex,
      getSchedulingWrites: (target) =>
        this.#writeIndex.getSchedulingWrites(target),
      getActionId: (target) => this.#getActionId(target),
    };
  }

  #createDependencyGraphState(): DependencyGraphState {
    return {
      scopeKeyIdentity: () => this.runtime.scopeKeyIdentity,
      triggerIndex: this.#triggerIndex,
      writersByEntity: this.#writeIndex.writersByEntity,
      dependencies: this.#dependencies,
      dependents: this.#dependents,
      reverseDependencies: this.#reverseDependencies,
      nodes: this.#nodes,
      materializerIndex: this.#materializers,
      getSchedulingWrites: (action) =>
        this.#writeIndex.getSchedulingWrites(action),
    };
  }

  #createDependencyUpdateState(): DependencyUpdateState {
    return {
      writeIndex: this.#writeIndex,
      dependencies: this.#dependencies,
    };
  }

  #createTriggerSubscriptionState(): TriggerSubscriptionState {
    return new SchedulerTriggerSubscriptions({
      triggerIndex: this.#triggerIndex,
      cancels: this.#cancels,
      getActionId: (action) => this.#getActionId(action),
      onTriggerUnsubscribe: (actionId, entityCount) => {
        logger.debug("schedule-unsubscribe", () => [
          `Action: ${actionId}`,
          `Entities: ${entityCount}`,
        ]);
      },
    });
  }

  #createStorageNotificationState(): StorageNotificationState {
    return {
      triggerIndex: this.#triggerIndex,
      nodes: this.#nodes,
      getDiagnosisEnabled: () => this.#diagnosisEnabled,
      getCollectTriggerTrace: () => this.#collectTriggerTrace,
      changeGroupToActionId: this.#changeGroupToActionId,
      recordCausalEdge: (edge) => {
        this.#causalEdges.push(edge);
      },
      actionChangeGroups: this.#actionChangeGroups,
      effects: this.#nodes.effects,
      pending: this.#pending,
      getActionId: (target) => this.#getActionId(target),
      recordCellUpdate: (change) =>
        this.runtime.telemetry.submit({
          type: "cell.update",
          change,
        }),
      recordTriggerTrace: (entry) =>
        recordTriggerTraceState({ triggerTrace: this.#triggerTrace }, entry),
      scheduleWithDebounce: (target) => this.#scheduleWithDebounce(target),
      markInvalid: (target, cause) =>
        this.#markAndScheduleInvalidAction(target, cause),
      isInvalid: (target) => this.#isInvalidAction(target),
      materializerIndex: this.#materializers,
      queueExecution: () => this.queueExecution(),
      isRendererInputSource: (source) =>
        source !== undefined && isRendererInputTx(source),
      holdShapedNotification: (groupKey, itemKey, chargeKey, deliver) =>
        this.holdShapedCellNotification(groupKey, itemKey, chargeKey, deliver),
    };
  }

  #createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification: StorageNotification) => {
        this.#processStorageNotification(notification);
        return { done: false };
      },
    };
  }

  #processStorageNotification(notification: StorageNotification): void {
    processStorageNotification(
      this.#storageNotificationState,
      notification,
    );
  }

  #createPendingPullRunnableState(): PendingPullRunnableState {
    return {
      effects: this.#nodes.effects,
      isDemandedPullComputation: (action) =>
        this.#isDemandedPullComputation(action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        this.#shouldRunFirstPullComputationInDemandContext(action),
    };
  }

  #createDirtyPullRunnableState(): DirtyPullRunnableState {
    return {
      effects: this.#nodes.effects,
      isDemandedPullComputation: (action) =>
        this.#isDemandedPullComputation(action),
      isThrottled: (action) => this.#gates.isThrottled(action),
    };
  }

  #createDirtyPullRunnableStateWithDebounce(): DirtyPullRunnableStateWithDebounce {
    return {
      ...this.#dirtyPullRunnableState,
      isDebouncedComputationWaiting: (action) =>
        this.#isDebouncedComputationWaiting(action),
    };
  }

  #createPullSchedulingState(): PullSchedulingState {
    return {
      nodes: this.#nodes,
      pending: this.#pending,
      effects: this.#nodes.effects,
      materializerIndex: this.#materializers,
      pendingPullRunnableState: this.#pendingPullRunnableState,
      dirtyPullRunnableState: this.#dirtyPullRunnableState,
      dirtyPullRunnableStateWithDebounce: this
        .#dirtyPullRunnableStateWithDebounce,
      isLiveAction: (action) => this.#isLiveAction(action),
      hasActiveDebounceTimer: (action) =>
        this.#gates.hasActiveDebounceTimer(action),
      getNextEligibleRunTime: (action) => this.#getNextEligibleRunTime(action),
      // Engaged only while an initial rehydration is being applied (synchronous
      // post-phase-7). MUST NOT read backgroundTasks: that set holds work such
      // as an event-driven piece start (events.ts) or a sidecar pattern launch,
      // so gating on it would pause all pull scheduling on every one of them.
      // Per-node convergence episode state prevents one exhausted subgraph
      // from releasing idle for unrelated work.
      isConvergenceHoldActive: (action) =>
        this.#isConvergenceHoldActive(action),
      isConvergenceBackoffDeferred: (action) =>
        this.#isConvergenceBackoffDeferred(action),
    };
  }

  #isConvergenceHoldActive(action: Action): boolean {
    return (this.#nodes.get(action)?.gate.convergenceHoldPasses ?? 0) <
      CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES;
  }

  #resetConvergenceHoldPasses(): void {
    for (const record of this.#nodes.nodes()) {
      record.gate.convergenceHoldPasses = 0;
    }
  }

  /**
   * Returns whether `action` is convergence-backoff-deferred, which is so iff
   * its `gate.backoffUntil` is in the future. For an already-ran computation
   * `backoffUntil` is set exclusively by the settle-cap backoff
   * (`planBudgetBackoff()`); the resume initial-run hold that also rides
   * `backoffUntil` only applies to never-ran nodes. Throttle and debounce use
   * their own gate fields, so this cleanly excludes them.
   */
  #isConvergenceBackoffDeferred(action: Action): boolean {
    const backoffUntil = this.#nodes.get(action)?.gate.backoffUntil;
    return backoffUntil !== undefined && backoffUntil > performance.now();
  }

  #createSubscriptionState(): SchedulerSubscriptionState {
    return {
      actionChangeGroups: this.#actionChangeGroups,
      changeGroupToActionId: this.#changeGroupToActionId,
      nodes: this.#nodes,
      dependencyGraphState: this.#dependencyGraphState,
      getIdempotencyCheckMode: () => this.#idempotencyCheckMode,
      queueExecution: () => this.queueExecution(),
      getActionId: (target) => this.#getActionId(target),
      getExecutingAction: () => this.#executingAction,
    };
  }

  #createSubscribeActionState(): SchedulerSubscribeActionState {
    return {
      subscriptionState: this.#subscriptionState,
      dependencyUpdateState: this.#dependencyUpdateState,
      triggerSubscriptionState: this.#triggerSubscriptionState,
      markProvisionalDemand: (record) => this.#markProvisionalDemand(record),
      pending: this.#pending,
      effects: this.#nodes.effects,
      writeIndex: this.#writeIndex,
      adoptGateConfig: (action) => this.#gates.adopt(action),
      setDebounce: (action, ms) => this.setDebounce(action, ms),
      setNoDebounce: (action, optOut) => this.setNoDebounce(action, optOut),
      setThrottle: (action, ms) => this.setThrottle(action, ms),
      getSchedulingWrites: (action) =>
        this.#writeIndex.getSchedulingWrites(action),
      isThrottled: (action) => this.#gates.isThrottled(action),
      isDebouncedComputationWaiting: (action) =>
        this.#isDebouncedComputationWaiting(action),
      markInvalid: (action) => this.#markAndScheduleInvalidAction(action),
      updateDependents: (action, log) => this.#updateDependents(action, log),
      registerWriterDependents: (action, writes) =>
        registerDependentsForWriterSurface(
          this.#dependencyGraphState,
          action,
          writes,
        ),
      queueExecution: () => this.queueExecution(),
      getActionId: (action) => this.#getActionId(action),
      unsubscribe: (action) => this.unsubscribe(action),
      submitSubscribeTelemetry: (event) => {
        this.runtime.telemetry.submit(event);
      },
    };
  }

  #createUnsubscribeState(): SchedulerUnsubscribeActionState {
    return {
      cancels: this.#cancels,
      dependencies: this.#dependencies,
      actionChangeGroups: this.#actionChangeGroups,
      changeGroupToActionId: this.#changeGroupToActionId,
      pending: this.#pending,
      reverseDependencies: this.#reverseDependencies,
      dependents: this.#dependents,
      dependencyGraphState: this.#dependencyGraphState,
      nodes: this.#nodes,
      writeIndex: this.#writeIndex,
      getActionId: (target) => this.#getActionId(target),
      clearInvalid: (target) => this.#clearInvalidAction(target),
      cancelDebounceTimer: (target) => this.#gates.cancelDebounceTimer(target),
      clearComputationDebounceState: (target, targetOptions) =>
        this.#gates.clearComputationDebounceState(target, targetOptions),
      recomputeWakeAfterClear: () => this.#gates.recomputeWakeAfterClear(),
    };
  }

  #createSettleLoopState(): SchedulerSettleLoopState {
    return {
      scopeKeyIdentity: () => this.runtime.scopeKeyIdentity,
      getCollectSettleStats: () => this.#collectSettleStats,
      effects: this.#nodes.effects,
      computations: this.#nodes.computations,
      pending: this.#pending,
      dependencies: this.#dependencies,
      nodes: this.#nodes,
      dependents: this.#dependents,
      filterStats: this.#filterStats,
      materializerIndex: this.#materializers,
      writersByEntity: this.#writeIndex.writersByEntity,
      getSchedulingWrites: (action) =>
        this.#writeIndex.getSchedulingWrites(action),
      getSchedulingWritesMap: () => this.#writeIndex.getSchedulingWritesMap(),
      collectPullIterationSeeds: (seeds) =>
        this.#collectPullIterationSeeds(seeds),
      refreshPassScopedDemand: (demand) => {
        this.#eventPassDemandRefresh?.(demand);
      },
      getActionId: (action) => this.#getActionId(action),
      isThrottled: (action) => this.#gates.isThrottled(action),
      getNextEligibleRunTime: (action) => this.#getNextEligibleRunTime(action),
      isDebouncedComputationWaiting: (action) =>
        this.#isDebouncedComputationWaiting(action),
      clearComputationDebounceState: (action) =>
        this.#gates.clearComputationDebounceState(action),
      isLiveAction: (action) => this.#isLiveAction(action),
      runAction: (action) => this.run(action),
      // Stage C tuning T3: only a serving runtime yields between runs.
      ...(this.#cooperativeYield !== undefined
        ? { yieldBetweenRuns: this.#cooperativeYieldBetweenRuns }
        : {}),
    };
  }

  #createExecuteContinuationState(): ExecuteContinuationState {
    return {
      pullScheduling: this.#pullSchedulingState,
      eventQueue: this.#eventQueue,
      idlePromises: this.#idlePromises,
      consumeRerunAfterCurrentExecute: () => {
        const shouldRerun = this.#rerunAfterCurrentExecute;
        this.#rerunAfterCurrentExecute = false;
        return shouldRerun;
      },
      hasPendingLineageHeadEvent: () => this.#hasPendingLineageHeadEvent(),
      hasLoadParkedHeadEvent: () => this.#hasLoadParkedHeadEvent(),
      scheduleWake: (at) => this.#gates.scheduleWake(at),
      hasWakeTimer: () => this.#gates.hasWakeTimer(),
      setScheduled: (scheduled) => {
        this.#scheduled = scheduled;
      },
      resetSettlingTracker: () => {
        this.#settlingTracker = createSettlingTracker();
      },
      resetConvergenceHoldPasses: () => {
        this.#resetConvergenceHoldPasses();
      },
      setPendingQueueTaskTimer: (timer) => {
        this.#pendingQueueTaskTimer = timer;
      },
      execute: () => this.#execute(),
    };
  }

  #createEventQueueState(): SchedulerEventQueueState {
    return {
      runtime: this.runtime,
      eventHandlers: this.#eventHandlers,
      eventQueue: this.#eventQueue,
      backgroundTasks: this.#backgroundTasks,
      queueExecution: () => this.queueExecution(),
      recordLineageEvent: (originTx, queuedEvent) => {
        this.#lineage.recordEvent(originTx, queuedEvent);
      },
      releaseLineageEvent: (originTx, queuedEvent) => {
        this.#lineage.release(originTx, queuedEvent);
      },
    };
  }

  #createEventExecutionState(): SchedulerEventExecutionState {
    const getEventPreflightTelemetryEnabled = () =>
      this.#eventPreflightTelemetryEnabled;
    return {
      runtime: this.runtime,
      eventQueue: this.#eventQueue,
      backpressure: this.runtime.commitBackpressure,
      collectPendingLoadParkKeys: (event, deps) =>
        this.#collectPendingLoadParkKeys(event, deps),
      capturePendingLoadGenerations: () =>
        this.#capturePendingLoadGenerations(),
      parkHeadEventForLoads: (event, keys) =>
        this.#parkHeadEventForLoads(event, keys),
      isHeadEventLoadParked: (event) => this.#isHeadEventLoadParked(event),
      nodes: this.#nodes,
      pending: this.#pending,
      get eventPreflightTelemetryEnabled() {
        return getEventPreflightTelemetryEnabled();
      },
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getActionId: (target) => this.#getActionId(target),
      getActionTelemetryInfo: (target) =>
        getSchedulerActionTelemetryInfo(target),
      handleError: (error, target) => this.#handleError(error, target),
      queueExecution: () => this.queueExecution(),
      setEventPreflightTraceContext: (trace) => {
        this.#eventPreflightTraceContext = trace;
      },
      collectInvalidUpstreamForLog: (deps, invalidDeps) =>
        this.#collectInvalidUpstreamForLog(
          deps,
          invalidDeps,
        ),
      // The transient-demander preflight (fan-out stage B, review F2):
      // only a serving runtime has fan-out records and served actors, so
      // the OFF arm and a flag-ON client leave this undefined (inert).
      ...(this.runtime.servingPosture
        ? {
          rearmNotCurrentFanOutForActor: (
            deps: ReactivityLog,
            actor: ScopeKeyIdentity,
          ) => this.rearmNotCurrentFanOutForActor(deps, actor),
        }
        : {}),
      setEventPassDemandRefresh: (refresh) => {
        this.#eventPassDemandRefresh = refresh;
      },
      isDebouncedComputationWaiting: (target) =>
        this.#isDebouncedComputationWaiting(target),
      getNextDebounceRunTime: (target) => this.#getNextDebounceRunTime(target),
      getNextEligibleRunTime: (target) => this.#getNextEligibleRunTime(target),
      scheduleWake: (notBefore) => this.#gates.scheduleWake(notBefore),
      lineageStatus: (originTx) => this.#lineage.originStatus(originTx),
      releaseLineageEvent: (originTx, queuedEvent) => {
        this.#lineage.release(originTx, queuedEvent);
      },
      dropEvent: (queuedEvent, reason) => {
        this.#dropEvent(queuedEvent, reason);
      },
      recordLineageEvent: (originTx, queuedEvent) => {
        this.#lineage.recordEvent(originTx, queuedEvent);
      },
      getOriginLocalSeq: (originTx, targetSpace) =>
        getCommitLocalSeq(originTx.tx, targetSpace),
      snapshotEventPreflightTraceContext: (trace) =>
        snapshotEventPreflightTraceContext(
          this.#eventPreflightDependencyState,
          trace,
        ),
    };
  }

  /** Helper for an unavailable run, which retains reads and its prior writes. */
  #parkLocalRead(action: Action, attempted: ReactivityLog): void {
    const previous = this.#dependencies.get(action);
    const log = {
      reads: [...(previous?.reads ?? []), ...attempted.reads],
      shallowReads: [
        ...(previous?.shallowReads ?? []),
        ...attempted.shallowReads,
      ],
      writes: previous?.writes ?? [],
    };
    this.resubscribe(action, log);
    const record = this.#nodes.get(action);
    if (record === undefined) return;
    const cancels: (() => void)[] = [];
    for (const space of new Set(log.reads.map((read) => read.space))) {
      const replica = this.runtime.storageManager.open(space).replica;
      const cancel = replica.subscribeLocalCoverage?.((addresses) => {
        if (
          !log.reads.some((read) =>
            read.space === space &&
            addresses.some((address) =>
              address.id === read.id &&
              (address.scope ?? "space") === (read.scope ?? "space")
            )
          )
        ) return;
        this.#markActionInvalid(action);
        this.queueExecution();
      });
      if (cancel !== undefined) cancels.push(cancel);
    }
    record.cancelLocalReadWake = () => cancels.forEach((cancel) => cancel());
  }

  #createActionRunState(): SchedulerActionRunState {
    return {
      runtime: this.runtime,
      actionChangeGroups: this.#actionChangeGroups,
      actionTimingState: this.#actionTimingState,
      getReadStatsEnabled: () => this.#collectReadStats,
      getReadAttemptAccountingEnabled: () => this.#readAttemptAccountingEnabled,
      retries: this.#retries,
      offBudgetRetries: this.#offBudgetRetries,
      pending: this.#pending,
      actionRunTrace: this.#actionRunTrace,
      nodes: this.#nodes,
      diagnosisHistory: this.#diagnosisHistory,
      diagnosisNonIdempotent: this.#diagnosisNonIdempotent,
      idempotencyViolations: this.#idempotencyViolations,
      getRunningPromise: () => this.runningPromise,
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getCollectActionRunTrace: () => this.#collectActionRunTrace,
      getDiagnosisEnabled: () => this.#diagnosisEnabled,
      getIdempotencyCheckMode: () => this.#idempotencyCheckMode,
      getActionId: (target) => this.#getActionId(target),
      getActionTelemetryInfo: (target) =>
        getSchedulerActionTelemetryInfo(target),
      getSchedulingWrites: (target) =>
        this.#writeIndex.getSchedulingWrites(target),
      getMaterializerWriteEnvelopes: (target) =>
        this.#materializers.getMaterializerWriteEnvelopes(target),
      getDebounce: (target) => this.#gates.getDebounce(target),
      getNoDebounce: (target) => this.#gates.getNoDebounce(target),
      getThrottle: (target) => this.#gates.getThrottle(target),
      maybeAutoDebounce: (target) => this.#maybeAutoDebounce(target),
      markActionHasRun: (target) => this.#gates.markActionHasRun(target),
      markNodeHasRun: (target) => this.#markNodeHasRun(target),
      handleError: (error, target) => this.#handleError(error, target),
      resubscribe: (target, log) => this.resubscribe(target, log),
      markInvalid: (target, options) =>
        this.#markActionInvalid(target, undefined, options),
      isLiveAction: (target) => this.#isLiveAction(target),
      isDisposed: () => this.#disposed,
      parkLocalRead: (target, log) => this.#parkLocalRead(target, log),
      queueExecution: () => this.queueExecution(),
      setExecutingAction: (target, targetActionId) => {
        this.#executingAction = target;
        this.#currentActionId = targetActionId;
      },
      clearExecutingAction: () => {
        this.#executingAction = null;
        this.#currentActionId = undefined;
      },
    };
  }

  #createGraphSnapshotState(): SchedulerGraphSnapshotState {
    return {
      scopeKeyIdentity: () => this.runtime.scopeKeyIdentity,
      effects: this.#nodes.effects,
      computations: this.#nodes.computations,
      pending: this.#pending,
      dependencies: this.#dependencies,
      dependents: this.#dependents,
      nodes: this.#nodes,
      actionStats: this.#actionStats,
      getDebounce: (action) => this.#gates.getDebounce(action),
      getThrottle: (action) => this.#gates.getThrottle(action),
      hasActiveDebounceTimer: (action) =>
        this.#gates.hasActiveDebounceTimer(action),
      getActionId: (action) => this.#getActionId(action),
      getSchedulingWrites: (action) =>
        this.#writeIndex.getSchedulingWrites(action),
      getNextDebounceRunTime: (action) => this.#getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) => this.#getNextEligibleRunTime(action),
      isDemandedPullComputation: (action) =>
        this.#isDemandedPullComputation(action),
      isLiveEffect: (action) => this.#isLiveEffect(action),
      isPullDemandRootEffect: (action) => this.#isPullDemandRootEffect(action),
      getPatternIdentity: (action) => {
        const annotated = action as Partial<TelemetryAnnotations>;
        return annotated.pattern
          ? this.runtime.patternManager.getArtifactEntryRef(annotated.pattern)
          : undefined;
      },
    };
  }

  //
  // Private forwarding helpers
  //

  /**
   * Gets a stable identifier for an action based on its source location.
   * Prefers .src (set as backup) over .name, falls back to a generated ID.
   * This ID is used for stats tracking to persist across action recreation.
   */
  #getActionId(action: Action | EventHandler): string {
    return getSchedulerActionId(this.#actionIdentityState, action);
  }

  #isDemandedPullComputation(action: Action): boolean {
    const record = this.#nodes.get(action);
    return record?.kind === "computation" &&
      isLive(this.#dependencyGraphState, record);
  }

  #shouldRunFirstPullComputationInDemandContext(
    action: Action,
  ): boolean {
    const record = this.#nodes.get(action);
    return record?.kind === "computation" &&
      record.status === "never-ran" &&
      record.provisionalDemand;
  }

  #isLiveEffect(action: Action): boolean {
    return this.#nodes.get(action)?.kind === "effect";
  }

  #isLiveAction(action: Action): boolean {
    const record = this.#nodes.get(action);
    return record !== undefined && isLive(this.#dependencyGraphState, record);
  }

  #isPullDemandRootEffect(action: Action): boolean {
    const record = this.#nodes.get(action);
    return record?.kind === "effect" &&
      (this.#writeIndex.getSchedulingWrites(action)?.length ?? 0) === 0;
  }

  #isInvalidAction(action: Action): boolean {
    const record = this.#nodes.get(action);
    return record?.status === "invalid" || record?.status === "never-ran";
  }

  #getNextEligibleRunTime(action: Action): number | undefined {
    return this.#gates.getNextEligibleRunTime(action);
  }

  #markActionInvalid(
    action: Action,
    cause?: IMemorySpaceAddress,
    options?: MarkInvalidOptions,
  ): void {
    const record = this.#nodes.get(action);
    if (!record) return;
    markInvalidRecord(this.#nodes, action, cause, options);
    // A scheduler-owed retry (`options.retry`: a refused run re-queued after
    // its catch-up, or an empty rejection without an accepted result or live
    // demander) is not an input change — it runs past the node's
    // freshness gates, and any armed readiness is released (§8.3).
    if (options?.retry) {
      this.#gates.releaseForRetry(action);
      return;
    }
    // Trailing computation debounce re-arms when no retry is owed
    // (§8.1: debounceReadyAt resets while gated). Arming here — in the one
    // invalid-setter — covers every path (channel, registration), so gate
    // QUERIES stay side-effect-free.
    if (record.kind === "computation") {
      this.#gates.onInvalidated(
        record,
        performance.now(),
        this.#createDebouncedComputationContext(),
      );
    }
  }

  #clearInvalidAction(action: Action): void {
    const record = this.#nodes.get(action);
    if (!record) return;
    if (record.status === "invalid") {
      this.#nodes.setStatus(action, "clean");
    }
    record.invalidCauses.clear();
  }

  #markAndScheduleInvalidAction(
    action: Action,
    cause?: IMemorySpaceAddress,
    options?: Pick<MarkInvalidOptions, "retry">,
  ): void {
    this.#markActionInvalid(action, cause, options);

    if (
      this.#nodes.effects.has(action) &&
      this.#gates.getDebounce(action)
    ) {
      this.#scheduleWithDebounce(action);
      return;
    }
    if (
      this.#isLiveAction(action) ||
      this.#materializers.isMaterializer(action) ||
      this.#pending.has(action)
    ) {
      this.queueExecution();
    }
  }

  #collectInvalidUpstreamForLog(
    log: ReactivityLog,
    workSet: Set<Action>,
  ): boolean {
    return collectInvalidUpstreamForLogState(
      this.#eventPreflightDependencyState,
      log,
      workSet,
    );
  }

  #collectPendingLoadParkKeys(
    event: QueuedEvent,
    log: ReactivityLog,
  ): string[] {
    const pendingLoadAddresses =
      this.runtime.storageManager.pendingLoadAddresses?.() ?? [];
    const keys = collectPendingLoadParkKeysState(
      this.#eventPreflightDependencyState,
      pendingLoadAddresses,
      log,
    );
    if (keys.length === 0) return keys;
    const history = this.#headEventLoadParkHistory;
    if (!history || history.eventId !== event.id) return keys;
    return keys.filter((key) => {
      const currentGeneration =
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0;
      const settledGeneration = history.generations.get(key);
      if (settledGeneration === undefined) return true;
      if (settledGeneration === currentGeneration) return false;
      return this.#preflightPendingLoadGenerations.get(key) ===
        currentGeneration;
    });
  }

  #capturePendingLoadGenerations(): void {
    this.#preflightPendingLoadGenerations.clear();
    for (
      const address of this.runtime.storageManager.pendingLoadAddresses?.() ??
        []
    ) {
      const key = entityKey(address, this.runtime.scopeKeyIdentity);
      this.#preflightPendingLoadGenerations.set(
        key,
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0,
      );
    }
  }

  #parkHeadEventForLoads(
    event: QueuedEvent,
    keys: readonly string[],
  ): void {
    if (this.#headEventLoadPark?.eventId === event.id) return;
    const generations = new Map(
      keys.map((key) => [
        key,
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0,
      ]),
    );
    this.#headEventLoadPark = { eventId: event.id, keys, generations };
    logger.debug("event-load-park", () => [
      `event ${event.id} parks on ${keys.length} loading document(s)`,
      keys,
    ]);
    const settled = this.runtime.storageManager.loadsSettled?.(keys) ??
      Promise.resolve();
    settled.then(
      () => this.#releaseHeadEventLoadPark(event.id),
      (error) => this.#failHeadEventLoadPark(event, error),
    );
  }

  #releaseHeadEventLoadPark(eventId: string): void {
    if (this.#headEventLoadPark?.eventId !== eventId) return;
    if (this.#headEventLoadParkHistory?.eventId !== eventId) {
      this.#headEventLoadParkHistory = { eventId, generations: new Map() };
    }
    for (const [key, generation] of this.#headEventLoadPark.generations) {
      this.#headEventLoadParkHistory.generations.set(key, generation);
    }
    this.#headEventLoadPark = null;
    this.queueExecution();
  }

  /**
   * The head event's required replica load FAILED.
   *
   * events.md §5's T3 drop predicate is "no runnable handler", never
   * "the run raced" — and a load failure is the second: the doc the
   * closure reads EXISTS durably, only the read path failed. The live
   * shape (verification-coverage.md's OW45 residue member, store-proven
   * on CI run 32929764230) is a serving session revoked by the genesis
   * ACL landing after activation — `unauthorized` on a cross-space read
   * of a doc the server itself wrote one second earlier. Sealing §5's
   * dropped-event notice for that DISCHARGED at-least-once on a healthy
   * trusted user action and advanced the watermark past it, so nothing
   * ever re-ran it: the click was silently lost.
   *
   * CORRECTED 2026-08-26. This docstring used to add "healing by design
   * on the next mount", and that was FALSE: nothing remounted. Run
   * 33021643751 (the same board's shards 2 and 6) measured 350 deferrals
   * over 5m47s off one revoked session, zero successful loads — the
   * deferral below waiting for a heal that did not exist, exactly as
   * `storage/rejection.ts`'s SessionError note had said ("the
   * convergence argument is sound, only the remount is missing"). The
   * remount now exists: an admitted commit touching the space's ACL doc
   * re-arms the session (storage/v2.ts `consumeOwedSessionRemount`,
   * triggered by executor/host.ts), so the deferral's convergence
   * argument holds. What has NOT changed is the persistent-failure
   * posture spelled out below: a load whose ACL never changes — or whose
   * re-open is denied — defers indefinitely, which is OW54's territory.
   *
   * A SERVED event therefore DEFERS — no consequence written, the
   * durable entry left pending and UNCONSEQUENCED, a later drain
   * re-delivering it. The deferral carries the drain's arrival-order
   * BARRIER with it (events.md §2, mirroring the sidecar-sync-failure
   * arm): every later-arrived durable served entry behind it IN THE
   * SAME SPACE defers too, or a later arrival's consequence lands ahead
   * of an earlier one. Two exclusions, both deliberate: cross-space
   * queue neighbours (§2's order is per-space) and LT1 in-process
   * copies (`served` with no `streamEntry`), which have no durable
   * entry to re-drain and are a running event's same-wave cascade
   * children rather than later arrivals.
   *
   * Client-side (no `served`) there is no durable entry to re-drain, so
   * the drop keeps today's shape — the same split events.ts makes for a
   * piece-load failure.
   */
  #failHeadEventLoadPark(event: QueuedEvent, error: unknown): void {
    if (this.#headEventLoadPark?.eventId !== event.id) return;
    const keys = this.#headEventLoadPark.keys.join(", ");
    this.#headEventLoadPark = null;
    this.#headEventLoadParkHistory = null;
    const detail = error instanceof Error ? error.message : String(error);
    const failure = error instanceof ReplicaLoadFailureError ? error.failure : {
      failureClass: "unknown" as const,
      recoveryEpoch: "untyped",
      permanentEvidence: false,
    };
    if (event.served === undefined) {
      this.#dropEvent(
        event,
        `Event dropped: required replica load failed before dispatch (${detail})`,
      );
      this.queueExecution();
      return;
    }
    // The head's debug record names the failing doc keys and error;
    // `events.loadParkDeferrals` counts every head and barrier deferral, while
    // the durable checkpoint and terminal attention surface persistent failure.
    this.#dropEvent(
      event,
      `Event deferred: required replica load failed before dispatch ` +
        `(${keys}: ${detail}); the entry stays pending and a later drain ` +
        `re-delivers it`,
      {
        servedKind: "deferred",
        quiet: true,
        servedOutcome: {
          kind: "deferred",
          cause: "load-park",
          role: "failed-head",
          failure,
        },
      },
    );
    for (const later of [...this.#eventQueue]) {
      if (later.eventLink.space !== event.eventLink.space) continue;
      if (later.served?.streamEntry === undefined) continue;
      this.#dropEvent(
        later,
        `Event deferred: held behind ${event.id}, whose required replica ` +
          `load failed before dispatch (${keys}); later-arrived events wait ` +
          `behind it`,
        {
          servedKind: "deferred",
          quiet: true,
          servedOutcome: {
            kind: "deferred",
            cause: "arrival-barrier",
            blockedBy: event.id,
          },
        },
      );
    }
    this.queueExecution();
  }

  #dropEvent(
    event: QueuedEvent,
    reason: string,
    options: {
      quiet?: boolean;

      /** Defaults to the terminal `dropped` arm. `deferred` leaves the
       * durable entry UNCONSEQUENCED for a later drain (events.md §5);
       * only meaningful for a served event. */
      servedKind?: "dropped" | "deferred";

      servedOutcome?: ServedEventFailureOutcome;
    } = {},
  ): void {
    if (this.#headEventLoadPark?.eventId === event.id) {
      this.#headEventLoadPark = null;
    }
    if (this.#headEventLoadParkHistory?.eventId === event.id) {
      this.#headEventLoadParkHistory = null;
    }
    dropQueuedEvent(
      {
        runtime: this.runtime,
        eventQueue: this.#eventQueue,
        releaseLineageEvent: (originTx, queuedEvent) => {
          this.#lineage.release(originTx, queuedEvent);
        },
      },
      event,
      reason,
      options.servedKind ?? "dropped",
      options,
    );
  }

  /**
   * Remove every QUEUED event matching `predicate` — queued, held at the
   * head for a load, or mid-presync at the head, never one whose
   * dispatch has shifted it off the queue — through the pre-dispatch
   * drop chokepoint (`dropQueuedEvent`: lineage released, the final-
   * outcome guard honored, a head dispatch parked in presync bails when
   * it finds itself no longer at the head). Returns how many were
   * removed. Server-execution v2 stage C build W3, (α1): the serving
   * loop calls this at its flush-deadline decision to purge the LT1
   * in-process leftovers (`served !== undefined && served.streamEntry
   * === undefined`) whose wave is closing — the durable entry is the
   * truth and the next drain re-runs it WITH a `streamEntry`
   * (events.md §4). Quiet: the purge is routine and counted
   * (`events.lt1LeftoversPurged`), not a dropped-event warning. The OFF
   * arm never calls it.
   */
  purgeQueuedEvents(
    predicate: (event: QueuedEvent) => boolean,
    reason: string,
  ): number {
    const matches = this.#eventQueue.filter(predicate);
    for (const event of matches) {
      this.#dropEvent(event, reason, { quiet: true });
    }
    return matches.length;
  }

  #isHeadEventLoadParked(event: QueuedEvent): boolean {
    return this.#headEventLoadPark?.eventId === event.id;
  }

  #hasLoadParkedHeadEvent(): boolean {
    const head = this.#eventQueue[0];
    return head !== undefined && this.#headEventLoadPark?.eventId === head.id;
  }

  #canAutomaticallyDebounce(action: Action): boolean {
    return this.#gates.canAutomaticallyDebounce(action, {
      effects: this.#nodes.effects,
    });
  }

  #collectPullIterationSeeds(workSet: Set<Action>): void {
    collectPullIterationSeedsState(this.#pullSchedulingState, workSet);
  }

  #hasRunnablePullWork(): boolean {
    return hasRunnablePullWorkState(this.#pullSchedulingState);
  }

  #hasIdleBlockingDeferredPullWork(): boolean {
    return hasIdleBlockingDeferredPullWorkState(this.#pullSchedulingState);
  }

  #clearBackoffForCleanNodes(): void {
    let clearedDeadline = false;
    for (const record of this.#nodes.nodes()) {
      if (record.status === "clean") {
        clearedDeadline = this.#clearNodeBackoff(record) || clearedDeadline;
      }
    }
    if (clearedDeadline) this.#gates.recomputeWakeAfterClear();
  }

  #clearNodeBackoff(record: SchedulerNode): boolean {
    return this.#gates.clearBackoff(record);
  }

  #hasPendingLineageHeadEvent(): boolean {
    const head = this.#eventQueue[0];
    if (head?.originTx === undefined) return false;
    if (this.#lineage.originStatus(head.originTx) !== "pending") return false;
    return getCommitLocalSeq(head.originTx.tx, head.eventLink.space) ===
      undefined;
  }

  #updateMaterializerRegistration(action: Action): void {
    const record = this.#nodes.get(action);
    const wasLive = record ? isLive(this.#dependencyGraphState, record) : false;
    this.#materializers.register(
      action,
      (action as Partial<TelemetryAnnotations>).materializerWriteEnvelopes,
    );
    this.runtime.telemetry.submit({
      type: "scheduler.materializer.register",
      actionId: this.#getActionId(action),
      writes: (this.#materializers.getMaterializerWriteEnvelopes(action) ?? [])
        .map((w) => `${w.space}/${w.id}/${w.path.join("/")}`),
    });
    notifyNodeLivenessChange(this.#dependencyGraphState, action, wasLive);
  }

  #markProvisionalDemand(record: SchedulerNode): void {
    setNodeProvisionalDemand(
      this.#dependencyGraphState,
      record,
      true,
      this.#activePassId,
    );
    if (this.#activePassId !== undefined) {
      this.#provisionalDemandThisPass.add(record);
    }
  }

  #markNodeHasRun(action: Action): void {
    const record = this.#nodes.get(action);
    if (!record) return;

    if (record.status === "never-ran") {
      this.#nodes.setStatus(action, "clean");
    }

    if (
      record.provisionalDemand &&
      (record.provisionalDemandPass === undefined ||
        this.#passCounter > record.provisionalDemandPass)
    ) {
      setNodeProvisionalDemand(this.#dependencyGraphState, record, false);
    }
  }

  #clearProvisionalDemandAtPassEnd(): void {
    const passId = this.#activePassId;
    if (passId === undefined) return;

    for (const record of this.#provisionalDemandThisPass) {
      if (
        record.provisionalDemand &&
        record.provisionalDemandPass === passId &&
        record.status !== "never-ran"
      ) {
        setNodeProvisionalDemand(this.#dependencyGraphState, record, false);
      }
    }
    this.#provisionalDemandThisPass.clear();
  }

  #getNextDebounceRunTime(action: Action): number | undefined {
    // Same context as the waiting/schedule paths — the planner must agree
    // with them on the first-run debounce gate (shouldDebounceFirstRun), or a
    // scheduled debounce has no wake time.
    return this.#gates.getNextDebounceRunTime(
      action,
      this.#createDebouncedComputationContext(),
    );
  }

  #isDebouncedComputationWaiting(action: Action): boolean {
    return this.#gates.isDebouncedComputationWaiting(
      action,
      this.#createDebouncedComputationContext(),
    );
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  #scheduleWithDebounce(action: Action): void {
    this.#gates.scheduleWithDebounce(action, {
      pending: this.#pending,
      queueExecution: () => this.queueExecution(),
      logDebounce: (message) =>
        logger.debug("schedule-debounce", () => [message]),
    });
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  #maybeAutoDebounce(action: Action): void {
    const update = this.#gates.maybeAutoDebounce(action, {
      canAutomaticallyDebounce: (candidate) =>
        this.#canAutomaticallyDebounce(candidate),
    });
    if (update) {
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${update.actionId} ` +
        `auto-debounced (avg ${
          update.averageTime.toFixed(1)
        }ms >= ${update.thresholdMs}ms)`,
      ]);
    }
  }

  #createDebouncedComputationContext() {
    return {
      computations: this.#nodes.computations,
      effects: this.#nodes.effects,
      isInvalid: (target: Action) => this.#isInvalidAction(target),
      pending: this.#pending,
      queueExecution: () => this.queueExecution(),
      logDebounce: (message: string) =>
        logger.debug("schedule-debounce", () => [message]),
      shouldDebounceFirstRun: (target: Action) => {
        const record = this.#nodes.get(target);
        return record?.provisionalDemand === true &&
          record.status === "never-ran";
      },
    };
  }
}
