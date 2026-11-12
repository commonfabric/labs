import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  type SessionViewInterest,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryServer from "@commonfabric/memory/v2/server";

import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import type { HostMemoryServer } from "../../src/executor/host-memory-server.ts";
import {
  LIFECYCLE_VERB_SPACE_PARKED,
  SpaceServer,
  type SpaceServerOptions,
  type SpaceServerPolicy,
} from "../../src/executor/space-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
  SETTLE_SERIES_MAX,
} from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  type WaveCommitSink,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { COMPONENT_READ_CONTRACT_VERSION } from "../../src/component-read-contract.ts";
import { Runtime } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog } from "../support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("wave commit arms space");
const serviceSigner = await Identity.fromPassphrase("wave commit arms service");
const space = spaceSigner.did() as MemorySpace;
const ownerSigner = await Identity.fromPassphrase("wave commit arms owner");
const log = getLogger("space-server");

/** How many times the space server logged `key` at `level` so far. */
const logged = (key: string, level: "debug" | "info" | "warn" | "error") =>
  log.countsByKey[key]?.[level] ?? 0;

/**
 * Holds the home commits a serving loop hands its sink until the test lets
 * each one through, or fails it.
 */
class CommitGate {
  /** One entry per held commit, as the sink receives it. */
  readonly arrivals = new ArrivalLog<void>();
  #held = false;
  #release = Promise.withResolvers<void>();
  #onCommit: (() => void) | undefined;

  #onHeads: (() => void) | undefined;

  /** Calls `effect` as the next home commit reaches the sink. */
  whenCommitting(effect: () => void): void {
    this.#onCommit = effect;
  }

  /** Calls `effect` as the next wave commit starts reading the heads. */
  whenReadingHeads(effect: () => void): void {
    this.#onHeads = effect;
  }

  /** Holds every commit from now until `release()` or `fail()`. */
  hold(): void {
    this.#held = true;
    this.#release = Promise.withResolvers<void>();
  }

  /** Lets the held commits through to the store. */
  release(): void {
    this.#held = false;
    this.#release.resolve();
  }

  /** Fails the held commits, as a sink whose transport broke does. */
  fail(error: Error): void {
    this.#held = false;
    this.#release.reject(error);
  }

