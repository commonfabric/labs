import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  createSettlingTracker,
  markExecuteStart,
  markNonSettlingEpisode,
  planEventInvalidDependencyScheduling,
  pushBoundedHistory,
  recordExecuteEnd,
} from "../src/scheduler/execution.ts";
import type { Action } from "../src/scheduler/types.ts";

describe("scheduler execution planning", () => {
  it("parks debounced invalid dependencies until their scheduled run", () => {
    const debounced: Action = () => {};
    const runnable: Action = () => {};

    const plan = planEventInvalidDependencyScheduling({
      invalidDeps: [debounced, runnable],
      isDebouncedComputationWaiting: (action) => action === debounced,
      getNextDebounceRunTime: (action) =>
        action === debounced ? 1_250 : undefined,
      getNextEligibleRunTime: () => undefined,
      now: 1_000,
    });

    expect(plan).toEqual({
      runnableDeps: [runnable],
      nextEligibleAt: 1_250,
    });
  });

  it("discards the oldest entry when bounded history is full", () => {
    const history = [1, 2];

    pushBoundedHistory(history, 3, 2);

    expect(history).toEqual([2, 3]);
  });
});

describe("settling tracker", () => {
  // The non-settling heuristic only fires once a busy window crosses wall-clock
  // thresholds (5s / 10s), so integration runs cover these branches only when a
  // CI machine happens to run slow enough — which made the coverage gate flap.
  // These tests pin the branches with explicit `now` values instead.

  it("emits non-settling telemetry once the busy window crosses thresholds", () => {
    const tracker = createSettlingTracker();
    markExecuteStart(tracker, 0);

    const update = recordExecuteEnd(tracker, 6_000);

    expect(update.nonSettlingTelemetry).toEqual({
      busyTime: 6_000,
      windowDuration: 6_000,
      busyRatio: 1,
    });
    expect(tracker.nonSettlingDetected).toBe(true);
    expect(tracker.isExecuting).toBe(false);
  });

  it("reports a non-settling episode at most once", () => {
    const tracker = createSettlingTracker();
    markExecuteStart(tracker, 0);
    recordExecuteEnd(tracker, 6_000);

    // The window restarted at 6s, so 12s keeps it past the 5s threshold with
    // a saturated busy ratio — only the already-detected guard stays quiet.
    markExecuteStart(tracker, 6_000);
    const update = recordExecuteEnd(tracker, 12_000);

    expect(update.nonSettlingTelemetry).toBeUndefined();
    expect(update.diagnosisBusyTimeMs).toBe(6_000);
  });

  it("stays quiet while the window is below the detection thresholds", () => {
    const tracker = createSettlingTracker();
    markExecuteStart(tracker, 0);

    const update = recordExecuteEnd(tracker, 100);

    expect(update).toEqual({ diagnosisBusyTimeMs: 100 });
    expect(tracker.nonSettlingDetected).toBe(false);
  });

  it("slides the window past 10s, halving accumulated busy time", () => {
    const tracker = createSettlingTracker();
    // Start at 1, not 0: windowStart === 0 means "unset", and a window that
    // opens at 0 would be re-opened by the next markExecuteStart.
    markExecuteStart(tracker, 1);
    recordExecuteEnd(tracker, 2_001);

    markExecuteStart(tracker, 10_901);
    const update = recordExecuteEnd(tracker, 11_001);

    // busyRatio 2100/11000 is under 0.3: no telemetry, but the window slides.
    expect(update.nonSettlingTelemetry).toBeUndefined();
    expect(tracker.windowStart).toBe(11_001);
    expect(tracker.busyTime).toBe(1_050);
  });

  it("marks an externally observed episode, counting in-flight busy time", () => {
    const tracker = createSettlingTracker();
    markExecuteStart(tracker, 1_000);

    const telemetry = markNonSettlingEpisode(tracker, 3_000);

    expect(telemetry).toEqual({
      busyTime: 2_000,
      windowDuration: 2_000,
      busyRatio: 1,
    });
    expect(markNonSettlingEpisode(tracker, 4_000)).toBeUndefined();
  });
});
