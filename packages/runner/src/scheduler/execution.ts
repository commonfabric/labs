import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  PASS_RUN_BUDGET,
} from "./constants.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type {
  Action,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SpaceScopeAndURI,
} from "./types.ts";
import { assessPullWork, type PullSchedulingState } from "./work-oracle.ts";

export interface SettlingTracker {
  windowStart: number;
  busyTime: number;
  lastExecuteStart: number;
  isExecuting: boolean;
  nonSettlingDetected: boolean;
}

export function createSettlingTracker(): SettlingTracker {
  return {
    windowStart: 0,
    busyTime: 0,
    lastExecuteStart: 0,
    isExecuting: false,
    nonSettlingDetected: false,
  };
}

export function markExecuteStart(
  tracker: SettlingTracker,
  now = performance.now(),
): void {
  tracker.lastExecuteStart = now;
  tracker.isExecuting = true;
  if (tracker.windowStart === 0) {
    tracker.windowStart = now;
  }
}

export interface ExecuteEndUpdate {
  diagnosisBusyTimeMs: number;
  nonSettlingTelemetry?: {
    busyTime: number;
    windowDuration: number;
    busyRatio: number;
  };
}

export function recordExecuteEnd(
  tracker: SettlingTracker,
  now = performance.now(),
): ExecuteEndUpdate {
  const elapsed = now - tracker.lastExecuteStart;
  tracker.busyTime += elapsed;
  tracker.isExecuting = false;

  let nonSettlingTelemetry: ExecuteEndUpdate["nonSettlingTelemetry"];
  const windowDuration = now - tracker.windowStart;
  if (windowDuration > 5000) {
    const busyRatio = tracker.busyTime / windowDuration;
    if (
      busyRatio > 0.3 &&
      tracker.busyTime > 1000 &&
      !tracker.nonSettlingDetected
    ) {
      tracker.nonSettlingDetected = true;
      nonSettlingTelemetry = {
        busyTime: tracker.busyTime,
        windowDuration,
        busyRatio,
      };
    }
  }

  // Slide the window if it exceeds 10s without idle.
  if (windowDuration > 10000) {
    tracker.windowStart = now;
    tracker.busyTime = tracker.busyTime / 2; // Rolling average
  }

  return {
    diagnosisBusyTimeMs: elapsed,
    ...(nonSettlingTelemetry ? { nonSettlingTelemetry } : {}),
  };
}

/**
 * Summarizes the tracker's current busy window without touching its state, so
 * a caller can report every non-settling episode rather than only the first.
 */
export function summarizeNonSettlingWindow(
  tracker: SettlingTracker,
  now = performance.now(),
): NonNullable<ExecuteEndUpdate["nonSettlingTelemetry"]> {
  const windowStart = tracker.windowStart || now;
  const inFlightBusyTime = tracker.isExecuting
    ? Math.max(0, now - tracker.lastExecuteStart)
    : 0;
  const busyTime = tracker.busyTime + inFlightBusyTime;
  const windowDuration = Math.max(1, now - windowStart);

  return {
    busyTime,
    windowDuration,
    busyRatio: Math.min(1, busyTime / windowDuration),
  };
}

/**
 * Latches the tracker's non-settling flag, returning the window summary for the
 * episode that set it and `undefined` for every episode after it. The flag
 * lives on the tracker, which the scheduler replaces when a continuation
 * begins, so the latch spans a run of settle passes rather than the runtime.
 */
export function markNonSettlingEpisode(
  tracker: SettlingTracker,
  now = performance.now(),
): ExecuteEndUpdate["nonSettlingTelemetry"] | undefined {
  if (tracker.nonSettlingDetected) return undefined;

  const summary = summarizeNonSettlingWindow(tracker, now);
  tracker.nonSettlingDetected = true;
  return summary;
}

export function buildPullInitialSeeds(state: {
  readonly eventBlockingDeps: Iterable<Action>;
}): Set<Action> {
  const initialSeeds = new Set<Action>();

  for (const action of state.eventBlockingDeps) {
    initialSeeds.add(action);
  }

  return initialSeeds;
}

export type SchedulerSettleResult = {
  settledEarly: boolean;
  maxSettleIterations: number;
  backoffApplied: boolean;
  backoffActionCount: number;

  /** Actions deferred by convergence backoff in this settle pass. */
  backoffActions: readonly Action[];

  backoffUntil?: number;

  /** Iterations that actually ran work (excludes the final settled check). */
  iterationsRun: number;

  /** Wall-clock of the settle loop, measured unconditionally. */
  settleDurationMs: number;

  /** Number of actions in the final non-empty settle work set. */
  workSetSize: number;

  settleStats?: SettleStats;
};