  /** Wraps `sink` so that its home commits pass this gate. */
  readonly decorate = (sink: WaveCommitSink): WaveCommitSink => {
    const commitWave: WaveCommitSink["commitWave"] = async (batch) => {
      const effect = batch.home ? this.#onCommit : undefined;
      if (effect !== undefined) {
        this.#onCommit = undefined;
        effect();
      }
      if (this.#held) {
        const release = this.#release.promise;
        this.arrivals.record();
        await release;
      }
      return await sink.commitWave(batch);
    };
    const currentHeads: WaveCommitSink["currentHeads"] = (space, docs) => {
      const effect = this.#onHeads;
      this.#onHeads = undefined;
      effect?.();
      return sink.currentHeads(space, docs);
    };
    return new Proxy(sink, {
      get(target, property) {
        if (property === "commitWave") return commitWave;
        if (property === "currentHeads") return currentHeads;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

/** Stands in for the memory server's `idle()`, which it can keep waiting. */
class IdleHold {
  #held: PromiseWithResolvers<void> | undefined;

  /** Keeps every `idle()` from now waiting until `release()`. */
  hold(): void {
    this.#held ??= Promise.withResolvers<void>();
  }

  /** Lets every waiting `idle()` resolve. */
  release(): void {
    this.#held?.resolve();
    this.#held = undefined;
  }

  /** The override of `server`'s `idle()`. */
  readonly overrides = (
    server: MemoryServer.Server,
  ): Partial<HostMemoryServer> => ({
    idle: () => this.#held?.promise ?? server.idle(),
  });
}

/**
 * Calls `observe` with each span the executor's timing logger records, as
 * `executor/wave/<phase>`, right after recording it.
 */
function observeSpans(observe: (span: string) => void): Disposable {
  const timing = getLogger("executor");
  const time = timing.time.bind(timing);
  return stub(timing, "time", (...args: Parameters<typeof time>) => {
    const result = time(...args);
    observe(args.slice(1).join("/"));
    return result;
  });
}

/** Appends an event to `stream`'s sidecar, as a delegated sender would. */
async function appendEvent(
  server: MemoryServer.Server,
  stream: { id: string; path: string[] },
  eventId: string,
): Promise<void> {
  const appended = await server.commitDelegatedAppend({
    targetSpace: space,
    targetStream: streamEntriesDocId(stream),
    targetStreamLink: stream,
    eventId,
    payload: {},
    actingPrincipal: ownerSigner.did(),
    actingSession: "arms-session",
    capabilityRef: "arms-capability",
    sessionId: "arms-delivery",
    localSeq: 1,
  });
  expect(appended.deduped).toBe(false);
}

/** The memory server members only a serving loop's cycle calls. */
const LOOP_CALLS = new Set([
  "idle",
  "demandForSpace",
  "viewInterestsForSpace",
  "flushSessions",
  "setViewSelection",
]);

type Fixture = {
  server: MemoryServer.Server;
  engine: Engine.Engine;
  serving: SpaceServer;
  stats: ServingLoopStats;
  cycles: ArrivalLog<void>;
  parks: ArrivalLog<string>;
  /** Each space-root ensure's outcome. */
  ensures: ArrivalLog<string>;
  /** Each event drain pass, with how many wave cycles had ended before it. */
  drainPasses: ArrivalLog<{ queued: number; cyclesEnded: number }>;
  /** Hands the loop a notice of an authored commit at the store's head. */
  notify: () => void;
  /** The loop-only server calls made after a park began, by name. */
  loopCallsAfterPark: string[];
  /** Every commit the serving loop reported to the memory server. */
  notices: MemoryServer.AdmittedCommitNotice[];
  runtime: () => Runtime;
  /** Whether disposing the serving runtime has begun. */
  disposed: () => boolean;
  /** Seals a derivation write of `value` to `name` into the open wave. */
  seal: (name: string, value: number) => Promise<IExtendedStorageTransaction>;
  /** The value the store holds for `name`. */
  stored: (name: string) => unknown;
  close: () => Promise<void>;
};

/**
 * Activates a SpaceServer over a fresh memory server, with `overrides`
 * standing in for the server's own members.
 */
async function serve(options: {
  policy?: SpaceServerPolicy;
  stats?: ServingLoopStats;
  gate?: CommitGate;
  createWaveCommitSink?: SpaceServerOptions["createWaveCommitSink"];
  /** Whether the tenure ensures the space's root; off unless asked. */
  ensureSpaceRoots?: boolean;
  /** Runs against the space's engine before the server activates. */
  prepare?: (engine: Engine.Engine) => void;
  overrides?: (server: MemoryServer.Server) => Partial<HostMemoryServer>;
}): Promise<Fixture> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  options.prepare?.(engine);
  const notices: MemoryServer.AdmittedCommitNotice[] = [];
  const overrides: Partial<HostMemoryServer> = {
    noteExecutorCommit: (notice) => {
      notices.push(notice);
      server.noteExecutorCommit(notice);
    },
    ...options.overrides?.(server),
  };
  // Set once activation has returned, so a call made while the server is
  // inactive is one made after a park began.
  let activated = false;
  const loopCallsAfterPark: string[] = [];
  const facade = new Proxy(server, {
    get(target, property) {
      const owner = Object.hasOwn(overrides, property) ? overrides : target;
      const value = Reflect.get(owner, property);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !LOOP_CALLS.has(property)) {
        return value.bind(owner);
      }
      return (...args: unknown[]) => {
        if (activated && !serving.active) loopCallsAfterPark.push(property);
        return Reflect.apply(value, owner, args);
      };
    },
  });
  let servingRuntime: Runtime | undefined;
  let disposed = false;
  const stats = options.stats ?? emptyServingLoopStats();
  const cycles = new ArrivalLog<void>();
  const parks = new ArrivalLog<string>();
  const ensures = new ArrivalLog<string>();
  const drainPasses = new ArrivalLog<
    { queued: number; cyclesEnded: number }
  >();
  const serving = new SpaceServer({
    space,
    engine,
    server: facade,
    serviceIdentity: serviceSigner.did(),
    createRuntime: () => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: serviceSigner,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      servingRuntime = runtime;
      return Promise.resolve({
        runtime,
        dispose: async () => {
          disposed = true;
          await runtime.dispose();
          await manager.close();
        },
      });
    },
    localSeqRef: { value: 0 },
    stats,
    ensureSpaceRoots: options.ensureSpaceRoots ?? false,
    policy: options.policy ?? { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    onWaveCycle: cycles.record,
    onParked: parks.record,
    onRootEnsure: ensures.record,
    onEventDrainPass: (queued) =>
      drainPasses.record({ queued, cyclesEnded: cycles.entries.length }),
    ...(options.createWaveCommitSink === undefined
      ? {}
      : { createWaveCommitSink: options.createWaveCommitSink }),
    ...(options.gate === undefined
      ? {}
      : { decorateWaveCommitSink: options.gate.decorate }),
  });
  expect(await serving.activate()).toBe(true);
  activated = true;
  const runtime = () => servingRuntime!;
  const cellOf = (name: string) =>
    runtime().getCell<number>(space, name, undefined);
  return {
    server,
    engine,
    serving,
    stats,
    cycles,
    parks,
    ensures,
    drainPasses,
    notify: () =>
      serving.enqueueCommit({
        space,
        seq: Engine.serverSeq(engine),
        class: "authored",
        sessionId: "session:arms-probe",
        writes: [{ id: "of:arms-probe", scopeKey: "space" }],
      }),
    notices,
    loopCallsAfterPark,
    runtime,
    disposed: () => disposed,
    seal: async (name, value) => {
      const probe = cellOf(name);
      await probe.sync();
      const tx = runtime().edit();
      stampWaveRunContext(tx, { actionId: `test/${name}`, kind: "derivation" });
      probe.withTx(tx).set(value);
      expect((await tx.commit().settled).error).toBeUndefined();
      return tx;
    },
    stored: (name) =>
      Engine.read(engine, { id: cellOf(name).getAsNormalizedFullLink().id })
        ?.value,
    close: async () => {
      try {
        await serving.park("test-teardown");
      } finally {
        await server.close();
      }
    },
  };
}

/** A policy under which a cycle may leave its wave commit in flight. */
const overlapped: SpaceServerPolicy = {
  flushDeadlineMs: 2_000,
  idleParkMs: 600_000,
  overlapWaveCommit: true,
};

/** Runs `body` with the space server's info and debug messages formatted. */
async function withDebugLog<T>(body: () => Promise<T>): Promise<T> {
  const previous = log.level;
  log.level = "debug";
  try {
    return await body();
  } finally {
    log.level = previous;
  }
}

describe("SpaceServer", () => {
  describe("instance members", () => {
    describe("park()", () => {
      it("takes over a wave commit left in flight: it reports the commit once the store has it, and the loop's own finish stands down", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          gate.hold();
          const tx = await f.seal("taken-over", 7);
          await gate.arrivals.reached(1);
          await clock.settle();
          const barrier = f.runtime().sealsCommitted!();
          const wavesBefore = f.stats.waves;
          const parked = f.serving.park("handover");
          // The park resolves what waited on the tenure's waves before the
          // commit it took over has landed.
          await barrier;
          expect(f.stored("taken-over")).toBeUndefined();
          gate.release();
          await parked;
          expect(f.stored("taken-over")).toBe(7);
          expect((await waveSettlementOf(tx))?.error).toBeUndefined();
          const seq = Engine.serverSeq(f.engine);
          expect(
            f.notices.filter((notice) => notice.class === "derived").map((
              notice,
            ) => notice.seq),
          ).toEqual([seq]);
          expect(f.stats.waves).toBe(wavesBefore);
          expect(f.parks.entries).toEqual(["handover"]);
          expect(f.loopCallsAfterPark).toEqual([]);
        } finally {
          await f.close();
        }
      });

      it("drops a taken-over wave commit the sink fails: nothing is reported, and the loop does not fail", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          gate.hold();
          await f.seal("taken-over-failed", 7);
          await gate.arrivals.reached(1);
          await clock.settle();
          const loopFailures = logged("loop-failed", "error");
          const parked = f.serving.park("handover");
          gate.fail(new Error("the sink's transport broke"));
          await parked;
          expect(f.stored("taken-over-failed")).toBeUndefined();
          expect(f.notices.filter((notice) => notice.class === "derived"))
            .toEqual([]);
          expect(logged("loop-failed", "error")).toBe(loopFailures);
          expect(f.parks.entries).toEqual(["handover"]);
          expect(f.disposed()).toBe(true);
        } finally {
          await f.close();
        }
      });

      it("completes when releasing the lease throws, and reports the park", async () => {
        const f = await serve({
          overrides: (server) => ({
            executionLeases: {
              acquire: (leaseSpace, holder) =>
                server.executionLeases.acquire(leaseSpace, holder),
              release: () => Promise.reject(new Error("the port closed")),
            },
          }),
        });
        try {
          const failures = logged("park-release-failed", "warn");
          const parkedLogs = logged("parked", "info");
          await withDebugLog(() => f.serving.park("release-fails"));
          expect(f.serving.active).toBe(false);
          expect(f.parks.entries).toEqual(["release-fails"]);
          expect(logged("park-release-failed", "warn")).toBe(failures + 1);
          expect(logged("parked", "info")).toBe(parkedLogs + 1);
          // The lease row stays where the failed release left it.
          expect(f.engine.executionLeases.holderOf(space)).toBeDefined();
        } finally {
          await f.close();
        }
      });
    });

    describe("the settle", () => {
      it("drains an event appended while the previous commit was in flight in the settle that finishes that commit", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          const stream = { id: "of:arms-redrain-stream", path: ["event"] };
          let cyclesAtCommit = -1;
          let appended: Promise<void> | undefined;
          gate.whenCommitting(() => {
            cyclesAtCommit = f.cycles.entries.length;
            appended = appendEvent(f.server, stream, "redrain-event");
            f.notify();
          });
          await f.seal("redrain", 7);
          const pass = await f.drainPasses.matching((entry) =>
            cyclesAtCommit >= 0 && entry.cyclesEnded > cyclesAtCommit
          );
          await appended;
          // The cycle that left the commit in flight has ended, and the
          // next one drains the event before it ends.
          expect(pass.cyclesEnded).toBe(cyclesAtCommit + 1);
          expect(f.stored("redrain")).toBe(7);
        } finally {
          await f.close();
        }
      });

      it("stops draining an event appended while the previous commit was in flight once a park lands during the drain", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          const stream = { id: "of:arms-parked-stream", path: ["event"] };
          const sidecar = streamEntriesDocId(stream);
          let cyclesAtCommit = -1;
          let appended: Promise<void> | undefined;
          gate.whenCommitting(() => {
            cyclesAtCommit = f.cycles.entries.length;
            appended = appendEvent(f.server, stream, "parked-event");
            f.notify();
          });
          const runtime = f.runtime();
          const getCellFromLink = runtime.getCellFromLink.bind(runtime);
          using _sidecar = stub(
            runtime,
            "getCellFromLink",
            (...args: Parameters<typeof getCellFromLink>) => {
              const link = args[0];
              if ("id" in link && link.id === sidecar) {
                void f.serving.park("handover");
              }
              return getCellFromLink(...args);
            },
          );
          await f.seal("parked-drain", 7);
          await f.parks.reached(1);
          await f.serving.whenParked;
          await appended;
          expect(f.parks.entries).toEqual(["handover"]);
          expect(
            f.drainPasses.entries.filter((entry) =>
              entry.cyclesEnded > cyclesAtCommit
            ),
          ).toEqual([]);
          expect(Engine.selectPendingStreamEventDocs(f.engine)).toHaveLength(
            1,
          );
          expect(f.loopCallsAfterPark).toEqual([]);
        } finally {
          await f.close();
        }
      });

