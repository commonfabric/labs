// Scheduler throttle and bounded-freshness tests.

import { getLogger } from "@commonfabric/utils/logger";
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

describe("throttle - bounded freshness", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    // Each case starts at logical time zero, whichever of the others ran.
    clock.reset();
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("should set and get throttle for an action", () => {
    const action: Action = () => {};

    // Initially no throttle
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();

    // Set throttle
    runtime.scheduler.setThrottle(action, 200);
    expect(runtime.scheduler.getThrottle(action)).toBe(200);

    // Clear throttle
    runtime.scheduler.clearThrottle(action);
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();
  });

  it("should set throttle to 0 clears it", () => {
    const action: Action = () => {};

    runtime.scheduler.setThrottle(action, 200);
    expect(runtime.scheduler.getThrottle(action)).toBe(200);

    runtime.scheduler.setThrottle(action, 0);
    expect(runtime.scheduler.getThrottle(action)).toBeUndefined();
  });

  it("should run dirty work promptly when throttle is cleared", async () => {
    const source = runtime.getCell<number>(
      space,
      "throttle-clear-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let observed = 0;
    const effect: Action = (actionTx) => {
      observed = source.withTx(actionTx).get();
    };
    runtime.scheduler.subscribe(effect, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.scheduler.idle();
    expect(observed).toBe(1);

    runtime.scheduler.setThrottle(effect, 30_000);
    source.withTx(tx).send(2);
    // Drain the commit round trip with the clock held: awaiting it under
    // auto-advance would fire the armed throttle wake early. The drain lets
    // the scheduler tick observe the dirty gated node and arm the shared
    // wake before the clear, without the throttle window elapsing.
    const throttledCommit = tx.commit();
    tx = runtime.edit();
    await clock.settle();
    await throttledCommit;
    expect(observed).toBe(1);

    runtime.scheduler.clearThrottle(effect);
    await runtime.scheduler.idle();
    expect(observed).toBe(2);
  });

  it("should apply throttle from subscribe options", () => {
    const action: Action = () => {};

    // Subscribe with throttle option
    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { throttle: 200 },
    );

    // Verify throttle was set
    expect(runtime.scheduler.getThrottle(action)).toBe(200);
  });

  it("should skip throttled action if ran recently", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-skip-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First run (no throttle yet to establish lastRunTimestamp)
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
    expect(runCount).toBe(1);

    // Now set throttle
    runtime.scheduler.setThrottle(action, 500);

    // Try to run again immediately
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

    // Should be skipped due to throttle
    expect(runCount).toBe(1);
  });

  it("should run throttled action after throttle period expires", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-expire-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // First run with short throttle
    runtime.scheduler.setThrottle(action, 50);
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
    expect(runCount).toBe(1);

    // Try immediately - should be throttled
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
    expect(runCount).toBe(1);

    // Wait for throttle to expire
    await clock.tick(100);

    // Now should run
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
    expect(runCount).toBe(2);
  });

  it("should keep action dirty when throttled in pull mode", async () => {
    const source = runtime.getCell<number>(
      space,
      "throttle-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "throttle-dirty-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computeCount = 0;
    const computation: Action = (actionTx) => {
      computeCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Run computation once to establish timestamp
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
    expect(computeCount).toBe(1);

    // Set throttle
    runtime.scheduler.setThrottle(computation, 500);

    // Change source to mark computation dirty
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();

    // Wait for propagation
    await result.pull();

    // Computation should be marked dirty but not run (throttled)
    expect(runtime.scheduler.isDirty(computation)).toBe(true);
    expect(computeCount).toBe(1);
  });

  it("should run throttled effect after throttle expires", async () => {
    const source = runtime.getCell<number>(
      space,
      "throttle-pull-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "throttle-pull-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectCount = 0;
    const effect: Action = (actionTx) => {
      effectCount++;
      const val = source.withTx(actionTx).get();
      result.withTx(actionTx).send(val * 2);
    };

    // Subscribe as effect with throttle
    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { throttle: 500, isEffect: true },
    );
    await result.pull();
    expect(effectCount).toBe(1);
    expect(result.get()).toBe(2);

    // Change source - effect is scheduled but throttled. Drain the commit
    // round trip with the clock held so the throttle window cannot elapse
    // under auto-advance before the intermediate assertion.
    source.withTx(tx).send(5);
    const throttledCommit = tx.commit();
    tx = runtime.edit();
    await clock.settle();
    await throttledCommit;
    await clock.tick(80);
    expect(effectCount).toBe(1);
    expect(result.get()).toBe(2);

    // Wait for throttle to expire
    await clock.tick(700);
    await clock.settle();
    expect(effectCount).toBe(2);
    expect(result.get()).toBe(10);

    // Trigger again - now throttle has expired, should run
    source.withTx(tx).send(10);
    await tx.commit();
    tx = runtime.edit();
    await clock.tick(500);

    // Now effect should run again
    expect(effectCount).toBe(3);
    expect(result.get()).toBe(20);
  });

  it("should park throttled dirty effects instead of immediately requeueing", async () => {
    const source = runtime.getCell<number>(
      space,
      "throttle-effect-park-source",
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      "throttle-effect-park-result",
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectCount = 0;
    const effect: Action = (actionTx) => {
      effectCount++;
      result.withTx(actionTx).send(
        (source.withTx(actionTx).get() ?? 0) * 2,
      );
    };

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      { throttle: 500, isEffect: true },
    );
    await result.pull();
    expect(effectCount).toBe(1);
    expect(result.get()).toBe(2);

    // Drain the commit round trip with the clock held so the throttle window
    // cannot elapse under auto-advance before the parked-state assertion.
    runtime.scheduler.resetFilterStats();
    source.withTx(tx).send(5);
    const throttledCommit = tx.commit();
    tx = runtime.edit();
    await clock.settle();
    await throttledCommit;

    await clock.tick(80);
    expect(effectCount).toBe(1);
    expect(runtime.scheduler.getFilterStats().filtered).toBeLessThan(5);

    await clock.tick(700);
    await clock.settle();

    expect(effectCount).toBe(2);
    expect(result.get()).toBe(10);
  });

  it("should record lastRunTimestamp in action stats", async () => {
    const action: Action = () => {};

    // No stats initially
    expect(runtime.scheduler.getActionStats(action)).toBeUndefined();

    // Run action
    runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    // Stats should now include lastRunTimestamp
    const stats = runtime.scheduler.getActionStats(action);
    expect(stats).toBeDefined();
    expect(stats!.lastRunTimestamp).toBeDefined();
    expect(stats!.lastRunTimestamp).toBeGreaterThan(0);
  });

  it("should allow first run even with throttle set (no previous timestamp)", async () => {
    const cell = runtime.getCell<number>(
      space,
      "throttle-first-run",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Set throttle BEFORE first run
    runtime.scheduler.setThrottle(action, 1000);

    // First run should still execute (no previous timestamp to throttle against)
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cell.getAsNormalizedFullLink())],
      },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(1);
  });

  it("emits lazy scheduling diagnostics for registration and execution", async () => {
    const logger = getLogger("scheduler");
    const previousLevel = logger.level;
    const previousDisabled = logger.disabled;
    const originalDebug = console.debug;
    const debugCalls: unknown[][] = [];
    logger.level = "debug";
    logger.disabled = false;
    console.debug = (...args: unknown[]) => debugCalls.push(args);

    const source = runtime.getCell<number>(
      space,
      "throttle-debug-diagnostics",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let observed = 0;
    const effect: Action = (actionTx) => {
      observed = source.withTx(actionTx).get();
    };
    const log = {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    };

    try {
      runtime.scheduler.subscribe(effect, log, { isEffect: true });
      await runtime.scheduler.idle();
      expect(observed).toBe(1);
      runtime.scheduler.subscribe(
        () => {},
        { reads: [], shallowReads: [], writes: [] },
      );

      const keys = debugCalls.flatMap((call) => call).filter((value) =>
        typeof value === "string"
      );
      expect(keys).toContain("schedule");
      expect(keys).toContain("schedule-resubscribe");
      expect(keys).toContain("schedule-execute-pull");
      expect(keys).toContain("schedule-execute");
    } finally {
      logger.level = previousLevel;
      logger.disabled = previousDisabled;
      console.debug = originalDebug;
      await runtime.scheduler.idle();
    }
  });
});
