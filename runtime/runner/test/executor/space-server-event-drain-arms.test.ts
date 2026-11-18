import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  type DeliveryDeferral,
  getServerExecutionConfig,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryServer from "@commonfabric/memory/v2/server";

import {
  EVENT_PREQUEUE_STUCK_AFTER,
  SpaceServer,
  type SpaceServerPolicy,
} from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import type {
  WaveCommitRejection,
  WaveSpaceCommit,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { QueuedEvent } from "../../src/scheduler/types.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("event drain arms owner");
const service = await Identity.fromPassphrase("event drain arms service");
const space = owner.did();
const streams = ["a", "b"].map((name) => ({
  id: `of:drain-arms-stream-${name}` as const,
  path: [],
}));
const sidecars = streams.map((stream) =>
  streamEntriesDocId(stream) as `of:${string}`
);
const logId = "of:drain-arms-log";
const actingSession = "session:drain-arms-actor";
/** The serving loop's deferral backstop, after which a deferred entry's
 * re-drain runs. */
const rearmMs = 250;
const noticeActionPrefix = "server-execution/event-consequence:";
const logger = getLogger("space-server");

/** Drain transport and scheduler work while positive-delay timers stay fixed. */
async function settle<T>(operation: Promise<T>): Promise<T> {
  await clock.settle();
  return await operation;
}

/** How many times the space server has warned under `key`. */
function warnings(key: string): number {
  return logger.countsByKey[key]?.warn ?? 0;
}

describe("SpaceServer", () => {
  let server: MemoryServer.Server;
  let serving: SpaceServer | undefined;
  let previousServerExecution: boolean;

  beforeEach(() => {
    previousServerExecution = getServerExecutionConfig();
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      await settle(server.close());
    } finally {
      serving = undefined;
      setServerExecutionConfig(previousServerExecution);
    }
  });

  async function openFixture(policy?: SpaceServerPolicy) {
    const engine = await server.engineForSpace(space);
    await settle(
      server.writeDocument(space, SERVER_EXECUTION_WATERMARK_DOC_ID, {
        seq: 1,
      }),
    );
    const stats = emptyServingLoopStats();
    const called: string[] = [];
    let waveCommits = 0;
    let handlerFailures = 0;
    let deferredCallbacks = 0;
    let rejectNextWave:
      | ((batch: WaveSpaceCommit) => WaveCommitRejection)
      | undefined;
    const entries = () =>
      sidecars.flatMap((id) =>
        (Engine.read(engine, { id })?.value as StreamEventsDocValue | undefined)
          ?.entries ?? []
      );
    const entry = (eventId: string): StreamEventEntry | undefined =>
      entries().find((candidate) => candidate.eventId === eventId);
    const storedLog = () =>
      (Engine.read(engine, { id: logId })?.value as string[] | undefined) ?? [];
    let runtime: Runtime | undefined;
    serving = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      localSeqRef: { value: 0 },
      stats,
      onEventDeferred: () => deferredCallbacks++,
      ...(policy === undefined ? {} : { policy }),
      decorateWaveCommitSink: (sink) => ({
        currentHeads: (space, docs) => sink.currentHeads(space, docs),
        concurrentWritePaths: (space, doc, seq) =>
          sink.concurrentWritePaths(space, doc, seq),
        commitWave: (batch) => {
          waveCommits++;
          const reject = rejectNextWave;
          rejectNextWave = undefined;
          if (reject !== undefined) {
            return Promise.resolve({ error: reject(batch) });
          }
          return sink.commitWave(batch);
        },
      }),
      createRuntime: async ({ storeReadThrough }) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        if (storeReadThrough !== undefined) {
          manager.installStoreReadThrough(space, storeReadThrough);
        }
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const log = runtime.getCellFromLink<string[]>({
          space,
          id: logId,
          scope: "space",
          path: [],
        });
        await log.sync();
        for (const [index, stream] of streams.entries()) {
          await runtime.getCellFromLink({ space, ...stream, scope: "space" })
            .sync();
          await runtime.getCellFromLink({
            space,
            id: sidecars[index],
            scope: "space",
            path: [],
          }).sync();
          runtime.scheduler.addEventHandler((tx) => {
            if (handlerFailures > 0) {
              handlerFailures--;
              throw new Error("injected handler failure");
            }
            const name = index === 0 ? "A" : "B";
            called.push(name);
            const cell = log.withTx(tx);
            cell.set([...(cell.get() ?? []), name]);
          }, { space, ...stream, scope: "space" });
        }
        const created = runtime;
        return {
          runtime: created,
          dispose: async () => {
            await created.dispose();
            await manager.close();
          },
        };
      },
    });
    expect(await settle(serving.activate())).toBe(true);
    await clock.settle();
    const notices: MemoryServer.AdmittedCommitNotice[] = [];
    server.setServerExecutionObserver({
      commitAdmitted: (notice) => notices.push(notice),
    });
    const active = serving;
    let localSeq = 0;
    return {
      engine,
      stats,
      called,
      entries,
      entry,
      storedLog,
      runtime: runtime!,
      serving: active,
      get waveCommits() {
        return waveCommits;
      },
      get deferredCallbacks() {
        return deferredCallbacks;
      },
      failHandlerRuns(count: number) {
        handlerFailures = count;
      },
      rejectNextWave(reject: (batch: WaveSpaceCommit) => WaveCommitRejection) {
        rejectNextWave = reject;
      },
      async admitOne(streamIndex: number, eventId: string) {
        return await settle(server.commitDelegatedAppend({
          targetSpace: space,
          targetStream: sidecars[streamIndex],
          targetStreamLink: streams[streamIndex],
          eventId,
          payload: {},
          actingPrincipal: owner.did(),
          actingSession,
          capabilityRef: "cap:drain-arms",
          sessionId: "session:drain-arms-delivery",
          localSeq: ++localSeq,
        }));
      },
      async drain() {
        for (const notice of notices.splice(0)) active.enqueueCommit(notice);
        await clock.settle();
      },
      /** Writes `operations` on the sidecars straight to the store, as a
       * writer other than this tenure would. */
      patchStore(
        operations: Parameters<typeof Engine.applyCommit>[1]["commit"][
          "operations"
        ],
      ) {
        Engine.applyCommit(engine, {
          space,
          sessionId: "drain-arms-store-writer",
          principal: service.did(),
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations,
          },
        });
      },
    };
  }

  it("re-mints the entry's acting user and session on the served copy, and ignores a failure report after the tenure parks", async () => {
    // The scheduler reports a served copy's failure through the copy's
    // `onFailure`. A copy queued by one tenure can report after that tenure
    // parked, and what it reports then belongs to no running tenure.

    const fixture = await openFixture();
    const queued: QueuedEvent["served"][] = [];
    using _queue = stub(
      fixture.runtime.scheduler,
      "queueEvent",
      (...args: Parameters<typeof fixture.runtime.scheduler.queueEvent>) => {
        queued.push(args[5]?.served);
      },
    );
    await fixture.admitOne(0, "reported-active");
    await fixture.admitOne(1, "reported-parked");
    await fixture.drain();
    expect(queued).toHaveLength(2);
    expect(queued.map((served) => served?.firedAt)).toEqual([
      { user: owner.did(), session: actingSession },
      { user: owner.did(), session: actingSession },
    ]);

    const loadPark = {
      kind: "deferred",
      cause: "load-park",
      role: "failed-head",
      failure: {
        failureClass: "connection",
        recoveryEpoch: "drain-arms-epoch",
        permanentEvidence: false,
      },
    } as const;
    queued[0]!.onFailure!(loadPark);
    expect(fixture.stats.events.loadParkDeferrals).toBe(1);
    expect(fixture.deferredCallbacks).toBe(1);

    await settle(fixture.serving.park("test-park"));
    queued[1]!.onFailure!(loadPark);
    await clock.settle();
    expect(fixture.stats.events.loadParkDeferrals).toBe(1);
    expect(fixture.deferredCallbacks).toBe(1);
    expect(fixture.entry("reported-parked")?.deliveryDeferral)
      .toBeUndefined();
  });

  it("leaves an entry pending for the next drain when its error notice cannot be staged", async () => {
    // A handler that throws is consequenced by an error notice the server
    // stages on its own transaction. When staging that notice throws, the
    // entry stays unconsequenced and the next drain delivers it again.

    const fixture = await openFixture();
    const before = warnings("event-notice-failed");
    const stamp = fixture.runtime.stampServerRun.bind(fixture.runtime);
    const refused: string[] = [];
    {
      using _stamp = stub(
        fixture.runtime,
        "stampServerRun",
        (tx, info) => {
          if (info.actionId.startsWith(noticeActionPrefix)) {
            refused.push(info.actionId);
            throw new Error("injected notice staging failure");
          }
          stamp(tx, info);
        },
      );
      fixture.failHandlerRuns(1);
      await fixture.admitOne(0, "unstaged");
      await fixture.drain();
    }
    expect(refused).toEqual([`${noticeActionPrefix}unstaged`]);
    expect(warnings("event-notice-failed")).toBe(before + 1);
    // The notice's mark never reached a wave, so the wave's outcome finds
    // the entry still pending and drains it again.
    expect(fixture.called).toEqual(["A"]);
    expect(fixture.storedLog()).toEqual(["A"]);
    expect(fixture.entry("unstaged")?.consequenced).toBe(true);
    expect(fixture.entry("unstaged")?.error).toBeUndefined();
  });

  it("holds the wave's commit until a staged error notice's commit settles", async () => {
    // The error notice is the event's consequence, so the wave that carries
    // it commits only once the notice's own commit has settled.

    const fixture = await openFixture();
    const stamp = fixture.runtime.stampServerRun.bind(fixture.runtime);
    const release = Promise.withResolvers<void>();
    let gated = 0;
    using _stamp = stub(
      fixture.runtime,
      "stampServerRun",
      (tx, info) => {
        stamp(tx, info);
        if (!info.actionId.startsWith(noticeActionPrefix)) return;
        gated++;
        const commit = tx.commit.bind(tx);
        tx.commit = (options) => {
          const receipt = commit(options);
          return createTransactionCommitReceipt(
            release.promise.then(() => receipt.settled),
            receipt.verdict,
            receipt,
          );
        };
      },
    );
    fixture.failHandlerRuns(1);
    const commitsBefore = fixture.waveCommits;
    await fixture.admitOne(0, "gated-notice");
    await fixture.drain();
    expect(gated).toBe(1);
    expect(fixture.waveCommits).toBe(commitsBefore);
    expect(fixture.entry("gated-notice")?.consequenced).toBeUndefined();

    release.resolve();
    await clock.settle();
    expect(fixture.waveCommits).toBe(commitsBefore + 1);
    expect(fixture.entry("gated-notice")).toMatchObject({
      consequenced: true,
      error: "injected handler failure",
    });
    expect(fixture.called).toEqual([]);
  });

  it("counts a pre-queue deferral streak as stuck once and warns at each doubling of it", async () => {
    // A queue attempt that throws defers the entry ahead of the queue and
    // arms the backstop, whose re-drain defers it again.

    const fixture = await openFixture();
    const before = warnings("event-prequeue-stuck");
    let attempts = 0;
    {
      using _queue = stub(fixture.runtime.scheduler, "queueEvent", () => {
        attempts++;
        throw new Error("injected queue failure");
      });
      await fixture.admitOne(0, "stuck");
      await fixture.drain();
      expect(attempts).toBe(2);
      // Each backstop interval makes the next attempt.
      for (let attempt = 3; attempt < EVENT_PREQUEUE_STUCK_AFTER; attempt++) {
        await clock.tick(rearmMs);
      }
      expect(attempts).toBe(EVENT_PREQUEUE_STUCK_AFTER - 1);
      expect(fixture.stats.events.preQueueDeferralStuck).toBe(0);
      expect(warnings("event-prequeue-stuck")).toBe(before);

      await clock.tick(rearmMs);
      expect(attempts).toBe(EVENT_PREQUEUE_STUCK_AFTER);
      expect(fixture.stats.events.preQueueDeferralStuck).toBe(1);
      expect(warnings("event-prequeue-stuck")).toBe(before + 1);

      for (
        let attempt = EVENT_PREQUEUE_STUCK_AFTER + 1;
        attempt < 2 * EVENT_PREQUEUE_STUCK_AFTER;
        attempt++
      ) {
        await clock.tick(rearmMs);
      }
      expect(attempts).toBe(2 * EVENT_PREQUEUE_STUCK_AFTER - 1);
      expect(fixture.stats.events.preQueueDeferralStuck).toBe(1);
      expect(warnings("event-prequeue-stuck")).toBe(before + 1);

      await clock.tick(rearmMs);
      expect(attempts).toBe(2 * EVENT_PREQUEUE_STUCK_AFTER);
      expect(fixture.stats.events.preQueueDeferralStuck).toBe(1);
      expect(warnings("event-prequeue-stuck")).toBe(before + 2);
    }
    await clock.tick(rearmMs);
    expect(fixture.called).toEqual(["A"]);
    expect(fixture.entry("stuck")?.consequenced).toBe(true);
  });

  describe("a store-time refusal of a served event's write", () => {
    // The wave's commit is refused with a row-label verdict naming the
    // handler's write, which proves the event's consequence did not commit.
    // What the server records for that depends on what the store holds for
    // the entry by then.

    for (
      const stored of ["pending", "consequenced", "absent"] as const
    ) {
      const outcome = stored === "pending"
        ? "records the refusal as needing attention"
        : "records no delivery failure";
      it(`${outcome} when the entry is ${stored} in the store`, async () => {
        const fixture = await openFixture();
        fixture.rejectNextWave((batch) => {
          const failedOperation = batch.operations.findIndex((operation) =>
            operation.op !== "sqlite" && operation.id === logId
          );
          expect(failedOperation).toBeGreaterThanOrEqual(0);
          if (stored !== "pending") {
            fixture.patchStore([{
              op: "patch",
              id: sidecars[0],
              patches: stored === "consequenced"
                ? [{
                  op: "add",
                  path: "/value/entries/0/consequenced",
                  value: true,
                }]
                : [{ op: "remove", path: "/value/entries/0" }],
            }]);
          }
          return {
            name: "RowLabelCommitError",
            message: "injected row-label verdict",
            failedOperation,
          };
        });
        await fixture.admitOne(0, "refused");
        await fixture.drain();

        expect(fixture.storedLog()).toEqual([]);
        if (stored === "pending") {
          expect(fixture.stats.events.needsAttention.total).toBe(1);
          expect(fixture.entry("refused")).toMatchObject({
            consequenced: true,
            status: "needs-attention",
            attention: { phase: "commit-finalization" },
          });
        } else {
          expect(fixture.stats.events.needsAttention.total).toBe(0);
          expect(fixture.stats.events.deliveryDeferralsActive).toBe(0);
          expect(fixture.entry("refused")?.status).toBeUndefined();
          expect(fixture.entry("refused")?.attention).toBeUndefined();
          expect(fixture.entry("refused")?.deliveryDeferral)
            .toBeUndefined();
        }
      });
    }
  });

  it("cancels an armed delivery-failure wake and drops the active checkpoint when it parks", async () => {
    // An entry whose durable checkpoint is in the failed state arms a wake
    // at its budget boundary. Parking ends the tenure that owns both.

    const budgetMs = 4_000;
    const first = await openFixture({ deliveryFailureBudgetMs: budgetMs });
    await first.admitOne(0, "delivery-runnable");
    await first.admitOne(0, "delivery-failed");
    const checkpoint: DeliveryDeferral = {
      phase: "dispatch-load",
      failureClass: "authorization",
      firstFailureAt: Date.now(),
      lastFailureAt: Date.now(),
      accumulatedFailureMs: 0,
      activeFailureStartedAt: Date.now(),
      failureCount: 2,
      state: "failed",
    };
    first.patchStore([{
      op: "patch",
      id: sidecars[0],
      patches: [{
        op: "add",
        path: "/value/entries/1/deliveryDeferral",
        value: checkpoint,
      }],
    }]);
    await settle(first.serving.park("test-park-before-drain"));

    // Activation replays the durable checkpoint and arms its wake.
    const next = await openFixture({ deliveryFailureBudgetMs: budgetMs });
    expect(next.called).toEqual(["A"]);
    expect(next.stats.events.deliveryFailureWakesArmed).toBeGreaterThan(0);
    expect(next.stats.events.deliveryFailuresActive).toBe(1);

    await settle(next.serving.park("test-park"));
    expect(next.stats.events.deliveryFailuresActive).toBe(0);
    expect(next.stats.events.deliveryDeferralsActive).toBe(0);
    await clock.tick(budgetMs);
    expect(next.stats.events.deliveryFailureWakesFired).toBe(0);
    expect(next.entry("delivery-failed")?.consequenced).toBeUndefined();
  });
});
