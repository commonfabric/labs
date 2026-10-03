// Effect and computation tracking tests: verifying that effects are scheduled
// correctly and computations are re-run when dependencies change.

import { getSigilLink } from "../src/runner-utils.ts";
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
  EventHandler,
  IExtendedStorageTransaction,
  ReactivityLog,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("effect/computation tracking", () => {
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

  it("should track actions as computations by default", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-computations-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(0);
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    runtime.scheduler.queueExecution();
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(1);
    expect(stats2.effects).toBe(0);
    expect(runtime.scheduler.isComputation(action)).toBe(true);
    expect(runtime.scheduler.isEffect(action)).toBe(false);
  });

  it("should track actions as effects when isEffect is true", async () => {
    const a = runtime.getCell<number>(
      space,
      "track-effects-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.effects).toBe(0);

    const action: Action = () => {};
    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    expect(stats2.effects).toBe(1);
    expect(stats2.computations).toBe(0);
    expect(runtime.scheduler.isEffect(action)).toBe(true);
    expect(runtime.scheduler.isComputation(action)).toBe(false);
  });

  it("should remove from correct set on unsubscribe", async () => {
    const a = runtime.getCell<number>(
      space,
      "unsubscribe-tracking-1",
      undefined,
      tx,
    );
    a.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const computation: Action = () => {};
    const effect: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: false },
    );
    runtime.scheduler.subscribe(
      effect,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    const stats1 = runtime.scheduler.getStats();
    expect(stats1.computations).toBe(1);
    expect(stats1.effects).toBe(1);

    // Unsubscribe computation
    runtime.scheduler.unsubscribe(computation);
    const stats2 = runtime.scheduler.getStats();
    expect(stats2.computations).toBe(0);
    expect(stats2.effects).toBe(1);
    expect(runtime.scheduler.isComputation(computation)).toBe(false);

    // Unsubscribe effect
    runtime.scheduler.unsubscribe(effect);
    const stats3 = runtime.scheduler.getStats();
    expect(stats3.computations).toBe(0);
    expect(stats3.effects).toBe(0);
    expect(runtime.scheduler.isEffect(effect)).toBe(false);
  });

  it("should track sink() calls as effects", async () => {
    const a = runtime.getCell<number>(
      space,
      "sink-as-effect-1",
      undefined,
      tx,
    );
    a.set(42);
    await tx.commit().settled;
    tx = runtime.edit();

    const stats1 = runtime.scheduler.getStats();
    const initialEffects = stats1.effects;

    let sinkValue: number | undefined;
    const cancel = a.sink((value) => {
      sinkValue = value;
    });
    await runtime.idle();

    const stats2 = runtime.scheduler.getStats();
    // sink() should add an effect
    expect(stats2.effects).toBe(initialEffects + 1);
    expect(sinkValue).toBe(42);

    cancel();
    await runtime.idle();

    // After cancel, effect count should decrease (but may not be immediate due to GC)
  });

  it("should track sink() parent-child relationship when called inside an action", async () => {
    const sourceCell = runtime.getCell<number>(
      space,
      "sink-parent-source",
      undefined,
      tx,
    );
    sourceCell.set(1);

    const observedCell = runtime.getCell<number>(
      space,
      "sink-parent-observed",
      undefined,
      tx,
    );
    observedCell.set(42);

    await tx.commit().settled;
    tx = runtime.edit();

    let sinkCalled = false;
    let parentCalled = false;
    let sinkCancel: (() => void) | undefined;

    // Parent action that creates a sink during its execution
    const parentAction: Action = (actionTx) => {
      parentCalled = true;
      sourceCell.withTx(actionTx).get();

      // Create a sink inside the action - this should track parent relationship
      if (!sinkCancel) {
        sinkCancel = observedCell.sink((_value) => {
          sinkCalled = true;
        });
      }
    };

    runtime.scheduler.subscribe(parentAction, {
      reads: [toMemorySpaceAddress(sourceCell.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    }, { isEffect: true }); // Mark as effect so it runs in pull mode

    await runtime.idle();

    // Verify the parent action was called
    expect(parentCalled).toBe(true);

    // Verify the sink was called (sink() always calls callback immediately on creation)
    expect(sinkCalled).toBe(true);

    // Get the graph snapshot and verify parent-child relationship
    const graph = runtime.scheduler.getGraphSnapshot();

    // Find the sink action node (named sink:space/...)
    const sinkNodes = graph.nodes.filter((n) => n.id.startsWith("sink:"));
    expect(sinkNodes.length).toBe(1);
    const sinkNode = sinkNodes[0];

    // Verify the sink has a parent (the parent action)
    expect(sinkNode.parentId).toBeDefined();

    // Verify the parent node exists and has childCount
    const parentNode = graph.nodes.find((n) => n.id === sinkNode.parentId);
    expect(parentNode).toBeDefined();
    expect(parentNode!.childCount).toBeGreaterThanOrEqual(1);

    sinkCancel!();
    await runtime.idle();
  });

  it("should track dependents for reverse dependency graph", async () => {
    const source = runtime.getCell<number>(
      space,
      "dependents-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "dependents-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const output = runtime.getCell<number>(
      space,
      "dependents-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    // Action 1: reads source, writes intermediate
    const intermediateLink = intermediate.getAsNormalizedFullLink();
    const action1 = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        const val = source.withTx(actionTx).get();
        intermediate.withTx(actionTx).send(val * 10);
      }) as Action,
      {
        writes: [intermediateLink],
      },
    );

    // Action 2: reads intermediate, writes output
    const outputLink = output.getAsNormalizedFullLink();
    const action2 = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        const val = intermediate.withTx(actionTx).get();
        output.withTx(actionTx).send(val + 5);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    // Subscribe action1 first (writes to intermediate)
    runtime.scheduler.subscribe(
      action1,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediateLink)],
      },
      {},
    );
    await output.pull();

    // Subscribe action2 (reads intermediate)
    runtime.scheduler.subscribe(
      action2,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );
    await output.pull();

    // action2 should be a dependent of action1 (action1 writes what action2 reads)
    const dependents = runtime.scheduler.getDependents(action1);
    expect(dependents.has(action2)).toBe(true);
  });

  it("should backfill dependents when writer is added after effect subscribes", async () => {
    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-after-effect",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("foo").get();
    };

    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.scheduler.idle();

    const fooLink = data.key("foo").getAsNormalizedFullLink();
    const computation = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        data.withTx(actionTx).key("foo").set(2);
      }) as Action,
      {
        writes: [fooLink],
      },
    );
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(fooLink),
        ],
      },
      {},
    );

    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);
  });

  it("should keep writer paths fixed over resubscribe logs", async () => {
    const data = runtime.getCell<{ foo: number; bar: number }>(
      space,
      "backfill-writer-paths",
      undefined,
      tx,
    );
    data.set({ foo: 1, bar: 2 });
    await tx.commit().settled;
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      data.withTx(actionTx).key("bar").get();
    };

    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.scheduler.idle();

    const fooLink = data.key("foo").getAsNormalizedFullLink();
    const computation = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        data.withTx(actionTx).key("foo").set(2);
      }) as Action,
      {
        writes: [fooLink],
      },
    );
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(fooLink),
        ],
      },
      {},
    );

    const initialDependents = runtime.scheduler.getDependents(computation);
    expect(initialDependents.has(effect)).toBe(false);

    runtime.scheduler.resubscribe(computation, {
      reads: [],
      shallowReads: [],
      writes: [
        toMemorySpaceAddress(data.key("foo").getAsNormalizedFullLink()),
        toMemorySpaceAddress(data.key("bar").getAsNormalizedFullLink()),
      ],
    });

    const updatedDependents = runtime.scheduler.getDependents(computation);
    expect(updatedDependents.has(effect)).toBe(false);
  });

  it("should prune ignored scheduling writes from mightWrite and dependents", async () => {
    const output = runtime.getCell<number>(
      space,
      "ignored-scheduling-output",
      undefined,
      tx,
    );
    output.set(0);

    const childProcess = runtime.getCell<Record<string, unknown>>(
      space,
      "ignored-scheduling-child-process",
      undefined,
      tx,
    );
    childProcess.set({});
    await tx.commit().settled;
    tx = runtime.edit();

    const outputLink = output.getAsNormalizedFullLink();
    const childProcessLink = childProcess.getAsNormalizedFullLink();
    const action: Action & {
      writes?: ReturnType<typeof output.getAsNormalizedFullLink>[];
      ignoredSchedulingWrites?: ReturnType<
        typeof childProcess.getAsNormalizedFullLink
      >[];
    } = (actionTx) => {
      output.withTx(actionTx).set(1);
      childProcess.withTx(actionTx).setRaw({
        pattern: getSigilLink("of:child-pattern"),
      });
    };
    action.writes = [outputLink, childProcessLink];
    action.ignoredSchedulingWrites = [childProcessLink];

    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );

    await runtime.scheduler.run(action);

    const outputId = outputLink.id;
    const childProcessId = childProcessLink.id;
    expect(
      runtime.scheduler.getMightWrite(action)?.some((write) =>
        write.id === outputId
      ),
    ).toBe(true);
    expect(
      runtime.scheduler.getMightWrite(action)?.some((write) =>
        write.id === childProcessId
      ),
    ).toBe(false);
  });

  it("should keep dependents when resubscribe logs move outside the static surface", async () => {
    const cellA = runtime.getCell<number>(
      space,
      "write-switch-cell-a",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "write-switch-cell-b",
      undefined,
      tx,
    );
    cellB.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      cellA.withTx(actionTx).get();
    };
    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.scheduler.idle();

    const cellALink = cellA.getAsNormalizedFullLink();
    const computation = Object.assign((() => {}) as Action, {
      writes: [cellALink],
    });
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellALink)],
      },
      {},
    );

    expect(runtime.scheduler.getDependents(computation).has(effect)).toBe(true);

    runtime.scheduler.resubscribe(computation, {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
    });

    expect(runtime.scheduler.getDependents(computation).has(effect)).toBe(true);
  });

  it("should ignore attemptedWrites as scheduler dependency evidence", async () => {
    const output = runtime.getCell<number>(
      space,
      "attempted-write-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
    };
    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.scheduler.idle();

    const computation: Action = () => {};
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [],
        shallowReads: [],
        writes: [],
        attemptedWrites: [
          toMemorySpaceAddress(output.getAsNormalizedFullLink()),
        ],
      } as ReactivityLog & {
        attemptedWrites: ReturnType<typeof toMemorySpaceAddress>[];
      },
    );

    expect(runtime.scheduler.getDependents(computation).has(effect)).toBe(
      false,
    );
  });

  it("should run dirty materializer computations without downstream demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-undemanded-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ value: number; stable: number }>(
      space,
      "materializer-undemanded-target",
      undefined,
      tx,
    );
    source.set(1);
    target.set({ value: 0, stable: 0 });
    await tx.commit().settled;
    tx = runtime.edit();

    let materializerRuns = 0;
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        const value = source.withTx(actionTx).get();
        target.withTx(actionTx).set({ value, stable: 0 });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    await runtime.idle();
    expect(materializerRuns).toBe(1);
    expect(target.get()).toEqual({ value: 1, stable: 0 });

    const updateTx = runtime.edit();
    source.withTx(updateTx).set(2);
    await updateTx.commit().settled;
    await runtime.idle();

    expect(materializerRuns).toBe(2);
    expect(target.get()).toEqual({ value: 2, stable: 0 });
  });

  it("should schedule normal output readers when a materializer input dirties", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-normal-output-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "materializer-normal-output-target",
      undefined,
      tx,
    );
    const sideTarget = runtime.getCell<{ value: number }>(
      space,
      "materializer-normal-output-side-target",
      undefined,
      tx,
    );
    const unrelated = runtime.getCell<number>(
      space,
      "materializer-normal-output-unrelated",
      undefined,
      tx,
    );
    source.set(0);
    output.set(0);
    sideTarget.set({ value: 0 });
    unrelated.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const observedOutput: number[] = [];
    const runOrder: string[] = [];
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        runOrder.push("materializer");
        const value = source.withTx(actionTx).get();
        output.withTx(actionTx).set(value);
        sideTarget.withTx(actionTx).set({ value });
      },
      {
        writes: [output.getAsNormalizedFullLink()],
        materializerWriteEnvelopes: [sideTarget.getAsNormalizedFullLink()],
      },
    ) as Action & {
      writes: ReturnType<typeof output.getAsNormalizedFullLink>[];
      materializerWriteEnvelopes: ReturnType<
        typeof sideTarget.getAsNormalizedFullLink
      >[];
    };
    const outputEffect: Action = (actionTx) => {
      runOrder.push("output-effect");
      observedOutput.push(output.withTx(actionTx).get());
    };
    const unrelatedEffect: Action = (actionTx) => {
      runOrder.push("unrelated-effect");
      unrelated.withTx(actionTx).get();
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    });
    runtime.scheduler.subscribe(outputEffect, {
      isEffect: true,
    });
    runtime.scheduler.subscribe(unrelatedEffect, {
      isEffect: true,
    });
    await runtime.idle();

    runtime.scheduler.enableSettleStats();
    runOrder.length = 0;
    observedOutput.length = 0;

    const updateTx = runtime.edit();
    source.withTx(updateTx).set(1);
    unrelated.withTx(updateTx).set(1);
    await updateTx.commit().settled;
    await runtime.idle();

    expect(observedOutput).toEqual([1]);
    const nonEmptyIterations = runtime.scheduler.getSettleStatsHistory()
      .flatMap((entry) =>
        entry.stats.iterations.filter((iteration) => iteration.actionsRun > 0)
      );
    // The unrelated ordinary effect runs first. With no primary work left,
    // the standing-demand materializer runs at idle priority and its changed
    // output invalidates/runs the output effect in the following iteration.
    expect(nonEmptyIterations.length).toBe(2);
    expect(
      nonEmptyIterations.reduce(
        (total, iteration) => total + iteration.actionsRun,
        0,
      ),
    ).toBe(3);
    expect(runOrder.indexOf("materializer")).toBeLessThan(
      runOrder.indexOf("output-effect"),
    );
  });

  it("should keep broad materializer envelopes out of ordinary dependents", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-fanout-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ changed: number; stable: number }>(
      space,
      "materializer-fanout-target",
      undefined,
      tx,
    );
    source.set(1);
    target.set({ changed: 0, stable: 0 });
    await tx.commit().settled;
    tx = runtime.edit();

    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        const changed = source.withTx(actionTx).get();
        target.withTx(actionTx).set({ changed, stable: 0 });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };
    const changedEffect: Action = (actionTx) => {
      target.withTx(actionTx).key("changed").get();
    };
    const stableEffect: Action = (actionTx) => {
      target.withTx(actionTx).key("stable").get();
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    runtime.scheduler.subscribe(changedEffect, {
      isEffect: true,
    });
    runtime.scheduler.subscribe(stableEffect, { isEffect: true });
    await runtime.idle();

    expect(runtime.scheduler.getDependents(materializer).has(changedEffect))
      .toBe(false);
    expect(runtime.scheduler.getDependents(materializer).has(stableEffect))
      .toBe(false);
  });

  it("should coalesce dirty materializer runs behind manual debounce", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-debounce-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ value: number }>(
      space,
      "materializer-debounce-target",
      undefined,
      tx,
    );
    source.set(0);
    target.set({ value: 0 });
    await tx.commit().settled;
    tx = runtime.edit();

    let materializerRuns = 0;
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        target.withTx(actionTx).set({ value: source.withTx(actionTx).get() });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    }, { debounce: 20 });
    await runtime.idle();
    expect(materializerRuns).toBe(1);

    // Commit the three updates back-to-back and drain the in-flight frames
    // with the clock held, so every dirty notification lands inside one
    // debounce window instead of the window elapsing between commits.
    const commits: Promise<unknown>[] = [];
    for (const value of [1, 2, 3]) {
      const updateTx = runtime.edit();
      source.withTx(updateTx).set(value);
      commits.push(updateTx.commit().settled);
    }
    await clock.settle();
    await Promise.all(commits);
    await runtime.idle();

    expect(materializerRuns).toBe(2);
    expect(target.get()).toEqual({ value: 3 });
  });

  it("should fan out materializer changes only to actual changed readers", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-precise-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<Record<string, number>>(
      space,
      "materializer-precise-target",
      undefined,
      tx,
    );
    source.set(0);
    target.set(Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`k${index}`, 0]),
    ));
    await tx.commit().settled;
    tx = runtime.edit();

    let materializerRuns = 0;
    const effectRuns = Array.from({ length: 12 }, () => 0);
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        const next = { ...target.withTx(actionTx).get() };
        next.k7 = source.withTx(actionTx).get();
        target.withTx(actionTx).set(next);
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    for (let index = 0; index < effectRuns.length; index++) {
      const key = `k${index}`;
      const effect: Action = (actionTx) => {
        effectRuns[index]++;
        target.withTx(actionTx).key(key).get();
      };
      runtime.scheduler.subscribe(effect, { isEffect: true });
    }
    await runtime.idle();
    materializerRuns = 0;
    effectRuns.fill(0);

    const updateTx = runtime.edit();
    source.withTx(updateTx).set(7);
    await updateTx.commit().settled;
    await runtime.idle();

    expect(materializerRuns).toBe(1);
    expect(effectRuns[7]).toBe(1);
    expect(effectRuns.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it("should promote dirty materializers before demand-root effects", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-demand-source",
      undefined,
      tx,
    );
    const trigger = runtime.getCell<number>(
      space,
      "materializer-demand-trigger",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ value: number }>(
      space,
      "materializer-demand-target",
      undefined,
      tx,
    );
    source.set(1);
    trigger.set(0);
    target.set({ value: 1 });
    await tx.commit().settled;
    tx = runtime.edit();

    const observed: number[] = [];
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        target.withTx(actionTx).set({ value: source.withTx(actionTx).get() });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };
    const effect: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      observed.push(target.withTx(actionTx).key("value").get());
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.idle();
    observed.length = 0;

    // Commit both updates back-to-back and drain with the clock held, so the
    // materializer's dirtiness and the effect's demand land in the same
    // scheduler pass — the premise this ordering test is about.
    const sourceUpdateTx = runtime.edit();
    source.withTx(sourceUpdateTx).set(2);
    const sourceCommit = sourceUpdateTx.commit().settled;

    const triggerUpdateTx = runtime.edit();
    trigger.withTx(triggerUpdateTx).set(1);
    const triggerCommit = triggerUpdateTx.commit().settled;

    await clock.settle();
    await Promise.all([sourceCommit, triggerCommit]);
    await runtime.idle();

    expect(observed).toEqual([2]);
  });

  it("should promote dirty materializers before event preflight handlers", async () => {
    const eventStream = runtime.getCell<unknown>(
      space,
      "materializer-event-stream",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "materializer-event-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ value: number }>(
      space,
      "materializer-event-target",
      undefined,
      tx,
    );
    source.set(1);
    target.set({ value: 1 });
    await tx.commit().settled;
    tx = runtime.edit();

    const observed: number[] = [];
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        target.withTx(actionTx).set({ value: source.withTx(actionTx).get() });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };
    const handler: EventHandler = (actionTx) => {
      observed.push(target.withTx(actionTx).key("value").get());
    };
    handler.populateDependencies = (depTx) => {
      target.withTx(depTx).key("value").get();
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
    );
    await runtime.idle();

    const updateTx = runtime.edit();
    source.withTx(updateTx).set(2);
    await updateTx.commit().settled;
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), {});
    await runtime.idle();

    expect(observed).toEqual([2]);
  });

  it("should keep static declared writes demand-driven in pull mode", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-declared-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "static-declared-target",
      undefined,
      tx,
    );
    source.set(1);
    target.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let computationRuns = 0;
    const targetLink = target.getAsNormalizedFullLink();
    const computation = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        computationRuns++;
        target.withTx(actionTx).set(source.withTx(actionTx).get());
      }) as Action,
      {
        writes: [targetLink],
      },
    );
    runtime.scheduler.subscribe(computation, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(targetLink)],
    });
    await runtime.idle();
    expect(computationRuns).toBe(0);

    const effect: Action = (actionTx) => {
      target.withTx(actionTx).get();
    };
    runtime.scheduler.subscribe(effect, { isEffect: true });
    await runtime.idle();
    expect(computationRuns).toBe(1);
  });

  it("should keep materializer-annotated computations eager", async () => {
    const source = runtime.getCell<number>(
      space,
      "materializer-push-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<{ value: number }>(
      space,
      "materializer-push-target",
      undefined,
      tx,
    );
    source.set(1);
    target.set({ value: 0 });
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        runs++;
        target.withTx(actionTx).set({ value: source.withTx(actionTx).get() });
      },
      {
        materializerWriteEnvelopes: [target.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof target.getAsNormalizedFullLink
      >[];
    };

    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    await runtime.idle();
    expect(runs).toBe(1);

    const updateTx = runtime.edit();
    source.withTx(updateTx).set(2);
    await updateTx.commit().settled;
    await runtime.idle();

    expect(runs).toBe(2);
    expect(target.get()).toEqual({ value: 2 });
  });
});
