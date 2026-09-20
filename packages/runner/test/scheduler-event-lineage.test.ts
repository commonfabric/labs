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
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  cancel as cancelCancellable,
  useCancelGroup,
  useDeferredCancelOwnership,
} from "../src/cancel.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";

const secondSigner = await Identity.fromPassphrase(
  "scheduler event lineage second space",
);
const secondSpace = secondSigner.did();

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
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

function rejectNextServerTransact(
  storageManager: SchedulerTestStorageManager,
) {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  const rejected = Promise.withResolvers<void>();
  let shouldReject = true;
  server.transact = async (message, publishVerdict) => {
    if (shouldReject) {
      shouldReject = false;
      rejected.resolve();
      const response: TransactResponse = {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced scheduler lineage test conflict",
        },
      };
      publishVerdict?.(response);
      return response;
    }
    return await original(message, publishVerdict);
  };

  return {
    rejected: rejected.promise,
    restore: () => {
      server.transact = original;
    },
  };
}

function rejectServerTransacts(
  storageManager: SchedulerTestStorageManager,
): () => void {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  server.transact = (message, publishVerdict) => {
    const response: TransactResponse = {
      type: "response",
      requestId: message.requestId,
      error: {
        name: "ConflictError",
        message: "forced scheduler lineage test conflict",
      },
    };
    publishVerdict?.(response);
    return Promise.resolve(response);
  };

  return () => {
    server.transact = original;
  };
}

function delayNextServerTransact(
  storageManager: SchedulerTestStorageManager,
) {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"confirm" | "fail">();
  let shouldDelay = true;

  server.transact = async (message, publishVerdict) => {
    if (!shouldDelay) {
      return await original(message, publishVerdict);
    }
    shouldDelay = false;
    started.resolve();
    const outcome = await release.promise;
    if (outcome === "fail") {
      const response: TransactResponse = {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced scheduler lineage test conflict",
        },
      };
      publishVerdict?.(response);
      return response;
    }
    return await original(message, publishVerdict);
  };

  return {
    started: started.promise,
    confirm: () => release.resolve("confirm"),
    fail: () => release.resolve("fail"),
    restore: () => {
      server.transact = original;
    },
  };
}

