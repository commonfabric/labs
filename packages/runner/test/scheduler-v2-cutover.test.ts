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
  Cell,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import {
  BACKOFF_BASE_MS,
  CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
  PASS_RUN_BUDGET,
} from "../src/scheduler/constants.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  type DependencyGraphState,
  isLive,
  recomputeLiveRefs,
  registerDependentEdge,
  unregisterDependentEdge,
} from "../src/scheduler/dependency-graph.ts";
import { SchedulerGates } from "../src/scheduler/gates.ts";
import { planBudgetBackoff } from "../src/scheduler/execution.ts";

async function expectSchedulerIdle(runtime: Runtime): Promise<void> {
  const result = await Promise.race([
    runtime.scheduler.idle().then(() => "idle" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 2_000)
    ),
  ]);
  expect(result).toBe("idle");
}

describe("scheduler v2 cutover fixtures", () => {
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

  it("rewires conditional reads when the active branch changes", async () => {
    const condition = runtime.getCell<boolean>(
      space,
      "v2-cutover-ifelse-condition",
      undefined,
      tx,
    );
    const left = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-left",
      undefined,
      tx,
    );
    const right = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-right",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-output",
      undefined,
      tx,
    );
    condition.set(true);
    left.set(10);
    right.set(20);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const chooser = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const active = condition.withTx(actionTx).get()
          ? left.withTx(actionTx).get()
          : right.withTx(actionTx).get();
        output.withTx(actionTx).send(active);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    runtime.scheduler.subscribe(
      chooser,
      {
        reads: [
          toMemorySpaceAddress(condition.getAsNormalizedFullLink()),
          toMemorySpaceAddress(left.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );

    expect(await output.pull()).toBe(10);
    expect(runs).toBe(1);

    condition.withTx(tx).send(false);
    await tx.commit().settled;
    tx = runtime.edit();
    expect(await output.pull()).toBe(20);
    expect(runs).toBe(2);

    left.withTx(tx).send(11);
    await tx.commit().settled;
    tx = runtime.edit();
    expect(await output.pull()).toBe(20);
    expect(runs).toBe(2);

    right.withTx(tx).send(21);
    await tx.commit().settled;
    tx = runtime.edit();
    expect(await output.pull()).toBe(21);
    expect(runs).toBe(3);
  });

  it("continues a parent when its created child updates a sampled value", async () => {
    const item = runtime.getCell<number>(
      space,
      "v2-cutover-parent-continuation-item",
      undefined,
      tx,
    );
    item.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const samples: number[] = [];
    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const itemLink = item.getAsNormalizedFullLink();
    const itemAddress = toMemorySpaceAddress(itemLink);

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        item.withTx(actionTx).send(2);
      }) as Action,
      {
        writes: [itemLink],
      },
    );

    const parent: Action = (actionTx) => {
      samples.push(item.withTx(actionTx).get());
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [], shallowReads: [], writes: [itemAddress] },
          {},
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      { reads: [itemAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(samples).toEqual([1, 2]);
      expect(childRuns).toBe(1);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("does not run an effect when its upstream output is unchanged", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-noop-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-noop-output",
      undefined,
      tx,
    );
    source.set(0);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let computeRuns = 0;
    let effectRuns = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const compute = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        computeRuns++;
        const next = Math.floor(source.withTx(actionTx).get() / 10);
        output.withTx(actionTx).send(next);
      }) as Action,
      {
        writes: [outputLink],
      },
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
      effectRuns++;
    };

    const computeCancel = runtime.scheduler.subscribe(
      compute,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );
    const effectCancel = runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outputLink)],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      computeRuns = 0;
      effectRuns = 0;

      for (const value of [1, 2, 3]) {
        source.withTx(tx).send(value);
        await tx.commit().settled;
        tx = runtime.edit();
        await runtime.scheduler.idle();
      }

      expect(computeRuns).toBe(3);
      expect(effectRuns).toBe(0);
      expect(output.get()).toBe(0);
    } finally {
      computeCancel();
      effectCancel();
    }
  });

  it("does not invalidate a clean effect merely because a writer is gated", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-gated-writer-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-gated-writer-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const outputAddress = toMemorySpaceAddress(
      output.getAsNormalizedFullLink(),
    );
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        output.withTx(actionTx).send(source.withTx(actionTx).get());
      }) as Action,
      { writes: [output.getAsNormalizedFullLink()] },
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
    };
    const writerCancel = runtime.scheduler.subscribe(writer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [outputAddress],
    });
    const effectLog = {
      reads: [outputAddress],
      shallowReads: [],
      writes: [],
    };
    const effectCancel = runtime.scheduler.subscribe(
      effect,
      effectLog,
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(runtime.scheduler.isDirty(effect)).toBe(false);

      const internal = runtime.scheduler.accessForTestingOnly;
      internal.nodes.get(writer)!.gate.backoffUntil = performance.now() +
        30_000;
      internal.markAndScheduleInvalidAction(writer);
      runtime.scheduler.resubscribe(effect, effectLog);

      // P2/I3: writer reachability and dirtiness are not a value-bearing
      // change. Only the writer's eventual changed commit may invalidate this
      // already-ran effect.
      expect(runtime.scheduler.isDirty(effect)).toBe(false);
    } finally {
      writerCancel();
      effectCancel();
    }
  });

  it("runs an effect once per changed upstream output", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-changed-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-changed-output",
      undefined,
      tx,
    );
    source.set(0);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let effectRuns = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const compute = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
      effectRuns++;
    };

    const computeCancel = runtime.scheduler.subscribe(
      compute,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );
    const effectCancel = runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outputLink)],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      effectRuns = 0;

      for (const [index, value] of [1, 2, 3].entries()) {
        source.withTx(tx).send(value);
        await tx.commit().settled;
        tx = runtime.edit();
        await runtime.scheduler.idle();
        expect(output.get()).toBe(value * 10);
        expect(effectRuns).toBe(index + 1);
      }
    } finally {
      computeCancel();
      effectCancel();
    }
  });

  it("bounds a cycling subgraph without blocking an unrelated subgraph", async () => {
    const cycleA = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-a",
      undefined,
      tx,
    );
    const cycleB = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-b",
      undefined,
      tx,
    );
    const unrelatedSource = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-unrelated-source",
      undefined,
      tx,
    );
    const unrelatedOutput = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-unrelated-output",
      undefined,
      tx,
    );
    cycleA.set(0);
    cycleB.set(0);
    unrelatedSource.set(7);
    unrelatedOutput.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;
    const unrelatedValues: number[] = [];

    const actionA = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCountA++;
        cycleA.withTx(actionTx).send(cycleB.withTx(actionTx).get() + 1);
      }) as Action,
      {
        writes: [cycleA.getAsNormalizedFullLink()],
      },
    );
    const actionB = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCountB++;
        cycleB.withTx(actionTx).send(cycleA.withTx(actionTx).get() + 1);
      }) as Action,
      {
        writes: [cycleB.getAsNormalizedFullLink()],
      },
    );
    const cycleEffect: Action = (actionTx) => {
      cycleB.withTx(actionTx).get();
    };

    const unrelatedWriter = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        unrelatedOutput.withTx(actionTx).send(
          unrelatedSource.withTx(actionTx).get() * 10,
        );
      }) as Action,
      {
        writes: [unrelatedOutput.getAsNormalizedFullLink()],
      },
    );
    const unrelatedEffect: Action = (actionTx) => {
      unrelatedValues.push(unrelatedOutput.withTx(actionTx).get());
    };

    const cancelA = runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
      },
      {},
    );
    const cancelB = runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
      },
      {},
    );
    const cancelCycleEffect = runtime.scheduler.subscribe(
      cycleEffect,
      {
        reads: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    const cancelUnrelatedWriter = runtime.scheduler.subscribe(
      unrelatedWriter,
      {
        reads: [
          toMemorySpaceAddress(unrelatedSource.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(unrelatedOutput.getAsNormalizedFullLink()),
        ],
      },
      {},
    );
    const cancelUnrelatedEffect = runtime.scheduler.subscribe(
      unrelatedEffect,
      {
        reads: [
          toMemorySpaceAddress(unrelatedOutput.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await expectSchedulerIdle(runtime);
      expect(runCountA + runCountB).toBeGreaterThan(0);
      expect(runCountA).toBeLessThanOrEqual(
        PASS_RUN_BUDGET * CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
      );
      expect(runCountB).toBeLessThanOrEqual(
        PASS_RUN_BUDGET * CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
      );
      expect(unrelatedValues[unrelatedValues.length - 1]).toBe(70);
    } finally {
      cancelA();
      cancelB();
      cancelCycleEffect();
      cancelUnrelatedWriter();
      cancelUnrelatedEffect();
    }
  });

  it("keeps provisional demand until parent-created readers can demand a child", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-trigger",
      undefined,
      tx,
    );
    const childSource = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-child-source",
      undefined,
      tx,
    );
    const childOutput = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-child-output",
      undefined,
      tx,
    );
    trigger.set(0);
    childSource.set(1);
    childOutput.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let childARuns = 0;
    const childBValues: number[] = [];
    let childACancel: (() => void) | undefined;
    let childBCancel: (() => void) | undefined;
    const childOutputLink = childOutput.getAsNormalizedFullLink();
    const childOutputAddress = toMemorySpaceAddress(childOutputLink);

    const childA = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childARuns++;
        childOutput.withTx(actionTx).send(
          childSource.withTx(actionTx).get() * 10,
        );
      }) as Action,
      {
        writes: [childOutputLink],
      },
    );
    const childB: Action = (actionTx) => {
      childBValues.push(childOutput.withTx(actionTx).get());
    };

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childACancel) {
        childACancel = runtime.scheduler.subscribe(
          childA,
          {
            reads: [
              toMemorySpaceAddress(childSource.getAsNormalizedFullLink()),
            ],
            shallowReads: [],
            writes: [childOutputAddress],
          },
          {},
        );
      }
      if (!childBCancel) {
        childBCancel = runtime.scheduler.subscribe(
          childB,
          { reads: [childOutputAddress], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(childARuns).toBe(1);
      expect(childBValues.includes(10)).toBe(true);

      childBValues.length = 0;
      childSource.withTx(tx).send(2);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(childARuns).toBe(2);
      expect(childBValues.includes(20)).toBe(true);
    } finally {
      parentCancel();
      childACancel?.();
      childBCancel?.();
    }
  });

  it("keeps provisional demand for a debounced child until the gate opens", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-trigger",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-output",
      undefined,
      tx,
    );
    trigger.set(0);
    source.set(3);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const outputLink = output.getAsNormalizedFullLink();
    const outputAddress = toMemorySpaceAddress(outputLink);
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [sourceAddress], shallowReads: [], writes: [outputAddress] },
          { debounce: 200 },
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      const idleStart = performance.now();
      await runtime.scheduler.idle();
      expect(performance.now() - idleStart).toBeGreaterThanOrEqual(180);
      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("expires provisional demand after a parent-created child runs", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-trigger",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-output",
      undefined,
      tx,
    );
    trigger.set(0);
    source.set(3);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const outputLink = output.getAsNormalizedFullLink();
    const outputAddress = toMemorySpaceAddress(outputLink);
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [sourceAddress], shallowReads: [], writes: [outputAddress] },
          {},
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);

      source.withTx(tx).send(4);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("keeps a declared writer dormant while its output has no demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-dormant-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-dormant-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(runs).toBe(0);
    expect(output.get()).toBe(0);
  });

  it("does not trigger a never-ran node from declared reads alone", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-declared-read-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-declared-read-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const sourceLink = source.getAsNormalizedFullLink();
    const outputLink = output.getAsNormalizedFullLink();
    const sourceAddress = toMemorySpaceAddress(sourceLink);
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        reads: [sourceLink],
        writes: [outputLink],
      },
    );
    const internal = runtime.scheduler.accessForTestingOnly;

    const cancel = runtime.scheduler.subscribe(writer);

    try {
      await runtime.scheduler.idle();
      const record = internal.nodes.get(writer);
      expect(record?.status).toBe("never-ran");
      expect(record?.declaredReads).toEqual([sourceAddress]);
      expect(record?.invalidCauses.size).toBe(0);
      expect(runs).toBe(0);

      source.withTx(tx).send(2);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(internal.nodes.get(writer)?.invalidCauses.size).toBe(0);
      expect(runs).toBe(0);
      expect(output.get()).toBe(0);
    } finally {
      cancel();
    }
  });

  it("matches v1 parent-link semantics across registration paths", async () => {
    const parentlessSource = runtime.getCell<number>(
      space,
      "v2-cutover-parentless-source",
      undefined,
      tx,
    );
    const stickySource = runtime.getCell<number>(
      space,
      "v2-cutover-sticky-parent-source",
      undefined,
      tx,
    );
    const parentTrigger = runtime.getCell<number>(
      space,
      "v2-cutover-parent-link-trigger",
      undefined,
      tx,
    );
    parentlessSource.set(1);
    stickySource.set(1);
    parentTrigger.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const parentlessAddress = toMemorySpaceAddress(
      parentlessSource.getAsNormalizedFullLink(),
    );
    const stickyAddress = toMemorySpaceAddress(
      stickySource.getAsNormalizedFullLink(),
    );
    const triggerAddress = toMemorySpaceAddress(
      parentTrigger.getAsNormalizedFullLink(),
    );

    const noOpThenAssignChild: Action = function noOpThenAssignChild(
      actionTx,
    ) {
      parentlessSource.withTx(actionTx).get();
    };
    const preserveChild: Action = function preserveChild(actionTx) {
      stickySource.withTx(actionTx).get();
    };
    const overwriteChild: Action = function overwriteChild(actionTx) {
      stickySource.withTx(actionTx).get();
    };
    const deferredRegistry = new NodeRegistry();
    const deferredParent: Action = function deferredParent() {};
    const deferredChild: Action = function deferredChild() {};

    deferredRegistry.register(deferredChild, "computation");
    deferredRegistry.linkParent(deferredChild, deferredParent);
    expect(deferredRegistry.parentOf(deferredChild)).toBeUndefined();
    deferredRegistry.register(deferredParent, "effect");
    expect(deferredRegistry.parentOf(deferredChild)?.action).toBe(
      deferredParent,
    );
    expect(
      deferredRegistry.childrenOf(deferredParent)?.has(
        deferredRegistry.get(deferredChild)!,
      ),
    ).toBe(true);

    const parentlessInitialCancel = runtime.scheduler.subscribe(
      noOpThenAssignChild,
      { reads: [parentlessAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();
    parentlessInitialCancel();
    await runtime.scheduler.idle();

    const parentlessNestedCancels: Array<() => void> = [];
    const parentQ: Action = function parentQ(actionTx) {
      parentTrigger.withTx(actionTx).get();
      if (parentlessNestedCancels.length === 0) {
        parentlessNestedCancels.push(
          runtime.scheduler.subscribe(
            noOpThenAssignChild,
            { reads: [parentlessAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
      }
    };
    const parentQCancel = runtime.scheduler.subscribe(
      parentQ,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    let graph = runtime.scheduler.getGraphSnapshot();
    const parentlessNode = graph.nodes.find((node) =>
      node.id === "noOpThenAssignChild"
    );
    expect(parentlessNode).toBeDefined();
    expect(parentlessNode!.parentId).toBe("parentQ");

    const stickyCancels: Array<() => void> = [];
    const parentP: Action = function parentP(actionTx) {
      parentTrigger.withTx(actionTx).get();
      if (stickyCancels.length === 0) {
        stickyCancels.push(
          runtime.scheduler.subscribe(
            preserveChild,
            { reads: [stickyAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
        stickyCancels.push(
          runtime.scheduler.subscribe(
            overwriteChild,
            { reads: [stickyAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
      }
    };
    const parentPCancel = runtime.scheduler.subscribe(
      parentP,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    graph = runtime.scheduler.getGraphSnapshot();
    const firstPreserveNode = graph.nodes.find((node) =>
      node.id === "preserveChild"
    );
    const firstOverwriteNode = graph.nodes.find((node) =>
      node.id === "overwriteChild"
    );
    expect(firstPreserveNode?.parentId).toBe("parentP");
    expect(firstOverwriteNode?.parentId).toBe("parentP");

    const parentRSubscribeCancels: Array<() => void> = [];
    const parentR: Action = function parentR(actionTx) {
      parentTrigger.withTx(actionTx).get();
      runtime.scheduler.resubscribe(
        preserveChild,
        { reads: [stickyAddress], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      if (parentRSubscribeCancels.length === 0) {
        parentRSubscribeCancels.push(
          runtime.scheduler.subscribe(overwriteChild, {
            reads: [stickyAddress],
            shallowReads: [],
            writes: [],
          }, { isEffect: true }),
        );
      }
    };
    const parentRCancel = runtime.scheduler.subscribe(
      parentR,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    graph = runtime.scheduler.getGraphSnapshot();
    const secondPreserveNode = graph.nodes.find((node) =>
      node.id === "preserveChild"
    );
    const secondOverwriteNode = graph.nodes.find((node) =>
      node.id === "overwriteChild"
    );
    expect(secondPreserveNode?.parentId).toBe("parentP");
    expect(secondOverwriteNode?.parentId).toBe("parentR");

    parentQCancel();
    for (const cancel of parentlessNestedCancels) cancel();
    parentPCancel();
    parentRCancel();
    for (const cancel of stickyCancels) cancel();
    for (const cancel of parentRSubscribeCancels) cancel();
  });

  it("promotes a computation to an effect on re-registration", async () => {
    // v1 parity: updateSchedulerActionType allowed an action first seen as a
    // computation to be promoted by a later `isEffect: true` subscription
    // ("once an effect, stays an effect"). Strict kind re-registration must
    // not throw on that path.
    const registry = new NodeRegistry();
    const promoted: Action = function promotedAction() {};
    registry.register(promoted, "computation");
    expect(registry.isComputation(promoted)).toBe(true);

    const record = registry.register(promoted, "effect");
    expect(record.kind).toBe("effect");
    expect(registry.isEffect(promoted)).toBe(true);
    expect(registry.isComputation(promoted)).toBe(false);

    // End-to-end: a live re-subscription with isEffect must not throw.
    const source = runtime.getCell<number>(
      space,
      "cutover-promotion-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit().settled;
    tx = runtime.edit();
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const reader: Action = function promotionReader(actionTx) {
      source.withTx(actionTx).get();
    };
    const firstCancel = runtime.scheduler.subscribe(reader, {
      reads: [sourceAddress],
      shallowReads: [],
      writes: [],
    });
    const promoteCancel = runtime.scheduler.subscribe(reader, {
      reads: [sourceAddress],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.scheduler.idle();
    firstCancel();
    promoteCancel();
  });

  it("keeps captured parent actions reachable before the parent registers", () => {
    // v1 parity: the parent edge was a WeakMap keyed by action objects, so
    // demand checks could consult the parent action even when its record was
    // not (yet) registered. parentActionOf() preserves that raw access.
    const registry = new NodeRegistry();
    const lazyParent: Action = function lazyParent() {};
    const lazyChild: Action = function lazyChild() {};
    registry.register(lazyChild, "computation");
    registry.linkParent(lazyChild, lazyParent);

    expect(registry.parentOf(lazyChild)).toBeUndefined();
    expect(registry.parentActionOf(lazyChild)).toBe(lazyParent);

    registry.register(lazyParent, "effect");
    expect(registry.parentOf(lazyChild)?.action).toBe(lazyParent);
    expect(registry.parentActionOf(lazyChild)).toBe(lazyParent);
  });

  it("releases liveness through dependency cycles", () => {
    // Spec §5.2: edge changes rebuild reachability from explicit roots. When
    // the only root unsubscribes, the cycle must become unreachable instead
    // of sustaining itself through its internal edges.
    const nodes = new NodeRegistry();
    const state = {
      nodes,
      dependents: new WeakMap<Action, Set<Action>>(),
      reverseDependencies: new WeakMap<Action, Set<Action>>(),
      materializerIndex: { isMaterializer: () => false },
      staleness: {
        addStaleUpstream: () => {},
        removeStaleUpstream: () => {},
      },
      isStale: () => false,
      queueExecution: () => {},
      getSchedulingWrites: () => undefined,
    } as unknown as DependencyGraphState;

    const liveRoot: Action = function liveRoot() {};
    const cycleA: Action = function cycleA() {};
    const cycleB: Action = function cycleB() {};
    nodes.register(liveRoot, "effect");
    nodes.register(cycleA, "computation");
    nodes.register(cycleB, "computation");

    // A and B read each other; the effect reads A.
    registerDependentEdge(state, cycleB, cycleA);
    registerDependentEdge(state, cycleA, cycleB);
    registerDependentEdge(state, cycleA, liveRoot);

    expect(isLive(state, nodes.get(cycleA)!)).toBe(true);
    expect(isLive(state, nodes.get(cycleB)!)).toBe(true);

    unregisterDependentEdge(state, cycleA, liveRoot);

    expect(isLive(state, nodes.get(cycleA)!)).toBe(false);
    expect(isLive(state, nodes.get(cycleB)!)).toBe(false);
  });

  it("keeps a shared writer live when one arm of a demand diamond is removed", () => {
    const nodes = new NodeRegistry();
    const state = {
      nodes,
      dependents: new WeakMap<Action, Set<Action>>(),
      reverseDependencies: new WeakMap<Action, Set<Action>>(),
      materializerIndex: { isMaterializer: () => false },
      getSchedulingWrites: () => undefined,
    } as unknown as DependencyGraphState;

    const writer: Action = function diamondWriter() {};
    const left: Action = function diamondLeft() {};
    const right: Action = function diamondRight() {};
    const merge: Action = function diamondMerge() {};
    const root: Action = function diamondRoot() {};
    nodes.register(writer, "computation");
    nodes.register(left, "computation");
    nodes.register(right, "computation");
    nodes.register(merge, "computation");
    nodes.register(root, "effect");

    registerDependentEdge(state, writer, left);
    registerDependentEdge(state, writer, right);
    registerDependentEdge(state, left, merge);
    registerDependentEdge(state, right, merge);
    registerDependentEdge(state, merge, root);

    expect(nodes.get(writer)?.liveRefs).toBe(2);
    unregisterDependentEdge(state, writer, left);

    expect(nodes.get(writer)?.liveRefs).toBe(1);
    expect(isLive(state, nodes.get(writer)!)).toBe(true);

    unregisterDependentEdge(state, writer, right);
    expect(nodes.get(writer)?.liveRefs).toBe(0);
    expect(isLive(state, nodes.get(writer)!)).toBe(false);
  });

  it("rejects self-dependencies without mutating the graph", () => {
    const nodes = new NodeRegistry();
    const action: Action = function selfDependentAction() {};
    nodes.register(action, "computation");
    const state = {
      nodes,
      dependents: new WeakMap<Action, Set<Action>>(),
      reverseDependencies: new WeakMap<Action, Set<Action>>(),
      materializerIndex: { isMaterializer: () => false },
      getSchedulingWrites: () => undefined,
    } as unknown as DependencyGraphState;

    expect(registerDependentEdge(state, action, action)).toBe(false);
    expect(state.dependents.get(action)).toBeUndefined();
    expect(state.reverseDependencies.get(action)).toBeUndefined();
  });

  it("ignores stale dependency edges while rebuilding liveness", () => {
    const nodes = new NodeRegistry();
    const root: Action = function staleEdgeRoot() {};
    const removedWriter: Action = function removedDependencyWriter() {};
    nodes.register(root, "effect");
    const state = {
      nodes,
      reverseDependencies: new WeakMap<Action, Set<Action>>([
        [root, new Set([removedWriter])],
      ]),
      materializerIndex: { isMaterializer: () => false },
    };

    recomputeLiveRefs(state);

    expect(isLive(state, nodes.get(root)!)).toBe(true);
  });

  it("escalates convergence backoff for consecutive exhaustion", () => {
    const nodes = new NodeRegistry();
    const action: Action = function nonSettlingAction() {};
    const record = nodes.register(action, "effect");

    const planAt = (now: number) =>
      planBudgetBackoff({
        workSet: new Set([action]),
        nodes,
        pending: new Set<Action>(),
        isLiveAction: () => true,
        getNextEligibleRunTime: (candidate) => {
          const until = nodes.get(candidate)?.gate.backoffUntil;
          return until !== undefined && until > now ? until : undefined;
        },
        isDebouncedComputationWaiting: () => false,
        reason: "iteration-cap",
        now,
      });

    const first = planAt(1_000);
    expect(first.backoffUntil).toBe(1_000 + BACKOFF_BASE_MS);
    const second = planAt(first.backoffUntil!);
    expect(second.backoffUntil).toBe(
      first.backoffUntil! + BACKOFF_BASE_MS * 2,
    );
    expect(record.gate.backoffStreak).toBe(2);
  });

  it("does not back off undemanded, debounced, or already-gated work", () => {
    const now = 10_000;
    const cases = [
      {
        name: "undemanded",
        isLive: false,
        isDebounced: false,
        nextEligibleAt: undefined,
      },
      {
        name: "debounced",
        isLive: true,
        isDebounced: true,
        nextEligibleAt: undefined,
      },
      {
        name: "already gated",
        isLive: true,
        isDebounced: false,
        nextEligibleAt: now + 1_000,
      },
    ] as const;

    for (const testCase of cases) {
      const nodes = new NodeRegistry();
      const action: Action = function rejectedBackoffCandidate() {};
      const record = nodes.register(action, "computation");

      const plan = planBudgetBackoff({
        workSet: new Set([action]),
        nodes,
        pending: new Set<Action>(),
        isLiveAction: () => testCase.isLive,
        getNextEligibleRunTime: () => testCase.nextEligibleAt,
        isDebouncedComputationWaiting: () => testCase.isDebounced,
        reason: "iteration-cap",
        now,
      });

      expect(plan.actions, testCase.name).toEqual([]);
      expect(plan.backoffUntil, testCase.name).toBeUndefined();
      expect(record.gate.backoffStreak, testCase.name).toBe(0);
      expect(record.gate.convergenceHoldPasses, testCase.name).toBe(0);
      expect(record.gate.backoffUntil, testCase.name).toBeUndefined();
    }
  });

  it("plans wake times for invalidation-armed debounced computations", () => {
    // Arming happens at invalidation time (the facade's markActionInvalid →
    // gates.onInvalidated); the waiting check and the wake-time planner are
    // pure reads of that armed state, so they agree by construction — and a
    // query on an un-armed gate must stay a no-op (no lazy self-arming).
    const nodes = new NodeRegistry();
    const action: Action = function debouncedFirstRun() {};
    nodes.register(action, "computation");
    const gates = new SchedulerGates({
      nodes,
      actionStats: new Map(),
      getActionId: () => "debounced-first-run",
      isDisposed: () => false,
      queueExecution: () => {},
    });
    gates.setDebounce(action, 50);
    const context = {
      computations: new Set([action]),
      effects: new Set<Action>(),
      isInvalid: () => true,
      pending: new Set<Action>(),
      queueExecution: () => {},
      logDebounce: () => {},
      shouldDebounceFirstRun: () => true,
    };

    try {
      // Pure query on an un-armed gate: reports nothing and does not arm.
      expect(gates.isDebouncedComputationWaiting(action, context)).toBe(false);
      expect(gates.getNextDebounceRunTime(action, context)).toBeUndefined();
      // Invalidation arms the trailing debounce; both reads then agree.
      gates.onInvalidated(nodes.get(action)!, performance.now(), context);
      expect(gates.isDebouncedComputationWaiting(action, context)).toBe(true);
      expect(gates.getNextDebounceRunTime(action, context)).toBeDefined();
    } finally {
      gates.cancelWake();
    }
  });

  it("recomputes the shared wake when a gate is released early", () => {
    const nodes = new NodeRegistry();
    const action: Action = function earlyGateRelease() {};
    nodes.register(action, "computation");
    let queued = 0;
    const gates = new SchedulerGates({
      nodes,
      actionStats: new Map(),
      getActionId: () => "early-gate-release",
      isDisposed: () => false,
      queueExecution: () => queued++,
    });
    const context = {
      computations: new Set([action]),
      effects: new Set<Action>(),
      isInvalid: () => true,
      pending: new Set<Action>(),
      queueExecution: () => {},
      logDebounce: () => {},
      shouldDebounceFirstRun: () => true,
    };

    try {
      gates.holdInitialRun(action, performance.now() + 30_000);
      expect(gates.hasWakeTimer()).toBe(true);
      gates.releaseInitialRunHold(action);
      expect(gates.hasWakeTimer()).toBe(false);
      expect(queued).toBe(1);

      gates.setDebounce(action, 30_000);
      gates.onInvalidated(nodes.get(action)!, performance.now(), context);
      expect(gates.hasWakeTimer()).toBe(true);
      gates.setDebounce(action, 0);
      expect(gates.hasWakeTimer()).toBe(false);
      expect(queued).toBe(2);

      gates.setThrottle(action, 30_000);
      gates.scheduleWake(performance.now() + 30_000);
      expect(gates.hasWakeTimer()).toBe(true);
      gates.clearThrottle(action);
      expect(gates.hasWakeTimer()).toBe(false);
      expect(queued).toBe(3);
    } finally {
      gates.cancelWake();
    }
  });

  it("cancels the shared wake when a clean node clears backoff", () => {
    const scheduler = runtime.scheduler.accessForTestingOnly;
    const action: Action = function adoptedBeforeBackoffWake() {};
    const record = scheduler.nodes.register(action, "computation");
    scheduler.nodes.setStatus(action, "clean");
    record.gate.backoffStreak = 1;
    record.gate.convergenceHoldPasses = 1;
    record.gate.backoffUntil = performance.now() + 30_000;
    scheduler.gates.scheduleWake(record.gate.backoffUntil);

    expect(scheduler.gates.hasWakeTimer()).toBe(true);
    scheduler.clearBackoffForCleanNodes();
    expect(scheduler.gates.hasWakeTimer()).toBe(false);
    expect(record.gate.backoffUntil).toBeUndefined();
    expect(record.gate.backoffStreak).toBe(0);
    expect(record.gate.convergenceHoldPasses).toBe(0);
  });

  it("resets a dormant node's convergence episode at an already-idle boundary", async () => {
    const scheduler = runtime.scheduler.accessForTestingOnly;
    const action: Action = function dormantPreviousEpisode() {};
    const record = scheduler.nodes.register(action, "computation");
    scheduler.nodes.setStatus(action, "invalid");
    record.gate.convergenceHoldPasses =
      CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES;

    // No demand root reaches this invalid node, so idle resolves directly
    // without an execute/continuation cycle. That boundary must still reset the
    // per-node episode before the action is demanded again.
    await runtime.scheduler.idle();

    expect(record.gate.convergenceHoldPasses).toBe(0);
  });

  it("settles a fully declared deep chain in one ordered pass", async () => {
    // Every edge is declared up front, so topological ordering can run a chain
    // deeper than MAX_ITERS in one settle iteration. This complements the
    // discovered-read multi-pass regression in scheduler-convergence.test.ts:
    // declared topology must not incur convergence backoff at all.
    const DEPTH = 12;
    const cells: Cell<number>[] = [];
    for (let i = 0; i <= DEPTH; i++) {
      const cell = runtime.getCell<number>(
        space,
        `v2-cutover-deep-chain-${i}`,
        undefined,
        tx,
      );
      cell.set(0);
      cells.push(cell);
    }
    await tx.commit().settled;
    tx = runtime.edit();

    const cancels: Array<() => void> = [];
    let maxRunsForAnyLink = 0;
    try {
      // Chain: cell[i+1] = cell[i] + 1 for each hop.
      for (let i = 0; i < DEPTH; i++) {
        const src = cells[i];
        const dst = cells[i + 1];
        let runs = 0;
        const link = Object.assign(
          ((actionTx: IExtendedStorageTransaction) => {
            runs++;
            maxRunsForAnyLink = Math.max(maxRunsForAnyLink, runs);
            dst.withTx(actionTx).send(src.withTx(actionTx).get() + 1);
          }) as Action,
          { writes: [dst.getAsNormalizedFullLink()] },
        );
        cancels.push(
          runtime.scheduler.subscribe(link, {
            reads: [toMemorySpaceAddress(src.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(dst.getAsNormalizedFullLink())],
          }),
        );
      }

      // A live effect at the tail makes the whole chain demanded.
      const tailReads: number[] = [];
      const tailEffect: Action = (actionTx) => {
        tailReads.push(cells[DEPTH].withTx(actionTx).get());
      };
      cancels.push(
        runtime.scheduler.subscribe(tailEffect, {
          reads: [toMemorySpaceAddress(cells[DEPTH].getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [],
        }, { isEffect: true }),
      );

      // No iteration-cap backoff is applied and no non-settling episode is
      // recorded. Assert that signal directly rather than racing a wall clock:
      // a loaded CI runner could breach an elapsed-time bound with zero
      // regressions, whereas `scheduler.non-settling` telemetry fires iff
      // backoff was actually applied.
      const nonSettlingMarkers: unknown[] = [];
      const onTelemetry = (event: Event) => {
        const marker = (event as RuntimeTelemetryEvent).marker;
        if (marker.type === "scheduler.non-settling") {
          nonSettlingMarkers.push(marker);
        }
      };
      runtime.telemetry.addEventListener("telemetry", onTelemetry);
      try {
        cells[0].withTx(tx).send(5);
        await tx.commit().settled;
        tx = runtime.edit();
        await runtime.scheduler.idle();
      } finally {
        runtime.telemetry.removeEventListener("telemetry", onTelemetry);
      }

      // Full propagation: tail sees source + DEPTH hops.
      expect(cells[DEPTH].get()).toBe(5 + DEPTH);
      // Healthy progress, not a cycle: no link approached the run budget.
      expect(maxRunsForAnyLink).toBeLessThan(5);
      // No iteration-cap backoff was applied (deterministic; no wall clock).
      expect(nonSettlingMarkers.length).toBe(0);
    } finally {
      for (const cancel of cancels) cancel();
    }
  });

  // (Removed main's "moves a debounced action to pending after its timer fires"
  // test: it asserts the v1 SchedulerDelays per-action-timer model — timer fires
  // → action added directly to `pending`. v2 gates use a unified wake timer
  // (scheduleWake) + settle re-check instead, so that premise no longer holds.
  // Equivalent gates debounce behavior is covered by scheduler-timing.test.ts
  // and the "plans wake times for first-run debounced computations" test above.)
});