export interface SchedulerSettleLoopState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly getCollectSettleStats: () => boolean;
  readonly effects: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly nodes: NodeRegistry;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly filterStats: { filtered: number; executed: number };
  readonly materializerIndex: MaterializerIndexState;
  readonly writersByEntity: ReadonlyMap<SpaceScopeAndURI, Set<Action>>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getSchedulingWritesMap: () => WeakMap<
    Action,
    IMemorySpaceAddress[]
  >;
  readonly collectPullIterationSeeds: (seeds: Set<Action>) => void;

  /** Refresh transient demand such as a head event's current invalid closure. */
  readonly refreshPassScopedDemand?: (demand: Set<Action>) => void;

  readonly getActionId: (action: Action) => string;
  readonly isThrottled: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly isLiveAction: (action: Action) => boolean;
  readonly runAction: (action: Action) => Promise<unknown>;

  /** The serving posture's cooperative macrotask yield between runs
   * (server-execution v2 stage C tuning T3, cooperative-yield.ts):
   * returns a promise to await when the current slice is spent, else
   * undefined. Installed only on a serving runtime — absent (inert) on
   * the OFF arm and on flag-ON clients. */
  readonly yieldBetweenRuns?: () => Promise<void> | undefined;
}

export function recordSettleActionRun(
  state: SchedulerSettleLoopState,
  fn: Action,
): void {
  const record = state.nodes.get(fn);
  if (record) {
    record.passRuns++;
  }
}

export function summarizeSettleIteration(state: {
  readonly workSetSize: number;
  readonly order: readonly Action[];
  readonly actionsRun: number;
  readonly durationMs: number;
  readonly effects: ReadonlySet<Action>;
  readonly getActionId: (action: Action) => string;
  readonly maxActions?: number;
}): SettleIterationStats {
  const maxActions = state.maxActions ?? 30;
  const actions: SettleIterationStats["actions"] = [];
  for (const action of state.order) {
    actions.push({
      id: state.getActionId(action),
      type: state.effects.has(action) ? "effect" : "computation",
    });
    if (actions.length >= maxActions) break;
  }

  return {
    workSetSize: state.workSetSize,
    orderSize: state.order.length,
    actionsRun: state.actionsRun,
    actions,
    durationMs: state.durationMs,
  };
}

export function summarizeSettleRun(state: {
  readonly iterations: SettleIterationStats[];
  readonly totalDurationMs: number;
  readonly settledEarly: boolean;
  readonly initialSeedCount: number;
}): SettleStats {
  return {
    iterations: state.iterations,
    totalDurationMs: state.totalDurationMs,
    settledEarly: state.settledEarly,
    initialSeedCount: state.initialSeedCount,
  };
}

export function pushBoundedHistory<T>(
  history: T[],
  entry: T,
  maxLength: number,
): void {
  history.push(entry);
  if (history.length > maxLength) {
    history.shift();
  }
}

export interface BudgetBackoffPlan {
  readonly actions: Action[];
  readonly backoffUntil?: number;
}

export function planBudgetBackoff(state: {
  readonly workSet: ReadonlySet<Action>;

  /** Transient demand roots, such as a head event's preflight closure. */
  readonly passScopedDemand?: ReadonlySet<Action>;

  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly isLiveAction: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly reason: "iteration-cap" | "pass-budget";
  readonly now?: number;
}): BudgetBackoffPlan {
  const now = state.now ?? performance.now();
  const actions: Action[] = [];
  let backoffUntil: number | undefined;

  for (const action of state.workSet) {
    const record = state.nodes.get(action);
    if (!record || !isBudgetBackoffCandidate(state, record, now)) {
      continue;
    }

    const delayMs = nextBackoffDelayMs(record);
    record.gate.backoffStreak++;
    record.gate.convergenceHoldPasses++;
    record.gate.backoffUntil = now + delayMs;
    state.nodes.noteBackoff(record);
    actions.push(action);
    backoffUntil = minDefined(backoffUntil, record.gate.backoffUntil);
  }

  return {
    actions,
    ...(backoffUntil !== undefined ? { backoffUntil } : {}),
  };
}

