// Scheduler event handling tests.

import {
  getLoggerCountsBreakdown,
  resetAllLoggerCounts,
} from "@commonfabric/utils/logger";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import {
  isExplicitTransactionAbort,
  reportServedEventFailure,
} from "../src/scheduler/events.ts";
import { TransactionAborted } from "../src/storage/transaction-errors.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
): Promise<void> {
  // Iteration-bounded, not wall-clock-bounded: zero-delay yields do not
  // advance the fake clock, so a time deadline could never expire and an
  // unreachable condition would spin forever — and the old deadline form
  // also fell through SILENTLY when it lapsed, letting a later assertion
  // fail far from the wait. Each round drains the scheduler and yields one
  // real timer turn — transport pumps and the emulated server's fan-out
  // flush (which resolves awaited commits at marker coverage, CT-1950) ride
  // zero-delay timers, exempt from the fake clock's test-armed freeze — so a
  // condition the system will ever reach is reached within a bounded number
  // of rounds, and one it never reaches throws `message` instead of hanging.
  for (let round = 0; round < 200 && !condition(); round++) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

/**
 * Await a signal the test itself resolves — a gate's deferred, a commit
 * callback. Deliberately no deadline: the package clock preload freezes
 * test-armed positive-delay timers, so a `setTimeout(reject, …)` race here
 * could never fire and would backstop nothing
 * (`docs/development/waiting-in-tests.md`). A signal that never arrives lets
 * the event loop quiesce, and Deno fails the pending wait at once, naming
 * the test; the label keeps the call site readable for whoever reads that
 * failure.
 */
async function waitForSignal(
  signal: Promise<void>,
  _label: string,
): Promise<void> {
  await signal;
}

describe("event handling", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  it("isolates served failure observers from scheduler control flow", () => {
    const outcomes: unknown[] = [];
    reportServedEventFailure({
      onFailure: (outcome) => outcomes.push(outcome),
    }, { kind: "dropped", message: "terminal" });
    expect(outcomes).toEqual([{ kind: "dropped", message: "terminal" }]);

    expect(() =>
      reportServedEventFailure({
        onFailure: () => {
          throw new Error("observer failed");
        },
      }, { kind: "error", message: "handler failed" })
    ).not.toThrow();
  });

  it("recognizes explicit aborts from typed producer evidence only", () => {
    expect(isExplicitTransactionAbort(TransactionAborted("custom reason")))
      .toBe(true);
    expect(isExplicitTransactionAbort({
      name: "StorageTransactionAborted",
      message: "Transaction was aborted",
    })).toBe(false);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should queue and process events", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should queue and process events 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should queue and process events 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);

    await eventResultCell.pull();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it("awaits presyncInputs before running the handler body", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "presync before handler 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "presync before handler 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    const order: string[] = [];
    let releasePresync!: () => void;
    const presyncDone = new Promise<void>((resolve) => {
      releasePresync = resolve;
    });

    const eventHandler: EventHandler = (tx, event) => {
      order.push("handler");
      eventResultCell.withTx(tx).send(event);
    };
    eventHandler.presyncInputs = async (event) => {
      order.push(`presync:${event}`);
      await presyncDone;
      order.push("presync-resolved");
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 7);

    // Give the scheduler a chance to dispatch; the handler must not run while
    // presync is pending.
    await clock.settle();
    expect(order).toEqual(["presync:7"]);

    releasePresync();
    await eventResultCell.pull();

    expect(order).toEqual(["presync:7", "presync-resolved", "handler"]);
    expect(eventResultCell.get()).toBe(7);
  });

  it("dispatches the handler even when presyncInputs rejects (fail open)", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "presync fail open 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "presync fail open 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    const eventHandler: EventHandler = (tx, event) => {
      eventResultCell.withTx(tx).send(event);
    };
    eventHandler.presyncInputs = () =>
      Promise.reject(new Error("presync boom"));

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await eventResultCell.pull();
    expect(eventResultCell.get()).toBe(3);
  });

  it("should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should remove event handlers 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventCell.withTx(tx).send(event);
    };

    const removeHandler = runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await eventCell.pull();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventCell.pull();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it("replaces an existing handler for the same event link", async () => {
    resetAllLoggerCounts();
    const eventCell = runtime.getCell<number>(
      space,
      "single handler per link event",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<string[]>(
      space,
      "single handler per link payloads",
      undefined,
      tx,
    );
    eventCell.set(0);
    payloads.set([]);
    await tx.commit().settled;
    tx = runtime.edit();

    let firstCount = 0;
    let secondCount = 0;
    const firstHandler: EventHandler = (handlerTx, event) => {
      firstCount++;
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, `first:${event}`]);
    };
    const secondHandler: EventHandler = (handlerTx, event) => {
      secondCount++;
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, `second:${event}`]);
    };

    runtime.scheduler.addEventHandler(
      firstHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      secondHandler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 42);

    await waitForSignal(
      runtime.idle(),
      "replacement handler event did not settle",
    );

    expect(firstCount).toBe(0);
    expect(secondCount).toBe(1);
    expect(payloads.get()).toEqual(["second:42"]);
    expect(
      getLoggerCountsBreakdown().scheduler?.["event-handler-replaced"]?.warn,
    ).toBe(1);
  });

  it("should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      space,
      "should handle events with nested paths 1",
      undefined,
      tx,
    );
    parentCell.set({ child: { value: 0 } });
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
      42,
    );
    await runtime.idle();

    expect(eventCount).toBe(1);
  });

  it("should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should process events in order 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    const events: number[] = [];

    const eventHandler: EventHandler = (_tx, event) => {
      events.push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await runtime.idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it("should dispatch queued event commits without waiting for server confirmation", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should dispatch queued event commits without waiting for server confirmation 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const listCell = runtime.getCell<number[]>(
      space,
      "should dispatch queued event commits without waiting for server confirmation 2",
      {
        type: "array",
        items: { type: "number" },
        default: [],
      },
      tx,
    );
    listCell.set([]);
    await tx.commit().settled;

    let eventCount = 0;
    let commitWasStarted = false;
    let resolveCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      resolveCommitStarted = resolve;
    });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let resolveCommitFinished!: () => void;
    const commitFinished = new Promise<void>((resolve) => {
      resolveCommitFinished = resolve;
    });

    const eventHandler: EventHandler = (handlerTx, event) => {
      eventCount++;
      listCell.withTx(handlerTx).push(event);
      const originalCommit = handlerTx.commit.bind(handlerTx);
      handlerTx.commit = () => {
        commitWasStarted = true;
        resolveCommitStarted();
        const original = originalCommit();
        return createTransactionCommitReceipt(
          original.settled.then(async (result) => {
            await commitRelease;
            return result;
          }).finally(resolveCommitFinished),
          original.verdict,
          original,
        );
      };
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);

    const idlePromise = runtime.idle();
    let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForSignal(commitStarted, "queued event commit did not start");
      const idleResult = await Promise.race([
        idlePromise.then(() => "resolved" as const),
        new Promise<"blocked">((resolve) => {
          idleTimeoutId = setTimeout(() => resolve("blocked"), 500);
        }),
      ]);

      expect(idleResult).toBe("resolved");
      expect(eventCount).toBe(1);
    } finally {
      if (idleTimeoutId !== undefined) clearTimeout(idleTimeoutId);
      releaseCommit();
      await idlePromise.catch(() => {});
      if (commitWasStarted) {
        await waitForSignal(
          commitFinished,
          "queued event commit did not finish after release",
        );
      }
    }

    await listCell.pull();

    expect(listCell.get()).toEqual([1]);
  });

  it("should cap event commit telemetry write samples", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should cap event commit telemetry write samples 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const targetCells = Array.from({ length: 40 }, (_, index) => {
      const cell = runtime.getCell<number>(
        space,
        `should cap event commit telemetry write samples target ${index}`,
        undefined,
        tx,
      );
      cell.set(0);
      return cell;
    });
    await tx.commit().settled;

    const commitMarkers: RuntimeTelemetryMarker[] = [];
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{
        marker: RuntimeTelemetryMarker;
      }>).detail.marker;
      if (marker.type === "scheduler.event.commit") {
        commitMarkers.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);

    try {
      const eventHandler: EventHandler = (handlerTx, event) => {
        for (const cell of targetCells) {
          cell.withTx(handlerTx).set(event);
        }
      };
      runtime.scheduler.addEventHandler(
        eventHandler,
        eventCell.getAsNormalizedFullLink(),
      );

      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
      await waitForSchedulerCondition(
        runtime,
        () => commitMarkers.length > 0,
        "no commit marker was recorded for the queued event",
      );

      const marker = commitMarkers.at(-1);
      expect(marker?.type).toBe("scheduler.event.commit");
      if (marker?.type === "scheduler.event.commit") {
        expect(marker.writeCount).toBe(40);
        expect(marker.writes.length).toBe(25);
        expect(marker.writesTruncated).toBe(true);
      }
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should preserve queued event appends to multiple arrays", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should preserve queued event appends to multiple arrays 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const firstList = runtime.getCell<number[]>(
      space,
      "should preserve queued event appends to multiple arrays 2",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    firstList.set([]);
    const secondList = runtime.getCell<number[]>(
      space,
      "should preserve queued event appends to multiple arrays 3",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    secondList.set([]);
    await tx.commit().settled;

    let eventCount = 0;
    const eventHandler: EventHandler = (handlerTx, event) => {
      eventCount++;
      firstList.withTx(handlerTx).push(event);
      secondList.withTx(handlerTx).push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    for (let i = 1; i <= 7; i++) {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), i);
    }

    await runtime.idle();
    await firstList.pull();
    await secondList.pull();

    expect(eventCount).toBe(7);
    expect(firstList.get()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(secondList.get()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("should recompute array length after rapid queued event appends", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should recompute array length after rapid queued event appends 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const listCell = runtime.getCell<number[]>(
      space,
      "should recompute array length after rapid queued event appends 2",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    listCell.set([]);
    const countCell = runtime.getCell<number>(
      space,
      "should recompute array length after rapid queued event appends 3",
      { type: "number", default: 0 },
      tx,
    );
    countCell.set(0);
    await tx.commit().settled;

    const countRuns: number[] = [];
    const countItems = (actionTx: IExtendedStorageTransaction) => {
      const itemCount = listCell.withTx(actionTx).get().length;
      countRuns.push(itemCount);
      countCell.withTx(actionTx).send(itemCount);
    };

    runtime.scheduler.subscribe(
      countItems,
      {
        reads: [toMemorySpaceAddress(listCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
      },
      {},
    );
    await countCell.pull();

    const renderedCounts: number[] = [];
    const cancelCountSink = countCell.withTx(runtime.edit()).sink((value) => {
      if (value !== undefined) {
        renderedCounts.push(value);
      }
    });

    const eventHandler: EventHandler = (handlerTx, event) => {
      listCell.withTx(handlerTx).push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    for (let i = 1; i <= 7; i++) {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), i);
    }

    await runtime.idle();

    expect(countRuns.at(-1)).toBe(7);
    expect(countCell.get()).toBe(7);
    expect(renderedCounts.at(-1)).toBe(7);

    cancelCountSink();
    runtime.scheduler.unsubscribe(countItems);
  });

  it("should rerun demanded computation dirtied during an in-flight run", async () => {
    const listCell = runtime.getCell<number[]>(
      space,
      "should rerun demanded computation dirtied during an in-flight run 1",
      { type: "array", items: { type: "number" }, default: [] },
      tx,
    );
    listCell.set([1, 2, 3, 4, 5]);
    const countCell = runtime.getCell<number>(
      space,
      "should rerun demanded computation dirtied during an in-flight run 2",
      { type: "number", default: 0 },
      tx,
    );
    countCell.set(0);
    await tx.commit().settled;

    let blockAtSix = false;
    let releaseSix: (() => void) | undefined;
    const releasedSix = new Promise<void>((resolve) => {
      releaseSix = resolve;
    });
    let observedSix: (() => void) | undefined;
    const observedSixRun = new Promise<void>((resolve) => {
      observedSix = resolve;
    });
    const countRuns: number[] = [];
    const countItems = async (actionTx: IExtendedStorageTransaction) => {
      const itemCount = listCell.withTx(actionTx).get().length;
      countRuns.push(itemCount);
      if (blockAtSix && itemCount === 6) {
        observedSix?.();
        await releasedSix;
      }
      countCell.withTx(actionTx).send(itemCount);
    };

    runtime.scheduler.subscribe(
      countItems,
      {
        reads: [toMemorySpaceAddress(listCell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(countCell.getAsNormalizedFullLink())],
      },
      {},
    );

    let demandedPull: Promise<unknown> | undefined;
    try {
      await countCell.pull();
      expect(countCell.get()).toBe(5);

      blockAtSix = true;
      const appendSixTx = runtime.edit();
      listCell.withTx(appendSixTx).push(6);
      await appendSixTx.commit().settled;

      demandedPull = countCell.pull();
      await waitForSignal(
        observedSixRun,
        "timed out waiting for blocked six-item computation run",
      );

      const appendSevenTx = runtime.edit();
      listCell.withTx(appendSevenTx).push(7);
      await appendSevenTx.commit().settled;

      releaseSix?.();
      await demandedPull;
      await runtime.idle();
      await countCell.pull();

      expect(countRuns).toContain(6);
      expect(countRuns.at(-1)).toBe(7);
      expect(countCell.get()).toBe(7);
    } finally {
      releaseSix?.();
      await demandedPull?.catch(() => undefined);
      runtime.scheduler.unsubscribe(countItems);
    }
  });

  it("does not commit or flush outbox effects when event handler throws", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "does not commit or flush outbox effects when event handler throws 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "does not commit or flush outbox effects when event handler throws 2",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit().settled;

    let attempts = 0;
    let errors = 0;
    let flushed = 0;
    runtime.scheduler.onError(() => {
      errors++;
    });

    const eventHandler: EventHandler = (handlerTx) => {
      attempts++;
      resultCell.withTx(handlerTx).send(1);
      handlerTx.enqueuePostCommitEffect({
        id: "event-handler-throw-outbox",
        kind: "test",
        flush() {
          flushed++;
        },
      });
      throw new Error("boom");
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();
    await runtime.idle();

    expect(attempts).toBe(1);
    expect(errors).toBe(1);
    expect(flushed).toBe(0);
    expect(resultCell.get()).toBe(0);
  });

  it("settles the commit callback when no handler is registered", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "settles commit callback when no handler is registered 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    // No handler is registered for this cell, and the cell has no result /
    // pattern metadata, so the piece-start fallback cannot register one
    // either. The event can never be dispatched — the commit callback must
    // still settle (with an errored tx) instead of being dropped silently.
    const commitStatus = new Promise<string>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => resolve(commitTx.status().status),
      );
    });

    const status = await Promise.race([
      commitStatus,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("commit callback never settled")),
          1_000,
        )
      ),
    ]);
    expect(status).toBe("error");
  });

  it("settles the commit callback when the event handler throws", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "settles commit callback when the event handler throws 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    let errors = 0;
    runtime.scheduler.onError(() => {
      errors++;
    });

    const eventHandler: EventHandler = () => {
      throw new Error("boom");
    };
    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    // A throwing handler is the final outcome for the event; the commit
    // callback must observe it (errored tx) rather than wait forever.
    const commitStatus = new Promise<string>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => resolve(commitTx.status().status),
      );
    });

    const status = await Promise.race([
      commitStatus,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("commit callback never settled")),
          1_000,
        )
      ),
    ]);
    expect(status).toBe("error");
    expect(errors).toBe(1);
  });

  it("stringifies non-Error handler failures for served observers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stringifies non-Error handler failures",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    runtime.scheduler.onError(() => undefined);
    runtime.scheduler.addEventHandler(
      () => Promise.reject("primitive failure"),
      eventCell.getAsNormalizedFullLink(),
    );

    const outcomes: unknown[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      false,
      undefined,
      false,
      {
        eventId: "served-non-error-handler-failure",
        served: {
          onFailure: (outcome) => outcomes.push(outcome),
        },
      },
    );

    await runtime.idle();

    expect(outcomes).toEqual([{
      kind: "error",
      message: "primitive failure",
    }]);
  });

  it("settles the commit callback when populateDependencies throws", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "settles commit callback when populateDependencies throws 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    let errors = 0;
    runtime.scheduler.onError(() => {
      errors++;
    });

    let handlerRan = false;
    const eventHandler: EventHandler = () => {
      handlerRan = true;
    };
    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
      () => {
        throw new Error("boom in populateDependencies");
      },
    );

    // A dependency-preflight throw drops the event before dispatch; that is
    // its final outcome, so the commit callback must observe it (errored tx)
    // rather than wait forever.
    const commitStatus = new Promise<string>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => resolve(commitTx.status().status),
      );
    });

    const status = await Promise.race([
      commitStatus,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("commit callback never settled")),
          1_000,
        )
      ),
    ]);
    expect(status).toBe("error");
    expect(errors).toBe(1);
    expect(handlerRan).toBe(false);
  });

  it("settles the commit callback when piece loading is disabled and no handler exists", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "settles commit callback with doNotLoadPieceIfNotRunning 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    // This is the second-pass situation: after a piece start, events are
    // re-queued with doNotLoadPieceIfNotRunning=true; if the piece still
    // registered no handler for this stream, the event can never dispatch.
    // That is a final outcome, so the commit callback must settle instead of
    // vanishing with the event.
    const commitStatus = new Promise<string>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => resolve(commitTx.status().status),
        true,
      );
    });

    const status = await Promise.race([
      commitStatus,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("commit callback never settled")),
          1_000,
        )
      ),
    ]);
    expect(status).toBe("error");
  });

  it("contains a throwing commit callback when settling a dropped event", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "contains throwing commit callback on drop 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit().settled;

    // A misbehaving commit callback must not break the caller or the queue:
    // the drop-settle path catches it, and a subsequent event on the same
    // (still handlerless) stream settles its own callback normally.
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      undefined,
      () => {
        throw new Error("boom in commit callback");
      },
      true,
    );

    const commitStatus = new Promise<string>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        2,
        undefined,
        (commitTx) => resolve(commitTx.status().status),
        true,
      );
    });

    const status = await Promise.race([
      commitStatus,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("commit callback never settled")),
          1_000,
        )
      ),
    ]);
    expect(status).toBe("error");
  });

  it("should trigger recomputation of dependent cells", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    const action = (tx: IExtendedStorageTransaction) => {
      actionCount++;
      lastEventSeen = eventResultCell.withTx(tx).get();
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await eventResultCell.pull();

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await eventResultCell.pull();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await eventResultCell.pull();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });

  it(
    "does not retry an event handler whose transaction aborts locally",
    async () => {
      // A handler that aborts its own transaction produces a local
      // StorageTransactionAborted. That is a deterministic rejection, not
      // contention: re-running the identical handler cannot make it converge, so
      // the scheduler drops it on the first attempt regardless of the retries
      // budget. (A ConflictError, by contrast, is retried within the
      // backpressure window — see scheduler-commit-backpressure.test.ts.)
      const eventCell = runtime.getCell<number>(
        space,
        "should not retry event handler on local abort",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit().settled;

      let attempts = 0;
      const handler: EventHandler = (handlerTx, _event) => {
        attempts++;
        handlerTx.abort("force-abort-no-retry");
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );

      // Default retries budget; the local abort is dropped regardless of it.
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
      );

      await runtime.idle();
      // Give any erroneous retry a chance to run, then confirm none did.
      await runtime.idle();

      expect(attempts).toBe(1);
    },
  );

  it(
    "drops an event that needs inSpace-name resolution when the caller opted out (retries: false)",
    async () => {
      // RetryImmediately is the inSpace("name") resolution signal: the handler
      // referenced a named pattern space that has just been resolved, and the
      // scheduler re-runs the handler so it resolves synchronously from the
      // cache. A retries: false event is a one-shot (a speculative lineage
      // origin, an internal one-shot) and opts out of that re-run: it drops the
      // write instead of re-running to resolve names.
      const eventCell = runtime.getCell<number>(
        space,
        "retries-false-inspace-resolution",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit().settled;

      let attempts = 0;
      let onCommitStatus: string | undefined;
      const handler: EventHandler = (_handlerTx, _event) => {
        attempts++;
        throw new RetryImmediately();
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );

      // retries: false opts out of both the commit-retry window and the
      // inSpace-name resolution re-run. The final-outcome callback still fires
      // once for the dropped one-shot.
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        false,
        (committedTx) => {
          onCommitStatus = committedTx.status().status;
        },
      );

      await runtime.idle();
      // Give any erroneous re-run a chance to run, then confirm none did.
      await runtime.idle();

      // The one-shot ran once and dropped without re-running to resolve names.
      expect(attempts).toBe(1);
      expect(onCommitStatus).toBeDefined();
    },
  );

  it(
    "reruns a served event after inSpace-name resolution even when commit retries are disabled",
    async () => {
      const eventCell = runtime.getCell<number>(
        space,
        "served-inspace-resolution-event",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit().settled;

      let attempts = 0;
      let commits = 0;
      const presyncIdentities: unknown[] = [];
      const handler: EventHandler = () => {
        attempts++;
        if (attempts === 1) {
          throw new RetryImmediately();
        }
      };
      handler.presyncInputs = (_event, identity) => {
        presyncIdentities.push(identity);
        return Promise.resolve();
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        false,
        () => {
          commits++;
        },
        false,
        {
          eventId: "served-inspace-resolution",
          served: {
            firedAt: { user: "did:key:served-user", session: "served-session" },
          },
        },
      );

      await runtime.idle();

      expect(attempts).toBe(2);
      expect(commits).toBe(1);
      expect(presyncIdentities).toEqual([
        {
          principal: "did:key:served-user",
          sessionId: "served-session",
        },
        {
          principal: "did:key:served-user",
          sessionId: "served-session",
        },
      ]);
    },
  );
});