      it("purges an in-process event copy still queued at the flush deadline, unrun", async () => {
        const idle = new IdleHold();
        const f = await serve({ overrides: idle.overrides });
        try {
          await withDebugLog(async () => {
            const purges = logged("lt1-leftovers-purged", "debug");
            const runtime = f.runtime();
            const leftover = runtime.getCell(space, "arms-lt1-stream")
              .getAsNormalizedFullLink();
            let runs = 0;
            const cancel = runtime.scheduler.addEventHandler(() => {
              runs++;
            }, leftover);
            // The copy lands in the same synchronous stretch as the deadline
            // decision, so it is still queued when the purge looks.
            const purge = runtime.scheduler.purgeQueuedEvents.bind(
              runtime.scheduler,
            );
            using _purge = stub(
              runtime.scheduler,
              "purgeQueuedEvents",
              (predicate, reason) => {
                runtime.scheduler.queueEvent(
                  leftover,
                  {},
                  false,
                  undefined,
                  true,
                  {
                    eventId: "arms-lt1-copy",
                    served: { firedAt: { user: ownerSigner.did() } },
                  },
                );
                return purge(predicate, reason);
              },
            );
            try {
              idle.hold();
              await f.seal("lt1-leftover", 7);
              await f.cycles.matching(() => f.stats.waves > 0);
              expect(f.stats.events.lt1LeftoversPurged).toBe(1);
              expect(logged("lt1-leftovers-purged", "debug")).toBe(
                purges + 1,
              );
              await runtime.idle();
              expect(runs).toBe(0);
            } finally {
              cancel();
            }
          });
        } finally {
          idle.release();
          await f.close();
        }
      });

