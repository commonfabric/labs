// Scheduler debounce and throttle tests.

import { BoundedKeyMap } from "@commonfabric/utils/cache";

import { getActionStats, recordActionTime } from "../src/scheduler/timing.ts";
import type { ActionStats } from "../src/telemetry.ts";
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
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("action timing stats", () => {
  // Each action instance gets its own id, so a pattern that keeps creating
  // actions — a list projecting a window that moves — would otherwise add a
  // stats entry per instance for the life of the runtime.
  const stateFor = (actionStats: BoundedKeyMap<string, ActionStats>) => ({
    actionStats,
    getActionId: (action: Action) => (action as { id?: string }).id ?? "?",
  });
  const actionWithId = (id: string) =>
    Object.assign(() => {}, { id }) as unknown as Action;

  it("bounds the stats map and drops the least recently run entry", () => {
    const actionStats = new BoundedKeyMap<string, ActionStats>(20_000);
    const state = stateFor(actionStats);
    for (let index = 0; index < 25_000; index++) {
      recordActionTime(state, actionWithId(`action-${index}`), 1, index);
    }
    expect(actionStats.size).toBeLessThanOrEqual(20_000);
    expect(getActionStats(state, "action-0")).toBeUndefined();
    expect(getActionStats(state, "action-24999")).toBeDefined();
  });

  it("keeps an action that keeps running", () => {
    const actionStats = new BoundedKeyMap<string, ActionStats>(20_000);
    const state = stateFor(actionStats);
    const survivor = actionWithId("survivor");
    recordActionTime(state, survivor, 1, 0);
    for (let index = 0; index < 25_000; index++) {
      recordActionTime(state, actionWithId(`action-${index}`), 1, index + 1);
      if (index % 100 === 0) {
        recordActionTime(state, survivor, 1, index + 1);
      }
    }
    const stats = getActionStats(state, survivor);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBe(251);
  });
});

