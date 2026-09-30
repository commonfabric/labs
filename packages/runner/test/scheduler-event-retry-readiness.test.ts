import { resolveLink } from "../src/link-resolution.ts";
import type { CommitError } from "../src/storage/interface.ts";
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
  Cell,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/**
 * The stale-basis refusal in the shape `toRejectedError` hands the
 * scheduler: the engine's message plus the conflict descriptor parsed from
 * it, and the catch-up gate the wire attaches. It names the REAL document
 * the handler writes, so the readiness pull resolves against the store
 * rather than a phantom id.
 */
function staleReadRefusal(
  of: string,
  readyToRetry: () => Promise<void>,
): CommitError {
  return {
    name: "ConflictError",
    message: `stale confirmed read: ${of} at seq 0 conflicted with seq 9`,
    conflict: { space, the: "application/json", of },
    readyToRetry,
  } as unknown as CommitError;
}

/**
 * Refuses the first commit of an event handler's transaction with
 * `refusal`, letting every other transaction commit as it would. The
 * handler's transaction is the one the scheduler stamps with a dispatched
 * event id before running the handler. A refused commit applies nothing,
 * so the attempt's writes are discarded the way the rollback behind a
 * server refusal discards them.
 */
function refuseFirstEventCommit(
  runtime: Runtime,
  refusal: CommitError,
): { refusals(): number; restore(): void } {
  const edit = runtime.edit.bind(runtime);
  let refusals = 0;
  runtime.edit = (options) => {
    const tx = edit(options);
    const commit = tx.commit.bind(tx);
    tx.commit = (commitOptions) => {
      if (tx.dispatchedEventId === undefined || refusals > 0) {
        return commit(commitOptions);
      }
      refusals++;
      tx.abort(refusal.message);
      return Promise.resolve({ error: refusal });
    };
    return tx;
  };
  return {
    refusals: () => refusals,
    restore: () => {
      runtime.edit = edit;
    },
  };
}

/**
 * Records every sync of the document `of` through the space's provider, in
 * order with the other entries of `events`, and forwards each to the real
 * sync.
 */
function observeSyncsOf(
  runtime: Runtime,
  of: string,
  events: string[],
): { restore(): void } {
  const provider = runtime.storageManager.open(space);
  const sync = provider.sync.bind(provider);
  provider.sync = (uri, ...rest) => {
    if (uri === of) events.push(`sync:${of}`);
    return sync(uri, ...rest);
  };
  return {
    restore: () => {
      provider.sync = sync;
    },
  };
}

/**
 * Builds a piece with one effect handler that adds the event value to a
 * running total, recording each invocation in `events`. The handler's
 * commit is the committed write under test, and the returned document id
 * is the one that write goes to.
 */
function buildCounterPiece(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
  events: string[],
): {
  documentId: string;
  total: () => number;
  invocations: () => number;
  queueAdd: (
    value: number,
    eventId: string,
    onCommit?: (tx: IExtendedStorageTransaction) => void,
  ) => void;
} {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { cell, handler, pattern } = commonfabric;
  let invocations = 0;
  const recordEvent = handler<
    { value: number },
    { effects: Cell<{ total: number }> }
  >(
    true,
    {
      type: "object",
      properties: { effects: { type: "object", asCell: ["cell"] } },
    },
    (event, { effects }) => {
      invocations++;
      events.push(`run:${event.value}`);
      const total = effects.key("total");
      total.set(total.get() + event.value);
    },
  );
  const rootPattern = pattern(() => {
    const effects = cell({ total: 0 });
    return { effects, stream: recordEvent({ effects }) };
  });
  const rootCell = runtime.getCell<
    { effects: { total: number }; stream: unknown }
  >(space, label, undefined, tx);
  const root = runtime.run(tx, rootPattern, {}, rootCell);

  const resolved = (key: "stream" | "effects") =>
    resolveLink(
      runtime,
      runtime.readTx(),
      root.key(key).getAsNormalizedFullLink(),
    );

  return {
    documentId: resolved("effects").id,
    total: () => (root.key("effects").key("total") as Cell<number>).get() ?? 0,
    invocations: () => invocations,
    queueAdd: (value, eventId, onCommit) => {
      runtime.scheduler.queueEvent(
        resolved("stream"),
        { value },
        undefined,
        onCommit,
        false,
        { eventId },
      );
    },
  };
}