function isBudgetBackoffCandidate(
  state: {
    readonly pending: ReadonlySet<Action>;
    readonly passScopedDemand?: ReadonlySet<Action>;
    readonly isLiveAction: (action: Action) => boolean;
    readonly getNextEligibleRunTime: (action: Action) => number | undefined;
    readonly isDebouncedComputationWaiting: (action: Action) => boolean;
    readonly reason: "iteration-cap" | "pass-budget";
  },
  record: SchedulerNode,
  now: number,
): boolean {
  if (!isInvalidActionRecord(record)) return false;
  if (
    !state.isLiveAction(record.action) &&
    !state.pending.has(record.action) &&
    state.passScopedDemand?.has(record.action) !== true
  ) {
    return false;
  }
  // NOTE(scheduler-v2): the iteration-cap backoff is NOT merely a perf pause
  // for deep chains — it is the escape valve that lets idle() resolve when a
  // live subgraph has not settled within MAX_ITERS. `backoffUntil` feeds
  // getNextEligibleRunTime, which defers the action out of hasDirtyPullWork
  // (idle resolves) and schedules a retry wake. Gating iteration-cap backoff
  // on cycle evidence (as Codex P2 #4103 suggested) removes that valve for
  // any sub-budget chain that repeatedly hits the cap under load — idle then
  // never resolves (observed: rapid-notebook-create + reload integration
  // tests timed out on `runtime:idle`). Kept as-is; the pass-budget gate only
  // applies to the pass-budget reason.
  if (state.reason === "pass-budget" && record.passRuns < PASS_RUN_BUDGET) {
    return false;
  }
  if (state.isDebouncedComputationWaiting(record.action)) return false;

  const nextEligibleAt = state.getNextEligibleRunTime(record.action);
  if (nextEligibleAt !== undefined && nextEligibleAt > now) {
    return false;
  }
  return true;
}

function nextBackoffDelayMs(record: SchedulerNode): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** record.gate.backoffStreak,
    BACKOFF_MAX_MS,
  );
}

export interface ExecuteContinuationPlan {
  hasRunnablePullWork: boolean;
  hasImmediateRerunRequest: boolean;
  hasQueuedEventReadyNow: boolean;
  hasParkedHeadEvent: boolean;
  nextDirtyPullRunAt?: number;
  nextDirtyPullRunWaitsForIdle: boolean;
  shouldQueueAnotherTick: boolean;
}

export function planEventInvalidDependencyScheduling(state: {
  readonly invalidDeps: Iterable<Action>;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly now?: number;
}): {
  runnableDeps: Action[];
  nextEligibleAt?: number;
} {
  let nextEligibleAt: number | undefined;
  const runnableDeps: Action[] = [];

  for (const dep of state.invalidDeps) {
    if (state.isDebouncedComputationWaiting(dep)) {
      const depNextDebounceAt = state.getNextDebounceRunTime(dep);
      if (depNextDebounceAt !== undefined) {
        nextEligibleAt = minDefined(nextEligibleAt, depNextDebounceAt);
        continue;
      }
    }

    const depNextEligibleAt = state.getNextEligibleRunTime(dep);
    if (
      depNextEligibleAt !== undefined &&
      depNextEligibleAt > (state.now ?? performance.now())
    ) {
      nextEligibleAt = minDefined(nextEligibleAt, depNextEligibleAt);
      continue;
    }

    runnableDeps.push(dep);
  }

  return {
    runnableDeps,
    ...(nextEligibleAt !== undefined ? { nextEligibleAt } : {}),
  };
}

export function planPullExecuteContinuation(state: {
  readonly pull: PullSchedulingState;
  readonly shouldRerunAfterCurrentExecute: boolean;
  readonly hasQueuedEventReadyNow: boolean;
  readonly hasParkedHeadEvent: boolean;
}): ExecuteContinuationPlan {
  const assessment = assessPullWork(state.pull);

  const hasImmediateRerunRequest = state.shouldRerunAfterCurrentExecute &&
    assessment.nextWakeAt === undefined;
  const shouldQueueAnotherTick = hasImmediateRerunRequest ||
    assessment.runnableNow ||
    state.hasQueuedEventReadyNow;

  return {
    hasRunnablePullWork: assessment.runnableNow,
    hasImmediateRerunRequest,
    hasQueuedEventReadyNow: state.hasQueuedEventReadyNow,
    hasParkedHeadEvent: state.hasParkedHeadEvent,
    ...(assessment.nextWakeAt !== undefined
      ? { nextDirtyPullRunAt: assessment.nextWakeAt }
      : {}),
    nextDirtyPullRunWaitsForIdle: assessment.deferredIdleBlocking,
    shouldQueueAnotherTick,
  };
}

function isInvalidActionRecord(record: SchedulerNode): boolean {
  return record.status === "invalid" || record.status === "never-ran";
}

function minDefined(
  current: number | undefined,
  next: number,
): number {
  return current === undefined ? next : Math.min(current, next);
}
