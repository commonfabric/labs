// Bounded convergence tests: verifying that the scheduler handles circular
// dependencies without unbounded reactive work.

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  getStaleSchedulerInternals,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import {
  CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
  PASS_RUN_BUDGET,
} from "../src/scheduler/constants.ts";

describe("bounded convergence", () => {
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

  it("should track action execution time", async () => {
    const cell = runtime.getCell<number>(
      space,
      "action-timing-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = () => {
      // Simulate some work
      let sum = 0;
      for (let i = 0; i < 1000; i++) {
        sum += i;
      }
      return sum;
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    runtime.scheduler.queueExecution();
    await runtime.idle();

    // Should have stats recorded
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(1);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(0);
    expect(stats!.averageTime).toBe(stats!.totalTime);
    expect(stats!.lastRunTime).toBe(stats!.totalTime);
  });

  it("should accumulate action stats across multiple runs", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "action-stats-trigger",
      undefined,
      tx,
    );
    trigger.set(1);
    const output = runtime.getCell<number>(
      space,
      "action-stats-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = trigger.withTx(actionTx).get();
      output.withTx(actionTx).send(val * 2);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await output.pull();

    // First run
    let stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(1);
    const firstRunTime = stats!.totalTime;

    // Trigger another run
    trigger.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await output.pull();

    // Second run - stats should accumulate
    stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(2);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(firstRunTime);
    expect(stats!.averageTime).toBe(stats!.totalTime / 2);
  });

  it("should handle cycles implicitly via re-dirtying detection", async () => {
    // Test that cycles are detected implicitly when actions re-dirty processed actions

    // Create cells for a simple converging cycle: A → B → A
    const cellA = runtime.getCell<number>(
      space,
      "cycle-detect-A",
      undefined,
      tx,
    );
    cellA.set(1);
    const cellB = runtime.getCell<number>(
      space,
      "cycle-detect-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const output = runtime.getCell<number>(
      space,
      "cycle-detect-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let actionARunCount = 0;
    let actionBRunCount = 0;
    let effectRunCount = 0;

    // Action A: reads A, writes B (computation)
    const actionA: Action = (actionTx) => {
      actionARunCount++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Action B: reads B, writes A (creates cycle, but converges)
    const actionB: Action = (actionTx) => {
      actionBRunCount++;
      const val = cellB.withTx(actionTx).get();
      // Only update if we haven't converged (val < 5 means cycle continues)
      if (val < 5) {
        cellA.withTx(actionTx).send(val);
      }
    };

    // Effect: observes cycle output (required to drive pull-based scheduling)
    const effect: Action = (actionTx) => {
      effectRunCount++;
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations first
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    // Wait for scheduler to settle
    await runtime.scheduler.idle();

    // All actions should have run (cycle was detected and handled)
    expect(actionARunCount).toBeGreaterThan(0);
    expect(actionBRunCount).toBeGreaterThan(0);
    expect(effectRunCount).toBeGreaterThan(0);
    // The cycle should make progress - cellB should have been updated from initial 0
    expect(cellB.get()).toBeGreaterThan(0);
  });

  it("should run fast cycle convergence method", async () => {
    // This test verifies the fast cycle convergence logic by directly
    // testing with default scheduling (which bypasses pull mode complexity)

    // Create a simple dependency chain
    const counter = runtime.getCell<number>(
      space,
      "fast-cycle-counter",
      undefined,
      tx,
    );
    counter.set(0);
    const doubled = runtime.getCell<number>(
      space,
      "fast-cycle-doubled",
      undefined,
      tx,
    );
    doubled.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    // Computation: doubles the counter
    const computation: Action = (actionTx) => {
      const val = counter.withTx(actionTx).get();
      doubled.withTx(actionTx).send(val * 2);
    };

    // Subscribe to ensure it runs immediately (default behavior)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(doubled.getAsNormalizedFullLink())],
      },
      {},
    );
    await doubled.pull();

    // After initial run, doubled should be 0 (0 * 2)
    expect(doubled.get()).toBe(0);

    // Update counter and run again
    counter.withTx(tx).send(5);
    await tx.commit().settled;
    tx = runtime.edit();

    // Subscribe again to re-run
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(doubled.getAsNormalizedFullLink())],
      },
      {},
    );
    await doubled.pull();

    // Now doubled should be 10 (5 * 2)
    expect(doubled.get()).toBe(10);
  });

  it("should apply pass budget backoff for non-converging cycles", async () => {
    // Create a non-converging cycle (always increments)
    const cellA = runtime.getCell<number>(
      space,
      "non-converge-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "non-converge-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const output = runtime.getCell<number>(
      space,
      "non-converge-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;

    // Action A: increments based on B
    const actionA: Action = (actionTx) => {
      runCountA++;
      const val = cellB.withTx(actionTx).get();
      cellA.withTx(actionTx).send(val + 1);
    };

    // Action B: increments based on A (infinite loop)
    const actionB: Action = (actionTx) => {
      runCountB++;
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val + 1);
    };

    // Effect to observe the cycle and drive pull-based scheduling
    const effect: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      output.withTx(actionTx).send(val);
    };

    // Subscribe both computations
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
      },
      {},
    );

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
      },
      {},
    );

    // Subscribe effect to drive the pull
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();

      expect(runCountA).toBeLessThanOrEqual(
        PASS_RUN_BUDGET * CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
      );
      expect(runCountB).toBeLessThanOrEqual(
        PASS_RUN_BUDGET * CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
      );
      expect(runCountA + runCountB).toBeGreaterThan(0);
    } finally {
      // This cycle is intentionally permanent. Leaving it subscribed makes
      // runtime disposal enter another capped backoff sequence after the
      // assertion has already proven the behavior.
      runtime.scheduler.unsubscribe(actionA);
      runtime.scheduler.unsubscribe(actionB);
      runtime.scheduler.unsubscribe(effect);
    }
  });

  it("materializes a discovered-dependency chain within idle()", async () => {
    // A chain whose reads are discovered by first runs (raw builtins and VNode
    // traversal have this shape) must still materialize all the way to its
    // demanded effect before idle resolves.
    const DEPTH = 8;
    const cells = Array.from(
      { length: DEPTH + 1 },
      (_, i) =>
        runtime.getCell<number>(space, `deep-chain-${i}`, undefined, tx),
    );
    cells[0].set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    // comp[i] reads cells[i-1] (DISCOVERED — not declared) and writes cells[i]
    // (declared, so demand can flow upstream before any run).
    const compRuns = new Array<number>(DEPTH + 1).fill(0);
    for (let i = 1; i <= DEPTH; i++) {
      const src = cells[i - 1];
      const dst = cells[i];
      const comp: Action = (actionTx) => {
        compRuns[i]++;
        const value = src.withTx(actionTx).get();
        // A placeholder write on missing input mirrors incremental VNode
        // materialization: every level's run changes what downstream reads,
        // so the whole downstream re-runs each settle iteration.
        dst.withTx(actionTx).send(value === undefined ? -i : value + 1);
      };
      runtime.scheduler.subscribe(
        comp,
        {
          reads: [],
          shallowReads: [],
          writes: [toMemorySpaceAddress(dst.getAsNormalizedFullLink())],
        },
        {},
      );
    }

    let observed: number | undefined;
    const effect: Action = (actionTx) => {
      observed = cells[DEPTH].withTx(actionTx).get();
    };
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(cells[DEPTH].getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    await runtime.idle();

    // The whole chain must have materialized: every computation ran at least
    // once and the effect observed the fully-propagated value.
    for (let i = 1; i <= DEPTH; i++) {
      expect(compRuns[i], `comp[${i}] never ran`).toBeGreaterThan(0);
    }
    expect(observed, "effect observed the fully-propagated value").toBe(
      DEPTH + 1,
    );
  });

  it("should preserve dirty effects after pass budget exhaustion", async () => {
    const schedulerInternal = runtime.scheduler.accessForTestingOnly;
    const staleSchedulerInternal = getStaleSchedulerInternals(
      runtime.scheduler,
    );
    let effectRuns = 0;
    const reDirtyLimit = 25;

    const selfDirtyingEffect: Action = () => {
      effectRuns++;
      if (effectRuns <= reDirtyLimit) {
        staleSchedulerInternal.markDirty(selfDirtyingEffect);
      }
    };

    runtime.scheduler.subscribe(
      selfDirtyingEffect,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    if (schedulerInternal.pendingQueueTaskTimer !== null) {
      clearTimeout(schedulerInternal.pendingQueueTaskTimer);
      schedulerInternal.pendingQueueTaskTimer = null;
    }

    await schedulerInternal.execute();

    if (schedulerInternal.pendingQueueTaskTimer !== null) {
      clearTimeout(schedulerInternal.pendingQueueTaskTimer);
      schedulerInternal.pendingQueueTaskTimer = null;
      schedulerInternal.scheduled = false;
    }

    expect(effectRuns).toBe(PASS_RUN_BUDGET);
    expect(runtime.scheduler.isDirty(selfDirtyingEffect)).toBe(true);
  });

  it("should not create infinite loops while resubscribing dependencies", async () => {
    // Create a simple dependency structure
    const source = runtime.getCell<number>(
      space,
      "collect-deps-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "collect-deps-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const computation: Action = (actionTx) => {
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

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

    // Initial result should be 2 (1 * 2)
    expect(result.get()).toBe(2);

    // Change source
    source.withTx(tx).send(9);
    await tx.commit().settled;
    tx = runtime.edit();

    // Re-subscribe to force a re-run (simulating what happens in real usage)
    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      {},
    );

    // Wait for updates
    await result.pull();

    // Final result should be based on last value
    expect(result.get()).toBe(18); // 9 * 2
  });

  it("should handle cycles during dependency collection without non-convergence", async () => {
    // Create cells that form a cycle
    const cellA = runtime.getCell<number>(
      space,
      "collect-cycle-A",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "collect-cycle-B",
      undefined,
      tx,
    );
    cellB.set(0);
    const cellC = runtime.getCell<number>(
      space,
      "collect-cycle-C",
      undefined,
      tx,
    );
    cellC.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    // A → B → C → A cycle
    const actionA: Action = (actionTx) => {
      const val = cellC.withTx(actionTx).get();
      if (val < 3) {
        cellA.withTx(actionTx).send(val + 1);
      }
    };

    const actionB: Action = (actionTx) => {
      const val = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).send(val);
    };

    const actionC: Action = (actionTx) => {
      const val = cellB.withTx(actionTx).get();
      cellC.withTx(actionTx).send(val);
    };

    // Subscribe all actions
    runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(cellC.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
      },
      {},
    );
    await cellA.pull();

    runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(cellA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
      },
      {},
    );
    await cellB.pull();

    runtime.scheduler.subscribe(
      actionC,
      {
        reads: [toMemorySpaceAddress(cellB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cellC.getAsNormalizedFullLink())],
      },
      {},
    );
    await cellC.pull();

    // The cycle should converge (value reaches 3).
    expect(cellC.get()).toBeLessThanOrEqual(3);
  });

  //
  // Action Stats Edge Cases
  //

  it("should return undefined for unknown action stats", () => {
    const unknownAction: Action = () => {};
    const stats = runtime.scheduler.getActionStats(unknownAction);
    expect(stats).toBeUndefined();
  });

  it("should record stats even when action throws", async () => {
    let errorCaught = false;
    runtime.scheduler.onError(() => {
      errorCaught = true;
    });

    const errorAction: Action = () => {
      throw new Error("Test error");
    };

    runtime.scheduler.subscribe(
      errorAction,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    runtime.scheduler.queueExecution();
    await runtime.idle();

    // Error should have been caught
    expect(errorCaught).toBe(true);

    // Stats should still be recorded
    const stats = runtime.scheduler.getActionStats(errorAction);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(1);
  });

  it("should correctly calculate average time", async () => {
    const cell = runtime.getCell<number>(
      space,
      "avg-time-cell",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      // Do some work to ensure measurable time
      let sum = 0;
      for (let i = 0; i < 100; i++) sum += i;
      cell.withTx(actionTx).send(sum);
    };

    // Run action multiple times
    for (let i = 0; i < 3; i++) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await cell.pull();
    }

    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(3);
    // Average should be total / count
    expect(stats!.averageTime).toBeCloseTo(stats!.totalTime / 3, 5);
  });

  //
  // Cycle Convergence Scenarios
  //

  it("should handle larger cycles without hanging", async () => {
    const cellA = runtime.getCell<number>(space, "4cycle-A", undefined, tx);
    cellA.set(1);
    const cellB = runtime.getCell<number>(space, "4cycle-B", undefined, tx);
    cellB.set(0);
    const cellC = runtime.getCell<number>(space, "4cycle-C", undefined, tx);
    cellC.set(0);
    const cellD = runtime.getCell<number>(space, "4cycle-D", undefined, tx);
    cellD.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let totalRuns = 0;

    // A → B → C → D → A (converges when D reaches 4)
    const actionA: Action = (actionTx) => {
      totalRuns++;
      const val = cellD.withTx(actionTx).get();
      if (val < 4) cellA.withTx(actionTx).send(val + 1);
    };
    const actionB: Action = (actionTx) => {
      totalRuns++;
      cellB.withTx(actionTx).send(cellA.withTx(actionTx).get());
    };
    const actionC: Action = (actionTx) => {
      totalRuns++;
      cellC.withTx(actionTx).send(cellB.withTx(actionTx).get());
    };
    const actionD: Action = (actionTx) => {
      totalRuns++;
      cellD.withTx(actionTx).send(cellC.withTx(actionTx).get());
    };

    // Subscribe all and let them run
    for (const action of [actionA, actionB, actionC, actionD]) {
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        {},
      );
      await cellD.pull();
    }

    // Let the cycle run for a few iterations
    for (let i = 0; i < 10; i++) {
      await cellD.pull();
    }

    // Should converge without infinite loop
    expect(cellD.get()).toBeLessThanOrEqual(4);
    // Should be bounded, not infinite
    expect(totalRuns).toBeLessThan(500);
  });

  it("should handle self-referential action without infinite loop", async () => {
    const counter = runtime.getCell<number>(
      space,
      "self-ref-counter",
      undefined,
      tx,
    );
    counter.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;

    // Action reads and writes the same cell (converges after 5)
    const selfRefAction: Action = (actionTx) => {
      runCount++;
      const val = counter.withTx(actionTx).get();
      if (val < 5) {
        counter.withTx(actionTx).send(val + 1);
      }
    };

    runtime.scheduler.subscribe(
      selfRefAction,
      { reads: [], shallowReads: [], writes: [] },
      {},
    );

    // Let it run for a while
    for (let i = 0; i < 20; i++) {
      await counter.pull();
    }

    // Should have converged and stopped at some point
    // The exact value depends on how reactive updates propagate
    expect(counter.get()).toBeLessThanOrEqual(5);
    // Should not run infinitely
    expect(runCount).toBeLessThan(200);
  });

  it("should preserve action stats across multiple scheduling cycles", async () => {
    const cell = runtime.getCell<number>(
      space,
      "preserve-stats-cell",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First scheduling cycle
    runtime.scheduler.subscribe(
      action,
      {
        reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );
    await cell.pull();

    let stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBe(1);
    const firstRunTime = stats!.lastRunTime;

    // Trigger another run by updating cell externally
    cell.withTx(tx).send(10);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.subscribe(
      action,
      {
        reads: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );
    await cell.pull();

    // Stats should persist and accumulate. The action reads and writes the
    // same cell, so a fast commit path (batch signing with immediate flush)
    // may cause one extra re-trigger before cycle detection kicks in.
    stats = runtime.scheduler.getActionStats(action);
    expect(stats!.runCount).toBeGreaterThanOrEqual(2);
    expect(stats!.runCount).toBeLessThanOrEqual(3);
    expect(stats!.totalTime).toBeGreaterThanOrEqual(firstRunTime);
  });

  it("should handle mixed cyclic and acyclic actions without hanging", async () => {
    // Acyclic: source → computed
    const source = runtime.getCell<number>(
      space,
      "mixed-source",
      undefined,
      tx,
    );
    source.set(1);
    const computed = runtime.getCell<number>(
      space,
      "mixed-computed",
      undefined,
      tx,
    );
    computed.set(0);

    // Cyclic: cycleA ↔ cycleB
    const cycleA = runtime.getCell<number>(
      space,
      "mixed-cycleA",
      undefined,
      tx,
    );
    cycleA.set(1);
    const cycleB = runtime.getCell<number>(
      space,
      "mixed-cycleB",
      undefined,
      tx,
    );
    cycleB.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let acyclicRuns = 0;
    let cycleRuns = 0;

    const acyclicAction: Action = (actionTx) => {
      acyclicRuns++;
      computed.withTx(actionTx).send(source.withTx(actionTx).get() * 2);
    };

    const cycleActionA: Action = (actionTx) => {
      cycleRuns++;
      cycleB.withTx(actionTx).send(cycleA.withTx(actionTx).get());
    };

    const cycleActionB: Action = (actionTx) => {
      cycleRuns++;
      const val = cycleB.withTx(actionTx).get();
      if (val < 5) cycleA.withTx(actionTx).send(val);
    };

    // Subscribe all with proper writes for pull mode to discover dependencies
    runtime.scheduler.subscribe(
      acyclicAction,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(computed.getAsNormalizedFullLink())],
      },
      {},
    );
    await computed.pull();

    runtime.scheduler.subscribe(
      cycleActionA,
      {
        reads: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
      },
      {},
    );
    await cycleB.pull();

    runtime.scheduler.subscribe(
      cycleActionB,
      {
        reads: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
      },
      {},
    );
    await cycleA.pull();

    // Let them all run
    for (let i = 0; i < 10; i++) {
      await cycleB.pull();
    }

    // The acyclic action should have run at least once
    expect(acyclicRuns).toBeGreaterThanOrEqual(1);

    // The computed value should be correct
    expect(computed.get()).toBe(2); // 1 * 2

    // Cycle runs should be bounded
    expect(cycleRuns).toBeLessThan(500);
  });
});
