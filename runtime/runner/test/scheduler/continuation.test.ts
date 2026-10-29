import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  applyPullExecuteContinuation,
  type ExecuteContinuationState,
} from "../../src/scheduler/continuation.ts";
import type { QueuedEvent } from "../../src/scheduler/types.ts";
import type { PullSchedulingState } from "../../src/scheduler/work-oracle.ts";

describe("continuation", () => {
  it("takes the rerun a pass that deferred to a parked head was asked for, and starts no pass of its own", () => {
    let rerunLatched = true;
    let executes = 0;
    const scheduled: boolean[] = [];
    let idleResolved = false;
    const state = {
      pullScheduling: {} as PullSchedulingState,
      eventQueue: [{} as QueuedEvent],
      idlePromises: [() => {
        idleResolved = true;
      }],
      consumeRerunAfterCurrentExecute: () => {
        const latched = rerunLatched;
        rerunLatched = false;
        return latched;
      },
      hasPendingLineageHeadEvent: () => false,
      hasLoadParkedHeadEvent: () => true,
      settleDeferredForLoadPark: () => true,
      scheduleWake: () => {},
      hasWakeTimer: () => false,
      setScheduled: (value) => scheduled.push(value),
      resetSettlingTracker: () => {},
      resetConvergenceHoldPasses: () => {},
      setPendingQueueTaskTimer: () => {},
      execute: () => executes++,
    } satisfies ExecuteContinuationState;

    applyPullExecuteContinuation(state);

    // The park's release queues the pass that settles what this one left, so
    // the request is taken here rather than left to queue a second behind it.
    expect(rerunLatched).toBe(false);
    expect(executes).toBe(0);
    expect(scheduled).toEqual([false]);
    expect(idleResolved).toBe(false);
  });
});
