import type { Action } from "./types.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";

/**
 * The one answer to "is there outstanding pull work, and what kind?".
 *
 * Three consumers historically re-derived this independently — the settle
 * seed scan, the execute continuation planner, and `idle()` — and every new
 * deferral mechanism (throttle, debounce, backoff, rehydration barrier) had
 * to be threaded through all of them consistently; divergence between them
 * was a recurring bug class. They now share this module's predicates and the
 * single-pass `assessPullWork`.
 */

export function isPendingPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
}, action: Action): boolean {
  return state.effects.has(action) ||
    state.isDemandedPullComputation(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action);
}

export function isDirtyPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting?: (action: Action) => boolean;
}, action: Action): boolean {
  return (
    state.effects.has(action) ||
    state.isDemandedPullComputation(action)
  ) &&
    !state.isThrottled(action) &&
    state.isDebouncedComputationWaiting?.(action) !== true;
}

export type PendingPullRunnableState = Parameters<
  typeof isPendingPullActionRunnable
>[0];
export type DirtyPullRunnableState = Parameters<
  typeof isDirtyPullActionRunnable
>[0];
export type DirtyPullRunnableStateWithDebounce = DirtyPullRunnableState & {
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
};

export interface PullSchedulingState {
  readonly nodes: NodeRegistry;
  // `pending` means an explicit run request that is not derivable from
  // invalid status alone: event preflight, retry, or an expired debounce
  // flush.
  readonly pending: Set<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
  readonly pendingPullRunnableState: PendingPullRunnableState;
  readonly dirtyPullRunnableState: DirtyPullRunnableState;
  readonly dirtyPullRunnableStateWithDebounce:
    DirtyPullRunnableStateWithDebounce;
  readonly isLiveAction: (action: Action) => boolean;
  readonly hasActiveDebounceTimer: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  // Per-action escape valve for convergence-backoff-deferred work. Keeping the
  // episode count on the gated node prevents one non-settling subgraph from
  // releasing idle() for an unrelated future convergence wave.
  readonly isConvergenceHoldActive: (action: Action) => boolean;
  // True iff the action is deferred by a CONVERGENCE-backoff wake specifically
  // (`gate.backoffUntil` in the future) — as opposed to a throttle/debounce
  // freshness window. Throttle/debounce deferred re-runs of an already-ran
  // computation must NOT block idle() (they are freshness bounds, not
  // correctness gates); a convergence-backoff deferral means the wave has not
  // settled and its re-run still owes a downstream effect its converged value.
  readonly isConvergenceBackoffDeferred: (action: Action) => boolean;
}

export function isInvalidOrNeverRan(record: SchedulerNode): boolean {
  return record.status === "invalid" || record.status === "never-ran";
}

export function isTimeGated(
  state: PullSchedulingState,
  action: Action,
  now: number,
): boolean {
  const nextEligibleAt = state.getNextEligibleRunTime(action);
  return nextEligibleAt !== undefined && nextEligibleAt > now;
}

export function isRunnableSchedulingSeed(
  state: PullSchedulingState,
  record: SchedulerNode,
  now: number = performance.now(),
): boolean {
  const action = record.action;
  return isInvalidOrNeverRan(record) &&
    (state.isLiveAction(action) || state.pending.has(action)) &&
    !state.dirtyPullRunnableStateWithDebounce.isThrottled(action) &&
    !isTimeGated(state, action, now) &&
    !state.hasActiveDebounceTimer(action) &&
    state.dirtyPullRunnableStateWithDebounce
        .isDebouncedComputationWaiting(action) !== true;
}

export function isIdleMaterializerRunnable(
  state: PullSchedulingState,
  record: SchedulerNode,
  now: number = performance.now(),
): boolean {
  const action = record.action;
  return state.materializerIndex.isMaterializer(action) &&
    isRunnableSchedulingSeed(state, record, now) &&
    !state.effects.has(action) &&
    state.dirtyPullRunnableStateWithDebounce
        .isDebouncedComputationWaiting(action) !== true;
}

/** One-pass assessment of outstanding pull work. */
export interface PullWorkAssessment {
  /** A seed the settle loop would run right now exists. */
  readonly runnableNow: boolean;

  /**
   * Earliest future eligibility among deferred idle-relevant work (effects,
   * materializers, demanded computations, awaited first runs). Feeds the
   * single wake timer.
   */
  readonly nextWakeAt?: number;

  /**
   * Some deferred node's eventual run is one an idle() waiter must observe:
   * effects and materializers (side effects), and a never-ran demanded
   * computation whose FIRST run is still awaited (e.g. a debounced child
   * created under a live parent's provisional demand). Limited to the first
   * run for computations: once one has produced output, throttle/debounce
   * deferred reruns must not block idle() through their window.
   */
  readonly deferredIdleBlocking: boolean;
}

