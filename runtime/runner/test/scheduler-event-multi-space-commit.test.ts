import { Identity } from "@commonfabric/identity";
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
} from "./scheduler-test-utils.ts";
import type {
  EventHandler,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

const otherSigner = await Identity.fromPassphrase(
  "scheduler event multi-space commit other space",
);
const otherSpace = otherSigner.did();

type TransactMessage = { requestId: string };
type TestMemoryServer = {
  transact(
    message: TransactMessage,
    publishVerdict?: (response: unknown) => void,
  ): Promise<unknown>;
};

/**
 * Holds the emulated server's next transact until `release()` is called, and
 * lets every later one through. `started` resolves once the held transact has
 * reached the server.
 */
function holdNextServerTransact(storageManager: SchedulerTestStorageManager) {
  const server = (storageManager as unknown as { server(): TestMemoryServer })
    .server();
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let held = false;
  server.transact = async (message, publishVerdict) => {
    if (!held) {
      held = true;
      started.resolve();
      await released.promise;
    }
    return await original(message, publishVerdict);
  };
  return {
    started: started.promise,
    release: () => released.resolve(),
    restore: () => {
      released.resolve();
      server.transact = original;
    },
  };
}

describe("an event after a multi-space commit", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      // A runtime that runs its own events, rather than echoing a server's.
      { experimental: { serverExecution: false } },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  /**
   * Sets up a click handler, sends it two clicks back to back with the
   * server's answer to the first commit held until the scheduler has done
   * all it can, and returns what each run read of `pending`, how many runs
   * the scheduler had made while the answer was held, and the count the
   * click made. A run that reads `pending` false sets it and counts one,
   * in the commit `write` sets up; one that reads it true does nothing.
   */
  async function clickTwice(
    label: string,
    write: (
      handlerTx: IExtendedStorageTransaction,
      count: () => void,
      setPending: () => void,
    ) => void,
    countSpace: typeof space,
  ): Promise<{ seen: boolean[]; runsWhileHeld: number; made: number }> {
    const stream = runtime.getCell<unknown>(
      space,
      `${label} stream`,
      { asCell: ["stream"] },
      tx,
    );
    const pending = runtime.getCell<boolean>(
      space,
      `${label} pending`,
      undefined,
      tx,
    );
    const made = runtime.getCell<number>(
      countSpace,
      `${label} made`,
      undefined,
      tx,
    );
    pending.set(false);
    await tx.commit().settled;
    tx = runtime.edit();
    // A commit writes one space, so the count is set up apart.
    made.withTx(tx).set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const seen: boolean[] = [];
    const handler: EventHandler = (handlerTx) => {
      const wasPending = pending.withTx(handlerTx).get();
      seen.push(wasPending);
      if (wasPending) return;
      write(
        handlerTx,
        () => made.withTx(handlerTx).set(made.withTx(handlerTx).get() + 1),
        () => pending.withTx(handlerTx).set(true),
      );
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    const hold = holdNextServerTransact(storageManager);
    let runsWhileHeld: number;
    try {
      runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), 1);
      runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), 2);
      await hold.started;
      await clock.settle();
      runsWhileHeld = seen.length;
      hold.release();
      await runtime.idle();
      await storageManager.synced();
      await runtime.idle();
    } finally {
      hold.restore();
    }
    return { seen, runsWhileHeld, made: made.get() };
  }

  it("runs against every space the earlier commit wrote", async () => {
    // The first click's commit closes the other space first, as an
    // `.inSpace()` create does, and hands its write of `pending` to this
    // space's replica only once the server has answered for the other one.
    const result = await clickTwice(
      "multi-space",
      (handlerTx, count, setPending) => {
        handlerTx.enableMultiSpaceWrites?.([otherSpace, space]);
        count();
        setPending();
      },
      otherSpace,
    );

    expect(result.runsWhileHeld).toBe(1);
    expect(result.seen).toEqual([false, true]);
    expect(result.made).toBe(1);
  });

  it("does not wait for the server after a commit to one space", async () => {
    // A one-space commit's writes are in the replica as it is issued, so the
    // second click runs, and reads them, while the server's answer is held.
    const result = await clickTwice(
      "one-space",
      (_handlerTx, count, setPending) => {
        count();
        setPending();
      },
      space,
    );

    expect(result.runsWhileHeld).toBe(2);
    expect(result.seen).toEqual([false, true]);
    expect(result.made).toBe(1);
  });
});