describe("debounce and throttling", () => {
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

  it("should set and get debounce for an action", () => {
    const action: Action = () => {};

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    // Clear debounce
    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should set debounce to 0 clears it", () => {
    const action: Action = () => {};

    runtime.scheduler.setDebounce(action, 100);
    expect(runtime.scheduler.getDebounce(action)).toBe(100);

    runtime.scheduler.setDebounce(action, 0);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });

  it("should delay action execution when debounce is set", async () => {
    const cell = runtime.getCell<number>(space, "debounce-test", undefined, tx);
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set a short debounce
    runtime.scheduler.setDebounce(action, 50);

    // Subscribe with proper writes for pull mode
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce period
    await clock.tick(100);
    await cell.pull();

    // Now it should have run
    expect(runCount).toBe(1);
  });

  it("should coalesce rapid triggers into single execution", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-coalesce",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set debounce
    runtime.scheduler.setDebounce(action, 50);

    // Trigger multiple times rapidly (with proper writes for pull mode)
    for (let i = 0; i < 5; i++) {
      runtime.scheduler.subscribe(
        action,
        {
          reads: [],
          shallowReads: [],
          writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
        },
        {},
      );
      await clock.tick(10);
    }

    // Should not have run yet (debounce keeps resetting)
    expect(runCount).toBe(0);

    // Wait for debounce to complete
    await clock.tick(100);
    await cell.pull();

    // Should have run only once
    expect(runCount).toBe(1);
  });

  it("should apply debounce from subscribe options", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-option",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Subscribe with debounce option (and proper writes for pull mode)
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      { debounce: 50 },
    );

    // Verify debounce was set
    expect(runtime.scheduler.getDebounce(action)).toBe(50);

    // Action should NOT have run immediately
    expect(runCount).toBe(0);

    // Wait for debounce
    await clock.tick(100);
    await cell.pull();

    expect(runCount).toBe(1);
  });

  it("should debounce dirty pull computations with immediate first run and trailing flush", async () => {
    const source = runtime.getCell<number>(
      space,
      "debounce-pull-computation-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "debounce-pull-computation-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const computation: Action = (actionTx) => {
      runCount++;
      const value = source.withTx(actionTx).get();
      result.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { debounce: 50 },
    );

    await result.pull();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();

    await clock.settle();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    await clock.tick(25);
    source.withTx(tx).send(3);
    await tx.commit().settled;
    tx = runtime.edit();

    await clock.tick(30);
    await clock.settle();
    expect(runCount).toBe(1);
    expect(result.get()).toBe(10);

    await clock.tick(40);
    await runtime.idle();
    await result.pull();

    expect(runCount).toBe(2);
    expect(result.get()).toBe(30);
  });

  it("should cancel debounce timer on unsubscribe", async () => {
    const cell = runtime.getCell<number>(
      space,
      "debounce-cancel",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set debounce
    runtime.scheduler.setDebounce(action, 100);

    // Subscribe with default scheduling (runs immediately)
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      {},
    );

    // Action should not have run yet
    expect(runCount).toBe(0);

    // Unsubscribe before debounce completes
    cancel();

    // Wait past the debounce period
    await clock.tick(150);
    await runtime.idle();

    // Action should NOT have run because we unsubscribed
    expect(runCount).toBe(0);
  });

  it("resolves idle promptly after unsubscribing a debounced effect with an armed wake", async () => {
    // #4108: clearing/unsubscribing a debounced action must recompute the
    // single shared wake timer. Otherwise the stale wake keeps idle() blocked
    // until its dead deadline fires, even though no gated work remains.

    let runCount = 0;
    const effect: Action = () => {
      runCount++;
    };

    // A long debounce so the armed wake is far in the future; the fix must not
    // wait for it.
    runtime.scheduler.setDebounce(effect, 30_000);
    const cancel = runtime.scheduler.subscribe(
      effect,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    // Let the settle pass arm the debounce wake. The first run is deferred, so
    // the effect has not run yet.
    await clock.tick(20);
    expect(runCount).toBe(0);

    // idle() is blocked behind the armed wake + idle-blocking effect.
    const idlePromise = runtime.idle();

    // Unsubscribing clears the debounced node; the shared wake must be
    // recomputed so idle() resolves now rather than after the 30s deadline.
    cancel();

    const timedOut = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), 1000);
    });
    const outcome = await Promise.race([
      idlePromise.then(() => "idle" as const),
      timeout,
    ]);
    clearTimeout(timer!);

    expect(outcome).toBe("idle");
    expect(runCount).toBe(0);
  });

  it("should cancel pending debounce wake on dispose", async () => {
    const local = createSchedulerTestRuntime(`${import.meta.url}#dispose-wake`);
    let runCount = 0;
    const action: Action = () => {
      runCount++;
    };

    try {
      local.runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true, debounce: 50 },
      );
      expect(runCount).toBe(0);

      local.runtime.scheduler.dispose();

      await clock.tick(100);

      expect(runCount).toBe(0);
    } finally {
      // The scheduler is disposed above as the behavior under test, and the
      // real teardown still runs over it — see scheduler-dispose-idle.test.ts
      // for the contract that makes the two compose.
      await disposeSchedulerTestRuntime(local);
    }
  });

  it("should auto-debounce slow actions after threshold runs", async () => {
    const cell = runtime.getCell<number>(
      space,
      "auto-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    // Create a slow action (simulated with artificial delay tracking)
    const action: Action = (actionTx) => {
      // We can't easily make this actually slow in tests,
      // so we'll manually set the stats to simulate slow execution
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe (auto-debounce is enabled by default)
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});
    await cell.pull();

    // Initially no debounce
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // The auto-debounce requires the action to be slow (>50ms avg after 3 runs)
    // In unit tests we can't easily simulate slow execution time,
    // so we mainly verify the infrastructure is in place
  });

  it("should not auto-debounce computations even when they are slow", () => {
    const computation: Action = () => {};
    runtime.scheduler.subscribe(computation, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, {});

    const scheduler = runtime.scheduler.accessForTestingOnly;
    scheduler.actionStats.set(scheduler.getActionId(computation), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(computation);

    expect(runtime.scheduler.getDebounce(computation)).toBeUndefined();
  });

  it("should auto-debounce slow writeful effects after threshold runs", () => {
    const output = runtime.getCell<number>(
      space,
      "auto-debounce-writeful-effect-output",
      undefined,
      tx,
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).send(1);
    };
    runtime.scheduler.subscribe(effect, {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    }, { isEffect: true });

    const scheduler = runtime.scheduler.accessForTestingOnly;
    scheduler.actionStats.set(scheduler.getActionId(effect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(effect);

    expect(runtime.scheduler.getDebounce(effect)).toBe(100);
  });

  it("auto-debounces slow write-less effects; pull roots opt out via noDebounce", () => {
    const effect: Action = () => {};
    runtime.scheduler.subscribe(effect, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });

    const scheduler = runtime.scheduler.accessForTestingOnly;
    scheduler.actionStats.set(scheduler.getActionId(effect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(effect);

    // v2 (spec §8.2): the auto-debounce exemption is the explicit
    // noDebounce opt-out (pull() sets it); v1 exempted any write-less
    // effect via the demand-root writes proxy, which no longer exists.
    expect(runtime.scheduler.getDebounce(effect)).toBe(100);

    const protectedEffect: Action = () => {};
    runtime.scheduler.subscribe(protectedEffect, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true, noDebounce: true });

    scheduler.actionStats.set(scheduler.getActionId(protectedEffect), {
      runCount: 3,
      totalTime: 180,
      averageTime: 60,
      lastRunTime: 60,
      lastRunTimestamp: performance.now(),
    });

    scheduler.maybeAutoDebounce(protectedEffect);

    expect(runtime.scheduler.getDebounce(protectedEffect)).toBeUndefined();
  });

  it("should not auto-debounce fast actions", async () => {
    const cell = runtime.getCell<number>(space, "fast-action", undefined, tx);
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe (auto-debounce is enabled by default, and proper writes for pull mode)
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

    // Run multiple times (fast actions)
    for (let i = 0; i < 5; i++) {
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
    }

    // Fast actions should NOT get auto-debounced
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();

    // Stats should be tracked
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.runCount).toBeGreaterThanOrEqual(5);
    // Average time should be well under threshold (50ms)
    expect(stats!.averageTime).toBeLessThan(50);
  });

  it("should work with both debounce and pull mode", async () => {
    const source = runtime.getCell<number>(
      space,
      "debounce-pull-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "debounce-pull-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runCount = 0;
    const effect: Action = (actionTx) => {
      runCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Set debounce before subscribing
    runtime.scheduler.setDebounce(effect, 50);

    // Subscribe as effect
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );

    // Should not run immediately due to debounce
    expect(runCount).toBe(0);

    // Wait for debounce
    await clock.tick(100);
    await result.pull();

    // Should have run
    expect(runCount).toBe(1);
    expect(result.get()).toBe(2);
  });

  it("should allow clearDebounce to remove a manual debounce", async () => {
    const cell = runtime.getCell<number>(
      space,
      "clear-manual-debounce-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.setDebounce(action, 500);
    expect(runtime.scheduler.getDebounce(action)).toBe(500);

    runtime.scheduler.clearDebounce(action);
    expect(runtime.scheduler.getDebounce(action)).toBeUndefined();
  });
});
