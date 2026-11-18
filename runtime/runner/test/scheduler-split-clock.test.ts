import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  applyPullExecuteContinuation,
  applyQuiescentContinuation,
  type ExecuteContinuationState,
} from "../src/scheduler/continuation.ts";
import {
  assessPullWork,
  isRunnableSchedulingSeed,
  type PullSchedulingState,
} from "../src/scheduler/work-oracle.ts";
import {
  NodeRegistry,
  type SchedulerNode,
} from "../src/scheduler/node-record.ts";
import { SchedulerGates } from "../src/scheduler/gates.ts";
import type { Action, QueuedEvent } from "../src/scheduler/types.ts";

describe("split-clock readiness decisions", () => {
  // F11: a readiness/parked decision must read `performance.now()` once. When
  // the head-event park check is evaluated twice with two different clock
  // reads, an event whose `notBefore` falls between them is classed as neither
  // ready nor parked — so the quiescent continuation resolves idle() with the
  // event still queued and undispatched.

  const realNow = performance.now.bind(performance);

  afterEach(() => {
    performance.now = realNow;
  });

  // Return each value in `sequence` on successive reads, then pin the last.
  function stubClock(sequence: readonly number[]): void {
    let i = 0;
    performance.now = () => sequence[Math.min(i++, sequence.length - 1)];
  }

  // Use the real gate queries: a stub that always returns the deadline hides
  // the clock read that can discard an expired deadline inside the gate.
  function dirtyGatedEffect(
    gate: "debounceReadyAt" | "throttleReadyAt" | "backoffUntil",
  ) {
    const nodes = new NodeRegistry();
    const effect: Action = () => {};
    const record = nodes.register(effect, "effect");
    nodes.setStatus(effect, "invalid");
    record.gate[gate] = 150;
    const gates = new SchedulerGates({
      nodes,
      actionStats: new Map(),
      getActionId: () => "effect",
      isDisposed: () => false,
      queueExecution: () => {},
    });
    const effects = new Set([effect]);
    const runnable = {
      effects,
      isDemandedPullComputation: () => false,
      shouldRunFirstPullComputationInDemandContext: () => false,
      isThrottled: (action: Action, now?: number) =>
        gates.isThrottled(action, now),
      isDebouncedComputationWaiting: () => false,
    };
    return {
      nodes,
      // A debounce wake revisits invalid effects without an explicit run request.
      pending: new Set<Action>(),
      effects,
      materializerIndex: {
        scopeKeyIdentity: () => ({ principal: "did:test:split-clock" }),
        materializersByEntity: new Map(),
        effects,
        getMaterializerWriteEnvelopes: () => undefined,
        isMaterializer: () => false,
      },
      pendingPullRunnableState: runnable,
      dirtyPullRunnableState: runnable,
      dirtyPullRunnableStateWithDebounce: runnable,
      isLiveAction: () => true,
      hasActiveDebounceTimer: (action: Action) =>
        gates.hasActiveDebounceTimer(action),
      getNextEligibleRunTime: (action: Action, now?: number) =>
        gates.getNextEligibleRunTime(action, now),
      isConvergenceHoldActive: () => true,
      isConvergenceBackoffDeferred: () => false,
    } satisfies PullSchedulingState;
  }

  for (
    const gate of [
      "debounceReadyAt",
      "throttleReadyAt",
      "backoffUntil",
    ] as const
  ) {
    it(`retains the wake when ${gate} expires during a dirty effect assessment`, () => {
      const state = dirtyGatedEffect(gate);
      // Throttle short-circuits before the aggregate time gate. Debounce and
      // backoff first pass the throttle query, then find their deadline.
      stubClock(
        gate === "throttleReadyAt" ? [50, 100, 200] : [50, 50, 100, 200],
      );

      expect(assessPullWork(state)).toEqual({
        runnableNow: false,
        nextWakeAt: 150,
        deferredIdleBlocking: true,
      });
    });
  }

  it("keeps idle pending and schedules a wake when a dirty effect's debounce expires during continuation", () => {
    const pullScheduling = dirtyGatedEffect("debounceReadyAt");
    let idleResolved = false;
    const wakes: number[] = [];
    const state = {
      pullScheduling,
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadWaitingHeadEvent: () => false,
      hasInputParkedHeadEvent: () => false,
      settleDeferredForLoadPark: () => false,
      scheduleWake: (at: number) => {
        wakes.push(at);
      },
      hasWakeTimer: () => false,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => {},
      setQueuedPass: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;
    // The continuation takes its event-clock sample before the work oracle's
    // sample. The effect's deadline expires between its gate and wake reads.
    stubClock([50, 50, 50, 100, 200]);

    applyPullExecuteContinuation(state);

    expect(idleResolved).toBe(false);
    expect(wakes).toEqual([150]);
  });

  it("does not resolve idle for an event straddled between two clock reads", () => {
    const NOT_BEFORE = 150;
    // assessPullWork consumes one clock read over the empty work state (50,
    // before the gate); the park check then reads 100 (parked). A buggy
    // two-read park decision would see 100 (parked) then 200 (ready) →
    // neither.
    stubClock([50, 100, 200]);

    let idleResolved = false;
    const state = {
      pullScheduling: {
        pending: new Set(),
        nodes: new NodeRegistry(),
      } as unknown as PullSchedulingState,
      eventQueue: [{ notBefore: NOT_BEFORE } as unknown as QueuedEvent],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadWaitingHeadEvent: () => false,
      settleDeferredForLoadPark: () => false,
      hasInputParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => false,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => {},
      setQueuedPass: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyPullExecuteContinuation(state);

    // With a single clock read the head is consistently parked, so idle() must
    // stay open while the event is queued and undispatched.
    expect(idleResolved).toBe(false);
    expect(state.eventQueue.length).toBe(1);
  });

  it("starts a fresh convergence-hold episode after the idle escape", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: {} as PullSchedulingState,
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadWaitingHeadEvent: () => false,
      settleDeferredForLoadPark: () => false,
      hasInputParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => true,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setQueuedPass: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, {
      hasParkedHeadEvent: false,
      nextDirtyPullRunAt: 1_000,
      nextDirtyPullRunWaitsForIdle: false,
    });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("does not let an irrelevant shared wake hold idle open", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: {} as PullSchedulingState,
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadWaitingHeadEvent: () => false,
      settleDeferredForLoadPark: () => false,
      hasInputParkedHeadEvent: () => false,
      scheduleWake: () => {},
      // With no nextDirtyPullRunAt and no parked event, this timer belongs only
      // to dormant/non-idle-relevant work.
      hasWakeTimer: () => true,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setQueuedPass: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, { hasParkedHeadEvent: false });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("resets convergence holds at an ordinary idle boundary", () => {
    let idleResolved = false;
    let holdResets = 0;
    const state = {
      pullScheduling: {} as PullSchedulingState,
      eventQueue: [],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => false,
      hasPendingLineageHeadEvent: () => false,
      hasLoadWaitingHeadEvent: () => false,
      settleDeferredForLoadPark: () => false,
      hasInputParkedHeadEvent: () => false,
      scheduleWake: () => {},
      hasWakeTimer: () => false,
      setScheduled: () => {},
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => holdResets++,
      setQueuedPass: () => {},
      execute: () => {},
    } satisfies ExecuteContinuationState;

    applyQuiescentContinuation(state, { hasParkedHeadEvent: false });

    expect(idleResolved).toBe(true);
    expect(holdResets).toBe(1);
  });

  it("isRunnableSchedulingSeed honors the passed clock instead of re-reading", () => {
    const ELIGIBLE_AT = 1000;
    const action = () => {};
    const record = {
      action,
      status: "never-ran",
    } as unknown as SchedulerNode;
    const state = {
      isLiveAction: () => true,
      pending: new Set(),
      hasActiveDebounceTimer: () => false,
      getNextEligibleRunTime: () => ELIGIBLE_AT,
      dirtyPullRunnableStateWithDebounce: {
        isThrottled: () => false,
        isDebouncedComputationWaiting: () => false,
      },
    } as unknown as PullSchedulingState;

    // The internal clock reads PAST the gate; the caller's captured clock reads
    // BEFORE it. A single-clock assessment must use the passed value and treat
    // the node as still time-gated (not runnable).
    stubClock([ELIGIBLE_AT + 100]);
    const runnable = isRunnableSchedulingSeed(state, record, ELIGIBLE_AT - 100);
    expect(runnable).toBe(false);

    // Sanity: past the gate under the same passed clock it is runnable.
    expect(isRunnableSchedulingSeed(state, record, ELIGIBLE_AT + 100)).toBe(
      true,
    );
  });
});