      it("commits a wave the flush deadline cut, counting it as exhausted", async () => {
        const idle = new IdleHold();
        const f = await serve({ overrides: idle.overrides });
        try {
          await withDebugLog(async () => {
            const exhaustedLogs = logged("wave-budget-exhausted", "debug");
            idle.hold();
            await f.seal("exhausted-wave", 7);
            await f.cycles.matching(() => f.stats.waves > 0);
            expect(f.stored("exhausted-wave")).toBe(7);
            expect(f.stats.wavesBudgetExhausted).toBe(1);
            expect(logged("wave-budget-exhausted", "debug")).toBe(
              exhaustedLogs + 1,
            );
          });
        } finally {
          idle.release();
          await f.close();
        }
      });

      it("commits nothing for an input whose settle the flush deadline cut, and counts the cycle as exhausted", async () => {
        const idle = new IdleHold();
        const f = await serve({ overrides: idle.overrides });
        try {
          await withDebugLog(async () => {
            const exhaustedLogs = logged("wave-budget-exhausted", "debug");
            const { seq } = await f.server.writeDocument(
              space,
              "of:arms-cut-input",
              { n: 1 },
            );
            idle.hold();
            const watermark = f.serving.watermark;
            f.notify();
            await f.cycles.matching(() => f.stats.wavesBudgetExhausted > 0);
            expect(f.stats.wavesBudgetExhausted).toBe(1);
            expect(f.stats.waves).toBe(0);
            expect(f.serving.watermark).toBe(watermark);
            expect(Engine.serverSeq(f.engine)).toBe(seq);
            expect(logged("wave-budget-exhausted", "debug")).toBe(
              exhaustedLogs + 1,
            );
          });
        } finally {
          idle.release();
          await f.close();
        }
      });

