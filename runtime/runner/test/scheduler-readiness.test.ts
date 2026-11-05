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
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { RetryWhenReady } from "../src/scheduler/retry-when-ready.ts";

type TestTransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
};

type TestMemoryServer = {
  transact(
    message: { requestId: string },
    publishVerdict?: (response: TestTransactResponse) => void,
  ): Promise<TestTransactResponse>;
};

function delayNextServerTransact(
  storageManager: SchedulerTestStorageManager,
) {
  const server = (storageManager as unknown as { server(): TestMemoryServer })
    .server();
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"confirm" | "fail">();
  let shouldDelay = true;
  server.transact = async (message, publishVerdict) => {
    if (!shouldDelay) return await original(message, publishVerdict);
    shouldDelay = false;
    started.resolve();
    if (await release.promise === "fail") {
      const response: TestTransactResponse = {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced readiness-lineage conflict",
        },
      };
      publishVerdict?.(response);
      return response;
    }
    return await original(message, publishVerdict);
  };
  return {
    started: started.promise,
    fail: () => release.resolve("fail"),
    restore: () => server.transact = original,
  };
}

describe("scheduler RetryWhenReady", () => {
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

  it("aborts reactive writes, keeps subscriptions, and coalesces stale readiness attempts", async () => {
    const source = runtime.getCell<number>(
      space,
      "readiness-action-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "readiness-action-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const firstAttempt = Promise.withResolvers<void>();
    const secondAttempt = Promise.withResolvers<void>();
    let ready = false;
    let runs = 0;
    const action: Action = (actionTx) => {
      const value = source.withTx(actionTx).get();
      runs++;
      if (!ready) {
        output.withTx(actionTx).send(1_000 + runs);
        if (runs === 1) firstAttempt.resolve();
        if (runs === 2) secondAttempt.resolve();
        throw new RetryWhenReady(readiness.promise);
      }
      output.withTx(actionTx).send(value);
    };

    const cancel = runtime.scheduler.subscribe(action, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    }, { isEffect: true });

    await firstAttempt.promise;
    await runtime.idle();
    expect(output.get()).toBe(0);

    let unrelatedRuns = 0;
    await runtime.scheduler.run(() => {
      unrelatedRuns++;
    });
    expect(unrelatedRuns).toBe(1);

    source.withTx(tx).send(2);
    await tx.commit().settled;
    tx = runtime.edit();
    await secondAttempt.promise;
    await runtime.idle();
    expect(runs).toBe(2);
    expect(output.get()).toBe(0);

    ready = true;
    readiness.resolve();
    await Promise.resolve();
    await runtime.idle();

    expect(runs).toBe(3);
    expect(output.get()).toBe(2);
    cancel();
  });

  it("can coalesce dependency changes until readiness rereads current state", async () => {
    const source = runtime.getCell<number>(
      space,
      "coalesced-readiness-action-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "coalesced-readiness-action-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    let ready = false;
    let runs = 0;
    const action: Action = (actionTx) => {
      const value = source.withTx(actionTx).get();
      runs++;
      if (!ready) {
        parked.resolve();
        throw new RetryWhenReady(
          readiness.promise,
          "coalesce until durable state is ready",
          { keepDependenciesWhileWaiting: false },
        );
      }
      output.withTx(actionTx).send(value);
    };
    const cancel = runtime.scheduler.subscribe(action, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
    }, { isEffect: true });

    await parked.promise;
    await runtime.idle();
    for (const value of [2, 3, 4]) {
      source.withTx(tx).send(value);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();
    }
    expect(runs).toBe(1);

    ready = true;
    readiness.resolve();
    await Promise.resolve();
    await runtime.idle();
    expect(runs).toBe(2);
    expect(output.get()).toBe(4);
    cancel();
  });

  it("fences a reactive readiness continuation after cancellation", async () => {
    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    let runs = 0;
    const action: Action = () => {
      runs++;
      parked.resolve();
      throw new RetryWhenReady(readiness.promise);
    };
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    await parked.promise;
    await runtime.idle();
    cancel();
    readiness.resolve();
    await Promise.resolve();
    await runtime.idle();

    expect(runs).toBe(1);
  });

  it("reports rejected reactive readiness without rerunning", async () => {
    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    const errors: ErrorWithContext[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    let runs = 0;
    const action: Action = () => {
      runs++;
      parked.resolve();
      throw new RetryWhenReady(readiness.promise);
    };
    const cancel = runtime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    await parked.promise;
    await runtime.idle();
    readiness.reject(new Error("factory load rejected"));
    await Promise.resolve();
    await Promise.resolve();
    await runtime.idle();

    expect(runs).toBe(1);
    expect(errors.map((error) => error.message)).toContain(
      "factory load rejected",
    );
    cancel();
  });

  it("requeues the same event intent after readiness without blocking another event", async () => {
    const stream = runtime.getCell<number>(
      space,
      "readiness-event-stream",
      undefined,
      tx,
    );
    const otherStream = runtime.getCell<number>(
      space,
      "readiness-event-other-stream",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "readiness-event-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    let ready = false;
    const eventIds: (string | undefined)[] = [];
    let handlerRuns = 0;
    const handler: EventHandler = (eventTx, event: number) => {
      handlerRuns++;
      eventIds.push(eventTx.dispatchedEventId);
      if (!ready) {
        output.withTx(eventTx).send(1_000);
        parked.resolve();
        throw new RetryWhenReady(readiness.promise);
      }
      output.withTx(eventTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    let otherRuns = 0;
    runtime.scheduler.addEventHandler(
      () => {
        otherRuns++;
      },
      otherStream.getAsNormalizedFullLink(),
    );

    let commitCalls = 0;
    let commitStatus: string | undefined;
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      7,
      false,
      (eventTx) => {
        commitCalls++;
        commitStatus = eventTx.status().status;
      },
      false,
      { eventId: "readiness-event-id" },
    );
    runtime.scheduler.queueEvent(
      otherStream.getAsNormalizedFullLink(),
      1,
    );

    await parked.promise;
    await runtime.idle();
    expect(output.get()).toBe(0);
    expect(otherRuns).toBe(1);
    expect(commitCalls).toBe(0);

    let durableIdleSettled = false;
    const durableIdle = runtime.scheduler.idleWithPendingCommits().then(() => {
      durableIdleSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(durableIdleSettled).toBe(false);

    ready = true;
    readiness.resolve();
    await Promise.resolve();
    await runtime.idle();
    // Event commit callbacks observe storage completion, which idle()
    // intentionally does not await.
    await runtime.settled();

    expect(handlerRuns).toBe(2);
    expect(eventIds).toEqual(["readiness-event-id", "readiness-event-id"]);
    expect(output.get()).toBe(7);
    expect(commitCalls).toBe(1);
    expect(commitStatus).toBe("done");
    await durableIdle;
  });

  it("preserves FIFO order when same-stream events share cold readiness", async () => {
    const stream = runtime.getCell<number>(
      space,
      "readiness-event-fifo-stream",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const bothParked = Promise.withResolvers<void>();
    let ready = false;
    let parkedCount = 0;
    const processed: string[] = [];
    runtime.scheduler.addEventHandler(
      (_eventTx, event: string) => {
        if (!ready) {
          parkedCount++;
          if (parkedCount === 2) bothParked.resolve();
          throw new RetryWhenReady(readiness.promise);
        }
        processed.push(event);
      },
      stream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      "A",
      false,
    );
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      "B",
      false,
    );

    await bothParked.promise;
    await runtime.idle();
    ready = true;
    readiness.resolve();
    await Promise.resolve();
    await runtime.settled();

    expect(processed).toEqual(["A", "B"]);
  });

  it("fences a parked event after handler cancellation and settles its callback", async () => {
    const stream = runtime.getCell<number>(
      space,
      "readiness-event-cancel-stream",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    let runs = 0;
    const handler: EventHandler = () => {
      runs++;
      parked.resolve();
      throw new RetryWhenReady(readiness.promise);
    };
    const cancel = runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    let commitCalls = 0;
    let commitStatus: string | undefined;
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      true,
      (eventTx) => {
        commitCalls++;
        commitStatus = eventTx.status().status;
      },
    );

    await parked.promise;
    await runtime.idle();
    cancel();

    // Cancellation is itself a final outcome. It must settle the durable
    // intent even when the readiness promise never does.
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(commitCalls).toBe(1);
    expect(commitStatus).toBe("error");

    // A late load completion remains fenced and cannot settle twice.
    readiness.resolve();
    await Promise.resolve();
    await runtime.idle();

    expect(runs).toBe(1);
    expect(commitCalls).toBe(1);
    expect(commitStatus).toBe("error");
  });

  it("reports rejected event readiness without requeueing or consuming authored retry policy", async () => {
    const stream = runtime.getCell<number>(
      space,
      "readiness-event-rejection-stream",
      undefined,
      tx,
    );
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    const errors: ErrorWithContext[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    let runs = 0;
    runtime.scheduler.addEventHandler(
      () => {
        runs++;
        parked.resolve();
        throw new RetryWhenReady(readiness.promise);
      },
      stream.getAsNormalizedFullLink(),
    );
    let commitCalls = 0;
    let commitStatus: string | undefined;
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      false,
      (eventTx) => {
        commitCalls++;
        commitStatus = eventTx.status().status;
      },
    );

    await parked.promise;
    await runtime.idle();
    readiness.reject(new Error("event factory load rejected"));
    await Promise.resolve();
    await Promise.resolve();
    await runtime.idle();

    expect(runs).toBe(1);
    expect(errors.map((error) => error.message)).toContain(
      "event factory load rejected",
    );
    expect(commitCalls).toBe(1);
    expect(commitStatus).toBe("error");
  });

  it("settles parked readiness when its speculative origin fails", async () => {
    const originStream = runtime.getCell<number>(
      space,
      "readiness-lineage-origin-stream",
      undefined,
      tx,
    );
    const childStream = runtime.getCell<number>(
      space,
      "readiness-lineage-child-stream",
      undefined,
      tx,
    );
    const originWrite = runtime.getCell<number>(
      space,
      "readiness-lineage-origin-write",
      undefined,
      tx,
    );
    originWrite.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const readiness = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    let childRuns = 0;
    runtime.scheduler.addEventHandler(
      () => {
        childRuns++;
        parked.resolve();
        throw new RetryWhenReady(readiness.promise);
      },
      childStream.getAsNormalizedFullLink(),
    );

    const finalCallback = Promise.withResolvers<string>();
    let finalCalls = 0;
    runtime.scheduler.addEventHandler(
      (originTx) => {
        originWrite.withTx(originTx).set(1);
        runtime.scheduler.queueEvent(
          childStream.getAsNormalizedFullLink(),
          1,
          false,
          (childTx) => {
            finalCalls++;
            finalCallback.resolve(childTx.status().status);
          },
          false,
          { originTx },
        );
      },
      originStream.getAsNormalizedFullLink(),
    );

    const gate = delayNextServerTransact(storageManager);
    try {
      runtime.scheduler.queueEvent(
        originStream.getAsNormalizedFullLink(),
        1,
        false,
      );
      await gate.started;
      await parked.promise;
      expect(childRuns).toBe(1);
      expect(finalCalls).toBe(0);

      gate.fail();
      expect(await finalCallback.promise).toBe("error");
      expect(finalCalls).toBe(1);

      readiness.resolve();
      await Promise.resolve();
      await runtime.idle();
      expect(childRuns).toBe(1);
      expect(finalCalls).toBe(1);
    } finally {
      gate.restore();
    }
  });
});
