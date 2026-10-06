// Pull scheduler event handler dependency tests.

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
  Action,
  ErrorWithContext,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("handler dependency pulling", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should pull computed dependencies before running handler (handler is only reader)", async () => {
    // This test validates that when a handler's populateDependencies callback
    // reads a computed cell that has no other readers, the scheduler will
    // pull (compute) that value before running the handler.
    //
    // Setup:
    // - source cell: initial value
    // - computed action: reads source, writes to computedOutput
    // - event handler: reads computedOutput (via populateDependencies), writes to result
    // - The handler is the ONLY reader of computedOutput

    const source = runtime.getCell<number>(
      space,
      "handler-pull-source",
      undefined,
      tx,
    );
    source.set(10);

    const computedOutput = runtime.getCell<number>(
      space,
      "handler-pull-computed",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-pull-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-pull-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;
    const executionOrder: string[] = [];

    // Computed action: reads source, writes doubled value to computedOutput
    const computedAction: Action = (actionTx) => {
      computedRuns++;
      executionOrder.push("computed");
      const val = source.withTx(actionTx).get();
      computedOutput.withTx(actionTx).send(val * 2);
    };

    // Subscribe the computed action
    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(computedOutput.getAsNormalizedFullLink()),
        ],
      },
      {},
    );
    await computedOutput.pull();

    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(20); // 10 * 2

    // Event handler: reads computedOutput and adds the event value
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      executionOrder.push("handler");
      const computed = computedOutput.withTx(handlerTx).get();
      result.withTx(handlerTx).send(computed + event);
    };

    // populateDependencies callback - this tells the scheduler what the handler reads
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computedOutput.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset execution order tracking
    executionOrder.length = 0;
    computedRuns = 0;
    handlerRuns = 0;

    // Change source value - this marks computedAction as dirty
    source.withTx(tx).send(20);
    await tx.commit().settled;
    tx = runtime.edit();

    // The computed action should NOT run yet (pull mode, no reader)
    expect(computedRuns).toBe(0);

    // Now queue an event - this should trigger:
    // 1. Scheduler sees handler depends on computedOutput (via populateDependencies)
    // 2. computedOutput's producer (computedAction) is dirty
    // 3. Scheduler pulls computedAction first
    // 4. Then runs the handler
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await result.pull();

    // Computed should have run (pulled by handler dependency)
    expect(computedRuns).toBe(1);
    expect(computedOutput.get()).toBe(40); // 20 * 2

    // Handler should have run with the fresh computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(45); // 40 + 5

    // Execution order should be: computed first, then handler
    expect(executionOrder).toEqual(["computed", "handler"]);
  });

  it("does not prepare dependency-discovery reads in enforcing mode", async () => {
    await runtime.dispose();
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      {
        cfcEnforcementMode: "enforce-explicit",
        storageManager,
      },
    ));

    const labeledSource = runtime.getCell<number>(
      space,
      "handler-pull-labeled-source",
      {
        type: "number",
        ifc: { confidentiality: ["secret"] },
      } as JSONSchema,
      tx,
    );
    labeledSource.set(7);

    const eventStream = runtime.getCell<number>(
      space,
      "handler-pull-labeled-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    // The labeled schema makes this seed CFC-relevant, so it lands only when
    // it is prepared the way the runtime's own commit paths prepare.
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await labeledSource.pull();

    let handlerRuns = 0;
    const handler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      labeledSource.withTx(handlerTx).get();
      void event;
    };

    let discoveryWasReadOnly: boolean | undefined;
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      // The read-only mark is what keeps this labeled read out of CFC gating:
      // the commit boundary runs no CFC arm at all for a read-only
      // transaction, so discovery neither prepares nor is refused for
      // arriving unprepared. This callback is the only handle the case has on
      // the transaction the scheduler built.
      discoveryWasReadOnly = depTx.isReadOnly?.();
      labeledSource.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await runtime.idle();
    await runtime.storageManager.synced();

    expect(handlerRuns).toBe(1);
    expect(discoveryWasReadOnly).toBe(true);
  });

  it("should not pull dirty computations when handler reads a different path", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-path-source",
      undefined,
      tx,
    );
    source.set(1);

    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "handler-path-data",
      undefined,
      tx,
    );
    data.set({ foo: 0, bar: 5 });

    const eventStream = runtime.getCell<number>(
      space,
      "handler-path-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-path-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;

    const computedAction: Action = (actionTx) => {
      computedRuns++;
      const val = source.withTx(actionTx).get();
      data.withTx(actionTx).key("foo").send(val * 2);
    };

    runtime.scheduler.subscribe(
      computedAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(data.key("foo").getAsNormalizedFullLink()),
        ],
      },
      {},
    );

    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const barValue = data.withTx(handlerTx).key("bar").get();
      result.withTx(handlerTx).send(barValue + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      data.withTx(depTx).key("bar").get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    await runtime.scheduler.idle();

    computedRuns = 0;
    handlerRuns = 0;

    // Mark the computation dirty by changing its source.
    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await result.pull();

    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(8); // bar (5) + event (3)
    expect(computedRuns).toBe(0);
  });

  it("should handle multiple dirty dependencies before running handler", async () => {
    // Test that multiple dirty computed dependencies are all pulled before handler runs

    const source1 = runtime.getCell<number>(
      space,
      "handler-multi-source1",
      undefined,
      tx,
    );
    source1.set(10);

    const source2 = runtime.getCell<number>(
      space,
      "handler-multi-source2",
      undefined,
      tx,
    );
    source2.set(100);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-multi-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-multi-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-multi-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-multi-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // First computed action
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source1.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // Second computed action
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = source2.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val * 3);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [toMemorySpaceAddress(source1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [toMemorySpaceAddress(source2.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed2.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed1.pull();
    await computed2.pull();

    expect(computed1.get()).toBe(20);
    expect(computed2.get()).toBe(300);

    // Handler reads both computed values
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c1 = computed1.withTx(handlerTx).get();
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c1 + c2 + event);
    };

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed1.withTx(depTx).get();
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change both sources
    source1.withTx(tx).send(20);
    source2.withTx(tx).send(200);
    await tx.commit().settled;
    tx = runtime.edit();

    // Neither should run yet (pull mode)
    expect(computed1Runs).toBe(0);
    expect(computed2Runs).toBe(0);

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
    await result.pull();

    // Both computed should have run
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(40); // 20 * 2
    expect(computed2.get()).toBe(600); // 200 * 3

    // Handler should have run with fresh values
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(641); // 40 + 600 + 1
  });

  it("should re-queue event if dependencies change during pull", async () => {
    // Test the scenario where pulling one dependency causes another to become dirty
    // (e.g., a chain: source -> computed1 -> computed2 -> handler)
    // The handler should wait until the full chain is computed

    const source = runtime.getCell<number>(
      space,
      "handler-chain-source",
      undefined,
      tx,
    );
    source.set(5);

    const computed1 = runtime.getCell<number>(
      space,
      "handler-chain-computed1",
      undefined,
      tx,
    );
    const computed2 = runtime.getCell<number>(
      space,
      "handler-chain-computed2",
      undefined,
      tx,
    );

    const eventStream = runtime.getCell<number>(
      space,
      "handler-chain-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-chain-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computed1Runs = 0;
    let computed2Runs = 0;
    let handlerRuns = 0;

    // computed1 reads source
    const computedAction1: Action = (actionTx) => {
      computed1Runs++;
      const val = source.withTx(actionTx).get();
      computed1.withTx(actionTx).send(val * 2);
    };

    // computed2 reads computed1
    const computedAction2: Action = (actionTx) => {
      computed2Runs++;
      const val = computed1.withTx(actionTx).get();
      computed2.withTx(actionTx).send(val + 10);
    };

    runtime.scheduler.subscribe(
      computedAction1,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      computedAction2,
      {
        reads: [toMemorySpaceAddress(computed1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed2.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed2.pull();

    expect(computed1.get()).toBe(10); // 5 * 2
    expect(computed2.get()).toBe(20); // 10 + 10

    // Handler reads computed2 (end of chain)
    const eventHandler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      const c2 = computed2.withTx(handlerTx).get();
      result.withTx(handlerTx).send(c2 + event);
    };

    // populateDependencies reads computed2, but computed2 depends on computed1
    // which depends on source. When source changes, both computed actions are dirty.
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      computed2.withTx(depTx).get();
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventStream.getAsNormalizedFullLink(),
      populateDependencies,
    );

    // Reset counters
    computed1Runs = 0;
    computed2Runs = 0;
    handlerRuns = 0;

    // Change source - this makes computed1 dirty, and when computed1 runs,
    // it will make computed2 dirty
    source.withTx(tx).send(10);
    await tx.commit().settled;
    tx = runtime.edit();

    // Queue event
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await result.pull();

    // Both computed should have run in order
    expect(computed1Runs).toBe(1);
    expect(computed2Runs).toBe(1);
    expect(computed1.get()).toBe(20); // 10 * 2
    expect(computed2.get()).toBe(30); // 20 + 10

    // Handler should see the final computed value
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(33); // 30 + 3
  });

  it("should park a head event until a throttled dependency becomes runnable", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-throttle-source",
      undefined,
      tx,
    );
    source.set(1);

    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-computed",
      undefined,
      tx,
    );
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    const result = runtime.getCell<number>(
      space,
      "handler-throttle-result",
      undefined,
      tx,
    );
    result.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;

    const computation: Action = (actionTx) => {
      computedRuns++;
      const value = source.withTx(actionTx).get();
      computed.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed.pull();
    expect(computedRuns).toBe(1);
    expect(computed.get()).toBe(10);

    runtime.scheduler.setThrottle(computation, 100);

    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        const value = computed.withTx(handlerTx).get();
        result.withTx(handlerTx).send(value + event);
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.resetFilterStats();
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);

    await clock.tick(50);

    expect(computedRuns).toBe(1);
    expect(handlerRuns).toBe(0);
    expect(runtime.scheduler.getFilterStats().filtered).toBeLessThan(5);

    await clock.tick(70);
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(23);
  });

  it("should keep parked event wake when unrelated work queues execution", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-throttle-wake-source",
      undefined,
      tx,
    );
    source.set(1);
    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-wake-computed",
      undefined,
      tx,
    );
    const unrelated = runtime.getCell<number>(
      space,
      "handler-throttle-wake-unrelated",
      undefined,
      tx,
    );
    unrelated.set(0);
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-wake-events",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "handler-throttle-wake-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let computedRuns = 0;
    let handlerRuns = 0;
    let unrelatedRuns = 0;

    const computation: Action = (actionTx) => {
      computedRuns++;
      computed.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };
    const unrelatedEffect: Action = (actionTx) => {
      unrelatedRuns++;
      unrelated.withTx(actionTx).send(unrelatedRuns);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      unrelatedEffect,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(unrelated.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await computed.pull();
    await unrelated.pull();
    expect(computedRuns).toBe(1);

    runtime.scheduler.setThrottle(computation, 100);
    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        result.withTx(handlerTx).send(
          (computed.withTx(handlerTx).get() ?? 0) + event,
        );
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 3);
    await clock.tick(25);
    runtime.scheduler.queueExecution();

    await clock.tick(120);
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(23);
  });

  it("should report preflight dependency errors without wedging the scheduler", async () => {
    const eventStream = runtime.getCell<number>(
      space,
      "handler-preflight-error-events",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "handler-preflight-error-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const errors: string[] = [];
    runtime.scheduler.onError((error: ErrorWithContext) => {
      errors.push(error.message);
    });

    let handlerRuns = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        handlerRuns++;
        result.withTx(handlerTx).send(event);
      },
      eventStream.getAsNormalizedFullLink(),
      () => {
        throw new Error("preflight dependency failed");
      },
    );

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 7);
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(0);
    expect(result.get()).toBe(0);
    expect(
      errors.some((message) => message.includes("preflight dependency failed")),
    ).toBe(true);

    const followup: Action = (actionTx) => {
      result.withTx(actionTx).send(9);
    };
    runtime.scheduler.subscribe(
      followup,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await result.pull();
    expect(result.get()).toBe(9);
  });

  it("should not emit event preflight telemetry unless enabled", async () => {
    const preflights: EventPreflightMarker[] = [];
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: RuntimeTelemetryMarker }>)
        .detail.marker;
      if (marker.type === "scheduler.event.preflight") {
        preflights.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);

    try {
      const eventStream = runtime.getCell<number>(
        space,
        "handler-preflight-telemetry-events",
        undefined,
        tx,
      );
      eventStream.set(0);
      const result = runtime.getCell<number>(
        space,
        "handler-preflight-telemetry-result",
        undefined,
        tx,
      );
      result.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      runtime.scheduler.addEventHandler(
        (handlerTx, event: number) => {
          result.withTx(handlerTx).send(event);
        },
        eventStream.getAsNormalizedFullLink(),
        (depTx) => {
          result.withTx(depTx).get();
        },
      );

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
      await result.pull();
      expect(preflights).toEqual([]);

      runtime.scheduler.setEventPreflightTelemetryEnabled(true);
      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 2);
      await result.pull();
      expect(preflights.length).toBe(1);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("reports unavailable handler parks with reason and queue depth", async () => {
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
    const preflights: EventPreflightMarker[] = [];
    const listener = (event: Event) => {
      const marker = (event as CustomEvent<{ marker: RuntimeTelemetryMarker }>)
        .detail.marker;
      if (marker.type === "scheduler.event.preflight") {
        preflights.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);

    try {
      const eventStream = runtime.getCell<number>(
        space,
        "handler-unavailable-preflight-events",
        undefined,
        tx,
      );
      eventStream.set(0);
      const ready = runtime.getCell<boolean>(
        space,
        "handler-unavailable-preflight-ready",
        undefined,
        tx,
      );
      ready.set(false);
      await tx.commit().settled;
      tx = runtime.edit();

      let handlerRuns = 0;
      const handler: EventHandler = Object.assign(
        () => {
          handlerRuns++;
        },
        {
          inputReadiness: (readTx: IExtendedStorageTransaction) =>
            ready.withTx(readTx).get()
              ? { ready: true as const }
              : { ready: false as const, reason: "pending" as const },
        },
      );
      runtime.scheduler.addEventHandler(
        handler,
        eventStream.getAsNormalizedFullLink(),
        (readTx) => ready.withTx(readTx).get(),
      );

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
      await runtime.scheduler.idle();

      expect(handlerRuns).toBe(0);
      expect(preflights[0]?.inputUnavailableReason).toBe("pending");
      expect(preflights[0]?.queueDepth).toBe(1);
      expect(preflights[0]?.skipped).toBe(true);

      const readyTx = runtime.edit();
      ready.withTx(readyTx).set(true);
      await readyTx.commit().settled;
      await runtime.scheduler.idle();
      expect(handlerRuns).toBe(1);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should preserve FIFO order while the head event is parked", async () => {
    const source = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-source",
      undefined,
      tx,
    );
    source.set(1);

    const computed = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-computed",
      undefined,
      tx,
    );
    const eventStream = runtime.getCell<number>(
      space,
      "handler-throttle-fifo-events",
      undefined,
      tx,
    );
    eventStream.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let computedRuns = 0;
    const handledEvents: number[] = [];

    const computation: Action = (actionTx) => {
      computedRuns++;
      computed.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );

    await computed.pull();
    expect(computedRuns).toBe(1);

    runtime.scheduler.setThrottle(computation, 80);

    runtime.scheduler.addEventHandler(
      (handlerTx, event: number) => {
        computed.withTx(handlerTx).get();
        handledEvents.push(event);
      },
      eventStream.getAsNormalizedFullLink(),
      (depTx) => {
        computed.withTx(depTx).get();
      },
    );

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);

    await clock.tick(20);
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 2);

    await clock.tick(90);
    await runtime.scheduler.idle();

    expect(computedRuns).toBe(2);
    expect(handledEvents).toEqual([1, 2]);
  });

  it("should wait for dynamically created lift before dispatching to downstream handler", async () => {
    // This test validates that when handler A triggers a lift and handler B
    // depends on that lift's output, the scheduler waits for the lift to
    // compute before running handler B.
    //
    // Setup:
    // - Stream B: handler B reads liftOutput (via populateDependencies)
    // - Stream A: handler A writes to liftInput (triggering lift) and queues event to B
    // - Lift: reads liftInput, writes to liftOutput
    // - Send event to A's stream
    //
    // Expected: A runs -> lift runs -> B runs (with fresh lift output)

    // Stream B - the downstream handler
    const streamB = runtime.getCell<number>(
      space,
      "dynamic-lift-streamB",
      undefined,
      tx,
    );
    streamB.set(0);

    // Cell to store what handler B sees from the lift output
    const handlerBSawLiftOutput = runtime.getCell<number[]>(
      space,
      "dynamic-lift-B-saw",
      undefined,
      tx,
    );
    handlerBSawLiftOutput.set([]);

    // Stream A - the upstream handler
    const streamA = runtime.getCell<number>(
      space,
      "dynamic-lift-streamA",
      undefined,
      tx,
    );
    streamA.set(0);

    // Lift input/output cells
    const liftInput = runtime.getCell<number>(
      space,
      "dynamic-lift-input",
      undefined,
      tx,
    );
    liftInput.set(0);

    const liftOutput = runtime.getCell<number>(
      space,
      "dynamic-lift-output",
      undefined,
      tx,
    );
    liftOutput.set(0);

    await tx.commit().settled;
    tx = runtime.edit();

    let handlerARuns = 0;
    let handlerBRuns = 0;
    let liftRuns = 0;
    const executionOrder: string[] = [];

    // Lift action: transforms input by doubling it
    const liftAction: Action = (actionTx) => {
      liftRuns++;
      executionOrder.push("lift");
      const input = liftInput.withTx(actionTx).get();
      liftOutput.withTx(actionTx).send(input * 2);
    };

    // Subscribe the lift with a registration-time surface - NOT scheduled immediately
    // This tests that the lift is pulled when handler B needs it
    runtime.scheduler.subscribe(liftAction, {
      reads: [toMemorySpaceAddress(liftInput.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(liftOutput.getAsNormalizedFullLink())],
    });

    await runtime.idle();
    expect(liftRuns).toBe(0); // NOT run yet - using rescheduling mode
    expect(liftOutput.get()).toBe(0); // Still initial value

    // Handler B: receives a LINK to liftOutput as the event, reads from it
    const handlerB: EventHandler = (handlerTx, _event: { "/": string }) => {
      handlerBRuns++;
      // The event IS a link to liftOutput - read from it
      // This simulates a handler receiving a reference to computed data
      const liftVal = liftOutput.withTx(handlerTx).get();
      executionOrder.push(`handlerB:lift=${liftVal}`);
      const saw = handlerBSawLiftOutput.withTx(handlerTx).get();
      handlerBSawLiftOutput.withTx(handlerTx).send([...saw, liftVal]);
    };

    // Handler B's populateDependencies - resolves the event link to capture dependency
    // The event IS a link to liftOutput, so we create a cell from it and read
    const handlerBPopulateDeps = (
      depTx: IExtendedStorageTransaction,
      eventValue: { "/": string },
    ) => {
      // Create a cell from the event (which is a link) and read it
      // This registers the dependency on whatever the link points to
      const eventCell = runtime.getImmutableCell(
        space,
        eventValue,
        undefined,
        depTx,
      );
      eventCell.get();
    };

    // Handler A: writes to liftInput and queues a LINK to liftOutput as event to B
    const handlerA: EventHandler = (handlerTx, event: number) => {
      handlerARuns++;
      executionOrder.push(`handlerA:${event}`);

      // Write to lift input - this will make the lift dirty
      liftInput.withTx(handlerTx).send(event);

      // Queue an event to stream B where the event VALUE is a link to liftOutput
      // This simulates: "hey B, go read from this computed cell"
      // The scheduler should see that B depends on liftOutput and pull the lift first
      const liftOutputLink = liftOutput.getAsLink();
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        liftOutputLink,
      );
    };

    // Register handlers
    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
      handlerBPopulateDeps,
    );

    await runtime.idle();

    // Reset tracking
    executionOrder.length = 0;
    handlerARuns = 0;
    handlerBRuns = 0;
    liftRuns = 0;

    // Send event to stream A with value 5
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), 5);
    await handlerBSawLiftOutput.pull();

    // Handler A should have run
    expect(handlerARuns).toBe(1);

    // Lift should have run (its input changed from 0 to 5)
    expect(liftRuns).toBe(1);
    expect(liftOutput.get()).toBe(10); // 5 * 2

    // Handler B should have run and seen the FRESH lift output (10, not stale 0)
    expect(handlerBRuns).toBe(1);
    expect(handlerBSawLiftOutput.get()).toEqual([10]);

    // Verify execution order
    expect(executionOrder).toContain("handlerA:5");
    expect(executionOrder).toContain("lift");

    // The lift should run before handler B sees the fresh value
    const liftIndex = executionOrder.indexOf("lift");
    const handlerBIndex = executionOrder.findIndex((s) =>
      s.startsWith("handlerB:")
    );
    expect(liftIndex).toBeLessThan(handlerBIndex);

    // Handler B should have seen lift=10 (the fresh value, not stale 0)
    expect(executionOrder.find((s) => s.startsWith("handlerB:"))).toBe(
      "handlerB:lift=10",
    );
  });
});
