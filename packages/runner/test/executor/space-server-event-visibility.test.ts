import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import {
  type DeliveryDeferral,
  getServerExecutionConfig,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventsDocValue,
  toDirtyKey,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryServer from "@commonfabric/memory/v2/server";

import {
  SpaceServer,
  type SpaceServerPolicy,
} from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { readWatermarkSeq } from "../../src/executor/watermark.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type { SealedCommitVerdict } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("event visibility owner");
const service = await Identity.fromPassphrase("event visibility service");
const space = owner.did();
const streams = ["a", "b"].map((name) => ({
  id: `of:visibility-stream-${name}` as const,
  path: [],
}));
const sidecars = streams.map((stream) =>
  streamEntriesDocId(stream) as `of:${string}`
);
const logId = "of:visibility-log";

/** Drain transport and scheduler work while positive-delay timers stay fixed. */
async function settle<T>(operation: Promise<T>): Promise<T> {
  await clock.settle();
  return await operation;
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
    const snapshots: {
      watermark: number;
      entries: StreamEventEntry[];
      log: string[];
    }[] = [];
    const called: string[] = [];
    const entries = () =>
      sidecars.flatMap((id) =>
        (Engine.read(engine, { id })?.value as StreamEventsDocValue | undefined)
          ?.entries ?? []
      );
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
      ...(policy === undefined ? {} : { policy }),
      decorateWaveCommitSink: (sink) => ({
        currentHeads: (space, docs) => sink.currentHeads(space, docs),
        concurrentWritePaths: (space, doc, seq) =>
          sink.concurrentWritePaths(space, doc, seq),
        commitWave: async (batch) => {
          const result = await sink.commitWave(batch);
          snapshots.push({
            watermark: readWatermarkSeq(engine),
            entries: entries(),
            log: storedLog(),
          });
          return result;
        },
      }),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
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
            id: sidecars[index] as `of:${string}`,
            scope: "space",
            path: [],
          }).sync();
          runtime.scheduler.addEventHandler((tx) => {
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
    const created = runtime!;
    let localSeq = 0;
    return {
      engine,
      stats,
      snapshots,
      called,
      entries,
      storedLog,
      runtime: created,
      serving: active,
      notices,
      async admit(prefix = "visibility") {
        const admissions = [];
        for (const streamIndex of [0, 1, 0]) {
          admissions.push(
            await settle(server.commitDelegatedAppend({
              targetSpace: space,
              targetStream: sidecars[streamIndex],
              targetStreamLink: streams[streamIndex],
              eventId: `${prefix}-${streamIndex}`,
              payload: {},
              actingPrincipal: owner.did(),
              actingSession: "session:visibility-actor",
              capabilityRef: "cap:visibility",
              sessionId: "session:visibility-delivery",
              localSeq: ++localSeq,
            })),
          );
        }
        return admissions;
      },
      async admitOne(streamIndex: number, eventId: string) {
        return await settle(server.commitDelegatedAppend({
          targetSpace: space,
          targetStream: sidecars[streamIndex],
          targetStreamLink: streams[streamIndex],
          eventId,
          payload: {},
          actingPrincipal: owner.did(),
          actingSession: "session:visibility-actor",
          capabilityRef: "cap:visibility",
          sessionId: "session:visibility-delivery",
          localSeq: ++localSeq,
        }));
      },
      async drain() {
        for (const notice of notices) active.enqueueCommit(notice);
        await clock.settle();
      },
    };
  }

  it("commits admitted events in arrival order before its watermark covers them", async () => {
    // An established watch still holds absence when admission creates its
    // sidecar. Manual fan-out preserves that window until the serving drain
    // publishes and applies the entries. Every durable wave is inspected.
    const fixture = await openFixture();
    const {
      snapshots,
      entries,
      runtime,
      notices,
      serving,
      called,
      storedLog,
      stats,
    } = fixture;
    const admissions = await fixture.admit();
    const provider = runtime.storageManager.open(space);
    const pull = provider.pullToServerHead!.bind(provider);
    using pulls = stub(provider, "pullToServerHead", pull);
    expect(admissions.map((admission) => admission.deduped))
      .toEqual([false, false, true]);
    expect(entries()).toHaveLength(2);
    expect(notices).toHaveLength(2);
    expect(runtime).toBeDefined();
    for (const id of sidecars) {
      expect(
        runtime!.getCellFromLink({
          space,
          id: id as `of:${string}`,
          scope: "space",
          path: [],
        }).get(),
      ).toBeUndefined();
    }
    const before = snapshots.length;
    for (const notice of notices) serving.enqueueCommit(notice);
    await clock.settle();
    const eventWaves = snapshots.slice(before);
    expect(eventWaves.length).toBeGreaterThan(0);
    for (const wave of eventWaves) {
      const coveredPending = wave.entries.filter((entry) =>
        entry.consequenced !== true && typeof entry.seq === "number" &&
        entry.seq <= wave.watermark
      );
      expect(coveredPending).toEqual([]);
    }
    expect(eventWaves[0].log).toEqual(["A", "B"]);
    expect(pulls.calls).toHaveLength(1);
    expect(stats.events.visibilityBarriers).toBe(1);
    expect(stats.events.visibilityRecoveries).toBe(1);
    expect(stats.events.visibilityDeferrals).toBe(0);
    expect(stats.events.deferredRescansArmed).toBe(0);
    expect(stats.events.deferredRescansFired).toBe(0);
    expect(called).toEqual(["A", "B"]);
    expect(storedLog()).toEqual(["A", "B"]);
    expect(entries().every((entry) => entry.consequenced === true)).toBe(true);
    expect(stats.wavesBudgetExhausted).toBe(0);
    await clock.tick(250);
    expect(called).toEqual(["A", "B"]);
    expect(storedLog()).toEqual(["A", "B"]);
  });

  for (const failure of ["publication", "response"] as const) {
    it(`keeps the watermark below unavailable events after a ${failure} failure`, async () => {
      const fixture = await openFixture();
      await fixture.admit();
      const provider = fixture.runtime.storageManager.open(space);
      const flush = server.flushSessions.bind(server);
      const pull = provider.pullToServerHead!.bind(provider);
      let failures = 0;
      using _flush = stub(server, "flushSessions", (spaces) => {
        if (
          failure === "publication" && spaces !== undefined && failures === 0
        ) {
          failures++;
          return Promise.reject(new Error("injected publication failure"));
        }
        return flush(spaces);
      });
      using _pull = stub(provider, "pullToServerHead", () => {
        if (failure === "response" && failures === 0) {
          failures++;
          return Promise.reject(new Error("injected response failure"));
        }
        return pull();
      });

      await fixture.drain();
      expect(failures).toBe(1);
      for (const wave of fixture.snapshots) {
        expect(
          wave.entries.filter((entry) =>
            entry.consequenced !== true && typeof entry.seq === "number" &&
            entry.seq <= wave.watermark
          ),
        ).toEqual([]);
      }
      expect(fixture.called).toEqual([]);
      expect(fixture.stats.events.visibilityBarriers).toBe(1);
      expect(fixture.stats.events.visibilityRecoveries).toBe(0);
      expect(fixture.stats.events.visibilityDeferrals).toBe(1);
      expect(fixture.stats.events.deferredRescansArmed).toBe(1);
      expect(fixture.stats.events.deferredRescansFired).toBe(0);
      expect(readWatermarkSeq(fixture.engine)).toBe(1);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([false, false]);
      // The wave's settle publishes the input even after the preflight failed.
      // Only the next actual event scan can establish consequence coverage.
      expect(provider.replica.getDocument(sidecars[0])?.value).toBeDefined();

      await clock.tick(250);
      expect(fixture.stats.events.deferredRescansFired).toBe(1);
      expect(fixture.called).toEqual(["A", "B"]);
      expect(fixture.storedLog()).toEqual(["A", "B"]);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
      for (const wave of fixture.snapshots) {
        expect(
          wave.entries.filter((entry) =>
            entry.consequenced !== true && typeof entry.seq === "number" &&
            entry.seq <= wave.watermark
          ),
        ).toEqual([]);
      }
    });
  }

  describe("the deferral backstop", () => {
    // Both cases fail the same drain pass at the same point: the queue attempt
    // for an admitted event throws, and the pass defers the entry rather than
    // consequencing it. What differs between them is whether the serving
    // tenure is still running when the deferral lands.

    it("fires a re-drain after a queue-time failure", async () => {
      const fixture = await openFixture();
      await fixture.admit();
      const scheduler = fixture.runtime.scheduler;
      using queued = stub(scheduler, "queueEvent", (): never => {
        throw new Error("injected queue failure");
      });

      await fixture.drain();
      expect(queued.calls).toHaveLength(2);
      expect(fixture.stats.events.deferredRescansArmed).toBe(1);
      expect(fixture.stats.events.deferredRescansFired).toBe(0);

      await clock.tick(250);
      expect(fixture.stats.events.deferredRescansFired).toBe(1);
      expect(queued.calls).toHaveLength(3);
    });

    it("arms nothing once the tenure has parked", async () => {
      const fixture = await openFixture();
      await fixture.admit();
      const scheduler = fixture.runtime.scheduler;
      using queued = stub(scheduler, "queueEvent", (): never => {
        // A park clears the backstop timer and the renew interval up front,
        // then awaits the seal chain and the runtime's disposal. The pass runs
        // on through those awaits, so the deferral below lands on a tenure
        // that has already released every timer it owns.
        void fixture.serving.park("test-park-mid-drain");
        throw new Error("injected queue failure");
      });

      // The tick comes before the assertions: a backstop armed here is one
      // nothing clears, and leaving it pending for the next case to fire
      // reports one failure as two.
      await fixture.drain();
      await clock.tick(250);
      expect(fixture.serving.active).toBe(false);
      expect(queued.calls).toHaveLength(1);
      expect(fixture.stats.events.deferredRescansArmed).toBe(0);
      expect(fixture.stats.events.deferredRescansFired).toBe(0);
      expect(fixture.called).toEqual([]);
    });

    it("leaves the entries of a parked pass to the next activation", async () => {
      const fixture = await openFixture();
      await fixture.admit();
      const scheduler = fixture.runtime.scheduler;
      {
        using _queued = stub(scheduler, "queueEvent", (): never => {
          void fixture.serving.park("test-park-mid-drain");
          throw new Error("injected queue failure");
        });
        await fixture.drain();
      }
      await settle(fixture.serving.park("test-park-await"));
      // Past the backstop boundary with the space parked, so what the next
      // tenure processes is what its own activation scan found.
      await clock.tick(250);
      expect(fixture.called).toEqual([]);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([false, false]);

      const next = await openFixture();
      await next.drain();
      expect(next.called).toEqual(["A", "B"]);
      expect(next.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
    });
  });

  it("processes a pending legacy entry after sequenced arrivals", async () => {
    const fixture = await openFixture();
    await fixture.admit();
    // Pending legacy rows retain their event identity without an admission
    // sequence. The durable consequence must retire them after modern rows.
    Engine.applyCommit(fixture.engine, {
      space,
      sessionId: "visibility-legacy-pending",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecars[0],
          patches: [{ op: "remove", path: "/value/entries/0/seq" }],
        }],
      },
    });
    expect(fixture.entries()[0].seq).toBeUndefined();
    server.markSpaceDirty(space, [toDirtyKey(sidecars[0])]);
    await fixture.drain();
    expect(fixture.called).toEqual(["B", "A"]);
    expect(fixture.storedLog()).toEqual(["B", "A"]);
    expect(fixture.entries().map((entry) => entry.consequenced)).toEqual([
      true,
      true,
    ]);
    expect(Engine.selectPendingStreamEventDocs(fixture.engine)).toEqual([]);
    await fixture.drain();
    expect(fixture.called).toEqual(["B", "A"]);
  });

  it("processes a re-admission after a consequenced legacy entry with no sequence", async () => {
    const fixture = await openFixture();
    await fixture.admit();
    await fixture.drain();
    expect(fixture.called).toEqual(["A", "B"]);
    // Legacy consumed history holds the same IDs without a sequence. New
    // admission stamps a distinct sequence, which identifies the live slot.
    Engine.applyCommit(fixture.engine, {
      space,
      sessionId: "visibility-legacy-history",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: sidecars.map((id) => ({
          op: "patch",
          id,
          patches: [{ op: "remove", path: "/value/entries/0/seq" }],
        })),
      },
    });
    expect(fixture.entries().map((entry) => entry.seq)).toEqual([
      undefined,
      undefined,
    ]);
    fixture.notices.length = 0;
    await fixture.admit();
    const before = fixture.snapshots.length;
    await fixture.drain();
    expect(fixture.snapshots[before]?.log).toEqual(["A", "B", "A", "B"]);
    expect(fixture.called).toEqual(["A", "B", "A", "B"]);
    expect(fixture.stats.events.skippedIdempotent).toBe(0);
    expect(fixture.entries().map((entry) => entry.consequenced)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("marks the current entry index after consumed history compacts during synchronization", async () => {
    const fixture = await openFixture();
    await fixture.admit();
    await fixture.drain();
    expect(fixture.called).toEqual(["A", "B"]);
    fixture.notices.length = 0;
    await fixture.admit("after-compaction");
    const provider = fixture.runtime.storageManager.open(space);
    const pull = provider.pullToServerHead!.bind(provider);
    using pulls = stub(provider, "pullToServerHead", async () => {
      for (const id of sidecars) {
        const current = Engine.read(fixture.engine, { id })!
          .value as StreamEventsDocValue;
        expect(current.entries).toHaveLength(2);
        expect(current.entries?.[0].consequenced).toBe(true);
      }
      Engine.applyCommit(fixture.engine, {
        space,
        sessionId: "visibility-history-compactor",
        principal: service.did(),
        commitClass: "system",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: sidecars.map((id) => ({
            op: "patch",
            id,
            patches: [{ op: "remove", path: "/value/entries/0" }],
          })),
        },
      });
      server.markSpaceDirty(space, sidecars.map((id) => toDirtyKey(id)));
      await server.flushSessions([space]);
      await pull();
    });
    const before = fixture.snapshots.length;
    await fixture.drain();
    expect(pulls.calls).toHaveLength(1);
    expect(fixture.snapshots[before]?.log).toEqual(["A", "B", "A", "B"]);
    expect(fixture.called).toEqual(["A", "B", "A", "B"]);
    expect(
      fixture.entries().map((entry) => ({
        id: entry.eventId,
        consequenced: entry.consequenced,
      })),
    ).toEqual([
      { id: "after-compaction-0", consequenced: true },
      { id: "after-compaction-1", consequenced: true },
    ]);
  });

  for (
    const phase of [
      "sidecar sync",
      "publication",
      "response",
      "stream document sync",
    ] as const
  ) {
    for (const outcome of ["success", "failure"] as const) {
      it(`leaves events pending when tenure ends during ${phase} ${outcome}`, async () => {
        const fixture = await openFixture();
        await fixture.admit();
        const manager = fixture.runtime.storageManager;
        const provider = manager.open(space);
        let parked: Promise<void> | undefined;
        // A park ends the tenure in its synchronous prefix and only then
        // awaits its seal chain and the runtime's disposal, so the drain
        // pass resumes from this wait inside that window: the tenure is
        // over and the runtime is still alive. Ending the tenure once the
        // pass has already resumed would leave nothing for the pass to
        // notice.
        const endTenure = () => {
          parked = fixture.serving.park("visibility-test");
          if (outcome === "failure") {
            throw new Error(`injected ${phase} failure`);
          }
        };
        const syncCell = manager.syncCell.bind(manager);
        const flush = server.flushSessions.bind(server);
        const pull = provider.pullToServerHead!.bind(provider);
        let sidecarSynced = false;
        using _syncCell = stub(manager, "syncCell", async (cell, ...rest) => {
          const result = await syncCell(cell, ...rest);
          if (parked !== undefined) return result;
          const { id } = cell.getAsNormalizedFullLink();
          if (id === sidecars[0]) {
            sidecarSynced = true;
            if (phase === "sidecar sync") endTenure();
          }
          // The sidecar gate puts this at the drain's own load of the
          // stream document, which the pass reaches per entry.
          if (
            phase === "stream document sync" && sidecarSynced &&
            id === streams[0].id
          ) {
            endTenure();
          }
          return result;
        });
        using _flush = stub(server, "flushSessions", async (spaces) => {
          await flush(spaces);
          if (
            phase === "publication" && spaces !== undefined &&
            parked === undefined
          ) {
            endTenure();
          }
        });
        using _pull = stub(provider, "pullToServerHead", async () => {
          await pull();
          if (phase === "response" && parked === undefined) endTenure();
        });
        await fixture.drain();
        expect(parked, `${phase} must run before teardown`).toBeDefined();
        await settle(parked!);
        await clock.settle();
        expect(fixture.called).toEqual([]);
        expect(fixture.storedLog()).toEqual([]);
        expect(readWatermarkSeq(fixture.engine)).toBe(1);
        expect(fixture.entries().map((entry) => entry.consequenced === true))
          .toEqual([false, false]);
      });
    }
  }

  for (const phase of ["initial sync", "visibility response"] as const) {
    const description = phase === "initial sync"
      ? "skips an entry whose durable consequence arrives during initial sidecar synchronization"
      : "skips an entry whose durable consequence arrives during synchronization";
    it(description, async () => {
      const fixture = await openFixture();
      await fixture.admit();
      const provider = fixture.runtime.storageManager.open(space);
      const pull = provider.pullToServerHead!.bind(provider);
      const consequence = async () => {
        Engine.applyCommit(fixture.engine, {
          space,
          sessionId: "visibility-consequence",
          principal: service.did(),
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: sidecars[0],
              patches: [{
                op: "add",
                path: "/value/entries/0/consequenced",
                value: true,
              }, {
                op: "add",
                path: "/value/eventWatermark",
                value: fixture.entries()[0].seq!,
              }],
            }, {
              op: "set",
              id: logId,
              value: { value: ["A"] },
            }],
          },
        });
        server.markSpaceDirty(
          space,
          [sidecars[0], logId].map((id) => toDirtyKey(id)),
        );
        await server.flushSessions([space]);
        await pull();
      };
      const sync = provider.sync.bind(provider);
      let consumed = false;
      using _sync = stub(provider, "sync", async (uri, ...args) => {
        const result = await sync(uri, ...args);
        if (phase === "initial sync" && uri === sidecars[0] && !consumed) {
          consumed = true;
          await consequence();
        }
        return result;
      });
      using _pull = stub(provider, "pullToServerHead", async () => {
        if (phase === "visibility response" && !consumed) {
          consumed = true;
          await consequence();
        } else {
          await pull();
        }
      });
      await fixture.drain();
      expect(consumed).toBe(true);
      expect(fixture.called).toEqual(["B"]);
      expect(fixture.storedLog()).toEqual(["A", "B"]);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
    });
  }

  for (
    const pending of [
      "unrelated",
      "absent entry",
      "different sequence",
    ] as const
  ) {
    const shadow = pending !== "unrelated";
    it(`completes visibility synchronization with a sealed ${pending} write pending`, async () => {
      const fixture = await openFixture();
      const provider = fixture.runtime.storageManager.open(space);
      await fixture.admit();
      const hidden = pending === "different sequence"
        ? {
          entries: [{
            ...fixture.entries()[0],
            seq: fixture.entries()[0].seq! + 100,
          }],
        }
        : { entries: [] };
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      const sealed = provider.replica.sealNative!(
        {
          operations: [{
            op: "set",
            id: shadow ? sidecars[0] : "of:visibility-unrelated",
            scope: "space",
            type: "application/json",
            value: { value: hidden },
          }],
        },
        undefined,
        verdict.promise,
      );
      let settled = false;
      void sealed.settled.then(() => settled = true);
      const pull = provider.pullToServerHead!.bind(provider);
      let responses = 0;
      using _pull = stub(provider, "pullToServerHead", async () => {
        await pull();
        responses++;
      });
      try {
        await fixture.drain();
        expect(responses).toBe(1);
        expect(settled).toBe(false);
        if (shadow) {
          expect(fixture.called).toEqual([]);
          expect(readWatermarkSeq(fixture.engine)).toBe(1);
          expect(provider.replica.getDocument(sidecars[0])?.value)
            .toEqual(hidden);
          expect(provider.replica.unappliedForeignSeqFloor!())
            .toBe(fixture.entries()[0].seq);
          // Repeated backstop scans cannot claim the still-hidden event.
          await clock.tick(250);
          expect(responses).toBe(2);
          expect(fixture.called).toEqual([]);
          expect(readWatermarkSeq(fixture.engine)).toBe(1);
        } else {
          expect(fixture.called).toEqual(["A", "B"]);
          expect(fixture.storedLog()).toEqual(["A", "B"]);
        }
      } finally {
        verdict.resolve({ withdrawn: { message: "test release" } });
        await settle(sealed.settled);
      }
      if (shadow) await clock.tick(250);
      expect(fixture.called).toEqual(["A", "B"]);
      expect(fixture.storedLog()).toEqual(["A", "B"]);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
    });
  }

  describe("the delivery-failure wake", () => {
    // Each case drains two events on one stream. The first is ordinary and
    // reaches the scheduler; the second carries a durable checkpoint whose
    // failed state holds no retry authority, which is what sends the pass to
    // the wake instead of to a dispatch. What differs between them is which
    // tenure is running when the pass reaches that second entry: the one that
    // admitted it, one that has parked mid-pass, or the one after that.

    const budgetMs = 4_000;

    async function openDeferredFixture() {
      const fixture = await openFixture({ deliveryFailureBudgetMs: budgetMs });
      await fixture.admitOne(0, "delivery-runnable");
      await fixture.admitOne(0, "delivery-failed");
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
      Engine.applyCommit(fixture.engine, {
        space,
        sessionId: "visibility-delivery-checkpoint",
        principal: service.did(),
        commitClass: "system",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: sidecars[0],
            patches: [{
              op: "add",
              path: "/value/entries/1/deliveryDeferral",
              value: checkpoint,
            }],
          }],
        },
      });
      return fixture;
    }

    it("fires at the failed checkpoint's budget boundary", async () => {
      const fixture = await openDeferredFixture();
      await fixture.drain();
      expect(fixture.called).toEqual(["A"]);
      // One timer stands per entry: a pass that re-derives the checkpoint
      // cancels the wake it replaces and arms another. So the armed count
      // reads how many passes reached the entry, which is a number this case
      // has no stake in; the fired count reads the timers.
      expect(fixture.stats.events.deliveryFailureWakesArmed).toBeGreaterThan(0);
      expect(fixture.stats.events.deliveryFailureWakesFired).toBe(0);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, false]);

      await clock.tick(budgetMs);
      expect(fixture.stats.events.deliveryFailureWakesFired).toBe(1);
      // The scan the wake owes finds the budget spent and seals the terminal
      // cover, which is what takes the entry off the park criterion.
      expect(fixture.called).toEqual(["A"]);
      expect(fixture.stats.events.needsAttention.total).toBe(1);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
    });

    it("arms nothing once the tenure has parked", async () => {
      const fixture = await openDeferredFixture();
      const scheduler = fixture.runtime.scheduler;
      using queued = stub(scheduler, "queueEvent", () => {
        // A park clears the wake timers and the renew interval up front, then
        // awaits the seal chain and the runtime's disposal. The pass runs on
        // through those awaits into the next entry, whose checkpoint reaches
        // the arming site on a tenure that has released every timer it owns.
        void fixture.serving.park("test-park-mid-drain");
      });

      // The tick carries the case past the budget boundary before the counters
      // are read, so an absent fire is observed rather than still pending.
      await fixture.drain();
      await clock.tick(budgetMs);
      expect(fixture.serving.active).toBe(false);
      expect(queued.calls).toHaveLength(1);
      expect(fixture.stats.events.deliveryFailureWakesArmed).toBe(0);
      expect(fixture.stats.events.deliveryFailureWakesFired).toBe(0);
      expect(fixture.called).toEqual([]);
      expect(fixture.entries().map((entry) => entry.consequenced === true))
        .toEqual([false, false]);
    });

    it("carries a replayed checkpoint's wake into the next tenure", async () => {
      const first = await openDeferredFixture();
      await settle(first.serving.park("test-park-before-drain"));

      // §6 step 4 replays the durable checkpoint, and the entry's wake stands
      // again with no input of any kind reaching the new tenure. What the
      // count of armings would say here is how many passes re-derived the
      // checkpoint, so the assertions read the one timer that stands.
      const next = await openFixture({ deliveryFailureBudgetMs: budgetMs });
      expect(next.called).toEqual(["A"]);
      expect(next.stats.events.deliveryFailureWakesFired).toBe(0);
      expect(next.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, false]);

      await clock.tick(budgetMs);
      expect(next.stats.events.deliveryFailureWakesFired).toBe(1);
      expect(next.stats.events.needsAttention.total).toBe(1);
      expect(next.entries().map((entry) => entry.consequenced === true))
        .toEqual([true, true]);
    });
  });
});