      it("advances the watermark over the loop's own derived commits at a quiet settle, keeping the newest advances in a bounded series", async () => {
        const stats = emptyServingLoopStats();
        const earlier = { space: "earlier", from: 0, to: 1, at: 0 };
        for (let index = 0; index < SETTLE_SERIES_MAX; index++) {
          stats.settleAdvances.series.push(earlier);
        }
        const f = await serve({ stats });
        try {
          await withDebugLog(async () => {
            const advanceLogs = logged("settle-advance", "debug");
            const { seq } = await f.server.writeDocument(
              space,
              "of:arms-settle-input",
              { n: 1 },
            );
            f.notify();
            await f.cycles.matching(() => f.serving.watermark === seq);
            await f.seal("settle-tail", 7);
            await f.cycles.matching(() => f.stored("settle-tail") === 7);
            const tail = Engine.serverSeq(f.engine);
            expect(f.serving.watermark).toBe(seq);
            f.serving.noteDemandChanged();
            await f.cycles.matching(() => f.stats.settleAdvances.count > 0);
            expect(f.serving.watermark).toBe(tail);
            expect(f.stats.settleAdvances.count).toBe(1);
            expect(f.stats.settleAdvances.series).toHaveLength(
              SETTLE_SERIES_MAX,
            );
            expect(f.stats.settleAdvances.dropped).toBe(1);
            expect(f.stats.settleAdvances.series.at(-1)).toMatchObject({
              from: seq,
              to: tail,
            });
            expect(logged("settle-advance", "debug")).toBe(advanceLogs + 1);
          });
        } finally {
          await f.close();
        }
      });