export function assessPullWork(
  state: PullSchedulingState,
): PullWorkAssessment {
  const now = performance.now();
  let nextWakeAt: number | undefined;
  let deferredIdleBlocking = false;

  const futureRunWaitsForIdle = (action: Action): boolean => {
    // Escape valve: once a non-settling episode has spent its backoff-pass
    // budget, NO deferred node blocks idle(), so a genuinely non-converging
    // (cyclic) subgraph still resolves idle() (the settle cap keeps the system
    // responsive; scheduler.non-settling telemetry has fired). This gate is the
    // reason the F1 hold below is cycle-safe.
    if (!state.isConvergenceHoldActive(action)) return false;
    return state.effects.has(action) ||
      state.materializerIndex.isMaterializer(action) ||
      state.pendingPullRunnableState
        .shouldRunFirstPullComputationInDemandContext(action) ||
      // F1: a CONVERGENCE-BACKOFF-deferred RE-RUN of an already-ran demanded
      // computation blocks idle() until it runs. Its eventual run propagates to
      // a live sink (isLive => its downstream cone reaches an effect/
      // materializer) that an idle() waiter must observe; without this, idle()
      // resolves mid-wave (the frontier hit the settle cap but its downstream
      // effect is still clean) and callers sample a pre-convergence graph. The
      // escape valve above bounds the hold so a true cycle (whose frontier is a
      // perpetually-invalid demanded computation) still resolves idle(). NOTE:
      // gated on isConvergenceBackoffDeferred — a throttle/debounce freshness
      // window on an already-ran computation must still let idle() resolve.
      (state.dirtyPullRunnableState.isDemandedPullComputation(action) &&
        state.isConvergenceBackoffDeferred(action));
  };

  // For a deferred idle-relevant action, fold its next eligibility into the
  // wake time and record whether idle() must wait for it. A waiting trailing
  // debounce implies an armed debounceReadyAt (arming happens at invalidation;
  // queries are pure), and eligibleAt = max(debounce, throttle, backoff), so
  // one gate read covers every deferral mechanism.
  const noteFutureEligibility = (action: Action): void => {
    const nextEligibleAt = state.getNextEligibleRunTime(action);
    if (nextEligibleAt !== undefined && nextEligibleAt > now) {
      nextWakeAt = nextWakeAt === undefined
        ? nextEligibleAt
        : Math.min(nextWakeAt, nextEligibleAt);
      deferredIdleBlocking ||= futureRunWaitsForIdle(action);
    }
  };

  let runnableNow = false;

  // Pending sources: explicit run requests.
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (!record) continue;
    const idleRelevant = state.effects.has(action) ||
      state.materializerIndex.isMaterializer(action) ||
      state.pendingPullRunnableState.isDemandedPullComputation(action) ||
      state.pendingPullRunnableState
        .shouldRunFirstPullComputationInDemandContext(action);
    if (!idleRelevant) continue;
    if (
      isRunnableSchedulingSeed(state, record, now) &&
      (isPendingPullActionRunnable(state.pendingPullRunnableState, action) ||
        isIdleMaterializerRunnable(state, record, now))
    ) {
      runnableNow = true;
      continue;
    }
    noteFutureEligibility(action);
  }

  // Dirty sources: the invalid-node index is exactly the candidate set.
  for (const action of state.nodes.getInvalidNodes()) {
    const record = state.nodes.get(action);
    if (!record || !isInvalidOrNeverRan(record)) continue;
    const idleRelevant = state.effects.has(action) ||
      state.dirtyPullRunnableStateWithDebounce
        .isDemandedPullComputation(action) ||
      state.materializerIndex.isMaterializer(action);
    if (
      isRunnableSchedulingSeed(state, record, now) &&
      (isDirtyPullActionRunnable(
        state.dirtyPullRunnableStateWithDebounce,
        action,
      ) ||
        isIdleMaterializerRunnable(state, record, now))
    ) {
      runnableNow = true;
      continue;
    }
    if (idleRelevant) noteFutureEligibility(action);
  }

  // Idle-priority materializers outside the invalid index scan above are
  // covered by it (materializers surface through invalid status like any
  // node); pending materializers were handled in the pending loop.

  return {
    runnableNow,
    ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
    deferredIdleBlocking,
  };
}

/** A seed the settle loop would run right now exists. */
export function hasRunnablePullWork(state: PullSchedulingState): boolean {
  return assessPullWork(state).runnableNow;
}

/**
 * Deferred work an idle() waiter must observe exists (see
 * PullWorkAssessment.deferredIdleBlocking).
 */
export function hasIdleBlockingDeferredPullWork(
  state: PullSchedulingState,
): boolean {
  return assessPullWork(state).deferredIdleBlocking;
}
