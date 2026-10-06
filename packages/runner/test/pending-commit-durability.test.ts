/**
 * The storage manager's pending-commit durability barrier and the scheduler's
 * client-facing quiescence built on it.
 *
 * Every write flows through a transaction from `storageManager.edit()`, and
 * `commit()` registers itself with the manager's barrier synchronously at the
 * entry point, so `hasPendingCommits()` is true from the moment a commit is
 * issued until the server confirms (or terminally rejects) it. The scheduler's
 * `idleWithPendingCommits()` — what the client-facing idle awaits — resolves
 * only when reactive quiescence and an empty barrier hold together, so a
 * client that treats "idle" as a safe point to navigate or reload cannot lose
 * an in-flight write. Plain `idle()` (internal reactive quiescence) ignores
 * the barrier by design.
 *
 * These tests drive REAL commits against the emulated server and gate its
 * responses, so they fail if the barrier ever stops observing the actual
 * commit pipeline (e.g. registration decoupled from the real commit promise)
 * and if the joint fixpoint ever stops re-checking after a commit settles.
 */

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

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string; precondition?: string };
};
type PublishTransactVerdict = (response: TransactResponse) => void;
type TestMemoryServer = {
  transact(
    message: TransactMessage,
    publishVerdict?: PublishTransactVerdict,
  ): Promise<TransactResponse>;
};

function emulatedServer(
  storageManager: SchedulerTestStorageManager,
): TestMemoryServer {
  return (storageManager as unknown as { server(): TestMemoryServer }).server();
}

/**
 * Gates every server commit response until released: the commit reaches the
 * server but its confirmation is withheld, so the client-side commit promise
 * stays pending. `releaseAll()` releases the currently held responses;
 * responses arriving afterwards are held again until the next release.
 */
function holdServerTransacts(
  storageManager: SchedulerTestStorageManager,
): { held: () => number; releaseAll: () => void; restore: () => void } {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let held = 0;
  const gates: (() => void)[] = [];
  server.transact = async (message, publishVerdict) => {
    held++;
    await new Promise<void>((resolve) => gates.push(resolve));
    return original(message, publishVerdict);
  };
  return {
    held: () => held,
    releaseAll: () => {
      for (const gate of gates.splice(0)) gate();
    },
    restore: () => {
      server.transact = original;
    },
  };
}

/**
 * Rejects server commits with `error` for the first `count` commits, then
 * passes through. Mirrors the backpressure tests' injector.
 */
function rejectServerTransacts(
  storageManager: SchedulerTestStorageManager,
  count: number,
  error: { name: string; message: string; precondition?: string },
): { rejected: () => number; restore: () => void } {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let rejected = 0;
  server.transact = (message, publishVerdict) => {
    if (rejected < count) {
      rejected++;
      const response: TransactResponse = {
        type: "response",
        requestId: message.requestId,
        error,
      };
      publishVerdict?.(response);
      return Promise.resolve(response);
    }
    return original(message, publishVerdict);
  };
  return {
    rejected: () => rejected,
    restore: () => {
      server.transact = original;
    },
  };
}

const tick = (_ms = 0) => clock.settle();