describe("scheduler event retry readiness", () => {
  // A stale-basis rejection of an event handler's commit re-runs the
  // handler against fresh state. These cases pin what "fresh" waits for:
  // the conflict's `readyToRetry` catch-up gate and the pull of the
  // document the conflict names, both ahead of the re-run, with the
  // pending-commit barrier open for the whole wait.
  //
  // Under the auto-advancing fake clock the backoff step is the only wait
  // a requeue has besides its readiness, and `clock.tick` moves logical
  // time past every step the policy below can produce while draining the
  // zero-delay execution tick the wake timer queues. So the barrier for the
  // negative cases is a tick past the backoff: a requeue that did not wait
  // for readiness has dispatched by then, which the release step of each
  // case confirms by observing exactly that dispatch once the gate opens.
  // `runtime.idle()` is not the barrier here — it holds on the parked head
  // for as long as the gate does, which the last case pins.

  const backoff = {
    baseDelayMs: 1,
    maxDelayMs: 4,
    jitter: 0,
    retryWindowMs: 60_000,
  };
  const pastEveryBackoffStep = backoff.maxDelayMs * 4;

  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { commitBackpressure: backoff },
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("re-dispatches a conflicted event only once the conflict's readiness resolves", async () => {
    const events: string[] = [];
    const piece = buildCounterPiece(runtime, tx, "readiness-gate-root", events);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    const gate = Promise.withResolvers<void>();
    const gateAwaited = Promise.withResolvers<void>();
    const injector = refuseFirstEventCommit(
      runtime,
      staleReadRefusal(piece.documentId, () => {
        events.push("readiness-awaited");
        gateAwaited.resolve();
        return gate.promise;
      }),
    );
    try {
      piece.queueAdd(3, "evt:readiness-gate:0:readiness-gate-root");
      await gateAwaited.promise;

      await clock.tick(pastEveryBackoffStep);
      expect(piece.invocations()).toBe(1);
      expect(piece.total()).toBe(0);

      gate.resolve();
      await runtime.scheduler.idleWithPendingCommits();

      expect(events).toEqual(["run:3", "readiness-awaited", "run:3"]);
      expect(injector.refusals()).toBe(1);
      expect(piece.total()).toBe(3);
    } finally {
      injector.restore();
    }
  });

  it("keeps the pending-commit barrier open while the readiness gate is held", async () => {
    const events: string[] = [];
    const piece = buildCounterPiece(
      runtime,
      tx,
      "readiness-barrier-root",
      events,
    );
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    const gate = Promise.withResolvers<void>();
    const gateAwaited = Promise.withResolvers<void>();
    const injector = refuseFirstEventCommit(
      runtime,
      staleReadRefusal(piece.documentId, () => {
        gateAwaited.resolve();
        return gate.promise;
      }),
    );
    try {
      piece.queueAdd(3, "evt:readiness-barrier:0:readiness-barrier-root");
      await gateAwaited.promise;
      const barrier = runtime.scheduler.idleWithPendingCommits()
        .then(() => "released" as const);

      await clock.tick(pastEveryBackoffStep);
      // `barrier` is listed first, so a barrier that already released wins
      // the race over the settled sentinel.
      expect(await Promise.race([barrier, Promise.resolve("held" as const)]))
        .toBe("held");

      gate.resolve();
      expect(await barrier).toBe("released");
      expect(piece.total()).toBe(3);
    } finally {
      injector.restore();
    }
  });

  it("syncs the document the conflict names before the handler re-runs", async () => {
    const events: string[] = [];
    const piece = buildCounterPiece(runtime, tx, "readiness-sync-root", events);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    const syncs = observeSyncsOf(runtime, piece.documentId, events);
    const injector = refuseFirstEventCommit(
      runtime,
      staleReadRefusal(piece.documentId, () => {
        events.push("readiness-awaited");
        return Promise.resolve();
      }),
    );
    try {
      piece.queueAdd(3, "evt:readiness-sync:0:readiness-sync-root");
      await runtime.scheduler.idleWithPendingCommits();

      expect(events).toEqual([
        "run:3",
        "readiness-awaited",
        `sync:${piece.documentId}`,
        "run:3",
      ]);
      expect(piece.total()).toBe(3);
    } finally {
      injector.restore();
      syncs.restore();
    }
  });

  it("holds a later event behind the retry until the retry has run", async () => {
    // The retry keeps its FIFO slot for the wait. Without that, a follower
    // sent after the rejection would run and commit first, and the retry
    // would then land over it — an event overtaking one sent before it.
    const events: string[] = [];
    const piece = buildCounterPiece(runtime, tx, "readiness-fifo-root", events);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    const gate = Promise.withResolvers<void>();
    const gateAwaited = Promise.withResolvers<void>();
    const injector = refuseFirstEventCommit(
      runtime,
      staleReadRefusal(piece.documentId, () => {
        events.push("readiness-awaited");
        gateAwaited.resolve();
        return gate.promise;
      }),
    );
    try {
      piece.queueAdd(3, "evt:readiness-fifo:0:readiness-fifo-root");
      await gateAwaited.promise;
      piece.queueAdd(4, "evt:readiness-fifo:1:readiness-fifo-root");
      const idle = runtime.idle().then(() => "released" as const);

      await clock.tick(pastEveryBackoffStep);
      expect(events).toEqual(["run:3", "readiness-awaited"]);
      expect(await Promise.race([idle, Promise.resolve("held" as const)]))
        .toBe("held");

      gate.resolve();
      expect(await idle).toBe("released");
      await runtime.scheduler.idleWithPendingCommits();

      expect(events).toEqual(["run:3", "readiness-awaited", "run:3", "run:4"]);
      expect(piece.total()).toBe(7);
    } finally {
      injector.restore();
    }
  });

  it("keeps a retry on the pending-commit barrier when its telemetry submission throws", async () => {
    // The commit's telemetry marker is submitted between the rejection and
    // the requeue, and a submission that throws is surfaced through the
    // tracked chain. It has to surface after the requeue settles: thrown
    // ahead of it, the chain would reject at once and the barrier would
    // release with the retry still parked.
    const events: string[] = [];
    const piece = buildCounterPiece(
      runtime,
      tx,
      "readiness-telemetry-root",
      events,
    );
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    const gate = Promise.withResolvers<void>();
    const gateAwaited = Promise.withResolvers<void>();
    const injector = refuseFirstEventCommit(
      runtime,
      staleReadRefusal(piece.documentId, () => {
        gateAwaited.resolve();
        return gate.promise;
      }),
    );
    const submit = runtime.telemetry.submit.bind(runtime.telemetry);
    runtime.telemetry.submit = (marker) => {
      if (marker.type === "scheduler.event.commit") {
        throw new Error("telemetry sink refused the marker");
      }
      submit(marker);
    };
    try {
      piece.queueAdd(3, "evt:readiness-telemetry:0:readiness-telemetry-root");
      await gateAwaited.promise;

      await clock.tick(pastEveryBackoffStep);
      expect(runtime.storageManager.hasPendingCommits()).toBe(true);
      expect(piece.invocations()).toBe(1);

      gate.resolve();
      await runtime.scheduler.idleWithPendingCommits();

      expect(piece.total()).toBe(3);
    } finally {
      runtime.telemetry.submit = submit;
      injector.restore();
    }
  });

  it("drops the retry when the runtime closes its storage during the wait", async () => {
    // A runtime of this case's own, since disposing it closes its storage.
    // Closing tears down writes before anything is drained, so the wait
    // returns at the teardown and the retry ends there: the event leaves the
    // queue, its commit callback settles on the refused transaction, and
    // the handler does not run again.
    const own = createSchedulerTestRuntime(import.meta.url, {
      commitBackpressure: backoff,
    });
    let disposed = false;
    try {
      const events: string[] = [];
      const piece = buildCounterPiece(
        own.runtime,
        own.tx,
        "readiness-teardown-root",
        events,
      );
      await own.tx.commit();
      await own.runtime.idle();

      const gate = Promise.withResolvers<void>();
      const gateAwaited = Promise.withResolvers<void>();
      refuseFirstEventCommit(
        own.runtime,
        staleReadRefusal(piece.documentId, () => {
          events.push("readiness-awaited");
          gateAwaited.resolve();
          return gate.promise;
        }),
      );
      piece.queueAdd(
        3,
        "evt:readiness-teardown:0:readiness-teardown-root",
        (tx) => events.push(`callback:${tx.status().status}`),
      );
      await gateAwaited.promise;

      disposed = true;
      await own.runtime.dispose();

      expect(events).toEqual(["run:3", "readiness-awaited", "callback:error"]);
      expect(piece.invocations()).toBe(1);
    } finally {
      // The disposal under test is the cleanup; a failure ahead of it still
      // releases the runtime and the storage it owns.
      if (!disposed) await own.runtime.dispose();
    }
  });
});
