import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Pattern } from "../src/builder/types.ts";
import {
  ensurePieceRunningVerdict,
  type EnsurePieceVerdict,
} from "../src/ensure-piece-running.ts";
import {
  getDerivedInternalCell,
  getMetaCell,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import { EventDroppedError } from "../src/scheduler/backpressure.ts";
import { EVENT_DEFERRAL_DROP_THRESHOLD } from "../src/scheduler/constants.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("scheduler event piece start");
const space = signer.did();

const patternIdentity = {
  identity: "test-scheduler-event-piece-start",
  symbol: "default",
};

// A start verdict for a piece whose result document, reached through a
// backlink, nothing ever writes.
const neverStartedVerdict: EnsurePieceVerdict = {
  started: false,
  reason: "no-pattern-meta",
  root: { space, id: "of:never-written", scope: "space" },
  observedDocIds: ["of:never-written"],
  observedDocs: [{ space, id: "of:never-written", scope: "space" }],
};

type LoadPieceForEvent = (
  runtime: Runtime,
  eventLink: NormalizedFullLink,
) => Promise<EnsurePieceVerdict>;

// Replaces the scheduler's piece-start seam. The seam is a `readonly` optional
// on the state, so the write narrows the state object rather than the
// scheduler.
function setLoadPieceForEvent(
  runtime: Runtime,
  load: LoadPieceForEvent,
): void {
  (runtime.scheduler.accessForTestingOnly.eventQueueState as {
    loadPieceForEvent?: LoadPieceForEvent;
  }).loadPieceForEvent = load;
}

// Returns a function that resolves `true` once a queued event next begins
// waiting for its piece, or `false` if `settled` settles first. The wait
// subscribes to storage in the same synchronous step that registers it, so a
// commit made once this resolves `true` is one the wait sees.
function onEachWaitBegins(
  runtime: Runtime,
): (settled: Promise<unknown>) => Promise<boolean> {
  const waits = runtime.scheduler.accessForTestingOnly.eventQueueState
    .pieceStartWaits;
  const add = waits.add.bind(waits);
  let began = Promise.withResolvers<void>();
  waits.add = (event: QueuedEvent) => {
    add(event);
    began.resolve();
    return waits;
  };
  return async (settled) => {
    const waited = await Promise.race([
      began.promise.then(() => true),
      settled.then(() => false),
    ]);
    began = Promise.withResolvers<void>();
    return waited;
  };
}

describe("scheduler-event-piece-start", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let runtimeA: Runtime;
  let runtimeB: Runtime;
  let handled: unknown[];
  let errors: Error[];

  // Each runtime is one participant: a send from `runtimeA` reaches a piece
  // that `runtimeB` creates, through the shared server alone.
  function newRuntime(
    storage: EmulatedStorageManager,
    options: Pick<RuntimeOptions, "commitBackpressure" | "experimental"> = {},
  ): Runtime {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...options,
    });
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: { events: { type: "object" } },
      },
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
      ],
      result: { events: { $alias: { partialCause: "events", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown) => {
              handled.push(event);
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
          },
          outputs: {},
        },
      ],
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );
    return runtime;
  }

  // The link of the stream of the piece whose result document is `name`,
  // which the piece's creation commit writes. Reading it writes nothing.
  function streamLink(runtime: Runtime, name: string): NormalizedFullLink {
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, name, undefined, tx);
    const link = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx).getAsNormalizedFullLink();
    tx.abort("read only");
    return link;
  }

  // Commits the piece whose result document is `name` as one creation commit,
  // its pattern pointer included unless `withPointer` is `false`.
  async function createPiece(
    runtime: Runtime,
    name: string,
    { withPointer = true }: { withPointer?: boolean } = {},
  ): Promise<void> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, name, undefined, tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx);
    resultCell.setRaw({ events: eventsCell.getAsWriteRedirectLink() });
    if (withPointer) {
      resultCell.setMetaRaw(
        "patternIdentity",
        patternIdentity,
        rawMetaWriteAuthorization,
      );
    }
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(eventsCell, resultCell);
    argumentCell.set({});
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  // Commits the pattern pointer of the piece whose result document is `name`.
  async function writePointer(runtime: Runtime, name: string): Promise<void> {
    const tx = runtime.edit();
    runtime.getCell(space, name, undefined, tx).setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  // Queues `event` on `link` the way a send from a handler does, and resolves
  // with the status of the transaction the event settles on.
  function send(
    runtime: Runtime,
    link: NormalizedFullLink,
    event: unknown,
  ): Promise<string> {
    const settled = Promise.withResolvers<string>();
    runtime.scheduler.queueEvent(
      link,
      event,
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );
    return settled.promise;
  }

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    handled = [];
    errors = [];
    runtimeA = newRuntime(storageA);
    runtimeB = newRuntime(storageB);
    runtimeA.scheduler.onError((error) => errors.push(error));
  });

  afterEach(async () => {
    await runtimeA.runner.idlePieceInstantiationSettlements();
    await runtimeB.dispose({ closeStorage: false });
    await runtimeA.dispose({ closeStorage: false });
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  it("delivers a send made before its piece exists once another runtime's creation commit lands", async () => {
    const link = streamLink(runtimeA, "created-later");
    const verdicts: EnsurePieceVerdict[] = [];
    setLoadPieceForEvent(runtimeA, async (runtime, eventLink) => {
      const verdict = await ensurePieceRunningVerdict(runtime, eventLink);
      verdicts.push(verdict);
      return verdict;
    });
    const waitBegins = onEachWaitBegins(runtimeA);

    const sentAt = performance.now();
    const status = send(runtimeA, link, { offer: "room-1" });
    expect(await waitBegins(status)).toBe(true);
    await createPiece(runtimeB, "created-later");

    expect(await status).toBe("done");
    // The end of the retry window asks once more as well, and would find the
    // piece too. Ending sooner is what says the commit ended the wait.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(handled).toEqual([{ offer: "room-1" }]);
    expect(errors).toEqual([]);
    expect(verdicts.map(({ started, reason }) => ({ started, reason })))
      .toEqual([
        { started: false, reason: "no-pattern-meta" },
        { started: false, reason: "no-pattern-meta" },
        { started: true, reason: undefined },
      ]);
  });

  it("delivers a send whose piece's creation commit lands after the start read its documents and before the wait began watching them", async () => {
    const link = streamLink(runtimeA, "created-in-gap");
    // Resolves once runtimeA's storage reports a change to the stream's
    // document, which is the one the start reads.
    const arrived = Promise.withResolvers<void>();
    runtimeA.storageManager.subscribe({
      next: (notification) => {
        if (notification.type === "reset") return undefined;
        for (const change of notification.changes) {
          if (change.address.id === link.id) {
            arrived.resolve();
            return { done: true };
          }
        }
        return undefined;
      },
    });
    let walks = 0;
    setLoadPieceForEvent(runtimeA, async (runtime, eventLink) => {
      walks++;
      const verdict = await ensurePieceRunningVerdict(runtime, eventLink);
      if (walks === 1) {
        await createPiece(runtimeB, "created-in-gap");
        await arrived.promise;
      }
      return verdict;
    });

    const sentAt = performance.now();
    const status = await send(runtimeA, link, "queued");

    expect(status).toBe("done");
    // The end of the retry window would find the piece too.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(walks).toBe(2);
    expect(handled).toEqual(["queued"]);
    expect(errors).toEqual([]);
  });

  it("does not wake for a write to a document with the observed ID in another space", async () => {
    const otherSpace = (await Identity.fromPassphrase(
      "scheduler event piece start, another space",
    )).did();
    const link = streamLink(runtimeA, "foreign-write");
    let walks = 0;
    setLoadPieceForEvent(runtimeA, () => {
      walks++;
      return Promise.resolve({
        started: false,
        reason: "no-pattern-meta",
        root: { space, id: "of:never-written", scope: "space" },
        observedDocIds: [link.id],
        observedDocs: [{ space, id: link.id, scope: "space" }],
      });
    });
    const waitBegins = onEachWaitBegins(runtimeA);

    const status = send(runtimeA, link, "queued");
    expect(await waitBegins(status)).toBe(true);
    const tx = runtimeA.edit();
    runtimeA.getCellFromEntityId<number>(otherSpace, link.id, [], undefined, tx)
      .set(1);
    await tx.commit().settled;
    runtimeA.scheduler.addEventHandler((_tx, event) => {
      handled.push(event);
    }, link);

    expect(await status).toBe("done");
    // The attempt, its recheck, and the attempt the handler's registration
    // woke: the write in the other space woke nothing.
    expect(walks).toBe(3);
    expect(handled).toEqual(["queued"]);
  });

  it("delivers a send whose stream's backlink reaches a result document with no pointer once the pointer lands", async () => {
    await createPiece(runtimeB, "pointer-later", { withPointer: false });
    const link = streamLink(runtimeA, "pointer-later");
    const waitBegins = onEachWaitBegins(runtimeA);

    const sentAt = performance.now();
    const status = send(runtimeA, link, "queued");
    expect(await waitBegins(status)).toBe(true);
    await writePointer(runtimeB, "pointer-later");

    expect(await status).toBe("done");
    // As in the case above, the retry window's end would find the piece too.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(handled).toEqual(["queued"]);
    expect(errors).toEqual([]);
  });

  it("waits for a piece whose owning document is the same ID in another scope", async () => {
    // `observedDocIds` names a backlink from the stream's scope to the same ID
    // in another one once, so counting IDs cannot say it was followed. The
    // root differing from the stream's link is what says so.
    const link: NormalizedFullLink = {
      ...streamLink(runtimeA, "scoped"),
      scope: "user",
    };
    setLoadPieceForEvent(runtimeA, () =>
      Promise.resolve({
        started: false,
        reason: "no-pattern-meta",
        root: { space, id: link.id, scope: "space" },
        observedDocIds: [link.id],
        observedDocs: [
          { space, id: link.id, scope: "user" },
          { space, id: link.id, scope: "space" },
        ],
      }));
    const waitBegins = onEachWaitBegins(runtimeA);

    const status = send(runtimeA, link, "queued");

    expect(await waitBegins(status)).toBe(true);
  });

  it("delivers a send whose piece has no graph installed once a handler registers for its stream", async () => {
    const link = streamLink(runtimeA, "between-graphs");
    setLoadPieceForEvent(runtimeA, () =>
      Promise.resolve({
        started: true,
        graphIsInstalled: () => false,
        observedDocIds: [],
        observedDocs: [],
      }));
    const waitBegins = onEachWaitBegins(runtimeA);

    const sentAt = performance.now();
    const status = send(runtimeA, link, "queued");
    expect(await waitBegins(status)).toBe(true);
    runtimeA.scheduler.addEventHandler((_tx, event) => {
      handled.push(event);
    }, link);

    expect(await status).toBe("done");
    // As above: the retry window's end would find the handler too.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(handled).toEqual(["queued"]);
    expect(errors).toEqual([]);
  });

  it("reports an `EventDroppedError` once the re-attempt budget is spent", async () => {
    const link = streamLink(runtimeA, "never-a-piece");
    const tx = runtimeA.edit();
    const watched = runtimeA.getCell<number>(space, "watched", undefined, tx);
    watched.set(0);
    await tx.commit().settled;
    let walks = 0;
    const { id } = watched.getAsNormalizedFullLink();
    setLoadPieceForEvent(runtimeA, () => {
      walks++;
      return Promise.resolve({
        started: false,
        reason: "no-pattern-meta",
        root: { space, id: "of:never-written", scope: "space" },
        observedDocIds: [id],
        observedDocs: [{ space, id, scope: "space" }],
      });
    });
    const waitBegins = onEachWaitBegins(runtimeA);

    const status = send(runtimeA, link, "queued");
    for (let write = 1; write <= EVENT_DEFERRAL_DROP_THRESHOLD; write++) {
      expect(await waitBegins(status)).toBe(true);
      const writeTx = runtimeA.edit();
      watched.withTx(writeTx).set(write);
      await writeTx.commit().settled;
    }

    expect(await status).toBe("error");
    // Each attempt that waits is rechecked once, uncounted, after the wait
    // begins watching; the attempt past the budget drops without waiting.
    expect(walks).toBe(2 * EVENT_DEFERRAL_DROP_THRESHOLD + 1);
    expect(handled).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect((errors[0] as EventDroppedError).attempts).toBe(
      EVENT_DEFERRAL_DROP_THRESHOLD + 1,
    );
    expect((errors[0] as EventDroppedError).pieceStartReason).toBe(
      "no-pattern-meta",
    );
  });

  it("reports an `EventDroppedError` once the retry window ends with nothing re-arming the wait", async () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage, {
      commitBackpressure: { retryWindowMs: 0 },
    });
    const windowErrors: Error[] = [];
    runtime.scheduler.onError((error) => windowErrors.push(error));
    try {
      let walks = 0;
      setLoadPieceForEvent(runtime, () => {
        walks++;
        return Promise.resolve(neverStartedVerdict);
      });

      const status = await send(
        runtime,
        streamLink(runtime, "window"),
        "queued",
      );

      expect(status).toBe("error");
      // The attempt, its recheck, and the last ask the window's end makes.
      expect(walks).toBe(3);
      expect(windowErrors.length).toBe(1);
      expect(windowErrors[0]).toBeInstanceOf(EventDroppedError);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });

  it("reports an `EventDroppedError` at once for a send to a document that is not a piece", async () => {
    const tx = runtimeA.edit();
    const plain = runtimeA.getCell<number>(space, "plain", undefined, tx);
    plain.set(1);
    await tx.commit().settled;

    const status = await send(
      runtimeA,
      plain.getAsNormalizedFullLink(),
      "queued",
    );

    expect(status).toBe("error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect((errors[0] as EventDroppedError).attempts).toBe(1);
  });

  it("reports an `EventDroppedError` for a send whose piece start throws", async () => {
    setLoadPieceForEvent(runtimeA, () => Promise.reject(new Error("boom")));

    const status = await send(
      runtimeA,
      streamLink(runtimeA, "throws"),
      "queued",
    );

    expect(status).toBe("error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect(errors[0].message).toContain("failed: boom");
    expect((errors[0] as EventDroppedError).pieceStartReason).toBe(
      "start-failed",
    );
  });

  it("names the start verdict's reason on an `EventDroppedError`", async () => {
    setLoadPieceForEvent(runtimeA, () =>
      Promise.resolve({
        started: false,
        reason: "pattern-unloadable",
        root: { space, id: "of:unloadable", scope: "space" },
        observedDocIds: ["of:unloadable"],
        observedDocs: [{ space, id: "of:unloadable", scope: "space" }],
      }));

    const status = await send(
      runtimeA,
      streamLink(runtimeA, "unloadable"),
      "queued",
    );

    expect(status).toBe("error");
    expect(errors.length).toBe(1);
    const dropped = errors[0] as EventDroppedError;
    expect(dropped.pieceStartReason).toBe("pattern-unloadable");
    expect(dropped.message).toContain(
      "could not be started (pattern-unloadable)",
    );
  });

  it("names `start-failed` for a start whose verdict gives no reason", async () => {
    // The start walk collapses a start that threw into a verdict with none.
    setLoadPieceForEvent(
      runtimeA,
      () =>
        Promise.resolve({
          started: false,
          observedDocIds: [],
          observedDocs: [],
        }),
    );

    await send(runtimeA, streamLink(runtimeA, "no-reason"), "queued");

    expect(errors.length).toBe(1);
    expect((errors[0] as EventDroppedError).pieceStartReason).toBe(
      "start-failed",
    );
  });

  it("drops a send whose piece cannot be started at once, reporting nothing, when server execution is on", async () => {
    // With server execution on, a client event without a served carriage is
    // the echo of a run the server makes and reports on for itself.
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage, {
      experimental: { serverExecution: true },
    });
    const echoErrors: Error[] = [];
    runtime.scheduler.onError((error) => echoErrors.push(error));
    try {
      setLoadPieceForEvent(runtime, () => Promise.resolve(neverStartedVerdict));
      const waitBegins = onEachWaitBegins(runtime);

      const status = send(runtime, streamLink(runtime, "echo"), "queued");

      expect(await waitBegins(status)).toBe(false);
      expect(await status).toBe("error");
      expect(echoErrors).toEqual([]);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });

  it("settles a send whose piece start is still in flight when its runtime is disposed, without waiting out the retry window", async () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage);
    const disposeErrors: Error[] = [];
    runtime.scheduler.onError((error) => disposeErrors.push(error));
    const verdict = Promise.withResolvers<EnsurePieceVerdict>();
    const attempted = Promise.withResolvers<void>();
    setLoadPieceForEvent(runtime, () => {
      attempted.resolve();
      return verdict.promise;
    });

    const sentAt = performance.now();
    const status = send(runtime, streamLink(runtime, "in-flight"), "queued");
    await attempted.promise;
    const disposed = runtime.dispose({ closeStorage: false });
    verdict.resolve(neverStartedVerdict);
    await disposed;
    await storage.close();

    expect(await status).toBe("error");
    expect(performance.now() - sentAt).toBeLessThan(
      runtime.commitBackpressure.retryWindowMs,
    );
    expect(disposeErrors).toEqual([]);
  });

  it("settles a waiting send with an error when its runtime is disposed", async () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage);
    const disposeErrors: Error[] = [];
    runtime.scheduler.onError((error) => disposeErrors.push(error));
    setLoadPieceForEvent(runtime, () => Promise.resolve(neverStartedVerdict));
    const waitBegins = onEachWaitBegins(runtime);

    const status = send(runtime, streamLink(runtime, "disposed"), "queued");
    expect(await waitBegins(status)).toBe(true);
    await runtime.dispose({ closeStorage: false });
    await storage.close();

    expect(await status).toBe("error");
    expect(disposeErrors).toEqual([]);
  });
});
