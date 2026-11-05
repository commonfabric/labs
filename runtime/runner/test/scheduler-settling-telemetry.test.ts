/**
 * The scheduler's non-settling telemetry (facade recordExecuteEndTelemetry)
 * sits behind a wall-clock heuristic: it fires only when a busy window
 * crosses 5s. Integration runs cover it only when a CI machine happens to run
 * slow enough, which made the runner coverage gate flap. This test drives the
 * path deterministically by backdating the private settling tracker — no
 * sleeping, no real busy-looping.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { SchedulerSettleResult } from "../src/scheduler/execution.ts";
import type { Action } from "../src/scheduler/types.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("settling telemetry test");

// The tracker and the execute-end hook come through `accessForTestingOnly`;
// backdating the tracker is what reaches the telemetry branch without real
// wall-clock busy time.

// A settle result carrying only the fields the backoff telemetry path reads;
// the rest of the shape is inert here.
function settleResultWithBackoff(
  backoffActions: readonly Action[],
): SchedulerSettleResult {
  return {
    settledEarly: false,
    maxSettleIterations: 10,
    backoffApplied: backoffActions.length > 0,
    backoffActionCount: backoffActions.length,
    backoffActions,
    iterationsRun: 10,
    settleDurationMs: 1,
    workSetSize: backoffActions.length,
  };
}

describe("scheduler non-settling telemetry", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("submits telemetry and auto-triggers diagnosis for a busy window", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const scheduler = runtime.scheduler.accessForTestingOnly;
      const markers: { busyTime: number; windowDuration: number }[] = [];
      let diagnosisStarts = 0;
      const listener = (event: Event) => {
        const { marker } = (event as RuntimeTelemetryEvent).detail;
        if (marker.type === "scheduler.non-settling") markers.push(marker);
        if (marker.type === "scheduler.diagnosis.start") diagnosisStarts++;
      };
      runtime.telemetry.addEventListener("telemetry", listener);
      try {
        runtime.scheduler.setAutoTriggerDiagnosis(true);
        // Backdate the tracker to a window that is unambiguously busy: 8s of
        // window with 4s busy stays over every threshold (5s window, 1s busy,
        // 0.3 ratio) no matter how much real time the test itself takes.
        const now = performance.now();
        scheduler.settlingTracker.windowStart = now - 8_000;
        scheduler.settlingTracker.busyTime = 4_000;
        scheduler.settlingTracker.lastExecuteStart = now;
        scheduler.settlingTracker.isExecuting = true;
        expect(runtime.scheduler.isNonSettling()).toBe(false);

        scheduler.recordExecuteEndTelemetry();

        expect(markers.length).toBe(1);
        expect(markers[0].busyTime).toBeGreaterThanOrEqual(4_000);
        expect(markers[0].windowDuration).toBeGreaterThanOrEqual(8_000);
        expect(runtime.scheduler.isNonSettling()).toBe(true);
        // Auto-trigger switched diagnosis on.
        expect(diagnosisStarts).toBe(1);

        // A later execute end in the same episode stays quiet (and takes the
        // diagnosis busy-time accounting branch instead).
        scheduler.recordExecuteEndTelemetry();
        expect(markers.length).toBe(1);
        expect(diagnosisStarts).toBe(1);
      } finally {
        runtime.telemetry.removeEventListener("telemetry", listener);
      }
    } finally {
      // Also clears the diagnosis auto-stop timer startDiagnosis armed.
      await runtime.dispose();
    }
  });

  describe("convergence-budget episodes", () => {
    it("submits a marker naming the deferred actions for each episode that defers work", async () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const scheduler = runtime.scheduler.accessForTestingOnly;
        const markers: RuntimeTelemetryMarker[] = [];
        const listener = (event: Event) => {
          const { marker } = (event as RuntimeTelemetryEvent).detail;
          if (marker.type === "scheduler.non-settling") markers.push(marker);
        };
        runtime.telemetry.addEventListener("telemetry", listener);
        try {
          const firstAction: Action = function firstDeferred() {};
          const secondAction: Action = function secondDeferred() {};

          scheduler.recordBudgetBackoffTelemetry(
            settleResultWithBackoff([firstAction]),
          );
          scheduler.recordBudgetBackoffTelemetry(
            settleResultWithBackoff([secondAction, firstAction]),
          );

          expect(markers.length).toBe(2);
          expect(
            markers.map((marker) =>
              marker.type === "scheduler.non-settling"
                ? marker.deferredActionCount
                : undefined
            ),
          ).toEqual([1, 2]);
          const firstLabels = markers[0].type === "scheduler.non-settling"
            ? markers[0].deferredActions
            : undefined;
          expect(firstLabels?.length).toBe(1);

          // An action carrying a scheduler observation identity is attributed
          // to its piece in the marker, scope stripped back to the result
          // cell's id — the attribution a builtin's `raw:` label cannot
          // provide. An unannotated action stays label-only.
          const annotatedAction: Action = function annotatedDeferred() {};
          (annotatedAction as {
            schedulerObservationIdentity?: {
              pieceId: string;
              pieceRootId?: string;
              ownerSpace?: string;
            };
          }).schedulerObservationIdentity = {
            // A `session:` scope key carries two colons of its own; the raw
            // id comes from `pieceRootId`, never from slicing `pieceId`.
            pieceId: "session:did:key:zP:sess-1:of:fid1:attributed",
            pieceRootId: "of:fid1:attributed",
            ownerSpace: "did:key:zTest",
          };
          scheduler.recordBudgetBackoffTelemetry(
            settleResultWithBackoff([annotatedAction, firstAction]),
          );
          const attributed = markers[2].type === "scheduler.non-settling"
            ? markers[2].deferredActions
            : undefined;
          expect(attributed?.[0]?.pieceId).toBe("of:fid1:attributed");
          expect(attributed?.[0]?.space).toBe("did:key:zTest");
          expect(attributed?.[1]?.pieceId).toBeUndefined();
          // The latch the warning rides still records that this run of settle
          // passes churned; a new continuation replaces the tracker holding it.
          expect(runtime.scheduler.isNonSettling()).toBe(true);
        } finally {
          runtime.telemetry.removeEventListener("telemetry", listener);
        }
      } finally {
        await runtime.dispose();
      }
    });

    it("submits no marker for a settle pass that deferred nothing", async () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const scheduler = runtime.scheduler.accessForTestingOnly;
        const markers: RuntimeTelemetryMarker[] = [];
        const listener = (event: Event) => {
          const { marker } = (event as RuntimeTelemetryEvent).detail;
          if (marker.type === "scheduler.non-settling") markers.push(marker);
        };
        runtime.telemetry.addEventListener("telemetry", listener);
        try {
          scheduler.recordBudgetBackoffTelemetry(settleResultWithBackoff([]));

          expect(markers.length).toBe(0);
          expect(runtime.scheduler.isNonSettling()).toBe(false);
        } finally {
          runtime.telemetry.removeEventListener("telemetry", listener);
        }
      } finally {
        await runtime.dispose();
      }
    });
  });
});