async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
): Promise<void> {
  // Iteration-bounded, not wall-clock-bounded: zero-delay yields do not
  // advance the fake clock, so a time deadline could never expire and an
  // unreachable condition would spin forever. Each round drains the
  // scheduler and yields one real timer turn — transport pumps and the
  // emulated server's zero-delay flush ride zero-delay timers, which are
  // exempt from the fake clock's test-armed freeze — so a condition the
  // system will ever reach is reached within a bounded number of rounds.
  for (let round = 0; round < 200 && !condition(); round++) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

/**
 * Await a signal the test itself resolves — a gate's deferred, a commit
 * callback. Deliberately no deadline: the package clock preload freezes
 * test-armed positive-delay timers, so a `setTimeout(reject, …)` race here
 * could never fire and would backstop nothing
 * (`docs/development/waiting-in-tests.md`). A signal that never arrives lets
 * the event loop quiesce, and Deno fails the pending wait at once, naming
 * the test; the label keeps the call site readable for whoever reads that
 * failure.
 */
async function waitForSignal(
  signal: Promise<void>,
  _label: string,
): Promise<void> {
  await signal;
}

async function expectIdlePending(
  idlePromise: Promise<void>,
): Promise<void> {
  const result = await Promise.race([
    idlePromise.then(() => "resolved" as const),
    clock.settle().then(() => "pending" as const),
  ]);
  expect(result).toBe("pending");
}

describe("scheduler event lineage", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      {
        // These tests assert lineage gating (which events run vs. drop), not
        // production backoff timing. Keep the cases that inject an unending
        // conflict from waiting for the full retry window before reaching
        // their terminal outcome.
        commitBackpressure: {
          baseDelayMs: 1,
          maxDelayMs: 5,
          jitter: 0,
          retryWindowMs: 250,
        },
      },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("commits only the retried origin attempt's same-space follow-up", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage duplication stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage duplication stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage duplication origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage duplication payloads",
      undefined,
      tx,
    );
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const rejection = rejectNextServerTransact(storageManager);
    let originAttempts = 0;
    const handlerA: EventHandler = (handlerTx) => {
      originAttempts++;
      originWrites.withTx(handlerTx).set(originAttempts);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        originAttempts,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {});
      await waitForSchedulerCondition(
        runtime,
        () => originAttempts >= 2 && payloads.get().length >= 1,
        "same-space follow-up did not commit",
      );

      expect(originAttempts).toBe(2);
      expect(payloads.get().length).toBe(1);
    } finally {
      rejection.restore();
    }
  });

  it("drops payload-only same-space follow-ups from permanently failed origins", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage permanent stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage permanent stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage permanent origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage permanent payloads",
      undefined,
      tx,
    );
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    let originAttempts = 0;
    const handlerA: EventHandler = (handlerTx) => {
      originAttempts++;
      originWrites.withTx(handlerTx).set(originAttempts);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        originAttempts,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
      handlerTx.abort("force lineage permanent failure");
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    // handlerTx.abort() aborts the commit locally (StorageTransactionAborted). A
    // locally-aborted commit is deterministic, not contention: it cannot converge
    // by retrying, so the event path drops it on the first attempt rather than
    // retrying (it is neither a conflict nor a bounded-budget retry). The
    // invariant under test is lineage gating: the payload-only same-space
    // follow-up B queued by the failed origin attempt must not commit.
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {}, true);
    await waitForSchedulerCondition(
      runtime,
      () => originAttempts >= 1,
      "origin did not run",
    );
    await runtime.idle();

    expect(originAttempts).toBe(1);
    expect(payloads.get()).toEqual([]);
  });

  it("drops a lineage event that is awaiting presync without dispatching it", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage presync race stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage presync race stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage presync race origin",
      undefined,
      tx,
    );
    originWrites.set(0);
    await tx.commit();
    tx = runtime.edit();

    const presyncStarted = Promise.withResolvers<void>();
    const releasePresync = Promise.withResolvers<void>();
    const descendantDropped = Promise.withResolvers<void>();
    let handlerRuns = 0;
    const finalStatuses: string[] = [];
    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        {},
        false,
        (eventTx) => {
          finalStatuses.push(eventTx.status().status);
          descendantDropped.resolve();
        },
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = () => {
      handlerRuns++;
    };
    handlerB.presyncInputs = async () => {
      presyncStarted.resolve();
      await releasePresync.promise;
    };
    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    const gate = delayNextServerTransact(storageManager);
    try {
      runtime.scheduler.queueEvent(
        streamA.getAsNormalizedFullLink(),
        {},
        false,
      );
      await waitForSignal(gate.started, "origin commit did not start");
      await waitForSignal(
        presyncStarted.promise,
        "descendant presync did not start",
      );

      gate.fail();
      await waitForSignal(
        descendantDropped.promise,
        "lineage failure did not drop the presyncing descendant",
      );
      releasePresync.resolve();
      await runtime.idle();

      expect(handlerRuns).toBe(0);
      expect(finalStatuses).toEqual(["error"]);
    } finally {
      gate.fail();
      releasePresync.resolve();
      gate.restore();
    }
  });

  it("keeps retried same-space follow-ups lineage-gated", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage retry stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      space,
      "lineage retry stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage retry origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage retry payloads",
      undefined,
      tx,
    );
    originWrites.set(0);
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    let descendantAttempts = 0;
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      descendantAttempts++;
      if (descendantAttempts === 1) {
        // Simulate the inSpace("name") resolution path: the run aborts and
        // the scheduler requeues the same event locally.
        throw new RetryImmediately();
      }
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    // Interleaving: the origin commit is held in flight while the descendant
    // dispatches speculatively and requeues itself locally (RetryImmediately).
    // The requeued retry must stay lineage-gated: when the origin then fails,
    // the retry must not run and commit.
    const gate = delayNextServerTransact(storageManager);

    try {
      runtime.scheduler.queueEvent(
        streamA.getAsNormalizedFullLink(),
        {},
        false,
      );
      await waitForSignal(gate.started, "origin commit did not start");
      await waitForSchedulerCondition(
        runtime,
        () => descendantAttempts >= 1,
        "descendant did not dispatch while the origin was pending",
      );
      gate.fail();
      await runtime.idle();
      await clock.tick(50);
      await runtime.idle();

      expect(payloads.get()).toEqual([]);
    } finally {
      gate.fail();
      gate.restore();
    }
  });

  it("treats read-only origin transactions as settled", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage read-only origin stream",
      { asCell: ["stream"] },
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage read-only origin payloads",
      undefined,
      tx,
    );
    payloads.set([]);
    await tx.commit();
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    // cell.send() forwards its transaction as the lineage origin; in read
    // contexts that is a read-only readTx() which never commits. Such events
    // are not speculative launches and must dispatch unconditionally instead
    // of throwing from addCommitCallback() or parking forever.
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      "from-read-context",
      undefined,
      undefined,
      false,
      { originTx: runtime.readTx() },
    );
    await waitForSchedulerCondition(
      runtime,
      () => payloads.get().length >= 1,
      "read-only-origin event did not dispatch",
    );

    expect(payloads.get()).toEqual(["from-read-context"]);
  });

  it("parks cross-space follow-ups until the origin confirms", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage cross confirm stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      secondSpace,
      "lineage cross confirm stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage cross confirm origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      secondSpace,
      "lineage cross confirm payloads",
      undefined,
      tx,
    );
    originWrites.set(0);
    await tx.commit();
    tx = runtime.edit();
    payloads.withTx(tx).set([]);
    await tx.commit();
    tx = runtime.edit();

    const gate = delayNextServerTransact(storageManager);
    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    let idlePromise: Promise<void> | undefined;

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), {});
      await waitForSignal(gate.started, "origin commit did not start");
      idlePromise = runtime.idle();
      await expectIdlePending(idlePromise);

      expect(payloads.get()).toEqual([]);

      gate.confirm();
      await idlePromise;
      await waitForSchedulerCondition(
        runtime,
        () => payloads.get().length === 1,
        "cross-space follow-up did not dispatch after origin confirmation",
      );
      expect(payloads.get().length).toBe(1);
    } finally {
      gate.confirm();
      gate.restore();
      await idlePromise?.catch(() => {});
    }
  });

  it("drops cross-space follow-ups when the origin fails", async () => {
    const streamA = runtime.getCell<unknown>(
      space,
      "lineage cross fail stream a",
      { asCell: ["stream"] },
      tx,
    );
    const streamB = runtime.getCell<unknown>(
      secondSpace,
      "lineage cross fail stream b",
      { asCell: ["stream"] },
      tx,
    );
    const originWrites = runtime.getCell<number>(
      space,
      "lineage cross fail origin writes",
      undefined,
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      secondSpace,
      "lineage cross fail payloads",
      undefined,
      tx,
    );
    originWrites.set(0);
    await tx.commit();
    tx = runtime.edit();
    payloads.withTx(tx).set([]);
    await tx.commit();
    tx = runtime.edit();

    const gate = delayNextServerTransact(storageManager);
    const handlerA: EventHandler = (handlerTx) => {
      originWrites.withTx(handlerTx).set(1);
      runtime.scheduler.queueEvent(
        streamB.getAsNormalizedFullLink(),
        1,
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
    };
    const handlerB: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    let idlePromise: Promise<void> | undefined;

    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    try {
      runtime.scheduler.queueEvent(
        streamA.getAsNormalizedFullLink(),
        {},
        false,
      );
      await waitForSignal(gate.started, "origin commit did not start");
      idlePromise = runtime.idle();
      await expectIdlePending(idlePromise);

      expect(payloads.get()).toEqual([]);

      gate.fail();
      await idlePromise;
      await runtime.idle();
      expect(payloads.get()).toEqual([]);
    } finally {
      gate.fail();
      gate.restore();
      await idlePromise?.catch(() => {});
    }
  });

  it("dispatches stream events whose origin transaction already committed", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage committed-origin stream",
      { asCell: ["stream"] },
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage committed-origin payloads",
      undefined,
      tx,
    );
    payloads.set([]);
    await tx.commit();

    const originTx = runtime.edit();
    await originTx.commit();
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    stream.withTx(originTx).send("settled origin payload");
    await waitForSignal(
      runtime.idle(),
      "already-committed origin event did not reach idle",
    );

    expect(payloads.get()).toEqual(["settled origin payload"]);
  });

  it("drops stream events whose origin transaction already failed", async () => {
    const stream = runtime.getCell<unknown>(
      space,
      "lineage failed-origin stream",
      { asCell: ["stream"] },
      tx,
    );
    const payloads = runtime.getCell<unknown[]>(
      space,
      "lineage failed-origin payloads",
      undefined,
      tx,
    );
    payloads.set([]);
    await tx.commit();

    const originTx = runtime.edit();
    originTx.abort("already failed lineage origin");
    tx = runtime.edit();

    const handler: EventHandler = (handlerTx, event: unknown) => {
      const current = payloads.withTx(handlerTx).get();
      payloads.withTx(handlerTx).set([...current, event]);
    };
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );

    let dropCallbacks = 0;
    let dropStatus: string | undefined;
    stream.withTx(originTx).send("dropped origin payload", (commitTx) => {
      dropCallbacks++;
      dropStatus = commitTx.status().status;
    });
    await waitForSignal(
      runtime.idle(),
      "already-failed origin event did not reach idle",
    );

    expect(payloads.get()).toEqual([]);
    expect(dropCallbacks).toBe(1);
    expect(dropStatus).toBe("error");
    await runtime.idle();
    expect(dropCallbacks).toBe(1);
  });

  it("stops handler-result pieces when the handler commit never converges", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    const childPattern = pattern<{ source: number }>(({ source }) => {
      const observed = lift((value: number) => value)(source);
      return { observed };
    });
    let handlerAttempts = 0;
    const launchChild = handler(
      {},
      {
        type: "object",
        properties: {
          source: { type: "number", asCell: ["cell"] },
        },
        required: ["source"],
      },
      (_event, { source }) => {
        handlerAttempts++;
        source.set((source.get() ?? 0) + 1);
        return childPattern({ source });
      },
    );
    const rootPattern = pattern(() => {
      const source = cell(0);
      return {
        launch: launchChild({ source }),
        source,
      };
    });
    const rootCell = runtime.getCell<{ launch: unknown; source: number }>(
      space,
      "lineage handler-result piece stop root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();

    const runningBefore = runtime.runner.cancels.size;
    const restoreTransact = rejectServerTransacts(storageManager);
    try {
      // idle() can resolve inside a verdict-in-flight gap (the event leaves
      // the queue at dispatch; its retry is requeued only when the rejection
      // frame lands a turn later), so it cannot bound the retry chain. Wait
      // for the chain's terminal outcome — the convergence error — instead.
      const gotConvergenceError = Promise.withResolvers<void>();
      runtime.scheduler.onError((error) => {
        if (error.name === "CommitConvergenceError") {
          gotConvergenceError.resolve();
        }
      });
      root.key("launch").send({});
      await waitForSignal(
        gotConvergenceError.promise,
        "handler retry chain did not reach its terminal outcome",
      );
      expect(handlerAttempts).toBeGreaterThanOrEqual(6);
      // Drain the terminal disposition's compensation (delivered on its own
      // turns) before asserting every handler-result piece was stopped.
      await clock.settle();
      await runtime.idle();

      expect(runtime.runner.cancels.size).toBe(runningBefore);
    } finally {
      restoreTransact();
    }
  });

  it("does not install a commit-gated handler result after its parent stops", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let childRuns = 0;
    const childPattern = pattern<{ source: number }>(({ source }) => {
      const observed = lift((value: number) => {
        childRuns++;
        return value;
      })(source);
      return { observed };
    });
    let handlerAttempts = 0;
    const launchChild = handler(
      {},
      {
        type: "object",
        properties: {
          source: { type: "number", asCell: ["cell"] },
        },
        required: ["source"],
      },
      (_event, { source }) => {
        handlerAttempts++;
        const handlerTx = source.tx;
        if (handlerTx === undefined) {
          throw new Error("handler source must carry the dispatch transaction");
        }
        handlerTx.tx.immediate = true;
        (handlerTx.tx as { deferRunnerStartUntilCommit?: boolean })
          .deferRunnerStartUntilCommit = true;
        return childPattern({ source });
      },
    );
    const rootPattern = pattern(() => {
      const source = cell(0);
      return {
        launch: launchChild({ source }),
        source,
      };
    });
    const rootCell = runtime.getCell<{ launch: unknown; source: number }>(
      space,
      "lineage deferred handler-result parent stop root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();
    await runtime.scheduler.idleWithPendingCommits();

    const runningBefore = runtime.runner.cancels.size;
    const gate = delayNextServerTransact(storageManager);
    try {
      root.key("launch").send({});
      await waitForSignal(gate.started, "handler commit did not start");
      expect(handlerAttempts).toBe(1);
      expect(runtime.runner.cancels.size).toBe(runningBefore);

      // The handler result is set up, but its start is deferred until this
      // commit succeeds. Stopping the parent must own and tombstone that
      // pending start, not merely stop a child that does not exist yet.
      runtime.runner.stop(rootCell);
      expect(runtime.runner.cancels.size).toBe(0);

      gate.confirm();
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.idle();

      expect(childRuns).toBe(0);
      expect(runtime.runner.cancels.size).toBe(0);
    } finally {
      gate.confirm();
      gate.restore();
    }
  });

  it("does not let deferred ownership stop a replacement at the same key", () => {
    type Cancel = () => void;
    let originalStops = 0;
    let replacementStops = 0;
    const originalCancel = () => originalStops++;
    const replacementCancel = () => replacementStops++;
    let currentCancel: Cancel = originalCancel;
    const ownership = useDeferredCancelOwnership((installedCancel) => {
      if (currentCancel === installedCancel) installedCancel();
    });
    expect(ownership.markInstalled(originalCancel)).toBe(false);

    // A stop/restart can replace the registration while the deferred start's
    // own transaction is still settling. Its later failure compensation is
    // stale and must not cancel by key into the replacement.
    currentCancel = replacementCancel;
    ownership.cancel();

    expect(originalStops).toBe(0);
    expect(replacementStops).toBe(0);
    expect(currentCancel).toBe(replacementCancel);
  });

  it("cancels a deferred retry child added after its parent stops", async () => {
    const local = createSchedulerTestRuntime(
      `${import.meta.url}#cancelled-handler-backoff`,
      {
        commitBackpressure: {
          baseDelayMs: 100,
          maxDelayMs: 100,
          jitter: 0,
          retryWindowMs: 500,
        },
      },
    );
    let localTx = local.tx;
    let restoreTransact = () => {};
    try {
      const { commonfabric } = createTrustedBuilder(local.runtime);
      const { cell, handler, lift, pattern } = commonfabric;
      let childRuns = 0;
      const childPattern = pattern<{ source: number }>(({ source }) => {
        const observed = lift((value: number) => {
          childRuns++;
          return value;
        })(source);
        return { observed };
      });
      let handlerAttempts = 0;
      const launchChild = handler(
        {},
        {
          type: "object",
          properties: {
            source: { type: "number", asCell: ["cell"] },
          },
          required: ["source"],
        },
        (_event, { source }) => {
          handlerAttempts++;
          const handlerTx = source.tx;
          if (handlerTx === undefined) {
            throw new Error(
              "handler source must carry the dispatch transaction",
            );
          }
          handlerTx.tx.immediate = true;
          (handlerTx.tx as { deferRunnerStartUntilCommit?: boolean })
            .deferRunnerStartUntilCommit = true;
          source.set((source.get() ?? 0) + 1);
          return childPattern({ source });
        },
      );
      const rootPattern = pattern(() => {
        const source = cell(0);
        return {
          launch: launchChild({ source }),
          source,
        };
      });
      const rootCell = local.runtime.getCell<{
        launch: unknown;
        source: number;
      }>(
        space,
        "lineage cancelled handler backoff root",
        undefined,
        localTx,
      );
      const root = local.runtime.run(localTx, rootPattern, {}, rootCell);
      await localTx.commit();
      localTx = local.runtime.edit();
      await root.pull();
      await local.runtime.scheduler.idleWithPendingCommits();

      const rejection = rejectNextServerTransact(local.storageManager);
      restoreTransact = rejection.restore;
      root.key("launch").send({});

      await waitForSignal(
        rejection.rejected,
        "handler commit was not rejected before parent cancellation",
      );
      // The rejection signal fires server-side; the client's backoff requeue
      // happens when the verdict frame lands a delivery turn later. Drain
      // those turns (the parked retry's positive-delay timer stays held) so
      // the first attempt's cleanup is registered before the stop below.
      await clock.settle();
      expect(handlerAttempts).toBe(1);

      // The first failed attempt registered its cleanup before this stop. The
      // retry registers a fresh deferred child after the group is cancelled;
      // a latched group must cancel that late addition immediately.
      local.runtime.runner.stop(rootCell);
      expect(local.runtime.runner.cancels.size).toBe(0);

      // Fire the held backoff window deterministically (baseDelayMs = 100,
      // jitter 0) instead of leaving the parked retry to whenever
      // auto-advance reaches its timer, then drain the retry's dispatch.
      await clock.tick(100);
      await local.runtime.idle();

      expect(handlerAttempts).toBe(2);
      expect(childRuns).toBe(0);
      expect(local.runtime.runner.cancels.size).toBe(0);
    } finally {
      restoreTransact();
      await disposeSchedulerTestRuntime({
        storageManager: local.storageManager,
        runtime: local.runtime,
        tx: localTx,
      });
    }
  });
});

