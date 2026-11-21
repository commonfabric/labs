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

  /** Returns future eligibility as of the caller's clock sample. */
  readonly getNextEligibleRunTime: (
    action: Action,
    now: number,
  ) => number | undefined;

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

/**
 * Whether no pull seed scan can do anything with the invalid node `action`
 * until something about it changes. A scan runs a node only when it is live
 * or pending (`isRunnableSchedulingSeed`), and waits on one only when it is
 * an effect, a materializer or a demanded computation, all of which are
 * live. The three are read here as well so that the answer does not depend
 * on that implication.
 */
function isDormantSeedCandidate(
  state: PullSchedulingState,
  action: Action,
): boolean {
  return !state.isLiveAction(action) &&
    !state.pending.has(action) &&
    !state.effects.has(action) &&
    !state.materializerIndex.isMaterializer(action) &&
    !state.dirtyPullRunnableStateWithDebounce.isDemandedPullComputation(action);
}

/**
 * With `SCHEDULER_SEED_SCAN_EQUIVALENCE=1`, every seed scan also walks all
 * the invalid nodes and throws unless it finds the same nodes in the same
 * order as the walk over the seed candidates did. It is the check on the
 * contract `NodeRegistry.noteMayBeLive()` states: run it across the runner
 * suite after a change to liveness maintenance or to what a scan reads. Off
 * by default, since it costs the walk the candidates exist to avoid.
 */
const SEED_SCAN_EQUIVALENCE_CHECK: boolean = (() => {
  try {
    return typeof Deno !== "undefined" &&
      Deno.env.get("SCHEDULER_SEED_SCAN_EQUIVALENCE") === "1";
  } catch {
    return false; // no env permission: stay disabled
  }
})();

/**
 * The invalid nodes a pull seed scan has to examine, in the order
 * `NodeRegistry.getInvalidNodes()` holds them: every invalid node that is
 * not dormant (`isDormantSeedCandidate`). The scans below iterate this where
 * they would iterate every invalid node, and reach the same result, because
 * a dormant node passes none of their tests.
 *
 * Under lazy materialization most invalid nodes of a large graph are
 * computations nothing demands, which stay `never-ran` and dormant for as
 * long as that holds. So a dormant node is parked in the registry when a
 * scan first meets it, and later scans cost the nodes that are live, pending
 * or newly changed, not every node that has yet to run.
 */
export function seedScanNodes(
  state: PullSchedulingState,
  verify: boolean = SEED_SCAN_EQUIVALENCE_CHECK,
): SchedulerNode[] {
  const candidates = state.nodes.getSeedCandidates();
  const found: SchedulerNode[] = [];
  for (const action of candidates) {
    if (isDormantSeedCandidate(state, action)) {
      state.nodes.parkSeedCandidate(action);
      continue;
    }
    found.push(state.nodes.get(action)!);
  }
  // A node is parked without regard to later run requests, so a parked node
  // that has since become pending is picked up from the pending set.
  for (const action of state.pending) {
    if (state.nodes.isInvalid(action) && !candidates.has(action)) {
      found.push(state.nodes.get(action)!);
    }
  }
  found.sort((a, b) => a.invalidOrdinal - b.invalidOrdinal);

  if (verify) {
    const expected: SchedulerNode[] = [];
    for (const action of state.nodes.getInvalidNodes()) {
      if (!isDormantSeedCandidate(state, action)) {
        expected.push(state.nodes.get(action)!);
      }
    }
    const same = expected.length === found.length &&
      expected.every((record, i) => record === found[i]);
    if (!same) {
      const name = (record: SchedulerNode) =>
        record.action.name || "<anonymous>";
      const foundSet = new Set(found);
      const expectedSet = new Set(expected);
      const missed = expected.filter((record) => !foundSet.has(record));
      const extra = found.filter((record) => !expectedSet.has(record));
      throw new Error(
        `seed scan drift: missed [${missed.map(name).join(", ")}], ` +
          `extra [${extra.map(name).join(", ")}], ` +
          `${missed.length === 0 && extra.length === 0 ? "order differs" : ""}`,
      );
    }
  }
  return found;
}

export function isTimeGated(
  state: PullSchedulingState,
  action: Action,
  now: number,
): boolean {
  const nextEligibleAt = state.getNextEligibleRunTime(action, now);
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
  // Eligibility and its wake share a clock sample, so a deadline that expires
  // during the scan still leaves a wake scheduled for the deferred work.
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
    const nextEligibleAt = state.getNextEligibleRunTime(action, now);
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

  // Dirty sources: the invalid nodes that are not dormant are exactly the
  // candidate set (`seedScanNodes`).
  for (const record of seedScanNodes(state)) {
    const action = record.action;
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