describe("pending-commit durability barrier", () => {
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

  it("plain idle() returns while an event commit is unconfirmed; idleWithPendingCommits waits for it", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "durability-event-in",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "durability-event-out",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const handler: EventHandler = (handlerTx, event) => {
      resultCell.withTx(handlerTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    const hold = holdServerTransacts(storageManager);
    try {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 5);

      // Reactive quiescence only: the handler has run and its commit has been
      // issued, but the server has not confirmed it. Plain idle() returns.
      await runtime.idle();
      expect(storageManager.hasPendingCommits()).toBe(true);

      // The client-facing wait stays open until the commit confirms.
      let settled = false;
      const idleP = runtime.scheduler.idleWithPendingCommits().then(() => {
        settled = true;
      });
      await tick();
      expect(settled).toBe(false);

      hold.releaseAll();
      await idleP;
      expect(settled).toBe(true);
      expect(storageManager.hasPendingCommits()).toBe(false);
    } finally {
      hold.releaseAll();
      hold.restore();
    }
  });

  it("covers direct cell writes that never pass through the scheduler", async () => {
    const cell = runtime.getCell<number>(
      space,
      "durability-direct-write",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const hold = holdServerTransacts(storageManager);
    try {
      // The same shape as a client cell-IPC write (applyCellWrite): an edit,
      // a set, and a fire-and-forget commit — no scheduler event involved.
      const writeTx = runtime.edit();
      cell.withTx(writeTx).set(7);
      runtime.prepareTxForCommit(writeTx);
      const commitP = writeTx.commit().settled;
      // Registration is synchronous with commit(): the barrier reports the
      // pending commit in the same turn, so a quiescence check started now
      // cannot miss it.
      expect(storageManager.hasPendingCommits()).toBe(true);

      let settled = false;
      const idleP = runtime.scheduler.idleWithPendingCommits().then(() => {
        settled = true;
      });
      await tick();
      expect(settled).toBe(false);

      hold.releaseAll();
      await commitP;
      await idleP;
      expect(settled).toBe(true);
      expect(storageManager.hasPendingCommits()).toBe(false);
    } finally {
      hold.releaseAll();
      hold.restore();
    }
  });

  it("waits across a follow-on commit issued from a confirmed commit's continuation", async () => {
    const cellA = runtime.getCell<number>(
      space,
      "durability-cascade-a",
      undefined,
      tx,
    );
    cellA.set(0);
    const cellB = runtime.getCell<number>(
      space,
      "durability-cascade-b",
      undefined,
      tx,
    );
    cellB.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const hold = holdServerTransacts(storageManager);
    try {
      // First commit; when it CONFIRMS, its continuation issues a second
      // commit — the shape of confirmation-triggered reactive work.
      const txA = runtime.edit();
      cellA.withTx(txA).set(1);
      runtime.prepareTxForCommit(txA);
      const commitA = txA.commit().settled.then(() => {
        const txB = runtime.edit();
        cellB.withTx(txB).set(2);
        runtime.prepareTxForCommit(txB);
        return txB.commit().settled;
      });

      let settled = false;
      const idleP = runtime.scheduler.idleWithPendingCommits().then(() => {
        settled = true;
      });
      await tick();
      expect(settled).toBe(false);

      // Confirm commit A. Its continuation immediately issues commit B, which
      // the gate holds again — the barrier must re-check and stay open rather
      // than resolving because the commits it first saw have settled.
      hold.releaseAll();
      await tick();
      expect(settled).toBe(false);
      expect(storageManager.hasPendingCommits()).toBe(true);

      hold.releaseAll();
      await commitA;
      await idleP;
      expect(settled).toBe(true);
    } finally {
      hold.releaseAll();
      hold.restore();
    }
  });

  it("a terminally rejected commit settles the barrier instead of wedging it", async () => {
    const cell = runtime.getCell<number>(
      space,
      "durability-rejected",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    // Reject every commit: a direct transaction does not retry, so the commit
    // resolves with an error and the barrier must drain.
    const injector = rejectServerTransacts(storageManager, Infinity, {
      name: "ConflictError",
      message: "forced rejection",
    });
    try {
      const writeTx = runtime.edit();
      cell.withTx(writeTx).set(9);
      runtime.prepareTxForCommit(writeTx);
      const result = await writeTx.commit().settled;
      expect(result.error).toBeDefined();

      await runtime.scheduler.idleWithPendingCommits();
      expect(storageManager.hasPendingCommits()).toBe(false);
    } finally {
      injector.restore();
    }
  });

  it("stays open across an event commit's conflict-backoff retries until the write lands", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "durability-conflict-in",
      undefined,
      tx,
    );
    eventCell.set(0);
    const resultCell = runtime.getCell<number>(
      space,
      "durability-conflict-out",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const handler: EventHandler = (handlerTx, event) => {
      resultCell.withTx(handlerTx).send(event);
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );

    // Two transient conflicts, then pass through: the event backs off and
    // retries (parking the queue behind a wake timer — the parked-waiter
    // branch of the quiescence check), and the wait must span the whole
    // conflict window, resolving only once the retry lands durably.
    const injector = rejectServerTransacts(storageManager, 2, {
      name: "ConflictError",
      message: "forced transient conflict",
    });
    try {
      runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 4);
      await runtime.scheduler.idleWithPendingCommits();

      expect(injector.rejected()).toBe(2);
      expect(resultCell.get()).toBe(4);
      expect(storageManager.hasPendingCommits()).toBe(false);
    } finally {
      injector.restore();
    }
  });

  it("notifies pending-commit transitions once per drain, not per commit", async () => {
    const cellOne = runtime.getCell<number>(
      space,
      "durability-notify-one",
      undefined,
      tx,
    );
    cellOne.set(0);
    const cellTwo = runtime.getCell<number>(
      space,
      "durability-notify-two",
      undefined,
      tx,
    );
    cellTwo.set(0);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const transitions: boolean[] = [];
    const unsubscribe = storageManager.subscribePendingCommits((pending) =>
      transitions.push(pending)
    );
    const hold = holdServerTransacts(storageManager);
    try {
      // Two overlapping held commits: one rising edge, one falling edge.
      const tx1 = runtime.edit();
      cellOne.withTx(tx1).set(1);
      runtime.prepareTxForCommit(tx1);
      const commit1 = tx1.commit().settled;
      const tx2 = runtime.edit();
      cellTwo.withTx(tx2).set(2);
      runtime.prepareTxForCommit(tx2);
      const commit2 = tx2.commit().settled;

      expect(transitions).toEqual([true]);

      // The emulated session serializes requests: the second commit's transact
      // only reaches the server once the first's response is released, so keep
      // releasing until both commits settle.
      let bothSettled = false;
      const settledP = Promise.allSettled([commit1, commit2]).then(() => {
        bothSettled = true;
      });
      while (!bothSettled) {
        hold.releaseAll();
        await tick(1);
      }
      await settledP;
      await runtime.scheduler.idleWithPendingCommits();
      expect(transitions[0]).toBe(true);
      expect(transitions[transitions.length - 1]).toBe(false);
    } finally {
      hold.releaseAll();
      hold.restore();
      unsubscribe();
    }
  });

  it("a throwing subscriber does not stop the others from being notified", async () => {
    // The notifier isolates subscribers: a callback that throws is caught and
    // logged, and later subscribers still receive the transition.
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const calls: string[] = [];
    const unsubThrowing = storageManager.subscribePendingCommits(() => {
      calls.push("throwing");
      throw new Error("subscriber boom");
    });
    const unsubHealthy = storageManager.subscribePendingCommits(() => {
      calls.push("healthy");
    });
    try {
      const { promise, resolve } = Promise.withResolvers<void>();
      // Rising edge (empty -> non-empty) notifies synchronously.
      storageManager.trackPendingCommit(promise);
      expect(calls).toEqual(["throwing", "healthy"]);
      // Falling edge (non-empty -> empty) notifies after the promise settles.
      resolve();
      await promise;
      await tick();
      expect(calls).toEqual(["throwing", "healthy", "throwing", "healthy"]);
      // Both throws were caught and logged, never propagated.
      expect(errors.length).toBe(2);
      expect(storageManager.hasPendingCommits()).toBe(false);
    } finally {
      console.error = originalError;
      unsubThrowing();
      unsubHealthy();
    }
  });
});
