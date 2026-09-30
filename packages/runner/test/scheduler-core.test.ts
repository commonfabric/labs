// Core scheduler tests: basic pull-scheduler behavior.

import {
  afterEach,
  assertSpyCalls,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  ignoreReadForScheduling,
  it,
  Runtime,
  space,
  spy,
  storedCfcMetadataAppliesToPath,
  toMemorySpaceAddress,
  txToReactivityLog,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { getDirectTransactionReactivityLog } from "../src/storage/transaction-inspection.ts";
import { PASS_RUN_BUDGET } from "../src/scheduler/constants.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { FabricValue } from "@commonfabric/data-model";

// Seed stored CFC metadata with a path-[] full-document write, reading the
// current doc first so the value survives. Every write that reaches a
// document's reserved siblings from outside the runtime's privileged
// persistence scope is recorded as label forgery (audit S18), so the seed
// goes through `seedStoredEnvelope`, which runs inside that scope.
const seedPrivilegedCfc = (
  tx: unknown,
  address: unknown,
  metadata: unknown,
): void => {
  const t = tx as IExtendedStorageTransaction;
  const docAddress = {
    ...(address as Record<string, unknown>),
    path: [],
  } as unknown as IMemorySpaceAddress;
  let current: unknown;
  try {
    current = t.readOrThrow(docAddress);
  } catch {
    current = undefined;
  }
  const base = current && typeof current === "object" ? current : {};
  seedStoredEnvelope(t, docAddress, {
    ...base,
    cfc: metadata,
  } as FabricValue);
};

describe("scheduler", () => {
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

  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should run actions when cells change 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions when cells change 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions when cells change 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.withTx(tx).send(2); // Simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [
        toMemorySpaceAddress(a.getAsNormalizedFullLink()),
        toMemorySpaceAddress(b.getAsNormalizedFullLink()),
      ],
      shallowReads: [],
      writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2); // No log, simulate external change
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("normalizes non-Error action throws before error handlers", async () => {
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });

    const throwingAction: Action = () => {
      throw "boom";
    };

    runtime.scheduler.subscribe(throwingAction, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });

    await runtime.scheduler.idle();

    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe("boom");
  });

  it("should re-run an async read-only effect when invalidated while paused", async () => {
    const source = runtime.getCell<number>(
      space,
      "paused-read-only-effect-source",
      undefined,
      tx,
    );
    source.set(0);
    await tx.commit();
    tx = runtime.edit();

    const seen: number[] = [];
    let runCount = 0;
    let startedResolve = () => {};
    let started = Promise.resolve();
    let allowResolve = () => {};
    let allowFinish = Promise.resolve();

    const effect: Action = async (actionTx) => {
      runCount++;
      const value = source.withTx(actionTx).get();
      if (runCount === 2) {
        startedResolve();
        await allowFinish;
      }
      seen.push(value);
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    expect(seen).toEqual([0]);

    started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    allowFinish = new Promise((resolve) => {
      allowResolve = resolve;
    });

    source.withTx(tx).send(1);
    await tx.commit();
    tx = runtime.edit();

    await started;

    const conflictingTx = runtime.edit();
    source.withTx(conflictingTx).send(2);
    await conflictingTx.commit();

    allowResolve();

    await runtime.scheduler.idle();

    expect(seen).toEqual([0, 1, 2]);
  });

  it("captures trigger trace for a change and downstream scheduled effects", async () => {
    const a = runtime.getCell<number>(
      space,
      "captures trigger trace source",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "captures trigger trace intermediate",
      undefined,
      tx,
    );
    b.set(0);
    const c = runtime.getCell<number>(
      space,
      "captures trigger trace sink",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    function computeIntermediate(tx: IExtendedStorageTransaction) {
      b.withTx(tx).send(
        (a.withTx(tx).get() ?? 0) + 1,
      );
    }

    function effectSink(tx: IExtendedStorageTransaction) {
      c.withTx(tx).send(
        b.withTx(tx).get() ?? 0,
      );
    }

    runtime.scheduler.subscribe(
      computeIntermediate,
      {
        reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
      },
      { changeGroup: "compute-intermediate-change-group" },
    );
    runtime.scheduler.subscribe(
      effectSink,
      {
        reads: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await c.pull();
    expect(c.get()).toBe(2);

    runtime.scheduler.setTriggerTraceEnabled(false);
    runtime.scheduler.setTriggerTraceEnabled(true);

    a.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await c.pull();

    const trace = runtime.scheduler.getTriggerTrace();
    const sourceInvalidation = trace.find((entry) =>
      entry.triggered.some((record) =>
        record.actionId === "computeIntermediate" &&
        record.decision === "mark-invalid"
      )
    );
    const downstreamInvalidation = trace.find((entry) =>
      entry.triggered.some((record) =>
        record.actionId === "effectSink" &&
        record.decision === "mark-invalid"
      )
    );

    expect(trace.length).toBeGreaterThan(0);
    expect(sourceInvalidation).toBeDefined();
    expect(downstreamInvalidation).toBeDefined();
    const intermediateEntityId = b.getAsNormalizedFullLink().id;
    expect(
      trace.some((entry) =>
        entry.entityId === intermediateEntityId &&
        entry.writerActionId === "computeIntermediate"
      ),
      "captures writer action IDs outside diagnosis mode",
    ).toBe(true);
  });

  it("rechecks downstream readers after delayed computation commits", async () => {
    const a = runtime.getCell<number>(
      space,
      "delayed computation commit source",
      undefined,
      tx,
    );
    a.set(0);
    const b = runtime.getCell<number>(
      space,
      "delayed computation commit intermediate",
      undefined,
      tx,
    );
    b.set(0);
    const c = runtime.getCell<number>(
      space,
      "delayed computation commit sink",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    function computeIntermediate(actionTx: IExtendedStorageTransaction) {
      const nextValue = a.withTx(actionTx).get() ?? 0;
      b.withTx(actionTx).send(nextValue);
      if (nextValue === 1) {
        const originalCommit = actionTx.commit.bind(actionTx);
        actionTx.commit = () =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              originalCommit().then(resolve, reject);
            }, 25);
          });
      }
    }

    function effectSink(actionTx: IExtendedStorageTransaction) {
      c.withTx(actionTx).send(b.withTx(actionTx).get() ?? 0);
    }

    runtime.scheduler.subscribe(
      computeIntermediate,
      {
        reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
      },
    );
    runtime.scheduler.subscribe(
      effectSink,
      {
        reads: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await c.pull();
    expect(c.get()).toBe(0);

    a.withTx(tx).send(1);
    await tx.commit();
    tx = runtime.edit();

    // The intermediate delays its own commit by 25ms (a modeled slow
    // computation). Drive the scheduler so it arms the delay, fire it, then let
    // the downstream effect re-run against the committed value.
    await runtime.scheduler.idle();
    await clock.tick(25);
    await runtime.scheduler.idle();

    expect(c.get()).toBe(1);
  });

  it("captures exact action runs for one reactive update", async () => {
    const a = runtime.getCell<number>(
      space,
      "captures action run trace source",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "captures action run trace intermediate",
      undefined,
      tx,
    );
    b.set(0);
    const c = runtime.getCell<number>(
      space,
      "captures action run trace sink",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit();
    tx = runtime.edit();

    function computeIntermediate(tx: IExtendedStorageTransaction) {
      b.withTx(tx).send(
        (a.withTx(tx).get() ?? 0) + 1,
      );
    }

    function effectSink(tx: IExtendedStorageTransaction) {
      c.withTx(tx).send(
        b.withTx(tx).get() ?? 0,
      );
    }

    runtime.scheduler.subscribe(
      computeIntermediate,
      {
        reads: [toMemorySpaceAddress(a.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
      },
    );
    runtime.scheduler.subscribe(
      effectSink,
      {
        reads: [toMemorySpaceAddress(b.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await c.pull();
    expect(c.get()).toBe(2);

    runtime.scheduler.setActionRunTraceEnabled(false);
    runtime.scheduler.setActionRunTraceEnabled(true);

    a.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await c.pull();

    const trace = runtime.scheduler.getActionRunTrace();
    const computeRuns = trace.filter((entry) =>
      entry.actionId === "computeIntermediate"
    );
    const effectRuns = trace.filter((entry) => entry.actionId === "effectSink");

    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(computeRuns.length).toBeGreaterThanOrEqual(1);
    expect(effectRuns.length).toBeGreaterThanOrEqual(1);
    expect(computeRuns.at(-1)?.actionType).toBe("computation");
    expect(effectRuns.at(-1)?.actionType).toBe("effect");
    expect(computeRuns.at(-1)?.declaredWrites.length).toBe(1);
    expect(effectRuns.at(-1)?.declaredWrites.length).toBe(0);
    expect(computeRuns.at(-1)?.actualWrites).toEqual(
      computeRuns.at(-1)?.declaredWrites,
    );
    expect(effectRuns.at(-1)?.actualWrites.length).toBe(1);
    expect(computeRuns.at(-1)?.declaredWrites[0]).toMatchObject({
      space,
      entityId: expect.stringMatching(/^of:/),
      path: ["value"],
    });
    expect(effectRuns.at(-1)?.actualWrites[0]).toMatchObject({
      space,
      entityId: expect.stringMatching(/^of:/),
      path: ["value"],
    });
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should remove actions 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should remove actions 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should remove actions 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unsubscribe(adder);
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const cancel = runtime.scheduler.subscribe(adder, {
      reads: [
        toMemorySpaceAddress(a.getAsNormalizedFullLink()),
        toMemorySpaceAddress(b.getAsNormalizedFullLink()),
      ],
      shallowReads: [],
      writes: [toMemorySpaceAddress(c.getAsNormalizedFullLink())],
    }, {});
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await c.pull();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = runtime.getCell<number>(
      space,
      "should run actions in topological order 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions in topological order 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions in topological order 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should run actions in topological order 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should run actions in topological order 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      runs.push("adder1");
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      runs.push("adder2");
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder1, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await e.pull();
    runtime.scheduler.subscribe(adder2, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await e.pull();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
    let maxRuns = PASS_RUN_BUDGET + 1;
    const a = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    const adder3: Action = (tx) => {
      if (--maxRuns <= 0) return;
      c.withTx(tx).send(
        e.withTx(tx).get() + b.withTx(tx).get(),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(adder1, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await e.pull();
    runtime.scheduler.subscribe(adder2, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await e.pull();
    runtime.scheduler.subscribe(adder3, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await e.pull();

    await e.pull();

    expect(maxRuns).toBe(0);
    assertSpyCalls(stopped, 0);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 1",
      undefined,
      tx,
    );
    counter.set(0);
    const by = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 2",
      undefined,
      tx,
    );
    by.set(1);
    tx.commit();
    tx = runtime.edit();
    const inc: Action = (tx) =>
      counter
        .withTx(tx)
        .send(counter.withTx(tx).get() + by.withTx(tx).get());

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(inc, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await counter.pull();
    expect(counter.get()).toBe(1);
    await counter.pull();
    expect(counter.get()).toBe(1);

    by.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await counter.pull();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should ignore its own optimistic commit notifications but react to external commits", async () => {
    let runCount = 0;
    const counter = runtime.getCell<number>(
      space,
      "self-commit-ignore-counter",
      undefined,
      tx,
    );
    counter.set(0);
    const step = runtime.getCell<number>(
      space,
      "self-commit-ignore-step",
      undefined,
      tx,
    );
    step.set(1);
    await tx.commit();
    tx = runtime.edit();

    const increment: Action = (actionTx) => {
      runCount++;
      counter.withTx(actionTx).send(
        counter.withTx(actionTx).get() + step.withTx(actionTx).get(),
      );
    };

    runtime.scheduler.subscribe(
      increment,
      {
        reads: [
          toMemorySpaceAddress(counter.getAsNormalizedFullLink()),
          toMemorySpaceAddress(step.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();
    expect(runCount).toBe(1);
    expect(counter.get()).toBe(1);

    counter.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();

    await runtime.scheduler.idle();
    expect(runCount).toBe(2);
    expect(counter.get()).toBe(11);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.subscribe(inc, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {
      isEffect: true,
    });
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it("should not create dependencies when using getRaw with ignoreReadForScheduling", async () => {
    // Create a source cell that will be read with ignored metadata
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "source-cell-for-ignore-test",
      undefined,
      tx,
    );
    sourceCell.set({ value: 1 });

    // Create a result cell to track action runs (avoiding self-dependencies)
    const resultCell = runtime.getCell<{ count: number; lastValue: any }>(
      space,
      "result-cell-for-ignore-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastValue: null });
    tx.commit();
    tx = runtime.edit();

    let actionRunCount = 0;
    let lastReadValue: any;

    // Action that ONLY uses ignored reads
    const ignoredReadAction: Action = (actionTx) => {
      actionRunCount++;

      // Read with ignoreReadForScheduling - should NOT create dependency
      lastReadValue = sourceCell.withTx(actionTx).getRaw({
        meta: ignoreReadForScheduling,
      });

      // Write to result cell to track that the action ran
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastValue: lastReadValue,
      });
    };

    // Run the action initially
    runtime.scheduler.subscribe(
      ignoredReadAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await resultCell.pull();
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.withTx(tx).set({ value: 10 });
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });

  it("should react to stored CFC metadata updates read through verifier helpers", async () => {
    const sourceCell = runtime.getCell<{ secret: string }>(
      space,
      "source-cell-for-cfc-metadata-reactivity-test",
      {
        type: "object",
        properties: {
          secret: { type: "string" },
        },
        required: ["secret"],
      },
      tx,
    );
    sourceCell.set({ secret: "seed" });

    const resultCell = runtime.getCell<{ count: number; applies: boolean }>(
      space,
      "result-cell-for-cfc-metadata-reactivity-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, applies: false });
    tx.commit();
    tx = runtime.edit();

    const secretLink = sourceCell.key("secret").getAsNormalizedFullLink();

    let actionRunCount = 0;
    let lastApplies = false;

    const cfcMetadataReadAction: Action = (actionTx) => {
      actionRunCount++;
      lastApplies = storedCfcMetadataAppliesToPath(actionTx, secretLink);
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        applies: lastApplies,
      });
    };

    runtime.scheduler.subscribe(
      cfcMetadataReadAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await resultCell.pull();

    expect(actionRunCount).toBe(1);
    expect(lastApplies).toBe(false);
    expect(resultCell.get()).toEqual({ count: 1, applies: false });

    seedPrivilegedCfc(
      tx,
      {
        space: secretLink.space,
        id: secretLink.id,
        path: ["cfc"],
      },
      {
        version: 1,
        schemaHash: "cfc-reactivity-test-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["secret"] },
          }],
        },
      },
    );
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    expect(actionRunCount).toBe(2);
    expect(resultCell.get()).toEqual({ count: 2, applies: true });

    const verifyTx = runtime.edit();
    expect(storedCfcMetadataAppliesToPath(verifyTx, secretLink)).toBe(true);
    await verifyTx.commit();
  });

  it("should react to direct reads of stored CFC metadata when the cfc field changes", async () => {
    const sourceCell = runtime.getCell<{ secret: string }>(
      space,
      "source-cell-for-direct-cfc-read-reactivity-test",
      {
        type: "object",
        properties: {
          secret: { type: "string" },
        },
        required: ["secret"],
      },
      tx,
    );
    sourceCell.set({ secret: "seed" });

    const resultCell = runtime.getCell<{ count: number; version: number }>(
      space,
      "result-cell-for-direct-cfc-read-reactivity-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, version: 0 });
    tx.commit();
    tx = runtime.edit();

    const sourceLink = sourceCell.getAsNormalizedFullLink();

    let actionRunCount = 0;
    let lastVersion = 0;

    const directCfcReadAction: Action = (actionTx) => {
      actionRunCount++;
      const cfcDocument = actionTx.readOrThrow({
        space: sourceLink.space,
        id: sourceLink.id,
        path: ["cfc"],
      }) as { version?: number } | undefined;
      lastVersion = cfcDocument?.version ?? 0;
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        version: lastVersion,
      });
    };

    runtime.scheduler.subscribe(
      directCfcReadAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await resultCell.pull();

    expect(actionRunCount).toBe(1);
    expect(lastVersion).toBe(0);
    expect(resultCell.get()).toEqual({ count: 1, version: 0 });

    seedPrivilegedCfc(
      tx,
      {
        space: sourceLink.space,
        id: sourceLink.id,
        path: ["cfc"],
      },
      {
        version: 1,
        schemaHash: "cfc-direct-read-reactivity-test-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["secret"] },
          }],
        },
      },
    );
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    expect(actionRunCount).toBe(2);
    expect(lastVersion).toBe(1);
    expect(resultCell.get()).toEqual({ count: 2, version: 1 });
  });

  it("should track attemptedWrites via Cell.set on nested path", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{ nested: { a: number; b: string } }>(
      space,
      "attempted-writes-cell-set-test",
      undefined,
      tx,
    );
    testCell.set({ nested: { a: 1, b: "hello" } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where `a` stays the same but `b` changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("nested").set({ a: 1, b: "world" });

    const storageLog = getDirectTransactionReactivityLog(setTx)!;
    const schedulerLog = txToReactivityLog(setTx);

    // key("nested").set() reads the nested object to compare.
    // The "nested" path should appear in attemptedWrites for CFC/security,
    // but scheduler-facing ReactivityLog should not expose attemptedWrites.
    const schedulerLogWithAttemptedWrites = schedulerLog as
      & typeof schedulerLog
      & {
        attemptedWrites?: typeof schedulerLog.writes;
      };
    expect(storageLog.attemptedWrites).toBeDefined();
    expect(schedulerLogWithAttemptedWrites.attemptedWrites).toBeUndefined();
    expect(
      storageLog.attemptedWrites!.some((addr) =>
        addr.path[0] === "value" && addr.path[1] === "nested"
      ),
    ).toBe(true);

    // Only `b` changed within nested, so nested.b should be in writes
    expect(
      schedulerLog.writes.some((w) =>
        w.path[0] === "value" && w.path[1] === "nested" && w.path[2] === "b"
      ),
    ).toBe(true);
    // nested.a should NOT be in writes (value didn't change)
    expect(
      schedulerLog.writes.some((w) =>
        w.path[0] === "value" && w.path[1] === "nested" && w.path[2] === "a"
      ),
    ).toBe(false);

    await setTx.commit();
  });

  it("should include nested path in attemptedWrites when using key().set()", async () => {
    // Create a cell with nested structure
    const testCell = runtime.getCell<{
      data: { unchanged: number; changed: number };
    }>(
      space,
      "diff-update-attempted-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ data: { unchanged: 42, changed: 1 } });
    tx.commit();
    tx = runtime.edit();

    // In a new transaction, set nested values where only one property changes
    const setTx = runtime.edit();
    testCell.withTx(setTx).key("data").set({ unchanged: 42, changed: 999 });

    const storageLog = getDirectTransactionReactivityLog(setTx)!;
    const schedulerLog = txToReactivityLog(setTx);

    // The "data" path should be in attemptedWrites because diffAndUpdate
    // reads the nested object to compare.
    const schedulerLogWithAttemptedWrites = schedulerLog as
      & typeof schedulerLog
      & {
        attemptedWrites?: typeof schedulerLog.writes;
      };
    expect(storageLog.attemptedWrites).toBeDefined();
    expect(schedulerLogWithAttemptedWrites.attemptedWrites).toBeUndefined();
    expect(
      storageLog.attemptedWrites!.some((addr) =>
        addr.path[0] === "value" && addr.path[1] === "data"
      ),
    ).toBe(true);

    // Only changed property within data should be in writes
    expect(
      schedulerLog.writes.some((w) =>
        w.path[0] === "value" && w.path[1] === "data" &&
        w.path[2] === "changed"
      ),
    ).toBe(true);
    // unchanged property should NOT be in writes (value didn't change)
    expect(
      schedulerLog.writes.some((w) =>
        w.path[0] === "value" && w.path[1] === "data" &&
        w.path[2] === "unchanged"
      ),
    ).toBe(false);

    await setTx.commit();
  });

  it("should not have attemptedWrites when using getRaw without metadata", async () => {
    const testCell = runtime.getCell<{ value: number }>(
      space,
      "no-attempted-writes-cell",
      undefined,
      tx,
    );
    testCell.set({ value: 1 });
    tx.commit();
    tx = runtime.edit();

    // getRaw without metadata should not create attemptedWrites
    const readTx = runtime.edit();
    testCell.withTx(readTx).key("value").getRaw();

    const storageLog = getDirectTransactionReactivityLog(readTx)!;
    const schedulerLog = txToReactivityLog(readTx);

    // Should have reads but no attemptedWrites
    const schedulerLogWithAttemptedWrites = schedulerLog as
      & typeof schedulerLog
      & {
        attemptedWrites?: typeof schedulerLog.writes;
      };
    expect(schedulerLog.reads.length).toBeGreaterThanOrEqual(1);
    expect(storageLog.attemptedWrites).toBeUndefined();
    expect(schedulerLogWithAttemptedWrites.attemptedWrites).toBeUndefined();

    await readTx.commit();
  });

  it("should track non-recursive reads separately in reactivity logs", async () => {
    const testCell = runtime.getCell<{ value: { nested: number } }>(
      space,
      "non-recursive-log-cell",
      undefined,
      tx,
    );
    testCell.set({ value: { nested: 1 } });
    tx.commit();
    tx = runtime.edit();

    const readTx = runtime.edit();
    testCell.withTx(readTx).key("value").getRaw({ nonRecursive: true });

    const log = txToReactivityLog(readTx);
    expect(log.shallowReads.length).toBeGreaterThanOrEqual(1);
    expect(log.shallowReads.some((addr) => addr.path[0] === "value"))
      .toBe(true);

    await readTx.commit();
  });

  it("should track getMetaRaw reads in the normal scheduler read log", async () => {
    const testCell = runtime.getCell<{ value: number }>(
      space,
      "meta-read-log-cell",
      undefined,
      tx,
    );
    testCell.set({ value: 1 });
    testCell.setMetaRaw("slug", "tracked-slug", rawMetaWriteAuthorization);
    tx.commit();
    tx = runtime.edit();

    const readTx = runtime.edit();
    expect(testCell.withTx(readTx).getMetaRaw("slug")).toBe("tracked-slug");

    const log = txToReactivityLog(readTx);
    expect(
      log.reads.some((addr) =>
        addr.id === testCell.getAsNormalizedFullLink().id &&
        addr.path.length === 1 &&
        addr.path[0] === "slug"
      ),
    ).toBe(true);
    expect(
      log.shallowReads.some((addr) =>
        addr.id === testCell.getAsNormalizedFullLink().id &&
        addr.path[0] === "slug"
      ),
    ).toBe(false);

    await readTx.commit();
  });

  it("should track read without load for scheduling and still trigger on writes", async () => {
    const sourceCell = runtime.getCell<number>(
      space,
      "source-cell-for-track-without-load",
      undefined,
      tx,
    );
    sourceCell.set(1);

    const resultCell = runtime.getCell<{ count: number; lastRead: unknown }>(
      space,
      "result-cell-for-track-without-load",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastRead: null });
    tx.commit();
    tx = runtime.edit();

    const sourceLink = sourceCell.getAsNormalizedFullLink();
    const sourceAddress = toMemorySpaceAddress(sourceLink);

    let actionRunCount = 0;
    const action: Action = (actionTx) => {
      actionRunCount++;
      const readResult = actionTx.read(sourceAddress, {
        trackReadWithoutLoad: true,
      });
      // sourceCell has a value, but trackReadWithoutLoad should not fetch it.
      expect(readResult.error).toBeUndefined();
      expect(readResult.ok?.value).toBeUndefined();
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastRead: readResult.ok?.value,
      });
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await resultCell.pull();
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastRead: undefined });

    // Write to the same address: tracked read should still invalidate.
    sourceCell.withTx(tx).set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();

    expect(actionRunCount).toBe(2);
    expect(resultCell.get()).toEqual({ count: 2, lastRead: undefined });
  });

  it("non-recursive read through link chain does not re-trigger on value update", async () => {
    // docA holds a link to docB at path ["foo", "bar"]
    // docB's root value is itself a link to docC
    // docC holds { baz: 1 }
    // Reading docA traverses docA → docB → docC and registers non-recursive
    // reads at each link target.  Updating an existing key in docC must not
    // trigger because the reads are non-recursive (only new keys trigger).
    const docA = runtime.getCell<unknown>(
      space,
      "link-chain-docA",
      undefined,
      tx,
    );
    const docB = runtime.getCell<unknown>(
      space,
      "link-chain-docB",
      undefined,
      tx,
    );
    const docC = runtime.getCell<{ baz: number; newKey?: string }>(
      space,
      "link-chain-docC",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "link-chain-result",
      undefined,
      tx,
    );

    // docA links to docB at ["foo","bar"]
    // docB.foo links to docC at []
    // A read of docA will not cause us to react to a write of docC.baz
    const docBDeepLink = docB.key("foo").key("bar").cellLink;
    docA.withTx(tx).setRaw(docBDeepLink); // points to B.foo.bar (or C.bar)
    docB.withTx(tx).setRaw({ foo: docC.cellLink }); // B.foo points to C
    docC.withTx(tx).setRaw({ baz: 1, bar: 2 });
    resultCell.withTx(tx).set(0);
    tx.commit();
    tx = runtime.edit();

    const docALink = docA.getAsNormalizedFullLink();
    const docBLink = docB.getAsNormalizedFullLink();
    const docCLink = docC.getAsNormalizedFullLink();
    const type = "application/json" as const;

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      // Mirror the non-recursive reads that followPointer (traverse.ts) registers
      // when traversing docA → docB → docC through the link chain.
      actionTx.read(
        {
          space: docALink.space,
          id: docALink.id,
          type,
          path: ["value"],
        },
        { nonRecursive: true },
      );
      actionTx.read(
        { space: docBLink.space, id: docBLink.id, type, path: ["value"] },
        { nonRecursive: true },
      );
      // docC root: non-recursive and scheduling-only (value already loaded via
      // the reads above; we just need to track the dependency).
      actionTx.read(
        { space: docCLink.space, id: docCLink.id, type, path: ["value"] },
        { nonRecursive: true, trackReadWithoutLoad: true },
      );
      resultCell.withTx(actionTx).set(runCount);
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.baz (existing key, value change only) — must NOT trigger.
    docC.withTx(tx).key("baz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Add a new direct key to docC — MUST trigger (non-recursive reads fire on key add).
    docC.withTx(tx).key("fiz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(2);
  });

  it("cell.get on docA inside action does not add recursive scheduling deps for docC", async () => {
    // Same link chain: docA → docB.foo.bar → docC
    // The action only calls docA.get() — no manual actionTx.read calls.
    // docA.get() should internally register only the reads it needs (non-recursive
    // through the link chain) and must not add recursive deps on docC, so
    // updating an existing key in docC must NOT re-trigger.
    const docA = runtime.getCell<unknown>(
      space,
      "link-chain-get-docA",
      undefined,
      tx,
    );
    const docB = runtime.getCell<unknown>(
      space,
      "link-chain-get-docB",
      undefined,
      tx,
    );
    const docC = runtime.getCell<{ baz: number; newKey?: string }>(
      space,
      "link-chain-get-docC",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "link-chain-get-result",
      undefined,
      tx,
    );

    const docBDeepLink = docB.key("foo").key("bar").cellLink;
    docA.withTx(tx).setRaw(docBDeepLink);
    docB.withTx(tx).setRaw({ foo: docC.cellLink });
    docC.withTx(tx).setRaw({ baz: 1, bar: 2 });
    resultCell.withTx(tx).set(0);
    tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      // Only cell.get — all scheduling deps come from this single call.
      docA.withTx(actionTx).get();
      resultCell.withTx(actionTx).set(runCount);
    };

    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.baz (existing key, value change only) — must NOT trigger.
    docC.withTx(tx).key("baz").set(2);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(1);

    // Update docC.bar (existing key, value change only) — must trigger.
    docC.withTx(tx).key("bar").set(3);
    tx.commit();
    tx = runtime.edit();
    await resultCell.pull();
    expect(runCount).toBe(2);
  });
});
