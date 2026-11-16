import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  getServerExecutionConfig,
  type PatchOp,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
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
import { sourceDocKey } from "../../src/compilation-cache/cell-cache.ts";
import {
  stampWaveRunContext,
  waveRunContextOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("event drain owner");
const service = await Identity.fromPassphrase("event drain service");
const space = owner.did();
const stream = { id: "of:event-drain-stream" as const, path: [] };
const sidecar = streamEntriesDocId(stream) as `of:${string}`;
const logId = "of:event-drain-log";
const warnings = (key: string): number =>
  getLogger("space-server").countsByKey[key]?.warn ?? 0;

type HeldSinkCall = "commitWave" | "staleReads";

/** Drain transport and scheduler work while positive-delay timers stay fixed. */
async function settle<T>(operation: Promise<T>): Promise<T> {
  await clock.settle();
  return await operation;
}

describe("SpaceServer", () => {
  let server: MemoryServer.Server;
  let servers: SpaceServer[];
  let previousServerExecution: boolean;

  beforeEach(() => {
    localSeq = 0;
    patchSeq = 0;
    previousServerExecution = getServerExecutionConfig();
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    servers = [];
  });

  afterEach(async () => {
    try {
      for (const serving of servers) {
        await settle(serving.park("test-teardown"));
      }
      await settle(server.close());
    } finally {
      setServerExecutionConfig(previousServerExecution);
    }
  });

  let localSeq = 0;
  let patchSeq = 0;

  /** Admits one event on the stream, as a delegated delivery does. */
  const admit = (eventId: string, payload: unknown) =>
    settle(server.commitDelegatedAppend({
      targetSpace: space,
      targetStream: sidecar,
      targetStreamLink: stream,
      eventId,
      payload,
      actingPrincipal: owner.did(),
      actingSession: "session:drain-actor",
      capabilityRef: "cap:drain",
      sessionId: "session:drain-delivery",
      localSeq: ++localSeq,
    }));

  /** Rewrites the stored entries in place with a system commit, as a store
   * holding rows no admission produced would hold them. */
  const patchEntries = async (
    patches: PatchOp[],
  ) => {
    Engine.applyCommit(await server.engineForSpace(space), {
      space,
      sessionId: "session:drain-patch",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: ++patchSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "patch", id: sidecar, patches }],
      },
    });
    server.markSpaceDirty(space, [toDirtyKey(sidecar)]);
  };

  /** Serves `space` with one handler on `stream` that appends each event's
   * `name` to the log document; the entries are read from the store. */
  async function serve(
    options: {
      policy?: SpaceServerPolicy;
      /** Runs on each serving runtime before its tenure begins. */
      prepare?: (runtime: Runtime) => void;
      /** Whether the serving runtime loads the log before its tenure
       * begins, rather than leaving the handler's first read to. */
      loadLog?: boolean;
    } = {},
  ) {
    const { policy, prepare, loadLog = true } = options;
    /** The sink calls held by `holdNext()`: while a method has a gate, its
     * next call waits for the gate before reaching the store. */
    const gates = new Map<HeldSinkCall, Promise<void>>();
    const held = new Map<HeldSinkCall, number>();
    /** Runs once, as the next cycle's settle begins (past its drains). */
    let atSettle: (() => void) | undefined;
    const engine = await server.engineForSpace(space);
    if (Engine.serverSeq(engine) === 0) {
      await settle(
        server.writeDocument(space, SERVER_EXECUTION_WATERMARK_DOC_ID, {
          seq: 1,
        }),
      );
    }
    const stats = emptyServingLoopStats();
    const called: string[] = [];
    const skipped: string[] = [];
    let drainPasses = 0;
    let runtime: Runtime | undefined;
    const serving = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      localSeqRef: { value: 0 },
      stats,
      onDrainInFlightSkip: (eventId) => skipped.push(eventId),
      onEventDrainPass: () => drainPasses++,
      policy: {
        ...policy,
        onFlushDeadline: () => {
          const run = atSettle;
          atSettle = undefined;
          run?.();
        },
      },
      decorateWaveCommitSink: (sink) =>
        new Proxy(sink, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            const call = value.bind(target);
            if (key !== "commitWave" && key !== "staleReads") return call;
            return async (...args: unknown[]) => {
              const gate = gates.get(key);
              gates.delete(key);
              if (gate !== undefined) {
                held.set(key, (held.get(key) ?? 0) + 1);
                await gate;
              }
              return await call(...args);
            };
          },
        }),
      createRuntime: async ({ storeReadThrough }) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        // Installed ahead of the syncs below, as a serving factory does, so
        // that they read the store and no session watches the space.
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
        if (loadLog) await log.sync();
        await runtime.getCellFromLink({ space, ...stream, scope: "space" })
          .sync();
        await runtime.getCellFromLink({
          space,
          id: sidecar,
          scope: "space",
          path: [],
        }).sync();
        runtime.scheduler.addEventHandler((tx, event) => {
          const name = (event as { name?: string } | undefined)?.name ?? "?";
          called.push(name);
          const cell = log.withTx(tx);
          cell.set([...(cell.get() ?? []), name]);
        }, { space, ...stream, scope: "space" });
        prepare?.(runtime);
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
    servers.push(serving);
    const holdNext = (call: HeldSinkCall) => {
      const gate = Promise.withResolvers<void>();
      gates.set(call, gate.promise);
      return gate.resolve;
    };
    const notices: MemoryServer.AdmittedCommitNotice[] = [];
    server.setServerExecutionObserver({
      commitAdmitted: (notice) => notices.push(notice),
    });
    return {
      engine,
      stats,
      called,
      skipped,
      serving,
      notices,
      runtime: () => runtime!,
      /** Holds the next wave commit until the returned release is called. */
      holdNextCommit: () => holdNext("commitWave"),
      heldCommits: () => held.get("commitWave") ?? 0,
      /** Holds the next stale-read check until the returned release is
       * called. */
      holdNextStaleReadCheck: () => holdNext("staleReads"),
      heldStaleReadChecks: () => held.get("staleReads") ?? 0,
      drainPasses: () => drainPasses,
      /** Hands the server every notice admitted so far once the next
       * cycle's settle begins, so that the cycle after it drains them. */
      feedAtNextSettle() {
        atSettle = () => {
          for (const notice of notices.splice(0)) {
            serving.enqueueCommit(notice);
          }
        };
      },
      entries: () =>
        (Engine.read(engine, { id: sidecar })?.value as
          | StreamEventsDocValue
          | undefined)?.entries ?? [],
      storedLog: () =>
        (Engine.read(engine, { id: logId })?.value as string[] | undefined) ??
          [],
      async activate() {
        expect(await settle(serving.activate())).toBe(true);
        await clock.settle();
      },
      /** Hands the server every notice admitted since the last call. */
      async feed() {
        for (const notice of notices.splice(0)) serving.enqueueCommit(notice);
        await clock.settle();
      },
    };
  }

  describe("the served dispatch of a stored event", () => {
    it("re-mints an entry's runtime-injected keys for the dispatch, and treats malformed ones as absent", async () => {
      const dispatched: Array<readonly string[] | undefined> = [];
      const fixture = await serve({
        prepare: (runtime) => {
          const scheduler = runtime.scheduler;
          const queueEvent = scheduler.queueEvent.bind(scheduler);
          scheduler.queueEvent = (...args) => {
            dispatched.push(args[5]?.runtimeInjectedEventKeys);
            return queueEvent(...args);
          };
        },
      });
      await admit("well-formed", { name: "W" });
      await admit("malformed", { name: "M" });
      await patchEntries([
        {
          op: "add",
          path: "/value/entries/0/runtimeInjectedEventKeys",
          value: ["injected"],
        },
        {
          op: "add",
          path: "/value/entries/1/runtimeInjectedEventKeys",
          value: "injected",
        },
      ]);
      const malformedBefore = warnings("event-malformed-injected-keys");
      await fixture.activate();

      expect(fixture.called).toEqual(["W", "M"]);
      expect(dispatched).toEqual([["injected"], undefined]);
      expect(warnings("event-malformed-injected-keys")).toBe(
        malformedBefore + 1,
      );
      expect(fixture.entries().map((entry) => entry.consequenced)).toEqual([
        true,
        true,
      ]);
    });
  });

  describe("a replayed program-unavailable checkpoint", () => {
    // A tenure found the event's program closure missing past its grace and
    // left the failure on the entry. The next tenure replays it at
    // activation, and retries the event once the closure is in the space.

    const closureId = "of:drain-program-closure";
    const now = 1_000;
    const checkpoint = {
      phase: "dispatch-load",
      failureClass: "program-unavailable",
      firstFailureAt: now,
      lastFailureAt: now,
      accumulatedFailureMs: 0,
      failureCount: 1,
      activeFailureStartedAt: now,
      state: "failed",
      recoveryEpoch: `program-closure:${closureId}`,
    };
    const replay = async () => {
      const fixture = await serve({
        policy: { deliveryFailureNow: () => now },
      });
      await admit("waiting", { name: "W" });
      // The serving wave that wrote the checkpoint wrote the stream's
      // processing watermark beside it.
      await patchEntries([
        {
          op: "add",
          path: "/value/entries/0/deliveryDeferral",
          value: checkpoint,
        },
        { op: "add", path: "/value/eventWatermark", value: 0 },
      ]);
      return fixture;
    };

    it("waits for the closure to arrive, and delivers the event once it does", async () => {
      const fixture = await replay();
      await fixture.activate();
      await clock.tick(1_000);
      expect(fixture.called).toEqual([]);
      expect(fixture.entries()[0].deliveryDeferral).toEqual(checkpoint);

      await settle(server.writeDocument(space, closureId, { closure: true }));
      await fixture.feed();
      expect(fixture.called).toEqual(["W"]);
      expect(fixture.entries()[0].consequenced).toBe(true);
    });

    it("delivers the event at activation when the closure arrived while no tenure watched", async () => {
      const fixture = await replay();
      await settle(server.writeDocument(space, closureId, { closure: true }));
      await fixture.activate();
      expect(fixture.called).toEqual(["W"]);
      expect(fixture.entries()[0].consequenced).toBe(true);
    });
  });

  describe("a delivery checkpoint's bookkeeping wave", () => {
    // The event's failed checkpoint is durable from an earlier tenure, as in
    // the replay cases above. Each case holds one wave's commit to place a
    // checkpoint or notice write in a wave other than the one it reconciles.

    const closureId = "of:drain-checkpoint-closure";
    let now: number;
    const failed = () => ({
      phase: "dispatch-load",
      failureClass: "program-unavailable",
      firstFailureAt: 1_000,
      lastFailureAt: 1_000,
      accumulatedFailureMs: 0,
      failureCount: 1,
      activeFailureStartedAt: 1_000,
      state: "failed",
      recoveryEpoch: `program-closure:${closureId}`,
    });
    const replay = async (policy: SpaceServerPolicy = {}) => {
      now = 1_000;
      const fixture = await serve({
        policy: { deliveryFailureNow: () => now, ...policy },
      });
      await admit("waiting", { name: "W" });
      await patchEntries([
        {
          op: "add",
          path: "/value/entries/0/deliveryDeferral",
          value: failed(),
        },
        { op: "add", path: "/value/eventWatermark", value: 0 },
      ]);
      await fixture.activate();
      return fixture;
    };
    /** Seals one derivation write through the serving runtime, so that a
     * wave has something to commit; resolves once the write has sealed. */
    const sealProbe = async (runtime: Runtime) => {
      const probe = runtime.getCellFromLink<number>({
        space,
        id: "of:drain-checkpoint-probe",
        scope: "space",
        path: [],
      });
      await settle(probe.sync());
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId: "test/probe", kind: "derivation" });
      probe.withTx(tx).set((probe.get() ?? 0) + 1);
      return tx.commit().settled;
    };

    it("holds an event behind its retry's unconfirmed checkpoint, and confirms the checkpoint from its own wave", async () => {
      const fixture = await replay({ overlapWaveCommit: true });
      const observed = warnings("event-delivery-recovery-observed");
      const writeFailures = warnings("event-delivery-checkpoint-write-failed");
      const releaseFirst = fixture.holdNextCommit();
      // The closure's arrival reaches the loop after one cycle's drains, and
      // that cycle has a wave to commit, so the event's retry is staged by
      // the next cycle while that wave's commit is still held.
      await settle(server.writeDocument(space, closureId, { closure: true }));
      fixture.feedAtNextSettle();
      expect((await settle(sealProbe(fixture.runtime()))).error)
        .toBeUndefined();
      expect(fixture.heldCommits()).toBe(1);
      expect(warnings("event-delivery-recovery-observed")).toBe(observed + 1);
      expect(fixture.entries()[0].deliveryDeferral?.state).toBe("failed");

      // The retry's checkpoint commits in the wave after; held too, it stays
      // unconfirmed while new input drains the event again.
      const releaseSecond = fixture.holdNextCommit();
      await settle(server.writeDocument(space, "of:drain-input", { n: 1 }));
      await fixture.feed();
      releaseFirst();
      await clock.settle();
      expect(fixture.heldCommits()).toBe(2);
      expect(fixture.called).toEqual([]);

      releaseSecond();
      await clock.settle();
      expect(fixture.called).toEqual(["W"]);
      expect(fixture.entries()[0].consequenced).toBe(true);
      expect(warnings("event-delivery-recovery-observed")).toBe(observed + 1);
      expect(fixture.stats.events.deliveryCheckpointWriteFailures).toBe(0);
      expect(warnings("event-delivery-checkpoint-write-failed")).toBe(
        writeFailures,
      );
    });

    it("confirms an attention notice staged while the previous wave's commit is in flight from its own wave", async () => {
      const fixture = await replay({ overlapWaveCommit: true });
      const release = fixture.holdNextCommit();
      // The failed-state budget runs out, and new input re-drains the event.
      // The input reaches the loop after one cycle's drains, and that cycle
      // has a wave to commit, so the event's notice is staged by the next
      // cycle while that wave's commit is still held.
      now += 60_000;
      await settle(server.writeDocument(space, "of:drain-input", { n: 1 }));
      fixture.feedAtNextSettle();
      expect((await settle(sealProbe(fixture.runtime()))).error)
        .toBeUndefined();
      expect(fixture.heldCommits()).toBe(1);
      expect(fixture.entries()[0].status).toBeUndefined();

      release();
      await clock.settle();
      expect(fixture.called).toEqual([]);
      expect(fixture.entries()[0]).toMatchObject({
        consequenced: true,
        status: "needs-attention",
      });
      expect(fixture.stats.events.needsAttention.total).toBe(1);
      expect(fixture.stats.events.needsAttentionSealFailures).toBe(0);
    });

    it("drops a confirmed checkpoint whose event a concurrent commit consequenced", async () => {
      const fixture = await replay();
      const release = fixture.holdNextCommit();
      await settle(server.writeDocument(space, closureId, { closure: true }));
      await fixture.feed();
      expect(fixture.heldCommits()).toBe(1);
      expect(fixture.stats.events.deliveryDeferralsActive).toBe(1);

      await patchEntries([{
        op: "add",
        path: "/value/entries/0/consequenced",
        value: true,
      }]);
      release();
      await clock.settle();
      expect(fixture.called).toEqual([]);
      expect(fixture.stats.events.deliveryDeferralsActive).toBe(0);
      expect(fixture.stats.events.deliveryCheckpointWriteFailures).toBe(0);
    });
  });

  describe("a served event's delivery failures", () => {
    // The scheduler is handed each queued copy and keeps it, and the test
    // reports the copy's failure through the callback the drain handed over
    // with it, as the dispatch reports a failed commit preparation.

    type QueueArgs = Parameters<Runtime["scheduler"]["queueEvent"]>;
    const holdQueued = (held: QueueArgs[]) => (runtime: Runtime) => {
      runtime.scheduler.queueEvent = (...args) => {
        held.push(args);
      };
    };
    const fail = (copy: QueueArgs, failureClass: "timeout" | "connection") =>
      copy[5]!.served!.onFailure!({
        kind: "deferred",
        cause: "delivery-failure",
        role: "failed-head",
        phase: "commit-preparation",
        failure: {
          failureClass,
          recoveryEpoch: `test:${failureClass}`,
          permanentEvidence: false,
        },
      });

    it("reports a failure whose class differs from the event's last one, and records the new class", async () => {
      const held: QueueArgs[] = [];
      const fixture = await serve({
        policy: { deliveryFailureNow: () => 1_000 },
        prepare: holdQueued(held),
      });
      await admit("failing", { name: "F" });
      await fixture.activate();
      expect(held).toHaveLength(1);
      const deferred = warnings("event-delivery-deferred");
      const changed = warnings("event-delivery-class-changed");

      fail(held[0], "timeout");
      await clock.settle();
      expect(warnings("event-delivery-deferred")).toBe(deferred + 1);
      expect(warnings("event-delivery-class-changed")).toBe(changed);
      expect(fixture.entries()[0].deliveryDeferral).toMatchObject({
        failureClass: "timeout",
        failureCount: 1,
      });
      // A first timeout earns one clean retry.
      expect(held).toHaveLength(2);

      fail(held[1], "connection");
      await clock.settle();
      expect(warnings("event-delivery-deferred")).toBe(deferred + 1);
      expect(warnings("event-delivery-class-changed")).toBe(changed + 1);
      expect(fixture.entries()[0].deliveryDeferral).toMatchObject({
        failureClass: "connection",
        failureCount: 2,
      });
      expect(fixture.called).toEqual([]);
    });

    describe("whose piece's program closure is not in the space", () => {
      const graceMs = 4_321;
      const patternIdentity = "drain-test-pattern";
      const unloadable = (copy: QueueArgs) =>
        copy[5]!.served!.onFailure!({
          kind: "deferred",
          cause: "pattern-unloadable",
          patternIdentity,
          message: "pattern could not be loaded",
        });
      const graceFixture = async (held: QueueArgs[]) => {
        const fixture = await serve({
          policy: {
            deliveryFailureNow: () => 1_000,
            programClosureGraceMs: graceMs,
          },
          prepare: holdQueued(held),
        });
        await admit("unloadable", { name: "U" });
        await fixture.activate();
        expect(held).toHaveLength(1);
        return fixture;
      };

      it("drains the event again once its grace runs out, and records the closure's absence as its delivery failure", async () => {
        const held: QueueArgs[] = [];
        const fixture = await graceFixture(held);
        unloadable(held[0]);
        await clock.settle();
        expect(fixture.stats.events.programWaitDeferrals).toBe(1);
        expect(fixture.entries()[0].deliveryDeferral).toBeUndefined();
        await clock.tick(graceMs - 1);
        expect(held).toHaveLength(1);

        await clock.tick(1);
        expect(held).toHaveLength(2);
        unloadable(held[1]);
        await clock.settle();
        expect(fixture.stats.events.programWaitDeferrals).toBe(1);
        const closureId = fixture.runtime().getCell(
          space,
          sourceDocKey(patternIdentity),
        ).getAsNormalizedFullLink().id;
        expect(fixture.entries()[0].deliveryDeferral).toMatchObject({
          phase: "dispatch-load",
          failureClass: "program-unavailable",
          recoveryEpoch: `program-closure:${closureId}`,
        });
        expect(fixture.called).toEqual([]);
      });

      it("drains nothing when its grace runs out on an event that has its consequence by then", async () => {
        const held: QueueArgs[] = [];
        const fixture = await graceFixture(held);
        unloadable(held[0]);
        await clock.settle();
        expect(fixture.stats.events.programWaitDeferrals).toBe(1);
        await patchEntries([{
          op: "add",
          path: "/value/entries/0/consequenced",
          value: true,
        }]);
        await clock.settle();
        const passes = fixture.drainPasses();

        await clock.tick(graceMs);
        expect(fixture.drainPasses()).toBe(passes);
        expect(held).toHaveLength(1);
      });

      it("arms no grace on a tenure that has parked", async () => {
        const held: QueueArgs[] = [];
        const fixture = await graceFixture(held);
        using timers = spy(globalThis, "setTimeout");
        const parking = fixture.serving.park("test-park");
        // The dispatch reports while the park disposes the runtime.
        unloadable(held[0]);
        await settle(parking);
        expect(fixture.stats.events.programWaitDeferrals).toBe(1);
        expect(timers.calls.filter((call) => call.args[1] === graceMs))
          .toEqual([]);
      });
    });

    /** Serves `space` holding every dispatch in `held`, and refusing the
     * event "failing"'s checkpoint write once `sealed` resolves. */
    const refusingCheckpoint = (
      held: QueueArgs[],
      sealed: Promise<void>,
    ) =>
      serve({
        policy: { deliveryFailureNow: () => 1_000 },
        prepare: (runtime) => {
          holdQueued(held)(runtime);
          const edit = runtime.edit.bind(runtime);
          runtime.edit = (options) => {
            const tx = edit(options);
            const commit = tx.commit.bind(tx);
            tx.commit = () => {
              // Only the event's checkpoint write is refused, by the
              // transaction's name: the loop's own bookkeeping commits.
              if (
                waveRunContextOf(tx)?.actionId !==
                  "server-execution/event-delivery-checkpoint:failing"
              ) {
                return commit();
              }
              tx.abort();
              return createTransactionCommitReceipt(
                sealed.then(() => ({
                  error: {
                    name: "StorageTransactionAborted" as const,
                    message: "checkpoint seal refused",
                    reason: new Error("checkpoint seal refused"),
                  },
                })),
              );
            };
            return tx;
          };
        },
      });

    for (const parked of [false, true]) {
      it(
        `${
          parked ? "ignores" : "records"
        } a checkpoint write that fails to seal ${
          parked ? "after the tenure parked" : "while the tenure holds it"
        }`,
        async () => {
          const held: QueueArgs[] = [];
          const sealed = Promise.withResolvers<void>();
          const fixture = await refusingCheckpoint(held, sealed.promise);
          await admit("failing", { name: "F" });
          await fixture.activate();
          expect(held).toHaveLength(1);
          const writeFailures = warnings(
            "event-delivery-checkpoint-write-failed",
          );

          fail(held[0], "timeout");
          if (parked) await settle(fixture.serving.park("test-park"));
          sealed.resolve();
          await clock.settle();
          expect(fixture.stats.events.deliveryCheckpointWriteFailures).toBe(
            parked ? 0 : 1,
          );
          expect(warnings("event-delivery-checkpoint-write-failed")).toBe(
            writeFailures + (parked ? 0 : 1),
          );
        },
      );
    }

    it("derives an event whose checkpoint write failed again only on input newer than the failure", async () => {
      const held: QueueArgs[] = [];
      const sealed = Promise.withResolvers<void>();
      const fixture = await refusingCheckpoint(held, sealed.promise);
      await admit("failing", { name: "F" });
      await fixture.activate();
      expect(held).toHaveLength(1);
      await settle(server.writeDocument(space, "of:drain-older-input", {}));
      const older = fixture.notices.splice(0);
      await settle(server.writeDocument(space, "of:drain-head-input", {}));
      await fixture.feed();

      fail(held[0], "timeout");
      sealed.resolve();
      await clock.settle();
      expect(fixture.stats.events.deliveryCheckpointWriteFailures).toBe(1);

      for (const notice of older) fixture.serving.enqueueCommit(notice);
      await clock.settle();
      expect(held).toHaveLength(1);

      await settle(server.writeDocument(space, "of:drain-newer-input", {}));
      await fixture.feed();
      expect(held).toHaveLength(2);
    });
  });

  describe("the catch-up gate of an event requeued for a stale read", () => {
    // The event's handler reads the log and writes it. A rival commit to the
    // log lands while the handler's wave is being committed, so the wave
    // requeues the event, and its replay waits until the replica has taken
    // the rival's commit.

    const requeue = async (options: Parameters<typeof serve>[0] = {}) => {
      const fixture = await serve(options);
      await fixture.activate();
      const release = fixture.holdNextStaleReadCheck();
      await admit("stale", { name: "S" });
      await fixture.feed();
      expect(fixture.heldStaleReadChecks()).toBe(1);
      expect(fixture.called).toEqual(["S"]);
      await settle(server.writeDocument(space, logId, ["rival"]));
      return {
        fixture,
        /** Lets the wave's stale-read check see the rival's commit. */
        async requeue() {
          release();
          await clock.settle();
          expect(fixture.stats.events.staleReadRequeues).toBe(1);
        },
      };
    };

    for (const storeReadThrough of [false, true]) {
      it(
        `replays the event over the rival's commit${
          storeReadThrough ? " under the store read-through" : ""
        }`,
        async () => {
          const { fixture, requeue: requeued } = await requeue({
            policy: { storeReadThrough },
          });
          await requeued();
          expect(fixture.called).toEqual(["S", "S"]);
          expect(fixture.storedLog()).toEqual(["rival", "S"]);
          expect(fixture.entries()[0].consequenced).toBe(true);
        },
      );
    }

    type Failing = { failing: boolean; failed: number };

    /** Fails the serving runtime's loads of the log, and its responses to
     * the space's published frames, while each is set to fail; and runs
     * `during` inside each such call, ahead of its outcome. */
    const failCatchUp = (
      loads: Failing,
      responses: Failing,
      during: { load?: () => void; response?: () => void } = {},
    ) =>
    (runtime: Runtime) => {
      const manager = runtime.storageManager;
      const syncCell = manager.syncCell.bind(manager);
      manager.syncCell = (cell, options) => {
        if (cell.getAsNormalizedFullLink().id !== logId) {
          return syncCell(cell, options);
        }
        during.load?.();
        if (loads.failing) {
          loads.failed++;
          return Promise.reject(new Error("injected log load failure"));
        }
        return syncCell(cell, options);
      };
      const provider = manager.open(space);
      const pull = provider.pullToServerHead!.bind(provider);
      provider.pullToServerHead = () => {
        during.response?.();
        if (responses.failing) {
          responses.failing = false;
          responses.failed++;
          return Promise.reject(new Error("injected response failure"));
        }
        return pull();
      };
    };

    it("holds the event while its replica cannot take the rival's commit, and replays it on the rescan once it can", async () => {
      const loads = { failing: false, failed: 0 };
      const responses = { failing: false, failed: 0 };
      const { fixture, requeue: requeued } = await requeue({
        loadLog: false,
        prepare: failCatchUp(loads, responses),
      });
      const syncFailures = warnings("event-catch-up-sync-failed");
      const loadFailures = warnings("event-catch-up-load-failed");
      responses.failing = true;
      loads.failing = true;
      await requeued();
      expect(responses.failed).toBe(1);
      expect(warnings("event-catch-up-sync-failed")).toBe(syncFailures + 1);
      expect(loads.failed).toBe(1);
      expect(warnings("event-catch-up-load-failed")).toBe(loadFailures + 1);
      expect(fixture.stats.events.deferredRescansArmed).toBe(1);
      expect(fixture.called).toEqual(["S"]);
      expect(fixture.entries()[0].consequenced).not.toBe(true);

      loads.failing = false;
      await clock.tick(250);
      expect(fixture.stats.events.deferredRescansFired).toBe(1);
      expect(fixture.called).toEqual(["S", "S"]);
      expect(fixture.storedLog()).toEqual(["rival", "S"]);
    });

    for (
      const where of [
        "publication",
        "response",
        "failed response",
        "load",
        "failed load",
      ] as const
    ) {
      it(`ends the pass without deferring when the tenure parks during the catch-up's ${where}`, async () => {
        const loads = { failing: false, failed: 0 };
        const responses = { failing: false, failed: 0 };
        let parking: Promise<void> | undefined;
        let armed = false;
        // Parks on the first such call the event drain makes once armed: the
        // drain makes none of them outside the catch-up for an event whose
        // view is current.
        const park = () => {
          if (armed && new Error().stack?.includes("drainStreamEvents")) {
            parking ??= fixture.serving.park("test-park");
          }
        };
        const { fixture, requeue: requeued } = await requeue({
          loadLog: false,
          prepare: failCatchUp(loads, responses, {
            ...(where.endsWith("load") ? { load: park } : {}),
            ...(where.endsWith("response") ? { response: park } : {}),
          }),
        });
        const flush = server.flushSessions.bind(server);
        using _flush = stub(server, "flushSessions", (spaces) => {
          if (where === "publication") park();
          return flush(spaces);
        });
        const before = {
          sync: warnings("event-catch-up-sync-failed"),
          load: warnings("event-catch-up-load-failed"),
        };
        // The loads reach the log only through the catch-up, behind a
        // response that fails.
        responses.failing = where !== "publication" && where !== "response";
        loads.failing = where === "failed load";
        armed = true;
        await requeued();
        await settle(parking!);
        expect(fixture.serving.active).toBe(false);
        expect(fixture.called).toEqual(["S"]);
        expect(fixture.stats.events.deferredRescansArmed).toBe(0);
        expect(warnings("event-catch-up-sync-failed")).toBe(
          before.sync + (where.endsWith("load") ? 1 : 0),
        );
        expect(warnings("event-catch-up-load-failed")).toBe(before.load);
      });
    }
  });

  describe("the drain's read of a sidecar", () => {
    it("passes over the entries of a sidecar deleted while the drain synced it, and delivers what is appended after", async () => {
      // The drain lists the pending entries, syncs their sidecar, and then
      // reads the stored log, which a commit can delete in between.
      let deleteOnSync = false;
      const fixture = await serve({
        prepare: (runtime) => {
          const manager = runtime.storageManager;
          const syncCell = manager.syncCell.bind(manager);
          manager.syncCell = async (cell, options) => {
            const synced = await syncCell(cell, options);
            if (deleteOnSync && cell.getAsNormalizedFullLink().id === sidecar) {
              deleteOnSync = false;
              Engine.applyCommit(await server.engineForSpace(space), {
                space,
                sessionId: "session:drain-delete",
                principal: service.did(),
                commitClass: "system",
                commit: {
                  localSeq: 1,
                  reads: { confirmed: [], pending: [] },
                  operations: [{ op: "delete", id: sidecar }],
                },
              });
            }
            return synced;
          };
        },
      });
      await admit("vanishing", { name: "V" });
      deleteOnSync = true;
      await fixture.activate();
      expect(deleteOnSync).toBe(false);
      expect(fixture.called).toEqual([]);
      expect(fixture.entries()).toEqual([]);

      await admit("after", { name: "A" });
      await fixture.feed();
      expect(fixture.called).toEqual(["A"]);
      expect(fixture.storedLog()).toEqual(["A"]);
    });
  });

  describe("the drain's in-flight guard", () => {
    // The scheduler is handed each queued copy and keeps it: nothing runs,
    // so the guard stays held until the test ends a copy through the final
    // callback the drain handed over with it.

    type QueueArgs = Parameters<Runtime["scheduler"]["queueEvent"]>;
    const holdQueued =
      (held: { eventId?: string; args: QueueArgs }[]) => (runtime: Runtime) => {
        runtime.scheduler.queueEvent = (...args) => {
          held.push({ eventId: args[5]?.eventId, args });
        };
      };
    /** Ends `copy` on a transaction that commits nothing, as a run aborted
     * before its seal ends it. */
    const end = (runtime: Runtime, copy: { args: QueueArgs }) => {
      const tx = runtime.edit();
      copy.args[3]!(tx);
      tx.abort();
    };

    it("queues an entry again once its queued copy ends without reaching a wave", async () => {
      const held: { eventId?: string; args: QueueArgs }[] = [];
      const fixture = await serve({ prepare: holdQueued(held) });
      await admit("held", { name: "H" });
      await fixture.activate();
      expect(held.map((copy) => copy.eventId)).toEqual(["held"]);

      await admit("second", { name: "S" });
      await fixture.feed();
      expect(fixture.skipped).toContain("held");
      expect(held.map((copy) => copy.eventId)).toEqual(["held", "second"]);

      end(fixture.runtime(), held[0]);
      await admit("third", { name: "T" });
      await fixture.feed();
      expect(held.map((copy) => copy.eventId)).toEqual([
        "held",
        "second",
        "held",
        "third",
      ]);
    });
  });
});