      it("holds the watermark below an input the replica still shadows, and counts the clamp", async () => {
        const f = await serve({});
        try {
          await withDebugLog(async () => {
            const clampLogs = logged("watermark-clamped", "info");
            const { seq } = await f.server.writeDocument(
              space,
              "of:arms-shadowed-input",
              { n: 1 },
            );
            const replica = f.runtime().storageManager.open(space).replica;
            replica.unappliedForeignSeqFloor = () => seq;
            f.notify();
            await f.cycles.matching(() => f.stats.watermarkClamped > 0);
            expect(f.stats.watermarkClamped).toBe(1);
            expect(f.serving.watermark).toBeLessThan(seq);
            expect(logged("watermark-clamped", "info")).toBe(clampLogs + 1);
          });
        } finally {
          await f.close();
        }
      });
    });

    describe("activate()", () => {
      it("leaves the space root to its creator when the genesis reservation names no source", async () => {
        await withDebugLog(async () => {
          const ensureLogs = logged("space-root-ensure", "info");
          const f = await serve({
            ensureSpaceRoots: true,
            prepare: (engine) => {
              Engine.applyCommit(engine, {
                sessionId: "arms-genesis",
                space,
                principal: space,
                commit: {
                  localSeq: 1,
                  reads: { confirmed: [], pending: [] },
                  genesisRoot: { cause: "arms-creator-placed-root" },
                  operations: [{
                    op: "set",
                    id: `of:${space}`,
                    value: { value: { [ownerSigner.did()]: "OWNER" } },
                  }],
                },
              });
            },
          });
          try {
            expect(
              await f.ensures.matching((outcome) =>
                outcome === "awaiting-creator"
              ),
            ).toBe("awaiting-creator");
            expect(f.stats.rootEnsure.created).toBe(0);
            expect(logged("space-root-ensure", "info")).toBe(ensureLogs + 1);
          } finally {
            await f.close();
          }
        });
      });
    });

    describe("the wave commit", () => {
      it("runs no post-commit step for a commit a cycle started after a park began", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          const cyclesBefore = f.cycles.entries.length;
          gate.whenReadingHeads(() => void f.serving.park("handover"));
          await f.seal("after-park", 7);
          await f.cycles.reached(cyclesBefore + 1);
          await f.serving.whenParked;
          expect(f.stats.waves).toBe(0);
          expect(f.parks.entries).toEqual(["handover"]);
        } finally {
          await f.close();
        }
      });

      it("fails the cycle and parks the space when the sink fails a commit left in flight", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          gate.hold();
          await f.seal("failed-in-flight", 7);
          await gate.arrivals.reached(1);
          const loopFailures = logged("loop-failed", "error");
          gate.fail(new Error("the sink's transport broke"));
          await f.parks.reached(1);
          expect(f.parks.entries).toEqual(["loop-failed"]);
          expect(f.stored("failed-in-flight")).toBeUndefined();
          expect(logged("loop-failed", "error")).toBe(loopFailures + 1);
        } finally {
          await f.close();
        }
      });

      it("finishes a commit left in flight before a verb queued meanwhile, and runs no verb once a park took the commit over", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          let ran = false;
          let verb: Promise<string> | undefined;
          gate.whenCommitting(() => {
            verb = f.serving.runLifecycleVerb({
              name: "after-park",
              run: () => {
                ran = true;
                return Promise.resolve("ran");
              },
            });
          });
          using _spans = observeSpans((span) => {
            if (span === "executor/wave/commit-wait") {
              void f.serving.park("handover");
            }
          });
          await f.seal("before-verb", 7);
          await f.parks.reached(1);
          await expect(verb!).rejects.toThrow(LIFECYCLE_VERB_SPACE_PARKED);
          expect(ran).toBe(false);
          expect(f.stored("before-verb")).toBe(7);
          expect(f.parks.entries).toEqual(["handover"]);
          expect(f.loopCallsAfterPark).toEqual([]);
        } finally {
          await f.close();
        }
      });

      it("ends the settle when a park takes over the commit the settle was finishing", async () => {
        const gate = new CommitGate();
        const f = await serve({ gate, policy: overlapped });
        try {
          gate.whenCommitting(f.notify);
          using _spans = observeSpans((span) => {
            if (span === "executor/wave/commit-wait") {
              void f.serving.park("handover");
            }
          });
          await f.seal("settle-finish", 7);
          await f.parks.reached(1);
          await f.serving.whenParked;
          expect(f.stored("settle-finish")).toBe(7);
          expect(f.parks.entries).toEqual(["handover"]);
          expect(f.loopCallsAfterPark).toEqual([]);
        } finally {
          await f.close();
        }
      });

      it("finishes the commit after a settle the deadline cut, and stops there once a park took it over", async () => {
        const gate = new CommitGate();
        const idle = new IdleHold();
        const exhausted: boolean[] = [];
        const f = await serve({
          gate,
          policy: {
            ...overlapped,
            onSettleEnded: (cut) => exhausted.push(cut),
          },
          overrides: idle.overrides,
        });
        try {
          gate.whenCommitting(() => {
            idle.hold();
            f.notify();
          });
          using _spans = observeSpans((span) => {
            if (span === "executor/wave/commit-wait") {
              void f.serving.park("handover");
            }
          });
          await f.seal("deadline-finish", 7);
          await f.parks.reached(1);
          await f.serving.whenParked;
          expect(exhausted.at(-1)).toBe(true);
          expect(f.stored("deadline-finish")).toBe(7);
          expect(f.parks.entries).toEqual(["handover"]);
          expect(f.loopCallsAfterPark).toEqual([]);
        } finally {
          idle.release();
          await f.close();
        }
      });

      it("reports nothing for a commit its sink made outside this server's store", async () => {
        const elsewhere = newSharedServer({ subscriptionRefreshDelayMs: 0 });
        const elsewhereEngine = await elsewhere.engineForSpace(space);
        const f = await serve({
          createWaveCommitSink: (deps) => {
            expect(
              elsewhereEngine.executionLeases.acquire(space, deps.sessionId),
            ).toBe(true);
            return new EngineWaveCommitSink({
              engineFor: () => elsewhereEngine,
              sessionId: deps.sessionId,
              localSeqRef: deps.localSeqRef,
            });
          },
        });
        try {
          const loopFailures = logged("loop-failed", "error");
          const seq = Engine.serverSeq(elsewhereEngine);
          await f.seal("elsewhere", 7);
          await f.cycles.matching(() => f.stats.waves > 0);
          expect(Engine.serverSeq(elsewhereEngine)).toBeGreaterThan(seq);
          expect(f.stored("elsewhere")).toBeUndefined();
          expect(f.notices.filter((notice) => notice.class === "derived"))
            .toEqual([]);
          expect(f.serving.active).toBe(true);
          expect(logged("loop-failed", "error")).toBe(loopFailures);
        } finally {
          await f.close();
          await elsewhere.close();
        }
      });

      it("answers a read view that registered after the cycle's demand pass in a later cycle", async () => {
        const interest: SessionViewInterest = {
          handle: {
            sessionId: "arms-reader",
            sessionEpoch: "arms-reader-session",
            viewEpoch: "arms-reader-view",
            viewId: "screen",
            revision: 0,
          },
          principal: ownerSigner.did(),
          attached: true,
          view: {
            id: "screen",
            revision: 0,
            mode: "read",
            componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
            query: { roots: [] },
          },
        };
        let registeredAt: number | undefined;
        const selections = new ArrivalLog<number>();
        let cyclesEnded = () => 0;
        const f = await serve({
          overrides: (server) => ({
            viewInterestsForSpace: () =>
              registeredAt === undefined ? [] : [interest],
            flushSessions: (spaces) => {
              registeredAt ??= cyclesEnded();
              return server.flushSessions(spaces);
            },
            setViewSelection: () => {
              selections.record(cyclesEnded());
              return Promise.resolve(true);
            },
          }),
        });
        cyclesEnded = () => f.cycles.entries.length;
        try {
          await f.seal("read-view", 7);
          const answeredAt = await selections.reached(1).then(() =>
            selections.entries[0]
          );
          expect(registeredAt).toBeDefined();
          expect(answeredAt).toBeGreaterThan(registeredAt!);
          expect(selections.entries).toHaveLength(1);
        } finally {
          await f.close();
        }
      });

      it("ends a cycle whose wave lost the lease to a park only once that park completes, and commits nothing", async () => {
        const gate = new CommitGate();
        const released = Promise.withResolvers<void>();
        const releaseHeld = Promise.withResolvers<void>();
        const f = await serve({
          gate,
          overrides: (server) => ({
            executionLeases: {
              acquire: (leaseSpace, holder) =>
                server.executionLeases.acquire(leaseSpace, holder),
              release: async (leaseSpace, holder) => {
                await server.executionLeases.release(leaseSpace, holder);
                released.resolve();
                await releaseHeld.promise;
              },
            },
          }),
        });
        try {
          gate.hold();
          const tx = await f.seal("lease-lost", 7);
          await gate.arrivals.reached(1);
          const order: string[] = [];
          const cycleEnded = f.cycles.reached(f.cycles.entries.length + 1)
            .then(() => order.push("cycle ended"));
          const aborts = logged("wave-aborted", "warn");
          const parked = f.serving.park("handover").then(() =>
            order.push("parked")
          );
          await released.promise;
          gate.release();
          expect((await waveSettlementOf(tx))?.error).toBeDefined();
          await clock.settle();
          releaseHeld.resolve();
          await Promise.all([parked, cycleEnded]);
          expect(order).toEqual(["parked", "cycle ended"]);
          expect(logged("wave-aborted", "warn")).toBe(aborts + 1);
          expect(f.stored("lease-lost")).toBeUndefined();
          expect(f.parks.entries).toEqual(["handover"]);
        } finally {
          await f.close();
        }
      });

      it("publishes the view plan and keeps the wave when flushing the sessions first throws", async () => {
        const f = await serve({
          overrides: () => ({
            flushSessions: () => Promise.reject(new Error("flush refused")),
          }),
        });
        try {
          const failures = logged("view-plan-session-flush-failed", "warn");
          const cyclesBefore = f.cycles.entries.length;
          await f.seal("flush-fails", 7);
          await f.cycles.matching(() => f.stats.waves > 0);
          expect(f.cycles.entries.length).toBeGreaterThan(cyclesBefore);
          expect(f.stored("flush-fails")).toBe(7);
          expect(logged("view-plan-session-flush-failed", "warn")).toBe(
            failures + 1,
          );
          expect(f.serving.active).toBe(true);
        } finally {
          await f.close();
        }
      });
    });
  });
});
