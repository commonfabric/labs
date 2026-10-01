// Pull scheduler core behavior and stale dependency propagation tests.

import { maxOf } from "@commonfabric/utils/math";

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  expectSemanticCommitNotifiesSynchronously,
  getStaleSchedulerInternals,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  Cell,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  RuntimeTelemetryMarker,
  SchedulerTestStorageManager,
  TelemetryAnnotations,
} from "./scheduler-test-utils.ts";

describe("pull-based scheduling", () => {
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

  it("should dispatch schema-marked streams without a materialized stream marker", async () => {
    const stream = runtime.getCell<{ amount: number }>(
      space,
      "schema-marked-stream-without-marker",
      {
        asCell: ["stream"],
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      } as JSONSchema,
      tx,
    );
    const result = runtime.getCell<number>(
      space,
      "schema-marked-stream-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let handlerRuns = 0;
    runtime.scheduler.addEventHandler(
      (eventTx, event: { amount: number }) => {
        handlerRuns++;
        result.withTx(eventTx).send(event.amount);
      },
      stream.getAsNormalizedFullLink(),
    );

    stream.send({ amount: 7 });
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(1);
    expect(await result.pull()).toBe(7);
  });

  it("should mark computations as dirty in pull mode when source changes", async () => {
    // This test verifies that in pull mode, computations are marked dirty
    // rather than scheduled when their inputs change.

    const source = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "pull-mode-dirty-marking-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;

    // Computation: reads source, writes result
    const computation: Action = (actionTx) => {
      computationRuns++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 10);
    };

    // Subscribe computation
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      {},
    );
    await result.pull();

    // After computation runs, result should be 10
    expect(result.get()).toBe(10);
    expect(computationRuns).toBe(1);

    // Verify computation is clean after running
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Change source - in pull mode, computation should be marked dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Give time for the storage notification to process
    await runtime.idle();

    // In pull mode with no effect depending on this computation,
    // the computation should be marked dirty but not run
    // (since there's no effect to pull it)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    // The computation should NOT have run again (pull mode doesn't schedule computations)
    expect(computationRuns).toBe(1);
  });

  it("should preserve writes from immediate ReactivityLog", async () => {
    const target = runtime.getCell<number>(
      space,
      "reactivity-log-writes-target",
      undefined,
      tx,
    );
    target.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writerRuns = 0;
    const writer: Action = (actionTx) => {
      writerRuns++;
      target.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
      },
      {},
    );

    await runtime.scheduler.idle();
    expect(writerRuns).toBe(0);
    expect(runtime.scheduler.getMightWrite(writer)).toEqual([
      toMemorySpaceAddress(target.getAsNormalizedFullLink()),
    ]);
    expect(writerRuns).toBe(0);
  });

  it("should not re-run an effect for an unrelated child subscription", async () => {
    const observed = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-observed",
      undefined,
      tx,
    );
    observed.set(1);
    const effectResult = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    const unrelatedSource = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-source",
      undefined,
      tx,
    );
    unrelatedSource.set(1);
    const unrelatedResult = runtime.getCell<number>(
      space,
      "pending-dep-unrelated-result",
      undefined,
      tx,
    );
    unrelatedResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;
    let unrelatedRuns = 0;

    const unrelatedComputation = ((actionTx: IExtendedStorageTransaction) => {
      unrelatedRuns++;
      unrelatedResult.withTx(actionTx).send(
        (unrelatedSource.withTx(actionTx).get() ?? 0) + 1,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    unrelatedComputation.reads = [unrelatedSource.getAsNormalizedFullLink()];
    unrelatedComputation.writes = [unrelatedResult.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        observed.withTx(actionTx).get() ?? 0,
      );

      if (effectRuns === 1) {
        runtime.scheduler.subscribe(
          unrelatedComputation,
          {},
        );
      }
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(observed.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);
    // v2 (spec §5.3): children created during a live effect's run get
    // provisional first-run demand; the v1 writeful-effect exception
    // keyed on run-learned writes, which no longer exist.
    expect(unrelatedRuns).toBe(1);
  });

  it("should re-run an effect for a transitively related child subscription", async () => {
    const source = runtime.getCell<number>(
      space,
      "pending-dep-transitive-source",
      undefined,
      tx,
    );
    source.set(2);
    const childResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-child-result",
      undefined,
      tx,
    );
    const parentResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pending-dep-transitive-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let childRuns = 0;
    let parentRuns = 0;
    let effectRuns = 0;

    const childComputation = ((actionTx: IExtendedStorageTransaction) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    childComputation.reads = [source.getAsNormalizedFullLink()];
    childComputation.writes = [childResult.getAsNormalizedFullLink()];

    const parentComputation = ((actionTx: IExtendedStorageTransaction) => {
      parentRuns++;

      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          childComputation,
          {},
        );
      }

      parentResult.withTx(actionTx).send(
        (childResult.withTx(actionTx).get() ?? 0) + 1,
      );
    }) as Action & Partial<TelemetryAnnotations>;
    parentComputation.reads = [childResult.getAsNormalizedFullLink()];
    parentComputation.writes = [parentResult.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        parentResult.withTx(actionTx).get() ?? 0,
      );
    };

    runtime.scheduler.subscribe(
      parentComputation,
      {},
    );

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(childRuns).toBe(1);
    expect(parentRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(21);
  });

  it("should not re-run an effect when pulled dirty computations do not change its inputs", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-derived",
      undefined,
      tx,
    );
    derived.set(1);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-effect-unchanged-effect-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let effectRuns = 0;

    const computation = ((actionTx: IExtendedStorageTransaction) => {
      computationRuns++;
      const value = source.withTx(actionTx).get() ?? 0;
      derived.withTx(actionTx).send(value % 2);
    }) as Action & Partial<TelemetryAnnotations>;
    computation.writes = [derived.getAsNormalizedFullLink()];

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        derived.withTx(actionTx).get() ?? 0,
      );
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);

    source.withTx(tx).send(3);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(2);
    expect(derived.get()).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(1);

    source.withTx(tx).send(4);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(3);
    expect(derived.get()).toBe(0);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(0);
  });

  it("should schedule effects when affected by invalid computations", async () => {
    const source = runtime.getCell<number>(
      space,
      "invalid-effects-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "invalid-effects-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "invalid-effects-result",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    // Computation: reads source, writes intermediate
    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(val * 10);
    };

    // Effect: reads intermediate
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val + 5);
    };

    // Subscribe computation first
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    // Subscribe effect with isEffect: true
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Verify dependency tracking is set up correctly
    const dependents = runtime.scheduler.getDependents(computation);
    expect(dependents.has(effect)).toBe(true);

    // Track initial effect runs
    const initialEffectRuns = effectRuns;

    // Change source - computation should be invalidated, effect should run.
    source.withTx(tx).send(2);
    await expectSemanticCommitNotifiesSynchronously(
      storageManager,
      () => tx.commit(),
    );
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBeGreaterThan(initialEffectRuns);
  });

  it("should run dirty computations with live downstream effect demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-derived",
      undefined,
      tx,
    );
    derived.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-demanded-dirty-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let effectRuns = 0;

    const computation: Action = (actionTx) => {
      computationRuns++;
      derived.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        (derived.withTx(actionTx).get() ?? 0) + 5,
      );
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(15);

    // The commit's local notification marks the graph synchronously at
    // commit() call time, and the cleanup pass runs inside the awaited
    // coverage round trip — so reshape the marked-but-unrun state before
    // awaiting, then let the single pass run it.
    source.withTx(tx).send(2);
    const invalidateCommit = tx.commit();
    tx = runtime.edit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    schedulerInternal.pending.delete(effect);
    schedulerInternal.clearInvalid(effect);
    schedulerInternal.markDirty(computation);
    runtime.scheduler.queueExecution();

    await invalidateCommit;
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(25);
  });

  it("should demand dirty computations from dependency-bearing live effects", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demand-live-effect-source",
      undefined,
      tx,
    );
    source.set(1);
    const derived = runtime.getCell<number>(
      space,
      "pull-demand-live-effect-derived",
      undefined,
      tx,
    );
    derived.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      derived.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      },
      {},
    );

    const effect: Action = (actionTx) => {
      derived.withTx(actionTx).get();
    };
    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    schedulerInternal.registerEffect(effect);
    const { log } = schedulerInternal.setDependencies(effect, {
      reads: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    schedulerInternal.updateDependents(effect, log);

    expect(schedulerInternal.isDemandedPullComputation(computation)).toBe(
      true,
    );

    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(derived.get()).toBe(1);
  });

  it("should discover writes for new child computations in demanded subgraphs", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-child-source",
      undefined,
      tx,
    );
    source.set(1);
    const parentResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    const childResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-demanded-child-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let parentRuns = 0;
    let childRuns = 0;
    let effectRuns = 0;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const parent: Action = (actionTx) => {
      parentRuns++;
      parentResult.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          child,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [],
          },
          {},
        );
      }
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      effectResult.withTx(actionTx).send(
        (parentResult.withTx(actionTx).get() ?? 0) +
          (childResult.withTx(actionTx).get() ?? 0),
      );
    };

    runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [
          toMemorySpaceAddress(parentResult.getAsNormalizedFullLink()),
          toMemorySpaceAddress(childResult.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(parentRuns).toBe(1);
    expect(childRuns).toBe(1);
    expect(effectRuns).toBeGreaterThanOrEqual(2);
    expect(effectResult.get()).toBe(11);
  });

  it("should continue a parent pull when a child writes a parent read", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-continuation-source",
      undefined,
      tx,
    );
    source.set(3);
    const childResult = runtime.getCell<number>(
      space,
      "pull-continuation-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    const parentResult = runtime.getCell<number>(
      space,
      "pull-continuation-parent-result",
      undefined,
      tx,
    );
    parentResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let parentRuns = 0;
    let childRuns = 0;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(source.withTx(actionTx).get() ?? 0);
    };

    const parent: Action = (actionTx) => {
      parentRuns++;
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(child, {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(childResult.getAsNormalizedFullLink())],
        });
      }
      parentResult.withTx(actionTx).send(
        (childResult.withTx(actionTx).get() ?? 0) + 1,
      );
    };

    runtime.scheduler.subscribe(parent, {
      reads: [toMemorySpaceAddress(childResult.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(parentResult.getAsNormalizedFullLink())],
    });

    expect(await parentResult.pull()).toBe(4);
    expect(parentRuns).toBe(2);
    expect(childRuns).toBe(1);
  });

  it("should first-run child computations created by demand-root effects", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-demanded-effect-child-source",
      undefined,
      tx,
    );
    source.set(3);
    const childResult = runtime.getCell<number>(
      space,
      "pull-demanded-effect-child-result",
      undefined,
      tx,
    );
    childResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;
    let childRuns = 0;
    let childSubscribed = false;

    const child: Action = (actionTx) => {
      childRuns++;
      childResult.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 10,
      );
    };

    const effect: Action = () => {
      effectRuns++;
      if (!childSubscribed) {
        childSubscribed = true;
        runtime.scheduler.subscribe(
          child,
          {
            reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(childResult.getAsNormalizedFullLink()),
            ],
          },
          {},
        );
      }
    };

    runtime.scheduler.subscribe(
      effect,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(effectRuns).toBe(1);
    expect(childRuns).toBe(1);
    expect(childResult.get()).toBe(30);
  });

  it("should run shared invalid dependencies consistently across effect seeds", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-shared-seeds-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate = runtime.getCell<number>(
      space,
      "pull-shared-seeds-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const leftResult = runtime.getCell<number>(
      space,
      "pull-shared-seeds-left-result",
      undefined,
      tx,
    );
    leftResult.set(0);
    const rightResult = runtime.getCell<number>(
      space,
      "pull-shared-seeds-right-result",
      undefined,
      tx,
    );
    rightResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    let leftEffectRuns = 0;
    let rightEffectRuns = 0;

    const computation: Action = (actionTx) => {
      computationRuns++;
      const value = source.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(value * 10);
    };

    const leftEffect: Action = (actionTx) => {
      leftEffectRuns++;
      const value = intermediate.withTx(actionTx).get();
      leftResult.withTx(actionTx).send(value + 1);
    };

    const rightEffect: Action = (actionTx) => {
      rightEffectRuns++;
      const value = intermediate.withTx(actionTx).get();
      rightResult.withTx(actionTx).send(value + 2);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      leftEffect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(leftResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    runtime.scheduler.subscribe(
      rightEffect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(rightResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    await runtime.scheduler.idle();

    expect(leftResult.get()).toBe(11);
    expect(rightResult.get()).toBe(12);
    expect(computationRuns).toBe(1);
    expect(leftEffectRuns).toBe(1);
    expect(rightEffectRuns).toBe(1);

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(leftResult.get()).toBe(21);
    expect(rightResult.get()).toBe(22);
    expect(computationRuns).toBe(2);
    expect(leftEffectRuns).toBe(2);
    expect(rightEffectRuns).toBe(2);
  });

  it("should recompute multi-hop chains before running effects in pull mode", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-multihop-source",
      undefined,
      tx,
    );
    source.set(1);
    const intermediate1 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-1",
      undefined,
      tx,
    );
    intermediate1.set(0);
    const intermediate2 = runtime.getCell<number>(
      space,
      "pull-multihop-mid-2",
      undefined,
      tx,
    );
    intermediate2.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-multihop-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let comp1Runs = 0;
    let comp2Runs = 0;
    let effectRuns = 0;

    const computation1: Action = (actionTx) => {
      comp1Runs++;
      const val = source.withTx(actionTx).get();
      intermediate1.withTx(actionTx).send(val + 1);
    };

    const computation2: Action = (actionTx) => {
      comp2Runs++;
      const val = intermediate1.withTx(actionTx).get();
      intermediate2.withTx(actionTx).send(val * 2);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = intermediate2.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val - 3);
    };

    runtime.scheduler.subscribe(
      computation1,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate1.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      computation2,
      {
        reads: [toMemorySpaceAddress(intermediate1.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate2.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate2.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectResult.get()).toBe((1 + 1) * 2 - 3);
    expect(comp2Runs).toBe(1);
    expect(effectRuns).toBe(1);

    const tx2 = runtime.edit();
    source.withTx(tx2).send(5);
    await tx2.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(comp1Runs).toBe(2);
    expect(comp2Runs).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe((5 + 1) * 2 - 3);
  });

  it("should drop stale dependents when computation changes inputs", async () => {
    const sourceA = runtime.getCell<number>(
      space,
      "pull-deps-source-a",
      undefined,
      tx,
    );
    sourceA.set(2);
    const sourceB = runtime.getCell<number>(
      space,
      "pull-deps-source-b",
      undefined,
      tx,
    );
    sourceB.set(7);
    const selector = runtime.getCell<boolean>(
      space,
      "pull-deps-selector",
      undefined,
      tx,
    );
    selector.set(false);
    const intermediate = runtime.getCell<number>(
      space,
      "pull-deps-intermediate",
      undefined,
      tx,
    );
    intermediate.set(0);
    const effectResult = runtime.getCell<number>(
      space,
      "pull-deps-effect",
      undefined,
      tx,
    );
    effectResult.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;

    const computation: Action = (actionTx) => {
      const useB = selector.withTx(actionTx).get();
      const value = useB
        ? sourceB.withTx(actionTx).get()
        : sourceA.withTx(actionTx).get();
      intermediate.withTx(actionTx).send(value * 10);
    };

    const effect: Action = (actionTx) => {
      effectRuns++;
      const value = intermediate.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(value);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [
          toMemorySpaceAddress(selector.getAsNormalizedFullLink()),
          toMemorySpaceAddress(sourceA.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
      },
      {},
    );
    await effectResult.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe(20);

    // Switch computation to sourceB
    const toggleTx = runtime.edit();
    selector.withTx(toggleTx).send(true);
    await toggleTx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);

    // Updating sourceA should not dirty the computation any more
    const tx3 = runtime.edit();
    sourceA.withTx(tx3).send(999);
    await tx3.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe(70);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    // Updating sourceB should still run the computation
    const tx4 = runtime.edit();
    sourceB.withTx(tx4).send(6);
    await tx4.commit();
    tx = runtime.edit();
    await effectResult.pull();

    expect(effectRuns).toBe(3);
    expect(effectResult.get()).toBe(60);
  });

  it("should track getStats with dirty count", async () => {
    const source = runtime.getCell<number>(
      space,
      "stats-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    const computation: Action = () => {};

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      {},
    );
    runtime.scheduler.queueExecution();
    await runtime.idle();

    // In pull mode, computation stays dirty since no effect pulled it
    // (computations are lazily evaluated only when needed by effects)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    // Stats should show correct counts
    const stats = runtime.scheduler.getStats();
    expect(stats.computations).toBeGreaterThanOrEqual(1);
    expect(stats.effects).toBe(0);
  });

  it("should keep invalid status value-local instead of transitive", async () => {
    const source = runtime.getCell<number>(
      space,
      "invalid-state-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "invalid-state-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "invalid-state-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "invalid-state-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    const actionA: Action = (actionTx) => {
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
    };
    const actionB: Action = (actionTx) => {
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await sink.pull();

    // The commit's local notification marks the graph synchronously at
    // commit() call time; awaiting the commit would span the cleanup pass.
    // Assert the marked-but-unrun shape before awaiting.
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    const updateCommit = updateTx.commit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(runtime.scheduler.isDirty(actionA)).toBe(true);
    expect(runtime.scheduler.isDirty(actionB)).toBe(false);
    expect(schedulerInternal.isInvalid(actionA)).toBe(true);
    expect(schedulerInternal.isInvalid(actionB)).toBe(false);
    expect(schedulerInternal.isInvalid(effect)).toBe(false);
    await updateCommit;
  });

  it("should keep a resubscribed shallow-read effect clean until its writer changes value", async () => {
    const source = runtime.getCell<number>(
      space,
      "pull-shallow-resubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const output = runtime.getCell<{ children: number[] }>(
      space,
      "pull-shallow-resubscribe-output",
      undefined,
      tx,
    );
    output.set({ children: [] });
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      output.withTx(actionTx).key("children").set([
        source.withTx(actionTx).get() ?? 0,
      ]);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(
            output.key("children").getAsNormalizedFullLink(),
          ),
        ],
      },
      {},
    );

    expect(runtime.scheduler.isDirty(computation)).toBe(true);
    expect(computationRuns).toBe(0);

    let effectRuns = 0;
    const effect: Action = (effectTx) => {
      effectRuns++;
      output.withTx(effectTx).key("children").getRaw({
        nonRecursive: true,
      });
    };

    runtime.scheduler.resubscribe(
      effect,
      {
        reads: [],
        shallowReads: [
          toMemorySpaceAddress(
            output.key("children").getAsNormalizedFullLink(),
          ),
        ],
        writes: [],
      },
      { isEffect: true },
    );

    // Resubscription records the effect's completed read set. An invalid
    // upstream writer is reachability evidence, not a value-bearing change;
    // the effect becomes invalid only if that writer's commit changes output.
    expect(runtime.scheduler.isDirty(effect)).toBe(false);
    await runtime.scheduler.idle();

    expect(computationRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
    expect(runtime.scheduler.isDirty(effect)).toBe(false);
  });

  it("should keep downstream clean when upstream recomputes unchanged", async () => {
    const source = runtime.getCell<number>(
      space,
      "invalid-noop-source",
      undefined,
      tx,
    );
    source.set(1);
    const stable = runtime.getCell<number>(
      space,
      "invalid-noop-stable",
      undefined,
      tx,
    );
    stable.set(0);
    const output = runtime.getCell<number>(
      space,
      "invalid-noop-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "invalid-noop-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    let stableRuns = 0;
    let downstreamRuns = 0;
    let effectRuns = 0;
    const stableAction: Action = (actionTx) => {
      stableRuns++;
      source.withTx(actionTx).get();
      stable.withTx(actionTx).send(1);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((stable.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      effectRuns++;
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      stableAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(stable.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await sink.pull();
    expect(sink.get()).toBe(2);

    stableRuns = 0;
    downstreamRuns = 0;
    effectRuns = 0;

    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    await runtime.scheduler.idle();

    expect(stableRuns).toBe(1);
    expect(downstreamRuns).toBe(0);
    expect(effectRuns).toBe(0);
    expect(sink.get()).toBe(2);

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(schedulerInternal.isInvalid(stableAction)).toBe(false);
    expect(schedulerInternal.isInvalid(downstreamAction)).toBe(false);
    expect(schedulerInternal.isInvalid(effect)).toBe(false);
  });

  it("should run downstream demand when upstream recompute changes output", async () => {
    const source = runtime.getCell<number>(
      space,
      "stale-change-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "stale-change-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "stale-change-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "stale-change-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    let downstreamRuns = 0;
    const upstreamAction: Action = (actionTx) => {
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) * 10);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) + 1);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      upstreamAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await sink.pull();
    expect(sink.get()).toBe(11);

    downstreamRuns = 0;
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(2);
    await updateTx.commit();
    await sink.pull();

    expect(downstreamRuns).toBe(1);
    expect(sink.get()).toBe(21);
    expect(runtime.scheduler.isDirty(downstreamAction)).toBe(false);
  });

  it("should keep event handlers behind invalid dependencies", async () => {
    const source = runtime.getCell<number>(
      space,
      "invalid-event-source",
      undefined,
      tx,
    );
    source.set(1);
    const mid = runtime.getCell<number>(
      space,
      "invalid-event-mid",
      undefined,
      tx,
    );
    mid.set(0);
    const output = runtime.getCell<number>(
      space,
      "invalid-event-output",
      undefined,
      tx,
    );
    output.set(0);
    const eventStream = runtime.getCell<number>(
      space,
      "invalid-event-stream",
      undefined,
      tx,
    );
    eventStream.set(0);
    const result = runtime.getCell<number>(
      space,
      "invalid-event-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let upstreamRuns = 0;
    let downstreamRuns = 0;
    let handlerRuns = 0;
    const upstreamAction: Action = (actionTx) => {
      upstreamRuns++;
      mid.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
    };
    const downstreamAction: Action = (actionTx) => {
      downstreamRuns++;
      output.withTx(actionTx).send((mid.withTx(actionTx).get() ?? 0) * 2);
    };

    runtime.scheduler.subscribe(
      upstreamAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      downstreamAction,
      {
        reads: [toMemorySpaceAddress(mid.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    await output.pull();

    const handler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      result.withTx(handlerTx).send(
        (output.withTx(handlerTx).get() ?? 0) + event,
      );
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      (depTx) => output.withTx(depTx).get(),
    );

    upstreamRuns = 0;
    downstreamRuns = 0;
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(4);
    await updateTx.commit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 5);
    await result.pull();

    expect(upstreamRuns).toBe(1);
    expect(downstreamRuns).toBe(1);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(((4 + 1) * 2) + 5);
  });

  it("should dispatch clean broad event preflight dependencies", async () => {
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
      const source = runtime.getCell<number>(
        space,
        "invalid-clean-preflight-source",
        undefined,
        tx,
      );
      source.set(1);
      const shared = runtime.getCell<number>(
        space,
        "invalid-clean-preflight-shared",
        undefined,
        tx,
      );
      shared.set(0);
      const target = runtime.getCell<number>(
        space,
        "invalid-clean-preflight-target",
        undefined,
        tx,
      );
      target.set(0);
      const eventStream = runtime.getCell<number>(
        space,
        "invalid-clean-preflight-event",
        undefined,
        tx,
      );
      eventStream.set(0);
      const result = runtime.getCell<number>(
        space,
        "invalid-clean-preflight-result",
        undefined,
        tx,
      );
      result.set(0);
      const fanCells: Cell<number>[] = [];
      for (let i = 0; i < 32; i++) {
        const cell = runtime.getCell<number>(
          space,
          `invalid-clean-preflight-fan-${i}`,
          undefined,
          tx,
        );
        cell.set(0);
        fanCells.push(cell);
      }
      await tx.commit();
      tx = runtime.edit();

      const sharedWriter: Action = (actionTx) => {
        shared.withTx(actionTx).send((source.withTx(actionTx).get() ?? 0) + 1);
      };
      runtime.scheduler.subscribe(
        sharedWriter,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
        },
        {},
      );

      for (const [index, fanCell] of fanCells.entries()) {
        const fanWriter: Action = (actionTx) => {
          fanCell.withTx(actionTx).send(
            (shared.withTx(actionTx).get() ?? 0) + index,
          );
        };
        runtime.scheduler.subscribe(
          fanWriter,
          {
            reads: [toMemorySpaceAddress(shared.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(fanCell.getAsNormalizedFullLink())],
          },
          {},
        );
      }

      const targetWriter: Action = (actionTx) => {
        let sum = 0;
        for (const fanCell of fanCells) {
          sum += fanCell.withTx(actionTx).get() ?? 0;
        }
        target.withTx(actionTx).send(sum);
      };
      runtime.scheduler.subscribe(
        targetWriter,
        {
          reads: fanCells.map((cell) =>
            toMemorySpaceAddress(cell.getAsNormalizedFullLink())
          ),
          shallowReads: [],
          writes: [toMemorySpaceAddress(target.getAsNormalizedFullLink())],
        },
        {},
      );
      await target.pull();

      const handler: EventHandler = (handlerTx, event: number) => {
        result.withTx(handlerTx).send(
          (target.withTx(handlerTx).get() ?? 0) + event,
        );
      };
      runtime.scheduler.addEventHandler(
        handler,
        eventStream.getAsNormalizedFullLink(),
        (depTx) => target.withTx(depTx).get(),
      );

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
      await result.pull();

      expect(preflights.length).toBe(1);
      expect(preflights[0].skipped).toBe(false);
      expect(preflights[0].hasDirtyDependencies).toBe(false);
      // Inverted preflight (decision 15): the walk seeds from the invalid-node
      // set and walks down to the closure, so its cost is bounded by the
      // (here near-empty) invalid set, NOT the 32-wide closure cone. The old
      // upstream walk visited the whole cone (~33+); the inverted walk visits
      // only a stray never-ran seed or two. This bound is the O(N^2)→O(N) fix
      // for rapid creation against a hub.
      expect(preflights[0].stats.visitCount).toBeLessThan(10);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("defers an event handler behind an invalid upstream materializer", async () => {
    // Exercises the materializer arm of the inverted preflight walk: a
    // materializer feeds a cell the handler reads, so it joins the handler's
    // closure; when its source changes it is invalid and the event must not
    // dispatch on the stale value until the materializer re-runs.
    const source = runtime.getCell<number>(
      space,
      "mat-preflight-source",
      undefined,
      tx,
    );
    const materialized = runtime.getCell<number>(
      space,
      "mat-preflight-materialized",
      undefined,
      tx,
    );
    const eventStream = runtime.getCell<number>(
      space,
      "mat-preflight-event",
      undefined,
      tx,
    );
    const result = runtime.getCell<number>(
      space,
      "mat-preflight-result",
      undefined,
      tx,
    );
    source.set(1);
    materialized.set(0);
    eventStream.set(0);
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let materializerRuns = 0;
    const materializer = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        materialized.withTx(actionTx).send(
          (source.withTx(actionTx).get() ?? 0) + 100,
        );
      },
      {
        materializerWriteEnvelopes: [materialized.getAsNormalizedFullLink()],
      },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof materialized.getAsNormalizedFullLink
      >[];
    };
    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    });
    await runtime.idle();
    expect(materializerRuns).toBe(1);
    expect(materialized.get()).toBe(101);

    let handlerRuns = 0;
    const handler: EventHandler = (handlerTx, event: number) => {
      handlerRuns++;
      result.withTx(handlerTx).send(
        (materialized.withTx(handlerTx).get() ?? 0) + event,
      );
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      (depTx) => materialized.withTx(depTx).get(),
    );

    // Invalidate the materializer via its source; `materialized` is now stale.
    const updateTx = runtime.edit();
    source.withTx(updateTx).send(5);
    await updateTx.commit();

    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 7);
    await result.pull();

    // The gate re-ran the materializer before dispatching, so the handler saw
    // the fresh value (105), not the stale 101.
    expect(materializerRuns).toBe(2);
    expect(handlerRuns).toBe(1);
    expect(result.get()).toBe(105 + 7);
  });

  it("bounds event preflight cost over a wide fan-in hub", async () => {
    // The notebook regression shape (decision 15): N independent writers feed
    // one aggregating hub that the handler reads. Invalidating ONE writer must
    // cost O(1) preflight work — its downstream cone is just the hub — not an
    // O(N) walk over the whole fan-in. The old upstream walk visited ~N; the
    // inverted walk seeds from the (size-1) invalid set.
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
      const N = 200;
      const sources: Cell<number>[] = [];
      const cells: Cell<number>[] = [];
      for (let i = 0; i < N; i++) {
        const s = runtime.getCell<number>(
          space,
          `fanin-source-${i}`,
          undefined,
          tx,
        );
        s.set(0);
        sources.push(s);
        const c = runtime.getCell<number>(
          space,
          `fanin-cell-${i}`,
          undefined,
          tx,
        );
        c.set(0);
        cells.push(c);
      }
      const hub = runtime.getCell<number>(space, "fanin-hub", undefined, tx);
      hub.set(0);
      const eventStream = runtime.getCell<number>(
        space,
        "fanin-event",
        undefined,
        tx,
      );
      eventStream.set(0);
      const result = runtime.getCell<number>(
        space,
        "fanin-result",
        undefined,
        tx,
      );
      result.set(0);
      await tx.commit();
      tx = runtime.edit();

      for (let i = 0; i < N; i++) {
        const idx = i;
        const writer: Action = (actionTx) => {
          cells[idx].withTx(actionTx).send(
            (sources[idx].withTx(actionTx).get() ?? 0) + 1,
          );
        };
        runtime.scheduler.subscribe(
          writer,
          {
            reads: [
              toMemorySpaceAddress(sources[idx].getAsNormalizedFullLink()),
            ],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(cells[idx].getAsNormalizedFullLink()),
            ],
          },
          {},
        );
      }
      const hubWriter: Action = (actionTx) => {
        let sum = 0;
        for (const c of cells) sum += c.withTx(actionTx).get() ?? 0;
        hub.withTx(actionTx).send(sum);
      };
      runtime.scheduler.subscribe(
        hubWriter,
        {
          reads: cells.map((c) =>
            toMemorySpaceAddress(c.getAsNormalizedFullLink())
          ),
          shallowReads: [],
          writes: [toMemorySpaceAddress(hub.getAsNormalizedFullLink())],
        },
        {},
      );
      await hub.pull();

      const handler: EventHandler = (handlerTx, event: number) => {
        result.withTx(handlerTx).send(
          (hub.withTx(handlerTx).get() ?? 0) + event,
        );
      };
      runtime.scheduler.addEventHandler(
        handler,
        eventStream.getAsNormalizedFullLink(),
        (depTx) => hub.withTx(depTx).get(),
      );

      // Invalidate exactly one of the 200 upstream writers.
      const updateTx = runtime.edit();
      sources[0].withTx(updateTx).send(1);
      await updateTx.commit();

      runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 9);
      await result.pull();

      // Correctness: the handler waited for the invalidated writer + hub to
      // re-settle before dispatching. All 200 cells start at 1 (source 0 + 1),
      // so hub starts at 200; bumping source[0] to 1 makes cell[0] = 2, hub =
      // 201. A stale dispatch would read 200 → 209; the fresh value is 210.
      expect(result.get()).toBe(201 + 9);
      // The fix: no preflight walked the 200-wide fan-in. The forward walk
      // would have visited ~200 per dispatch; the inverted walk visits O(1).
      expect(preflights.length).toBeGreaterThanOrEqual(1);
      const maxVisit = maxOf(preflights.map((p) => p.stats.visitCount));
      expect(maxVisit).toBeLessThan(20);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  });

  it("should update invalid status when dynamic dependencies change", async () => {
    const selector = runtime.getCell<number>(
      space,
      "invalid-dynamic-selector",
      undefined,
      tx,
    );
    selector.set(0);
    const sourceA = runtime.getCell<number>(
      space,
      "invalid-dynamic-source-a",
      undefined,
      tx,
    );
    sourceA.set(1);
    const sourceB = runtime.getCell<number>(
      space,
      "invalid-dynamic-source-b",
      undefined,
      tx,
    );
    sourceB.set(10);
    const output = runtime.getCell<number>(
      space,
      "invalid-dynamic-output",
      undefined,
      tx,
    );
    output.set(0);
    const sink = runtime.getCell<number>(
      space,
      "invalid-dynamic-sink",
      undefined,
      tx,
    );
    sink.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const useB = (selector.withTx(actionTx).get() ?? 0) === 1;
      const sourceCell = useB ? sourceB : sourceA;
      output.withTx(actionTx).send(sourceCell.withTx(actionTx).get() ?? 0);
    };
    const effect: Action = (actionTx) => {
      sink.withTx(actionTx).send(output.withTx(actionTx).get() ?? 0);
    };

    runtime.scheduler.subscribe(
      action,
      {
        reads: [
          toMemorySpaceAddress(selector.getAsNormalizedFullLink()),
          toMemorySpaceAddress(sourceA.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(sink.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await sink.pull();

    const switchTx = runtime.edit();
    selector.withTx(switchTx).send(1);
    await switchTx.commit();
    await sink.pull();
    expect(sink.get()).toBe(10);

    // The commit's local notification marks the graph synchronously at
    // commit() call time; awaiting the commit would span the cleanup pass.
    // Assert the marking at that synchronous point, on both sides.
    const updateOldSourceTx = runtime.edit();
    sourceA.withTx(updateOldSourceTx).send(2);
    const updateOldSourceCommit = updateOldSourceTx.commit();

    const schedulerInternal = getStaleSchedulerInternals(runtime.scheduler);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    expect(schedulerInternal.isInvalid(action)).toBe(false);
    await updateOldSourceCommit;

    const updateNewSourceTx = runtime.edit();
    sourceB.withTx(updateNewSourceTx).send(11);
    const updateNewSourceCommit = updateNewSourceTx.commit();
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    expect(schedulerInternal.isInvalid(action)).toBe(true);
    await updateNewSourceCommit;
  });
});
