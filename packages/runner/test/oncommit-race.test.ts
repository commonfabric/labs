/**
 * Regression tests for stream-event final-outcome callbacks.
 *
 * Scheduler-delivered `onCommit` callbacks fire exactly once for the final
 * result: after a transient conflict is retried and lands, or after a
 * non-retryable failure (a local abort) drops the write.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLogger } from "@commonfabric/utils/logger";

import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

const signer = await Identity.fromPassphrase("test oncommit race");
const space = signer.did();

describe("onCommit callback final outcome", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("fires onCommit once when a handler abort drops the write", async () => {
    const streamCell = runtime.getCell<{ piece: string }>(
      space,
      "add-piece-stream",
      undefined,
      tx,
    );
    streamCell.set({} as { piece: string });
    await tx.commit().settled;
    tx = runtime.edit();

    const pieceRegistryCell = runtime.getCell<string[]>(
      space,
      "piece-registry-list",
      undefined,
      tx,
    );
    pieceRegistryCell.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        handlerCallCount++;
        handlerTx.abort("Simulated handler-initiated abort");
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      { piece: "test-piece-id" },
      true,
      (committedTx) => {
        statuses.push(committedTx.status().status);
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    // A local abort is deterministic, not contention, so it is not retried
    // (the retries budget of 2 is irrelevant): the handler runs once and
    // onCommit fires exactly once with the failed final status.
    expect(statuses).toEqual(["error"]);
    expect(handlerCallCount).toBe(1);
    expect(pieceRegistryCell.get()).toEqual([]);
  });

  it("fires onCommit once when the storage commit promise rejects", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "rejected-storage-promise-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.storageManager.synced();

    const rejection = Object.assign(
      new Error("forced event commit promise rejection"),
      { name: "TransactionError" },
    );
    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        handlerCallCount++;
        streamCell.withTx(handlerTx).set(event);
        handlerTx.tx.commit = () =>
          createTransactionCommitReceipt(Promise.reject(rejection));
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    const errors: unknown[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      1,
      true,
      (committedTx) => {
        const status = committedTx.status();
        statuses.push(status.status);
        if (status.status === "error") {
          errors.push(status.error);
        }
      },
    );

    await runtime.scheduler.idleWithPendingCommits();
    await Promise.resolve();

    expect(handlerCallCount).toBe(1);
    expect(statuses).toEqual(["error"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "StorageTransactionAborted",
      reason: rejection,
    });
    expect(streamCell.get()).toBe(0);
  });

  for (
    const {
      testName,
      streamId,
      rejection,
      expectedMarker,
    } of [
      {
        testName: "normalizes a plain permanent rejection",
        streamId: "plain-permanent-rejection-stream",
        rejection: {
          name: "PreconditionFailedError",
          message: "receipt already exists",
          precondition: "receipt-exists",
        },
        expectedMarker: {
          error: "receipt already exists",
          permanentRejection: "receipt-exists",
          terminal: "permanent",
        },
      },
      {
        testName: "normalizes malformed plain rejection fields",
        streamId: "plain-malformed-rejection-stream",
        rejection: {
          name: 42,
          message: 42,
          precondition: "invalid-precondition",
        },
        expectedMarker: {
          error: "Storage commit promise rejected",
        },
      },
    ] as const
  ) {
    it(testName, async () => {
      const streamCell = runtime.getCell<number>(
        space,
        streamId,
        undefined,
        tx,
      );
      streamCell.set(0);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.storageManager.synced();

      let handlerCallCount = 0;
      runtime.scheduler.addEventHandler(
        (handlerTx, event) => {
          handlerCallCount++;
          streamCell.withTx(handlerTx).set(event);
          handlerTx.tx.commit = () =>
            createTransactionCommitReceipt(Promise.reject(rejection));
        },
        streamCell.getAsNormalizedFullLink(),
      );

      const commitMarkers: unknown[] = [];
      const listener = (event: Event) => {
        const marker = (event as CustomEvent<{ marker: { type: string } }>)
          .detail.marker;
        if (marker.type === "scheduler.event.commit") {
          commitMarkers.push(marker);
        }
      };
      runtime.telemetry.addEventListener("telemetry", listener);
      try {
        const statuses: string[] = [];
        runtime.scheduler.queueEvent(
          streamCell.getAsNormalizedFullLink(),
          1,
          true,
          (committedTx) => {
            statuses.push(committedTx.status().status);
          },
        );

        await runtime.scheduler.idleWithPendingCommits();
        await Promise.resolve();

        expect(handlerCallCount).toBe(1);
        expect(statuses).toEqual(["error"]);
        expect(commitMarkers).toHaveLength(1);
        expect(commitMarkers[0]).toMatchObject(expectedMarker);
        if (!("terminal" in expectedMarker)) {
          expect(commitMarkers[0]).not.toHaveProperty("permanentRejection");
          expect(commitMarkers[0]).not.toHaveProperty("terminal");
        }
        expect(streamCell.get()).toBe(0);
      } finally {
        runtime.telemetry.removeEventListener("telemetry", listener);
      }
    });
  }

  it("settles when event commit telemetry throws", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "commit-result-handling-error-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.storageManager.synced();

    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        handlerCallCount++;
        streamCell.withTx(handlerTx).set(event);
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    const telemetryError = new Error("commit result telemetry failed");
    const errorReports: Array<{
      readonly messages: unknown[];
      readonly statuses: string[];
    }> = [];
    const originalSubmit = runtime.telemetry.submit.bind(runtime.telemetry);
    const schedulerLogger = getLogger("scheduler");
    const originalLoggerErrorDescriptor = Object.getOwnPropertyDescriptor(
      schedulerLogger,
      "error",
    );
    const originalLoggerError = schedulerLogger.error;
    let commitMarkerAttempts = 0;
    runtime.telemetry.submit = (marker) => {
      if (marker.type === "scheduler.event.commit") {
        commitMarkerAttempts++;
        throw telemetryError;
      }
      originalSubmit(marker);
    };
    schedulerLogger.error = (key, ...messages) => {
      if (
        messages.includes("Event handler commit result handling failed:")
      ) {
        errorReports.push({ messages, statuses: [...statuses] });
      }
      originalLoggerError.call(schedulerLogger, key, ...messages);
    };
    try {
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        1,
        true,
        (committedTx) => {
          statuses.push(committedTx.status().status);
        },
      );

      await runtime.scheduler.idleWithPendingCommits();
      await Promise.resolve();

      expect(handlerCallCount).toBe(1);
      expect(commitMarkerAttempts).toBe(1);
      expect(statuses).toEqual(["done"]);
      expect(errorReports).toHaveLength(1);
      expect(errorReports[0]?.statuses).toEqual(["done"]);
      expect(errorReports[0]?.messages.at(-1)).toBe(telemetryError);
      expect(streamCell.get()).toBe(1);
    } finally {
      runtime.telemetry.submit = originalSubmit;
      if (originalLoggerErrorDescriptor) {
        Object.defineProperty(
          schedulerLogger,
          "error",
          originalLoggerErrorDescriptor,
        );
      } else {
        Reflect.deleteProperty(schedulerLogger, "error");
      }
    }
  });

  it(
    "fires onCommit once after a rejected conflict is retried and lands",
    async () => {
      const streamCell = runtime.getCell<number>(
        space,
        "fix-demo-stream",
        undefined,
        tx,
      );
      streamCell.set(0);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.storageManager.synced();

      const rejection = Object.assign(
        new Error("forced retry-then-land conflict"),
        { name: "ConflictError" },
      );
      let attempts = 0;
      runtime.scheduler.addEventHandler(
        (handlerTx, event) => {
          attempts++;
          streamCell.withTx(handlerTx).set(event + 1);
          if (attempts === 1) {
            handlerTx.tx.commit = () =>
              createTransactionCommitReceipt(Promise.reject(rejection));
          }
        },
        streamCell.getAsNormalizedFullLink(),
      );

      // Reject the first commit promise with a transient conflict. The
      // scheduler classifies the rejection, retries within the backpressure
      // window, and runs onCommit only for the second attempt that lands.
      const statuses: string[] = [];
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        1,
        true,
        (committedTx) => {
          statuses.push(committedTx.status().status);
        },
      );

      // Advancing the clock fires the backoff timer so the retry lands before
      // the assertions.
      await clock.tick(2_000);
      await runtime.idle();
      await runtime.storageManager.synced();

      expect(attempts).toBe(2);
      expect(statuses).toEqual(["done"]);
      expect(streamCell.get()).toBe(2);
    },
  );

  it("prepares scheduler-managed relevant writes before commit", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "cfc-scheduler-prepare-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const guardedCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-scheduler-prepare-output",
      {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["value"],
      },
      tx,
    );
    guardedCell.set({ value: "seed" });
    // The labeled schema makes this seed CFC-relevant, so it lands only when
    // it is prepared the way the scheduler prepares the handler's own write
    // below.
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        guardedCell.withTx(handlerTx).set({ value: `event-${event}` });
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      1,
      false,
      (committedTx) => {
        statuses.push(committedTx.status().status);
      },
    );

    await runtime.idle();
    // idleWithPendingCommits spans the event commit AND its disposition
    // handling (the tracked handled-chain), which is what delivers the
    // onCommit callback; synced() alone stops at storage settlement, a few
    // microtasks before the callback runs.
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();

    expect(statuses).toEqual(["done"]);
    const readTx = runtime.edit();
    const refreshed = runtime.getCell<{ value: string }>(
      space,
      "cfc-scheduler-prepare-output",
      {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["value"],
      },
      readTx,
    );
    expect(refreshed.get()).toEqual({ value: "event-1" });
  });
});
