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
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { watchReactiveActionCommit } from "../src/scheduler/run.ts";

describe("scheduler generation fencing", () => {
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

  it("does not invoke an action canceled while it waits for another run", async () => {
    const blockerStarted = Promise.withResolvers<void>();
    const releaseBlocker = Promise.withResolvers<void>();
    let victimRuns = 0;

    const blocker: Action = async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    };
    const victim: Action = () => {
      victimRuns++;
    };

    const blockerRun = runtime.scheduler.run(blocker);
    await blockerStarted.promise;
    const victimRun = runtime.scheduler.run(victim);
    runtime.scheduler.unsubscribe(victim);
    releaseBlocker.resolve();

    await Promise.all([blockerRun, victimRun]);
    expect(victimRuns).toBe(0);
  });

  it("aborts a canceled async action before commit or resubscribe", async () => {
    const source = runtime.getCell<number>(
      space,
      "generation-fence-action-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "generation-fence-action-output",
      undefined,
      tx,
    );
    source.set(7);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    const action: Action = async (actionTx) => {
      runs++;
      const value = source.withTx(actionTx).get();
      started.resolve();
      await release.promise;
      output.withTx(actionTx).send(value);
    };

    const cancel = runtime.scheduler.subscribe(action, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    }, { isEffect: true });

    await started.promise;
    cancel();
    release.resolve();
    await runtime.idle();

    expect(output.get()).toBe(0);
    expect(runs).toBe(1);

    source.withTx(tx).send(8);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it("removes retired speculative writes before a replacement runs", async () => {
    const output = runtime.getCell<number>(
      space,
      "generation-fence-speculative-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;
    const action: Action = async (actionTx) => {
      output.withTx(actionTx).send(7);
      if (!hold) return;
      hold = false;
      started.resolve();
      await release.promise;
    };
    const registration = {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    };

    const cancel = runtime.scheduler.subscribe(action, registration, {
      isEffect: true,
    });
    await started.promise;
    cancel();
    runtime.scheduler.subscribe(action, registration, { isEffect: true });
    release.resolve();
    await runtime.idle();

    expect(output.get()).toBe(7);
  });

  it("does not requeue a conflict retry after its generation is canceled", async () => {
    const action: Action = () => {};
    const retryReady = Promise.withResolvers<void>();
    const releaseRetry = Promise.withResolvers<void>();
    let current = true;
    let requeues = 0;
    const commitPromise = Promise.resolve({
      error: {
        name: "ConflictError",
        message: "injected conflict",
        readyToRetry: async () => {
          retryReady.resolve();
          await releaseRetry.promise;
        },
      },
    }) as unknown as ReturnType<
      IExtendedStorageTransaction["commit"]
    >["settled"];

    watchReactiveActionCommit({
      action,
      generation: 1,
      awaitRetryReadiness: (error) =>
        (error as { readyToRetry?: () => Promise<void> }).readyToRetry?.() ??
          Promise.resolve(),
      tx: {} as IExtendedStorageTransaction,
      log: { reads: [], shallowReads: [], writes: [] },
      retries: new WeakMap(),
      offBudgetRetries: new WeakMap(),
      pending: new Set(),
      commitPromise,
      resubscribe: () => {},
      markInvalid: () => {
        requeues++;
      },
      queueExecution: () => {
        requeues++;
      },
      restoreInvalidCauses: () => {},
      isActionGenerationCurrent: () => current,
      getActionId: () => "generation-fenced-action",
    });

    await retryReady.promise;
    current = false;
    releaseRetry.resolve();
    await commitPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(requeues).toBe(0);
  });

  it("drops a handler canceled during input presync", async () => {
    const stream = runtime.getCell<number>(
      space,
      "generation-fence-presync-stream",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    const presyncStarted = Promise.withResolvers<void>();
    const releasePresync = Promise.withResolvers<void>();
    let runs = 0;
    const handler: EventHandler = () => {
      runs++;
    };
    handler.presyncInputs = async () => {
      presyncStarted.resolve();
      await releasePresync.promise;
    };

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), 1);

    await presyncStarted.promise;
    cancel();
    releasePresync.resolve();
    await runtime.idle();

    expect(runs).toBe(0);
  });

  it("aborts a handler canceled while its async body is running", async () => {
    const stream = runtime.getCell<number>(
      space,
      "generation-fence-handler-stream",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "generation-fence-handler-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    const handler: EventHandler = async (handlerTx, event: number) => {
      runs++;
      started.resolve();
      await release.promise;
      output.withTx(handlerTx).send(event);
    };

    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), 9);

    await started.promise;
    cancel();
    release.resolve();
    await runtime.idle();

    expect(runs).toBe(1);
    expect(output.get()).toBe(0);
  });

  it("does not route an already queued event into a replacement handler", async () => {
    const stream = runtime.getCell<number>(
      space,
      "generation-fence-replacement-stream",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    let oldRuns = 0;
    let newRuns = 0;
    let canceledStatus: string | undefined;
    const cancelOld = runtime.scheduler.addEventHandler(
      () => {
        oldRuns++;
      },
      stream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      true,
      (eventTx) => {
        canceledStatus = eventTx.status().status;
      },
    );
    cancelOld();
    runtime.scheduler.addEventHandler(
      () => {
        newRuns++;
      },
      stream.getAsNormalizedFullLink(),
    );

    await runtime.idle();
    expect(oldRuns).toBe(0);
    expect(newRuns).toBe(0);
    expect(canceledStatus).toBe("error");

    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), 2);
    await runtime.idle();
    expect(oldRuns).toBe(0);
    expect(newRuns).toBe(1);
  });

  it("tracks separate registrations when one handler serves two streams", async () => {
    const firstStream = runtime.getCell<number>(
      space,
      "generation-fence-shared-handler-first",
      undefined,
      tx,
    );
    const secondStream = runtime.getCell<number>(
      space,
      "generation-fence-shared-handler-second",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    const seen: number[] = [];
    const sharedHandler: EventHandler = (_eventTx, event: number) => {
      seen.push(event);
    };
    const cancelFirst = runtime.scheduler.addEventHandler(
      sharedHandler,
      firstStream.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      sharedHandler,
      secondStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(firstStream.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(secondStream.getAsNormalizedFullLink(), 2);
    cancelFirst();
    await runtime.idle();

    expect(seen).toEqual([2]);
  });
});
