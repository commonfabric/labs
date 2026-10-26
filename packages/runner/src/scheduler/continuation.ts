import { queueTask } from "./diagnostics.ts";
import { isHeadEventParked } from "./events.ts";
import { planPullExecuteContinuation } from "./execution.ts";
import type { PullSchedulingState } from "./work-oracle.ts";
import type { QueuedEvent } from "./types.ts";

export interface ExecuteContinuationState {
  readonly pullScheduling: PullSchedulingState;
  readonly eventQueue: readonly QueuedEvent[];
  readonly idlePromises: (() => void)[];
  readonly consumeRerunAfterCurrentExecute: () => boolean;
  readonly hasPendingLineageHeadEvent: () => boolean;
  readonly hasLoadParkedHeadEvent: () => boolean;

  /**
   * Whether the pass just ended deferred its settle to the pass a load park's
   * release starts, so the work it left is not cause for another pass.
   */
  readonly settleDeferredForLoadPark: () => boolean;

  readonly scheduleWake: (at: number) => void;
  readonly hasWakeTimer: () => boolean;
  readonly setScheduled: (scheduled: boolean) => void;
  readonly resetSettlingTracker: () => void;
  readonly resetConvergenceHoldPasses: () => void;
  readonly setPendingQueueTaskTimer: (
    timer: ReturnType<typeof setTimeout> | null,
  ) => void;
  readonly execute: () => void;
}

export interface QuiescentContinuation {
  readonly hasParkedHeadEvent: boolean;
  readonly nextDirtyPullRunAt?: number;
  readonly nextDirtyPullRunWaitsForIdle?: boolean;
}

export function applyQuiescentContinuation(
  state: ExecuteContinuationState,
  continuation: QuiescentContinuation,
): void {
  if (continuation.nextDirtyPullRunAt !== undefined) {
    state.scheduleWake(continuation.nextDirtyPullRunAt);
    if (
      !continuation.hasParkedHeadEvent &&
      !continuation.nextDirtyPullRunWaitsForIdle
    ) {
      finishIdleEpisode(state);
      // Resolving idle ends this logical non-settling episode even though its
      // rate-limited retry wake remains armed. A later unrelated wave must get
      // fresh telemetry/diagnostic accounting.
    }
    markNotScheduled(state);
    return;
  }

  if (continuation.hasParkedHeadEvent) {
    markNotScheduled(state);

    // A lineage-parked head has no timer; the origin transaction's commit
    // callback is the wake source. A time-parked event may share the gate wake.
    state.resetSettlingTracker();
    return;
  }

  if (state.hasWakeTimer()) {
    // The work oracle returned no nextDirtyPullRunAt and no event is parked, so
    // this shared timer belongs only to dormant/non-idle-relevant work. Leave
    // the harmless wake armed, but do not let it hold current idle waiters.
    finishIdleEpisode(state);
    markNotScheduled(state);
    return;
  }

  finishIdleEpisode(state);
  markNotScheduled(state);
}

export function queueAnotherExecutionTick(
  state: ExecuteContinuationState,
): void {
  // Keep scheduled = true since we're queuing another execution.
  const timer = queueTask(() => {
    state.setPendingQueueTaskTimer(null);
    state.execute();
  });
  state.setPendingQueueTaskTimer(timer);
}

function markNotScheduled(state: ExecuteContinuationState): void {
  state.setScheduled(false);
}

function resolveIdlePromises(promises: (() => void)[]): void {
  for (const resolve of promises) resolve();
  promises.length = 0;
}

function finishIdleEpisode(state: ExecuteContinuationState): void {
  resolveIdlePromises(state.idlePromises);
  state.resetConvergenceHoldPasses();
  state.resetSettlingTracker();
}

export function applyPullExecuteContinuation(
  state: ExecuteContinuationState,
): void {
  // In pull mode, we consider ourselves done when there are no effects or
  // effect-demanded computations to execute.
  //
  // Read the clock once for the whole ready/parked decision: an event whose
  // `notBefore` falls between two separate reads would be classed as neither
  // ready nor parked, letting idle() resolve with it still queued.
  const now = performance.now();
  const hasPendingLineageHeadEvent = state.hasPendingLineageHeadEvent();
  const hasLoadParkedHeadEvent = state.hasLoadParkedHeadEvent();
  // A pass that deferred its settle to a parked head's release waits for that
  // release, which queues the next pass; queueing one for the derivations it
  // left would run passes that defer again until the loads settle.
  if (hasLoadParkedHeadEvent && state.settleDeferredForLoadPark()) {
    // The release's pass settles whatever this one was asked to run again
    // for, so the request is taken here rather than left latched, where it
    // would queue a pass behind the release's own.
    state.consumeRerunAfterCurrentExecute();
    applyQuiescentContinuation(state, { hasParkedHeadEvent: true });
    return;
  }
  const hasQueuedEventReadyNow = state.eventQueue.length > 0 &&
    !isHeadEventParked(state, now) &&
    !hasPendingLineageHeadEvent &&
    !hasLoadParkedHeadEvent;
  const hasParkedHeadEvent = state.eventQueue.length > 0 &&
    (isHeadEventParked(state, now) || hasPendingLineageHeadEvent ||
      hasLoadParkedHeadEvent);
  const shouldRerunAfterCurrentExecute = state
    .consumeRerunAfterCurrentExecute();

  const continuation = planPullExecuteContinuation({
    pull: state.pullScheduling,
    shouldRerunAfterCurrentExecute,
    hasQueuedEventReadyNow,
    hasParkedHeadEvent,
  });

  if (!continuation.shouldQueueAnotherTick) {
    applyQuiescentContinuation(state, continuation);
    return;
  }

  queueAnotherExecutionTick(state);
}