describe("cancel group lifecycle", () => {
  it("invokes an optional cancellable cleanup", () => {
    let calls = 0;

    cancelCancellable({ cancel: () => calls++ });
    cancelCancellable({});

    expect(calls).toBe(1);
  });

  it("hands an installed cleanup through an already-cancelled owner once", () => {
    let calls = 0;
    const installedCancel = () => calls++;
    const ownership = useDeferredCancelOwnership((installed) => installed());

    ownership.cancel();
    expect(ownership.isCancelled()).toBe(true);
    expect(ownership.markInstalled(installedCancel)).toBe(true);
    ownership.cancel();

    expect(calls).toBe(1);
  });

  it("cancels each registered cleanup at most once", () => {
    const [cancel, addCancel] = useCancelGroup();
    let firstCalls = 0;
    let secondCalls = 0;

    addCancel(() => firstCalls++);
    addCancel(() => secondCalls++);

    cancel();
    cancel();

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it("immediately runs cleanups added after cancellation", () => {
    const [cancel, addCancel] = useCancelGroup();
    let calls = 0;

    cancel();
    addCancel(() => calls++);

    expect(calls).toBe(1);
  });

  it("immediately runs cleanups added while cancellation is in progress", () => {
    const [cancel, addCancel] = useCancelGroup();
    const calls: string[] = [];

    addCancel(() => {
      calls.push("parent");
      addCancel(() => calls.push("retry"));
    });
    addCancel(() => calls.push("sibling"));

    cancel();

    expect(calls).toEqual(["parent", "retry", "sibling"]);
  });

  it("runs sibling cleanups after one cleanup throws", () => {
    const [cancel, addCancel] = useCancelGroup();
    const calls: string[] = [];

    addCancel(() => {
      calls.push("throwing");
      throw new Error("cleanup failed");
    });
    addCancel(() => calls.push("sibling"));

    expect(cancel).toThrow("cleanup failed");
    expect(calls).toEqual(["throwing", "sibling"]);

    // Cancellation remains latched even when it reports a cleanup failure.
    cancel();
    expect(calls).toEqual(["throwing", "sibling"]);
  });

  it("aggregates multiple cleanup failures after running every cleanup", () => {
    const [cancel, addCancel] = useCancelGroup();
    const first = new Error("first cleanup failed");
    const second = new Error("second cleanup failed");
    const calls: string[] = [];
    addCancel(() => {
      calls.push("first");
      throw first;
    });
    addCancel(() => {
      calls.push("second");
      throw second;
    });

    let thrown: unknown;
    try {
      cancel();
    } catch (error) {
      thrown = error;
    }

    expect(calls).toEqual(["first", "second"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([first, second]);
  });
});
