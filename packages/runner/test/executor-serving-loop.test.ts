// Server-execution v2 stage F: the serving loop end to end, against a
// real memory server, engines, and TWO runtimes — a client session
// (authored commits over the loopback wire) and the SpaceServer's
// serving runtime (the ExecutorHost activates it on the client's session
// open; serving-loop.md §1, §3):
//
// - activation on session open via the admission-side observer (plane
//   (b)), lease acquired and RENEWED on stage B's cadence;
// - an authored client commit wakes the loop; the scheduler runs the
//   affected graph; the action seals into the wave; ONE derived commit
//   lands carrying the wave's writes, the watermark doc write, and
//   `derivedThrough` (protocol.md §4);
// - the client observes the derived value through ordinary push (M4:
//   instance-keyed dirtiness reaches its subscription) and settles via
//   `waitForSettled` — the poll-loop replacement (testing.md §3);
// - the loop's own derived commit returns on the feed and is skipped by
//   class + holder (self-echo, §3): the wave counter stabilizes;
// - a lost lease parks the space after reacquire fails (§2), and an
//   idle space with no live sessions parks per IDLE_PARK_MS (§1).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { markEffectCompletion } from "../src/executor/effect-completion.ts";
import { decodeMemoryBoundary, resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitEach,
  awaitEdges,
  awaitReplica,
} from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  readWatermarkSeq,
  waitForSettled,
  watermarkCell,
  watermarkDocLink,
} from "../src/executor/watermark.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import { getArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  /**
   * Delegates to the base `connectTo()`: `new this` gives back this subclass,
   * and the base clears server ownership so closing this manager never closes
   * the shared server.
   */
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }

  /** Test seam for the renew-blip interleave: when set, the serving
   * loop's settle hangs at its `inputSynced` barrier until the gate
   * resolves — holding an open (sealed, uncommitted) wave across a
   * lease tenure bump, deterministically. Undefined everywhere else. */
  settleGate: Promise<void> | undefined;

  override async inputSynced(): Promise<void> {
    await super.inputSynced();
    if (this.settleGate !== undefined) await this.settleGate;
  }
}

const newSharedServer = (
  options: { sessionTtlMs?: number; subscriptionRefreshDelayMs?: number } = {},
) =>
  new MemoryV2Server.Server({
    ...(options.sessionTtlMs === undefined ? {} : {
      sessions: new MemoryV2Server.SessionRegistry({
        ttlMs: options.sessionTtlMs,
      }),
    }),
    subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs ?? 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const spaceSigner = await Identity.fromPassphrase("serving loop space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("serving loop service");
const aliceSigner = await Identity.fromPassphrase("serving loop alice");
const bobSigner = await Identity.fromPassphrase("serving loop bob");

/**
 * The `{ total }` result schema of the patterns served below. A client that
 * wants the derived value reads the result under it: the store delivers the
 * result document alone, and the crossing from `total` to the computed
 * document behind it is what puts that document in the client's tracked
 * set — the demand the serving loop runs the derivation for.
 */
const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const satisfies JSONSchema;

describe("stage F serving loop", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  /** Stage G: the serving runtime's injected fetch (egress stub) —
   * effectful builtins served by the loop call THIS, never the network. */
  let servingFetch:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;

  /** Wraps each tenure's wave commit sink, when set. */
  let decorateWaveCommitSink:
    | ConstructorParameters<typeof ExecutorHost>[0]["decorateWaveCommitSink"]
    | undefined;

  // serving-loop.md §3e: the pattern-update posture flips server-side.
  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        if (factoryFailures > 0) {
          factoryFailures -= 1;
          throw new Error("induced runtime factory failure");
        }
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          ...(servingFetch !== undefined ? { fetch: servingFetch } : {}),
          experimental: {
            serverExecution: true,
          },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy,
      ...(decorateWaveCommitSink === undefined
        ? {}
        : { decorateWaveCommitSink }),
      onWaveCycle: cycles.record,
      onActivationSettled: (activatedSpace, outcome) => {
        activations.record({ space: activatedSpace, outcome });
        if (activationObserverThrows) {
          throw new Error("activation observer failure (test-injected)");
        }
      },
      onSpaceParked: (parkedSpace, reason) => {
        parks.record({ space: parkedSpace, reason });
        if (parkObserverThrows) {
          throw new Error("park observer failure (test-injected)");
        }
      },
    });

  /** Every wave cycle a tenure completes, every activation outcome, and
   * every park — the loop's own edges. Its counters, its watermark and
   * its tenure state all move behind one of the three. */
  let cycles: ArrivalLog<unknown>;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let parks: ArrivalLog<{ space: string; reason: string }>;
  /** When set, the park report throws. */
  let parkObserverThrows = false;
  /** When set, the activation report throws. */
  let activationObserverThrows = false;
  /** How many of the next runtime builds reject before building anything. */
  let factoryFailures = 0;
  /** How many of the next opens of a space's engine reject. */
  let engineOpenFailures = 0;
  /** Each survived renewal blip the loop reports to the memory server.
   * The renew arm is timer-driven, so this is the only edge it has. */
  let reacquires: ArrivalLog<void>;

  /** Resolves once the space has an ACTIVE tenure, counting the ones
   * that settled before the call. */
  const activated = (): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );

  /** Resolves once a tenure of the space has parked. */
  const parked = (): Promise<unknown> =>
    parks.matching((entry) => entry.space === space);

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
    servingFetch = undefined;
    decorateWaveCommitSink = undefined;
    parkObserverThrows = false;
    activationObserverThrows = false;
    factoryFailures = 0;
    engineOpenFailures = 0;
    cycles = new ArrivalLog();
    activations = new ArrivalLog();
    parks = new ArrivalLog();
    reacquires = new ArrivalLog();
    const noteLeaseReacquired = server.noteLeaseReacquired.bind(server);
    server.noteLeaseReacquired = (notice) => {
      reacquires.record();
      return noteLeaseReacquired(notice);
    };
    const engineForSpace = server.engineForSpace.bind(server);
    server.engineForSpace = (openedSpace) => {
      if (engineOpenFailures === 0) return engineForSpace(openedSpace);
      engineOpenFailures -= 1;
      return Promise.reject(new Error("induced engine open failure"));
    };
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  /**
   * Runs the pattern `total = n + 1`, reading `serving-arg` and writing
   * `serving-result`, on the serving runtime at activation.
   */
  const runIncrementPattern = async (runtime: Runtime): Promise<void> => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { computed, pattern } from 'commonfabric';",
          "export default pattern<{ n: number }, { total: number }>(",
          "  ({ n }) => ({ total: computed(() => n + 1) }),",
          ");",
        ].join("\n"),
      }],
    }, { space });
    const argument = runtime.getCell<{ n: number }>(
      space,
      "serving-arg",
      undefined,
    );
    const result = runtime.getCell<{ total: number }>(
      space,
      "serving-result",
      compiled.resultSchema,
    );
    // Presync before running, and retry a stale-read conflict: the
    // run races the client's in-flight authored writes, and the real
    // loader machinery owns exactly this presync + bounded-retry duty
    // (runtime-mapping N24/N15).
    await argument.sync();
    await result.sync();
    // Flushed before the run commits, so the replica the commit reads
    // against is current and the commit has nothing to conflict with.
    await runtime.storageManager.synced();
    const tx = runtime.edit();
    runtime.run(tx, compiled, argument, result);
    const committed = await tx.commit();
    if (committed.error !== undefined) {
      throw new Error(
        `serving pattern run failed: ${committed.error.message}`,
      );
    }
    await runtime.idle();
  };

  const openClient = () => {
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  };

  it("preserves serving row producers and skips untouched rows after client edits", async () => {
    type Row = { key: string; value: number };
    const ready = Promise.withResolvers<void>();
    let cancel: (() => void) | undefined;
    let readRows: (() => Row[]) | undefined;
    let inspect:
      | (() => { link: NormalizedFullLink; id: string; runs: number }[])
      | undefined;
    onServingRuntime = async (runtime) => {
      try {
        runtime.scheduler.enableSettleStats();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
            import { computed, pattern } from "commonfabric";
            export default pattern<{rows:{key:string;value:number}[]}>(({rows})=>({
              rows:rows.map(row=>({key:row.key,value:computed(()=>row.value*2)})),
            }));
          `,
          }],
        }, { space });
        const argument = runtime.getCell<{ rows: unknown[] }>(space, "row-arg");
        const result = runtime.getCell<{ rows: Row[] }>(
          space,
          "row-result",
          compiled.resultSchema,
        );
        const inputs = [0, 1].map((index) =>
          runtime.getCell<Row>(space, `row-input-${index}`)
        );
        const tx = runtime.edit();
        inputs.forEach((cell, index) =>
          cell.withTx(tx).set({ key: String(index), value: index + 1 })
        );
        argument.withTx(tx).set({ rows: inputs });
        runtime.run(tx, compiled, argument, result);
        expect((await tx.commit()).error).toBeUndefined();
        cancel = result.sink(() => {});
        await runtime.idle();
        readRows = () => result.get().rows;
        inspect = () => {
          const graph = runtime.scheduler.getGraphSnapshot();
          return [0, 1].map((index) => {
            const link = result.key("rows").key(index).key("value")
              .resolveAsCell().getAsNormalizedFullLink();
            const producers = graph.nodes.filter((node) =>
              node.type === "computation" &&
              node.writes?.some((write) => write.includes(link.id))
            );
            expect(producers).toHaveLength(1);
            expect(producers[0].stats?.runCount).toBeGreaterThan(0);
            return {
              link,
              id: producers[0].id,
              runs: producers[0].stats!.runCount,
            };
          });
        };
        ready.resolve();
      } catch (error) {
        ready.reject(error);
        throw error;
      }
    };
    host = newHost();
    openClient();
    try {
      const clientResult = clientRuntime.getCell<{ rows: Row[] }>(
        space,
        "row-result",
      );
      await clientResult.sync();
      await ready.promise;
      expect(readRows!()).toEqual([{ key: "0", value: 2 }, {
        key: "1",
        value: 4,
      }]);
      let before = inspect!();
      const engine = await server.engineForSpace(space);
      for (const edited of [0, 1]) {
        const input = clientRuntime.getCell<Row>(space, `row-input-${edited}`);
        await input.sync();
        const tx = clientRuntime.edit();
        input.withTx(tx).key("value").set(10 + edited);
        expect((await tx.commit()).error).toBeUndefined();
        // The serving wave can advance the head beyond its authored input.
        const authored = engine.database.prepare(
          `SELECT MAX(seq) AS seq FROM "commit" WHERE class = 'authored'`,
        ).get() as { seq: number };
        expect(authored.seq).toBeGreaterThan(0);
        await waitForSettled(clientRuntime, space, authored.seq);
        await servingRuntime!.idle();
        expect(readRows!()).toEqual([{ key: "0", value: 20 }, {
          key: "1",
          value: edited === 0 ? 4 : 22,
        }]);
        const after = inspect!();
        expect(after.map(({ link, id }) => ({ link, id }))).toEqual(
          before.map(({ link, id }) => ({ link, id })),
        );
        expect(after[edited].runs).toBeGreaterThan(before[edited].runs);
        expect(after[1 - edited].runs).toBe(before[1 - edited].runs);
        before = after;
      }
    } finally {
      cancel?.();
    }
  });

  it("serves a demanded derivation: authored commit → wave → ONE derived commit with watermark; the client settles via waitForSettled", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    // The serving graph: a REAL pattern run server-side at activation —
    // in production this structure materializes through the demand
    // loader (`ensurePieceRunning`); the run here IS the loaded
    // structure. The client's subscription to the result doc is the
    // DEMAND the loop maps to a live server-side reader.
    onServingRuntime = runIncrementPattern;

    openClient();
    const engine = await server.engineForSpace(space);

    // The client's DEMAND: subscribe the result doc. Its session open
    // activates the space (plane (b)).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "serving-result",
      undefined,
    );
    await clientResult.sync();

    // The client's authored write — the wave's input.
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "serving-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The serving loop activates, derives, and advances the watermark
    // past the authored commit.
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);

    // waitForSettled (testing.md §3): resolves through the ordinary
    // client subscription — no text polling.
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);

    // The derived value: the pattern computed 41 + 1 server-side. The
    // client reads it through the result doc's link (ordinary push +
    // link traversal — M4's instance-keyed dirtiness reached its
    // subscription).
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );

    // The derived commits: class derived, holder = the DR1 holder
    // minted from the service identity; the watermark doc write rides a
    // derived commit (never its own commit) and derivedThrough covers
    // the authored input.
    const derived = engine.database.prepare(
      `SELECT seq, holder, derived_through FROM "commit"
       WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number; holder: string; derived_through: number }[];
    expect(derived.length).toBeGreaterThanOrEqual(1);
    const spaceServer = host.spaceServer(space);
    expect(spaceServer?.active).toBe(true);
    for (const row of derived) {
      expect(row.holder).toBe(spaceServer!.holder);
    }
    const watermarkWrite = engine.database.prepare(
      `SELECT commit_seq FROM revision WHERE id = :id ORDER BY seq DESC LIMIT 1`,
    ).get({ id: "of:server-execution-watermark" }) as {
      commit_seq: number;
    };
    expect(derived.map((row) => row.seq)).toContain(watermarkWrite.commit_seq);
    const finalDerived = derived[derived.length - 1];
    expect(finalDerived.derived_through).toBeGreaterThanOrEqual(authoredSeq);

    // Self-echo (§3): the loop's own derived commits return on the feed
    // and are skipped — the wave count stabilizes rather than looping.
    // FLAGGED EDIT (W3.1 S1, RULED 2026-08-19): since the drain-settle
    // quiescence advance, a content wave is followed by ONE designed
    // trailing advance-only wave at quiescence; sampling before it
    // lands would count its arrival inside the stability window as a
    // loop. Wait for the advance first — the pin's meaning (the count
    // STABILIZES; no self-chase) is unchanged and now also covers the
    // advance's own no-successor guarantee.
    await awaitEach(cycles, () => host!.stats().settleAdvances.count >= 1);
    const wavesAfter = host.stats().waves;
    // Stability, observed rather than sampled over an interval: a loop
    // chasing its own echoes never reaches its input wait, so the
    // suspension is what "no further waves" means here.
    const servingSpaceServer = host.spaceServer(space)!;
    await awaitEach(cycles, () => servingSpaceServer.suspendedOnInput);
    expect(host.stats().waves).toBe(wavesAfter);

    // §7 counters: the loop is counted, not logged.
    const stats = host.stats();
    expect(stats.activeSpaces).toBe(1);
    expect(stats.derivedCommits).toBeGreaterThanOrEqual(1);
    expect(stats.lease.held).toBe(1);
    expect(stats.lease.lost).toBe(0);
    // Structure-load failures are SURFACED (serving-loop.md §1's
    // counted-and-logged posture reaches the §7 block, not a private
    // field): zero here — the demanded structure loaded.
    expect(stats.structureLoadFailures).toBe(0);
    expect(stats.events.appended).toBe(0);
    expect(stats.memo.hits + stats.memo.misses).toBe(0);

    // A second authored write drives a second wave THROUGH THE SEALED
    // PATH (the destination is installed now): the recompute seals into
    // the wave and lands in a derived commit; the loop keeps serving
    // across renewals.
    const tx2 = clientRuntime.edit();
    clientArg.withTx(tx2).set({ n: 99 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authored2);
    // Read past the barrier: a write is counted as SEEN when it reaches
    // the tenure's admission feed, and a write that arrives while the
    // tenure is still activating is covered by the activation scan,
    // which counts nothing. The settle orders this after the wave that
    // drained it.
    expect(host.stats().authoredSeen).toBeGreaterThanOrEqual(1);
    // W-soundness, bound STRICTLY (protocol.md §4): with the
    // subscriptions established, "settled" must mean the demanded
    // derivation is ALREADY current — the derived value and the
    // watermark ride one wave commit and one push frame, so the read
    // here is synchronous, no waiting. (This is the assertion that
    // catches a loop advancing W before the derivation ran.)
    expect(clientResult.key("total").get()).toBe(100);
    // And the store agrees at the same instant: the derivation is
    // durably committed at-or-below the settled watermark.
    const settledDerived = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' AND c.class = 'derived'`,
    ).get() as { n: number };
    expect(settledDerived.n).toBeGreaterThanOrEqual(1);

    // The recompute's write is DERIVED-class — the computed's doc's
    // latest revision rides a derived commit, not an authored one.
    const computedRow = engine.database.prepare(
      `SELECT c.class AS class FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
    ).get() as { class: string } | undefined;
    expect(computedRow?.class).toBe("derived");

    // The serving runtime's watermark cell reads the same W the client
    // settles on (one well-known SPACE-scoped doc).
    expect(servingRuntime).toBeDefined();
    expect(
      watermarkCell(servingRuntime!, space).get()?.seq,
    ).toBeGreaterThanOrEqual(authored2);
  });

  it("records a wave's duration and its phases as timing spans, which the §7 counters cannot carry", async () => {
    // `wavesBudgetExhausted` is a censored measurement: a wave that
    // overruns the flush deadline reports that deadline however far past
    // it the wave ran, so the counter alone cannot tell a loop barely
    // over its budget from one an order of magnitude over. These spans
    // carry the distribution, `/api/health/stats` reports them as its
    // `timingStats.executor` block, and both
    // `docs/development/debugging/profiling.md` and
    // `skills/perf-investigation/SKILL.md` name the keys as the way to
    // read a wave's cost. Nothing else fails when a rename leaves those
    // documents pointing at rows that no longer exist, so the assertion
    // here is on the KEY NAMES — never on a duration, which belongs to
    // the machine.
    const timing = getLogger("executor");
    const cycles = () =>
      timing.getTimeStats("executor", "wave", "cycle")?.count ?? 0;
    const drains = () =>
      timing.getTimeStats("executor", "wave", "drain")?.count ?? 0;
    const settles = () =>
      timing.getTimeStats("executor", "wave", "settle")?.count ?? 0;
    const before = { cycle: cycles(), drain: drains(), settle: settles() };
    const recorded = Promise.withResolvers<void>();
    let finalDrains: number | undefined = undefined;
    const time = timing.time.bind(timing);
    using _time = stub(timing, "time", (...args) => {
      const result = time(...args);
      if (
        finalDrains !== undefined &&
        cycles() - before.cycle >= finalDrains
      ) recorded.resolve();
      return result;
    });

    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    openClient();
    const engine = await server.engineForSpace(space);

    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "wave-timing-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 7 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });

    // Read with the loop stopped. A running loop records a cycle's drain
    // before the cycle that encloses it, so the counts differ by one at an
    // arbitrary observation point and only agree at rest.
    await host.close();
    // Closing releases the runtimes and leases. The cancelled cycle records
    // its final span when its remaining transport continuations complete.
    finalDrains = drains() - before.drain;
    if (cycles() - before.cycle >= finalDrains) recorded.resolve();
    await recorded.promise;

    // Every cycle runs its drain and its settle, so at rest the three
    // counts agree — a phase recorded on only some paths through the cycle
    // shows up here as a shortfall rather than as a silently partial
    // picture of where a wave's time went.
    const served = cycles() - before.cycle;
    expect(served).toBeGreaterThanOrEqual(1);
    expect(drains() - before.drain).toBe(served);
    expect(settles() - before.settle).toBe(served);
  });

  it("retries a demanded root the loader could not start YET: demand precedes the instantiation commit (the creation race), the deferred ensure re-attempts on a later cycle, and the piece serves", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    // NO onServingRuntime pattern run: unlike the tests above, the
    // demanded structure must come up through the DEMAND LOADER
    // (`ensurePieceRunning`) — the production path they side-step.

    openClient();
    const engine = await server.engineForSpace(space);

    // The client's DEMAND, registered before the piece exists ANYWHERE:
    // the session open activates the space, and the demand cycle's
    // ensure runs against a result doc that carries no patternIdentity
    // meta yet — the false return this test pins the retry of. Read
    // under the result schema, so that once the piece exists the watch
    // reaches the computed doc behind `total` and demands its derivation.
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "race-result",
      TOTAL_RESULT_SCHEMA,
    );
    await clientResult.sync();

    // A pre-instantiation authored input: the argument doc commits
    // BEFORE any patternIdentity exists anywhere. The wave cycle that
    // covers it runs the demand loader with the result root already
    // listed (the watch above predates this commit) — the ensure
    // attempt this test is about, guaranteed to find no meta.
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "race-arg",
      undefined,
    );
    await clientArg.sync();
    const argTx = clientRuntime.edit();
    clientArg.withTx(argTx).set({ n: 41 });
    expect((await argTx.commit()).error).toBeUndefined();
    const preInstantiationSeq = Engine.serverSeq(engine);

    // Barrier (engine-side, deterministic): W covering that commit
    // proves the demand cycle that drained it COMPLETED — its
    // structure-load pass listed the result root and attempted the
    // ensure, which found no pattern identity. Everything below runs
    // strictly AFTER that failed first attempt.
    await awaitAdmitted(
      server,
      () => readWatermarkSeq(engine) >= preInstantiationSeq,
    );

    // The race's second half: the piece is instantiated by a separate,
    // short-lived SERVICE-principal session — deliberately. An ordinary
    // client that runs a piece also WATCHES the piece's sibling docs
    // (source, internals, the computed), and each of those watches is a
    // NEW demanded root whose own first ensure attempt — made after the
    // meta exists — follows the result chain back to the result cell
    // and starts the piece, healing the very terminal state this test
    // pins. The demand loop excludes service-principal sessions from
    // demand (serving-loop.md §1: the loop's own reads are not client
    // demand), so this instantiator leaves the demand set exactly as
    // the client built it: the result root and the argument root, both
    // first-attempted before any meta existed. Its instantiation
    // commit is an ordinary authored input on the feed.
    const instantiatorManager = SharedServerStorageManager.connectTo(
      server,
      { as: serviceSigner },
    );
    const instantiator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: instantiatorManager,
    });
    try {
      const compiled = await instantiator.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const instArg = instantiator.getCell<{ n: number }>(
        space,
        "race-arg",
        undefined,
      );
      const instResult = instantiator.getCell<{ total: number }>(
        space,
        "race-result",
        compiled.resultSchema,
      );
      // Presync and retry a stale-read conflict, as the loader
      // machinery itself would (the same idiom as the tests above).
      await instArg.sync();
      await instResult.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await instantiator.storageManager.synced();
      const tx = instantiator.edit();
      instantiator.run(tx, compiled, instArg, instResult);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `instantiation run failed: ${committed.error.message}`,
        );
      }
      await instantiator.idle();
    } finally {
      // The instantiator leaves; its local run dies with it. From here
      // on, only a SERVER-started piece can derive anything.
      await instantiator.dispose();
      await instantiatorManager.close();
    }

    // The wave input whose demanded derivation only a server-side
    // piece can produce: the instantiator computed 42 for n=41 before
    // it left, so a derivation for n=99 cannot come from anything but
    // the serving loop.
    const pokeTx = clientRuntime.edit();
    clientArg.withTx(pokeTx).set({ n: 99 });
    expect((await pokeTx.commit()).error).toBeUndefined();

    // The convergence this test exists for, gated ENGINE-side: a
    // computed revision riding a DERIVED-class commit can only be the
    // serving loop's piece (waves without a running piece are
    // watermark-only, and no effect completions exist here).
    // Deliberately NOT a client-side value read first: reading through
    // the result link would sync the computed doc and mint a fresh
    // demanded root — the same heal path the instantiator's principal
    // closes. Without the retry, the loader attempted both roots once
    // before the meta existed and never re-attempts: no piece, no
    // derived computed revision, this wait times out. With the retry,
    // the instantiation commit fires a demand cycle, the pending root
    // re-attempts once the meta is readable on the serving replica,
    // the piece starts, and the poke derives 100.
    const newestComputed = () =>
      engine.database.prepare(
        `SELECT c.class AS class, c.holder AS holder FROM revision r
         JOIN "commit" c ON c.seq = r.commit_seq
         WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
      ).get() as { class: string; holder: string } | undefined;
    await awaitAdmitted(server, () => newestComputed()?.class === "derived");
    expect(newestComputed()?.holder).toBe(host.spaceServer(space)!.holder);

    // Only now read through the client: the derived value reached the
    // demanding subscriber (M4 push + link traversal).
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 100,
      { stuckLabel: "the client's total to reach 100" },
    );

    // §7: the not-loadable-yet attempt was COUNTED, not silent — since
    // stage P2-F as the TERMINAL class (confirmed-synced-no-meta parks
    // the root instead of re-deferring every cycle), the instantiation
    // commit RE-ARMED it (the not-yet half of OW19's not-yet-vs-never),
    // and none of the attempts THREW (classifications and failures stay
    // distinct counters).
    const stats = host.stats();
    expect(stats.structureLoadTerminal).toBeGreaterThanOrEqual(1);
    expect(stats.structureLoadRearmed).toBeGreaterThanOrEqual(1);
    expect(stats.structureLoadFailures).toBe(0);
  });

  it("lands a resumed map derivation whose result container was never persisted: the recovery seed commits bookkeeping-class instead of storming the §3d unstamped refusal (lunch-gate leg A)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    // Phase 1 — author the piece under CLIENT SPECULATION, the production
    // client posture under EXPERIMENTAL_SERVER_EXECUTION: the piece's
    // setup and argument writes commit durably (unstamped txs commit as
    // today), but every derivation-kind write — the map's result
    // container included — routes to the process-memory overlay and
    // NEVER commits (speculation.md §6). The store this leaves behind is
    // exactly the lunch-gate shape: a durable map piece whose result
    // container has no durable doc. Service principal, like the
    // creation-race test above: its session must not mint demand
    // (serving-loop.md §1), so the demand set stays exactly what the
    // client builds below.
    const authorManager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const author = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: authorManager,
      experimental: { serverExecution: true },
    });
    try {
      const compiled = await author.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
            "  return { doubled: items.map((item) => item.n * 2) };",
            "});",
          ].join("\n"),
        }],
      }, { space });
      const authorArg = author.getCell<{ items: { n: number }[] }>(
        space,
        "seed-arg",
        undefined,
      );
      await authorArg.sync();
      const argTx = author.edit();
      authorArg.withTx(argTx).set({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] });
      expect((await argTx.commit()).error).toBeUndefined();
      const authorResult = author.getCell<{ doubled: number[] }>(
        space,
        "seed-result",
        compiled.resultSchema,
      );
      // Presync and retry a stale-read conflict, as the loader machinery
      // itself would (the same idiom as the tests above).
      await authorArg.sync();
      await authorResult.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await author.storageManager.synced();
      const tx = author.edit();
      author.run(tx, compiled, authorArg, authorResult);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `author pattern run failed: ${committed.error.message}`,
        );
      }
      await author.idle();
    } finally {
      // The author leaves; its speculative derivations die with its
      // overlay. From here on, only a SERVER-resumed piece can
      // materialize the map's output.
      await author.dispose();
      await authorManager.close();
    }

    // Phase 2 — an ordinary client demands the result root. The demand
    // loader resumes the piece on the serving runtime (the fresh-runtime
    // resume path, awaitSync held), whose map coordinator finds the
    // result container durably ABSENT: the container pull settles with
    // nothing, and the builtin's recovery seed — an out-of-band
    // editWithRetry, no scheduler run around it — must seed [] so the
    // coordinator is not wedged. On a serving runtime that seed seals
    // into the wave, where §3d REFUSES unstamped transactions: without
    // the bookkeeping stamp the seed storms the refusal forever and the
    // demanded derivation NEVER lands (the lunch-gate red).
    openClient();
    const clientResult = clientRuntime.getCell<{ doubled: number[] }>(
      space,
      "seed-result",
      undefined,
    );
    await clientResult.sync();

    // The wave input that drives the demand cycle — and NEW map items,
    // so the landed derivation is unambiguously the server's (the
    // author's speculative run saw [1, 2, 3]).
    const clientArg = clientRuntime.getCell<{ items: { n: number }[] }>(
      space,
      "seed-arg",
      undefined,
    );
    await clientArg.sync();
    const pokeTx = clientRuntime.edit();
    clientArg.withTx(pokeTx).set({ items: [{ n: 2 }, { n: 3 }, { n: 4 }] });
    expect((await pokeTx.commit()).error).toBeUndefined();

    // The demanded derivation LANDS server-side and reaches the client
    // through ordinary push + link traversal. A plain client never runs
    // the piece itself (established by the tests above: only the serving
    // loop derives here), so this value can only be the resumed map —
    // seeded container, per-element runs, aggregate rebuilt.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("doubled"),
      (doubled: unknown) => JSON.stringify(doubled ?? null) === "[4,6,8]",
      { stuckLabel: "the client's doubled array to reach [4,6,8]" },
    );

    // The throw storm is GONE, by counter (serving-loop.md §7: tests
    // assert on counters, not logs): every seal the serving runtime saw
    // declared its run context — the recovery seed included.
    const stats = host.stats();
    expect(stats.unstampedSealRefusals).toBe(0);
    // §7's servedIntentSealFailures (Phase-4 independent review
    // NOTE-b): live in the stats block, zero on a healthy loop — no
    // navigate intent's seal failed here.
    expect(stats.servedIntentSealFailures).toBe(0);
    expect(stats.derivedCommits).toBeGreaterThanOrEqual(1);
    expect(stats.structureLoadFailures).toBe(0);
  });

  it("registers NO piece demand for never-a-piece id classes: computed:/cid:/watermark roots neither retry nor count as deferred (RULED 2026-08-07)", async () => {
    host = newHost({ flushDeadlineMs: 2_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const engine = await server.engineForSpace(space);

    // The client demands ONLY never-a-piece roots: the watermark doc
    // (every settledness subscription's watch), a `computed:` doc, and
    // a `cid:` doc (a content-addressed bundle — the ruled class this
    // exclusion test previously left unexercised). None can ever carry
    // `patternIdentity` meta, so a piece-demand attempt on them is
    // structurally futile churn — the ruled exclusion. The demand
    // SINKs still register (value-granular pull is not piece demand).
    const wmCell = clientRuntime.getCellFromLink<{ seq?: number }>(
      watermarkDocLink(space),
    );
    await wmCell.sync();
    const computedProbe = clientRuntime.getCellFromLink<unknown>({
      space,
      id: "computed:fid1:r2-exclusion-probe" as never,
      path: [],
    });
    await computedProbe.sync();
    const cidProbe = clientRuntime.getCellFromLink<unknown>({
      space,
      id: "cid:bafyr2exclusionprobe" as never,
      path: [],
    });
    await cidProbe.sync();
    await activated();

    // Drive several demand cycles with UNWATCHED authored input: an
    // address-level blind write mints no watch root (the cell route
    // registers a watch), so the demanded-root set stays exactly the
    // three never-a-piece ids.
    const kickId = "of:r2-exclusion-kick";
    for (const n of [1, 2, 3]) {
      const tx = clientRuntime.edit();
      tx.writeValueOrThrow(
        { space, id: kickId as never, scope: "space", path: ["n"] },
        n,
      );
      expect((await tx.commit()).error).toBeUndefined();
      // The kick's own seq, read from its document's head rather than the
      // space's: the commit resolves only once the client's view reflects
      // it, so the wave commit that advances W over the kick can land
      // first, and W never covers that advance-only commit.
      const kickSeq = Engine.selectDocHead(engine, {
        id: kickId as never,
        scopeKey: "space",
      });
      // Each kick gets its own cycle rather than sharing one, which is
      // what makes the deferral counter below a per-root observation.
      // The target is THIS kick's seq: a watermark that already covers an
      // earlier kick says nothing about this one.
      await awaitEach(cycles, () => readWatermarkSeq(engine) >= kickSeq);
    }

    // The ruled counter behavior: excluded roots produce ZERO deferral
    // churn (the counter stays meaningful for genuinely
    // not-yet-loadable pieces) and no failures.
    const stats = host.stats();
    expect(stats.structureLoadDeferred).toBe(0);
    expect(stats.structureLoadFailures).toBe(0);
  });

  it("holds W until loopback frames deliver at a REAL refresh cadence: the settle's server.idle() drain is load-bearing (protocol.md §4)", async () => {
    // The other tests run `subscriptionRefreshDelayMs: 0`, which masks
    // the settle's `server.idle()` drain: the refresh timer fires
    // before the settle's yield and delivers the loopback frames
    // anyway. Here the refresh delay is set ABOVE the flush deadline
    // (the production default, 5 ms, exhibits the same race — this
    // margin makes the probe deterministic on slow CI), so frame
    // delivery inside the settle happens ONLY through the explicit
    // drain. Remove `await this.#options.server.idle()` from
    // SpaceServer's settle and this test fails: the settle declares
    // quiescence before the authored commit's dirtiness ever reaches
    // the serving scheduler, W advances over the undelivered input,
    // and the strict settled ⇒ current assertion below reads a stale
    // derived value.
    server = newSharedServer({ subscriptionRefreshDelayMs: 400 });
    host = newHost({ flushDeadlineMs: 300, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "drain-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "drain-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "drain-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "drain-arg",
      undefined,
    );
    await clientArg.sync();

    // Phase 1 — prime: first authored write, settle, observe the
    // derived value. This also establishes the client's watermark-doc
    // watch, so phase 2's frames arrive on a LIVE subscription (the
    // strict assertion's precondition, as in the first test).
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );

    // Phase 2 — the strict W-soundness probe (protocol.md §4): with
    // the subscriptions live, "settled" must mean the demanded
    // derivation is ALREADY current — the derived value and the
    // watermark ride one wave commit and one push frame, so this read
    // is synchronous. Under the mutation (settle drain removed) the
    // wave advances W without the recompute, the flush carries the
    // watermark upsert alone, and this read sees the STALE total.
    const tx2 = clientRuntime.edit();
    clientArg.withTx(tx2).set({ n: 99 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authored2, {
      timeoutMs: 10_000,
    });
    expect(clientResult.key("total").get()).toBe(100);
  });

  it("hot-swaps a pattern SERVER-side: a client's pattern-pointer write dirties the piece and the SpaceServer swaps (serving-loop.md §3e, OW6)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    // §3e's posture: the watcher and the swap live in the SpaceServer.
    // The SWAP half — the patternIdentity sink reacting to a pointer
    // write, teardown + reinstantiation included — is what this test
    // drives, and it is installed with the piece (gated only by
    // doNotUpdateOnPatternChange). Following an origin is separate and
    // belongs to whoever opens a piece; a serving tenure opens none.

    let v2Ref: { identity: string; symbol: string } | undefined;
    onServingRuntime = async (runtime) => {
      const compileProgram = (expression: string) => ({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            `  ({ n }) => ({ total: computed(() => ${expression}) }),`,
            ");",
          ].join("\n"),
        }],
      });
      const v1 = await runtime.patternManager.compilePattern(
        compileProgram("n + 1"),
        { space },
      );
      const v2 = await runtime.patternManager.compilePattern(
        compileProgram("n + 2"),
        { space },
      );

      // v2's durable {identity, symbol}: the content-addressed entry
      // ref the compile indexed — exactly what the updater's pointer
      // write names.
      v2Ref = getArtifactEntryRef(v2);

      // The served piece runs v1.
      const argument = runtime.getCell<{ n: number }>(
        space,
        "swap-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "swap-result",
        v1.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, v1, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "swap-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "swap-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 15_000,
    });
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );

    // The pattern-pointer write: an ordinary AUTHORED input under the
    // updater's principal (here, the client) — the swap is the SERVER
    // reacting to it (serving-loop.md §3e; runtime-mapping N40/N41).
    expect(v2Ref?.identity).toBeDefined();
    // Baseline BEFORE the swap: the post-swap assertions below must
    // pin the SWAPPED derivation's own commit, not be satisfiable by
    // v1's pre-swap derived commits.
    const preSwapHead = Engine.serverSeq(engine);
    const pointerTx = clientRuntime.edit();
    clientResult.withTx(pointerTx).setMetaRaw(
      "patternIdentity",
      v2Ref!,
      rawMetaWriteAuthorization,
    );
    expect((await pointerTx.commit()).error).toBeUndefined();

    // The SpaceServer's watcher swaps to v2 and the wave serves the new
    // derivation: total becomes 43 without any client-side run — OW6's
    // substance: the pointer write is an ordinary authored input, and
    // the swap is the server reacting.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 43,
      { stuckLabel: "the client's total to reach 43 after the swap" },
    );
    // The SWAPPED derivation's own commit: derived-class commits landed
    // AFTER the pre-swap baseline, under the loop's own holder — v1's
    // earlier derived commits cannot satisfy this.
    const swapDerived = engine.database.prepare(
      `SELECT seq, holder FROM "commit"
       WHERE class = 'derived' AND seq > :preSwapHead ORDER BY seq`,
    ).all({ preSwapHead }) as { seq: number; holder: string }[];
    expect(swapDerived.length).toBeGreaterThanOrEqual(1);
    for (const row of swapDerived) {
      expect(row.holder).toBe(host.spaceServer(space)!.holder);
    }
    // And the value the client observed (43) is the NEWEST computed
    // revision, riding one of those post-swap derived commits.
    const latestComputed = engine.database.prepare(
      `SELECT c.class AS class, c.seq AS seq FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.id LIKE 'computed:%' ORDER BY r.seq DESC LIMIT 1`,
    ).get() as { class: string; seq: number } | undefined;
    expect(latestComputed?.class).toBe("derived");
    expect(latestComputed!.seq).toBeGreaterThan(preSwapHead);
    // Watermark note, deliberate: W is NOT asserted past the pointer
    // write here. The swap's by-identity reload can leave a module-doc
    // sync pending in this fully-local fixture, and an outstanding
    // demanded load legitimately pins W (protocol.md §4: W covers
    // demanded derivations CURRENT through W) — the flagged stage-F
    // settle residual, exercised properly against a real patterns route
    // in the integration environment.
  });

  it("parks on lease loss when a rival holds the lease (serving-loop.md §2)", async () => {
    host = newHost({
      flushDeadlineMs: 1_000,
      idleParkMs: 600_000,
      renewIntervalMs: 25,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "lease-loss-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await activated();
    const spaceServer = host.spaceServer(space)!;
    const engine = await server.engineForSpace(space);

    // Simulate expiry + takeover: the row disappears and a RIVAL takes
    // it, so renewal fails AND reacquire fails — the space parks.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    const rival = executionLeaseHolder("did:key:rival-process");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);

    await parked();
    expect(host.stats().lease.lost).toBeGreaterThanOrEqual(1);
    expect(host.stats().activeSpaces).toBe(0);
  });

  it("leaves a space unserved while a rival process holds its lease, and serves it once that lease is gone (serving-loop.md §2)", async () => {
    const engine = await server.engineForSpace(space);
    const rival = executionLeaseHolder("did:key:activation-rival");
    expect(
      acquireExecutionLease(engine, { space, holder: rival, ttlMs: 600_000 }),
    ).toBe(true);

    let built = 0;
    onServingRuntime = () => {
      built += 1;
      return Promise.resolve();
    };
    host = newHost();
    openClient();
    const demand = clientRuntime.getCell<{ value: number }>(
      space,
      "rival-lease-demand",
      undefined,
    );
    await demand.sync();
    // The admission trigger's own precondition, checked rather than
    // assumed: with a live client session an authored admission
    // activates, so the notice below reaches the refusal.
    expect(
      server.hasLiveSessionsForSpace(space, {
        excludePrincipal: serviceSigner.did(),
      }),
    ).toBe(true);
    server.noteExecutorCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "rival-lease-issuer",
      writes: [{ id: "of:rival-lease-c1", scopeKey: "space" }],
    });
    // The notice entered the activation synchronously, and close()
    // awaits every activation in flight — so this is the refusal
    // landing, not a guess at when it lands.
    await host.close();

    // The refusal precedes the runtime factory: a second deriver builds
    // nothing, registers nothing, and leaves the rival's row alone.
    expect(built).toBe(0);
    expect(host.stats().lease.held).toBe(0);
    expect(host.spaceServer(space)).toBeUndefined();
    expect(liveExecutionLeaseHolder(engine, space)).toBe(rival);

    // The control: with the row released, the SAME trigger against the
    // SAME live session serves the space — so the refusal above is the
    // lease's doing, not a trigger that never fired.
    releaseExecutionLease(engine, { space, holder: rival });
    host = newHost();
    server.noteExecutorCommit({
      space,
      seq: Engine.serverSeq(engine),
      class: "authored",
      sessionId: "rival-lease-issuer",
      writes: [{ id: "of:rival-lease-c2", scopeKey: "space" }],
    });
    await activated();
    expect(built).toBe(1);
  });

  it("parks on a renew-blip mid-wave abort, then re-activates for the live client: reacquire succeeds, the aborted tenure still parks, W does not move, and a fresh tenure serves (serving-loop.md §1, §2)", async () => {
    // The renew-blip interleave, end to end: (1) a wave opens (a seal
    // captures the CURRENT lease tenure); (2) the lease row vanishes
    // (expiry analogue) with NO rival, so the next renew tick FAILS and
    // the same-process reacquire SUCCEEDS — tenure bumps while the
    // sealed wave is still uncommitted; (3) the wave reaches its commit
    // step under the bumped tenure and aborts, its sealed writes
    // withdrawn. The pinned behavior: the space PARKS on that abort.
    // The pre-fix loop continued instead — and since nothing re-arms a
    // withdrawn derivation's producer (no revert consumer; inputs
    // unchanged) while #coverageHead had already claimed the batch, the
    // next cycle minted a watermark-only advance claiming work that
    // never re-ran. Deterministic mid-wave hold: the test manager's
    // settleGate hangs the settle's inputSynced barrier, keeping the
    // sealed wave open across the blip without any product-code hook.
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      renewIntervalMs: 25,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "renew-blip-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await activated();
    const spaceServer = host.spaceServer(space)!;
    const engine = await server.engineForSpace(space);
    // Let the activation-triggered cycle finish (its watermark-only
    // advance claims the authored input) so the loop sits in
    // wait-for-input — not mid-settle — before the gate closes.
    const authoredSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);

    // Close the gate, then open a wave: a stamped tx on the SERVING
    // runtime seals into the wave (capturing the current tenure); its
    // commit step cannot run until the settle passes the gated
    // inputSynced barrier.
    const manager = servingRuntime!
      .storageManager as SharedServerStorageManager;
    const gate = Promise.withResolvers<void>();
    manager.settleGate = gate.promise;
    const probeCell = servingRuntime!.getCell<{ n: number }>(
      space,
      "renew-blip-probe",
      undefined,
    );
    await probeCell.sync();
    const probeTx = servingRuntime!.edit();
    stampWaveRunContext(probeTx, {
      actionId: "test/renew-blip-probe",
      kind: "derivation",
    });
    probeCell.withTx(probeTx).set({ n: 1 });
    // Resolves at SEAL (the wave holds the store commit).
    expect((await probeTx.commit()).error).toBeUndefined();

    // The blip: the row vanishes with NO rival. The next renew tick
    // fails (tenure ends) and the same-process reacquire succeeds
    // (tenure bumps) — while the sealed wave is still gated open.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    // The reacquire reports itself to the memory server, and the failed
    // tick and the restored row are what produced it. The renew arm is
    // timer-driven, so this notice is the only edge it has.
    await reacquires.reached(1);
    expect(host.stats().lease.lost).toBeGreaterThanOrEqual(1);
    expect(liveExecutionLeaseHolder(engine, space)).toBe(spaceServer.holder);
    const watermarkBefore = readWatermarkSeq(engine);

    // Open the gate: the settle resumes, the wave reaches its commit
    // step under the bumped tenure and aborts — and the space PARKS
    // (the pre-fix loop stayed active here, which is what this wait
    // pins against).
    gate.resolve();
    await parked();
    manager.settleGate = undefined;
    // Soundness: no watermark movement rode the aborted wave, and no
    // continued loop minted a watermark-only advance after it.
    expect(readWatermarkSeq(engine)).toBe(watermarkBefore);
    expect(spaceServer.active).toBe(false);
    expect(host.stats().lease.lost).toBeGreaterThanOrEqual(1);

    // The client's session outlives the abort, so the space still meets
    // the ACTIVE criteria (serving-loop.md §1). Nothing else arrives to
    // wake it: the host re-activates it on its own, and the fresh
    // tenure's runtime recomputes what the aborted wave withdrew.
    await awaitEach(
      activations,
      () =>
        activations.count((entry) =>
          entry.space === space && entry.outcome === "active"
        ) === 2,
    );
    const successor = host.spaceServer(space)!;
    expect(successor).not.toBe(spaceServer);
    expect(successor.active).toBe(true);
    expect(liveExecutionLeaseHolder(engine, space)).toBe(successor.holder);
  });

  it("parks at the first derived commit the memory server refuses for a lapsed lease, before any renewal notices the lapse (serving-loop.md §2)", async () => {
    // Neither renewal driver comes due during this test: the interval
    // timer is set past its end, and the mid-wave check waits for a
    // third of the TTL. The refusal is the only sign of the lapse.
    const refusals = new ArrivalLog<string>();
    let cyclesAtRefusal: number | undefined;
    decorateWaveCommitSink = (sink) => {
      const intrusionSince = sink.intrusionSince?.bind(sink);
      return {
        currentHeads: (s, docs) => sink.currentHeads(s, docs),
        concurrentWritePaths: (s, doc, sinceSeq) =>
          sink.concurrentWritePaths(s, doc, sinceSeq),
        ...(intrusionSince === undefined ? {} : { intrusionSince }),
        commitWave: async (batch) => {
          const result = await sink.commitWave(batch);
          if (batch.home && result.error !== undefined) {
            cyclesAtRefusal ??= cycles.entries.length;
            refusals.record(result.error.message);
          }
          return result;
        },
      };
    };
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      renewIntervalMs: 600_000,
      leaseTtlMs: 600_000,
    });
    onServingRuntime = runIncrementPattern;
    openClient();
    const engine = await server.engineForSpace(space);
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "serving-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "serving-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    // Under the live lease the store accepts the loop's commits.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const spaceServer = host.spaceServer(space)!;
    await awaitEach(cycles, () => spaceServer.suspendedOnInput);
    expect(refusals.entries).toEqual([]);

    // The lapse: the row still names this holder, but it has expired,
    // and no rival takes it.
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: spaceServer.holder,
        now: 0,
        ttlMs: 1,
      }),
    ).toBe(true);
    expect(liveExecutionLeaseHolder(engine, space)).toBeUndefined();
    const watermarkBefore = readWatermarkSeq(engine);
    const countDerived = () =>
      (engine.database.prepare(
        `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'derived'`,
      ).get() as { n: number }).n;
    const derivedBefore = countDerived();

    // The next input drives a wave whose commit the store refuses. The
    // wait also ends on a second refusal, or on the end of the cycle that
    // was refused, so that a loop still serving fails the assertions
    // below rather than leaving the wait stuck.
    const tx2 = clientRuntime.edit();
    clientArg.withTx(tx2).set({ n: 99 });
    expect((await tx2.commit()).error).toBeUndefined();
    await awaitEdges(
      [parks.edge, refusals.edge, cycles.edge],
      () =>
        parks.entries.length > 0 || refusals.entries.length > 1 ||
        (cyclesAtRefusal !== undefined &&
          cycles.entries.length > cyclesAtRefusal),
    );
    expect(refusals.entries).toHaveLength(1);
    expect(refusals.entries[0]).toContain("execution_lease");
    expect(spaceServer.active).toBe(false);
    await parked();
    expect(parks.entries).toEqual([{ space, reason: "lease-lost-abort" }]);
    expect(host.stats().lease.lost).toBe(1);
    expect(countDerived()).toBe(derivedBefore);
    expect(readWatermarkSeq(engine)).toBe(watermarkBefore);
  });

  it("parks on a serving-loop failure instead of leaving a zombie holding the lease (thread r3731191431)", async () => {
    // A policy whose flushDeadlineMs getter can be made to throw: the
    // loop reads it once per wave cycle, so flipping `blowUp` makes the
    // NEXT cycle fail inside #waveCycle — a stand-in for any transient
    // loop failure. The pinned behavior: the loop's failure PARKS the
    // space (lease released, host hooks can recover); the pre-fix loop
    // died silently while the space stayed active and the renew timer
    // kept the lease alive forever — serving nothing, blocking every
    // successor.
    let blowUp = false;
    host = newHost(
      {
        idleParkMs: 600_000,
        renewIntervalMs: 25,
        get flushDeadlineMs(): number {
          if (blowUp) throw new Error("induced loop failure");
          return 1_000;
        },
      } as ConstructorParameters<typeof ExecutorHost>[0]["policy"],
    );
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "loop-failure-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await activated();
    const spaceServer = host.spaceServer(space)!;

    // Fail the next cycle and wake the loop.
    blowUp = true;
    spaceServer.noteDemandChanged();

    await parked();
    // The distinguishing observation: the pre-fix loop died with the
    // space still ACTIVE (the wait above would never return) and the
    // renew timer alive. whenParked resolves only after this tenure's
    // park path completed — renew stopped, runtime disposed, lease
    // released.
    await withStuckNet(
      spaceServer.whenParked,
      "the aborted wave's park to complete",
    );

    // What follows the failure park is the host's DESIGNED recovery arm:
    // the still-open client session is live demand, so the host
    // re-activates — and, with this policy failing every cycle, parks
    // and recovers again; with #5729's event-loop-turn frame delivery
    // the re-acquire outruns any released-gap probe. Close the host to
    // end recovery, then pin the no-zombie contract: nothing is left
    // renewing, so the lease frees for a rival. (Poll rather than probe
    // once: close() does not await a self-initiated park already in
    // flight, so the final tenure's release can land a beat later.)
    await host.close();
    const engine = await server.engineForSpace(space);
    const rival = executionLeaseHolder("did:key:loop-failure-rival");
    await awaitEach(
      cycles,
      () => acquireExecutionLease(engine, { space, holder: rival }),
    );
    releaseExecutionLease(engine, { space, holder: rival });
  });

  it("re-activates a space whose serving loop failed while its client's session is still live, with no further trigger (serving-loop.md §1)", async () => {
    // The client opens its session with a read and writes nothing, so no
    // admission races the park: the only thing that can bring the space
    // back is the host re-evaluating the ACTIVE criteria after the park.
    let failNextCycle = true;
    host = newHost({
      idleParkMs: 600_000,
      get flushDeadlineMs(): number {
        if (failNextCycle) {
          failNextCycle = false;
          throw new Error("induced transient loop failure");
        }
        return 1_000;
      },
    });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "loop-failure-recovery-input",
      undefined,
    );
    await input.sync();

    await parked();
    expect(activations.entries).toEqual([{ space, outcome: "active" }]);
    expect(parks.entries).toEqual([{ space, reason: "loop-failed" }]);

    await awaitEach(
      activations,
      () =>
        activations.count((entry) =>
          entry.space === space && entry.outcome === "active"
        ) === 2,
    );
    expect(host.spaceServer(space)?.active).toBe(true);
    expect(host.stats().reactivationBackoffs).toBe(1);

    // The successor serves: the client's first write is covered.
    const engine = await server.engineForSpace(space);
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);
  });

  for (
    const { failure, induce, expectedParks } of [
      {
        failure: "activation failed",
        induce: () => {
          factoryFailures = 1;
        },
        expectedParks: [{ space, reason: "activation-failed" }],
      },
      {
        failure: "engine failed to open on activation",
        induce: () => {
          engineOpenFailures = 1;
        },
        // No tenure exists yet, so nothing parks.
        expectedParks: [],
      },
    ]
  ) {
    it(`re-activates a space whose ${failure} while its client's session is still live, after the failure-park backoff (serving-loop.md §1)`, async () => {
      // As above, the session opens with a read, so the session-open
      // activation that fails is the only trigger there is.
      induce();
      host = newHost({ idleParkMs: 600_000 });
      onServingRuntime = () => Promise.resolve();
      openClient();
      const input = clientRuntime.getCell<{ value: number }>(
        space,
        "activation-failure-recovery-input",
        undefined,
      );
      await input.sync();

      await activated();
      expect(activations.entries).toEqual([
        { space, outcome: "failed" },
        { space, outcome: "active" },
      ]);
      expect(parks.entries).toEqual(expectedParks);
      expect(host.stats().reactivationBackoffs).toBe(1);
      expect(host.accessForTestingOnly.failureParkStreaks.get(space)).toBe(1);

      // The successor serves: the client's first write is covered.
      const engine = await server.engineForSpace(space);
      const tx = clientRuntime.edit();
      input.withTx(tx).set({ value: 1 });
      expect((await tx.commit()).error).toBeUndefined();
      const authoredSeq = Engine.serverSeq(engine);
      await awaitAdmitted(
        server,
        () => readWatermarkSeq(engine) >= authoredSeq,
      );
    });
  }

  it("leaves a space parked on a rival's lease to the rival: no activation attempt of its own and no backoff, though the client's session is still live (serving-loop.md §1, §2)", async () => {
    host = newHost({ idleParkMs: 600_000, renewIntervalMs: 25 });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "rival-park-input",
      undefined,
    );
    await input.sync();
    await activated();
    const first = host.spaceServer(space)!;
    const engine = await server.engineForSpace(space);

    // A rival takes the row, so the next renewal fails and so does the
    // re-acquire.
    releaseExecutionLease(engine, { space, holder: first.holder });
    const rival = executionLeaseHolder("did:key:rival-park-process");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
    await withStuckNet(first.whenParked, "the rival-lease park");
    expect(parks.entries).toEqual([{ space, reason: "lease-lost" }]);

    // With the rival gone, the client's next write is what activates the
    // space. Had the park chained an activation of its own, that
    // activation would already be sleeping out a backoff, and this one
    // would join it.
    releaseExecutionLease(engine, { space, holder: rival });
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);
    expect(activations.entries).toEqual([
      { space, outcome: "active" },
      { space, outcome: "active" },
    ]);
    expect(host.stats().reactivationBackoffs).toBe(0);
  });

  it("completes the park when the factory dispose never resolves: whenParked resolves, the lease frees, and a re-activation drains new input (lunch-wall containment)", async () => {
    // The lunch-wall persistence mechanism: a loop failure parks the
    // space, the park awaits the factory dispose, and a serving runtime
    // killed mid-wave can hang that dispose FOREVER — whenParked never
    // resolves, every chained recovery (#reactivateAfterPark) waits
    // behind it for eternity, and the space is permanently unserved
    // while events append durably. Park liveness must not gate on an
    // unbounded dispose: by dispose time the semantic obligations are
    // already met (loop stopped, wave abandoned, seal chain drained),
    // so the dispose gets a DEADLINE — on overrun the handle is
    // abandoned (crash-equivalent teardown, the sanctioned model for
    // abandoned waves) and the park completes anyway.
    const created: {
      runtime: Runtime;
      manager: SharedServerStorageManager;
    }[] = [];
    let blowUp = false;
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        created.push({ runtime, manager });
        // The never-resolving dispose: the hang, made deterministic.
        // The real teardown happens in the test's own cleanup below.
        return { runtime, dispose: () => new Promise<void>(() => {}) };
      },
      policy: {
        idleParkMs: 600_000,
        renewIntervalMs: 25,
        parkDisposeTimeoutMs: 100,
        get flushDeadlineMs(): number {
          if (blowUp) throw new Error("induced loop failure");
          return 1_000;
        },
      } as ConstructorParameters<typeof ExecutorHost>[0]["policy"],
      onWaveCycle: cycles.record,
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
      onSpaceParked: (parkedSpace, reason) =>
        parks.record({ space: parkedSpace, reason }),
    });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const engine = await server.engineForSpace(space);

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "hung-dispose-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await activated();
    const first = host.spaceServer(space)!;

    // Fail the next cycle and wake the loop: park("loop-failed") runs
    // against the hung dispose.
    blowUp = true;
    first.noteDemandChanged();

    // Park LIVENESS: `whenParked` resolves despite the hung dispose.
    // Pre-fix the park awaits the dispose forever, which the net below
    // reports rather than holding the suite open: the hung dispose keeps
    // the process alive, so nothing else would end the run.
    await withStuckNet(first.whenParked, "the hung-dispose park to complete");
    // Counted, not just logged (§7 posture).
    expect(host.stats().parkDisposeTimeouts).toBeGreaterThanOrEqual(1);

    // The lease released: a rival can take the row immediately.
    const rival = executionLeaseHolder("did:key:hung-dispose-rival");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
    releaseExecutionLease(engine, { space, holder: rival });

    // Recovery: the failure was transient; the host re-activates the
    // space for the client's live session (the host's designed recovery
    // arm) and a fresh tenure DRAINS the new input — the exact liveness
    // the zombie never had.
    blowUp = false;
    const tx2 = clientRuntime.edit();
    input.withTx(tx2).set({ value: 2 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    await activations.matching(() => {
      const current = host!.spaceServer(space);
      return current !== undefined && current !== first &&
        current.active === true;
    });
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authored2);

    // Cleanup: close the host (its parks are timeboxed over the same
    // hung-dispose factory), then tear down the abandoned runtimes for
    // real — the never-resolving dispose was the fixture, not a leak.
    await host.close();
    host = undefined;
    for (const entry of created) {
      await entry.runtime.dispose();
      await entry.manager.close();
    }
  });

  it("backs off failure-park re-activations: a permanently failing loop rebuilds at a bounded, growing spacing, and a served wave clears the streak", async () => {
    // The cascade flag behind the lunch wall's second half: once park
    // LIVENESS holds (the test above), a PERMANENTLY failing loop turns
    // from zombie into crash-loop — every admission chains a
    // re-activation, each rebuilds a full runtime, fails, and parks
    // (~300 reactivations/s observed). The host must back off repeated
    // failure-parks of the same space: streak-based exponential delay
    // (base·2^(streak−1), capped), counted in §7, cleared by a
    // successfully served wave.
    const activationTimes: number[] = [];
    const activationLog = new ArrivalLog<void>();
    let blowUp = true; // permanent failure, from the very first tenure
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        activationTimes.push(Date.now());
        activationLog.record();
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: {
        idleParkMs: 600_000,
        renewIntervalMs: 25,
        failureParkBackoffBaseMs: 150,
        failureParkBackoffMaxMs: 4_800,
        get flushDeadlineMs(): number {
          if (blowUp) throw new Error("induced permanent loop failure");
          return 1_000;
        },
      } as ConstructorParameters<typeof ExecutorHost>[0]["policy"],
      onWaveCycle: cycles.record,
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
      onSpaceParked: (parkedSpace, reason) =>
        parks.record({ space: parkedSpace, reason }),
    });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const engine = await server.engineForSpace(space);

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "backoff-input",
      undefined,
    );

    // The trigger feed — the "clicks keep arriving" analogue: authored
    // writes on a short cadence, each one an admission that chains a
    // re-activation of the failing space.
    let driving = true;
    const driverDone = (async () => {
      let n = 0;
      while (driving) {
        const tx = clientRuntime.edit();
        input.withTx(tx).set({ value: n++ });
        const committed = await tx.commit();
        if (committed.error !== undefined) {
          throw new Error(`driver write failed: ${committed.error.message}`);
        }
        await clientRuntime.storageManager.synced();
      }
    })();

    // Five tenures: the first undelayed, then four backoff-delayed
    // rebuilds (150, 300, 600, 1200ms minimum spacing).
    await activationLog.reached(5);
    driving = false;
    await driverDone;

    // The spacing bound: without backoff the gaps track the 15ms driver
    // cadence (the observed storm); with it, gap n is at least
    // base·2^(n−1) (capped). 10ms epsilon for clock granularity.
    const gaps = activationTimes.slice(1, 5).map(
      (t, i) => t - activationTimes[i],
    );
    const expectedMinimums = [150, 300, 600, 1200];
    for (let i = 0; i < expectedMinimums.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(expectedMinimums[i] - 10);
    }
    // Counted, not just logged (§7 posture).
    expect(host.stats().reactivationBackoffs).toBeGreaterThanOrEqual(4);

    // Recovery: the failure clears; the next tenure (possibly already
    // sleeping out its backoff) activates and SERVES — a wave commits,
    // which clears the streak.
    blowUp = false;
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1_000 });
    expect((await tx.commit()).error).toBeUndefined();
    const healthySeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= healthySeq);

    // The streak is CLEARED by the served wave: one fresh failure backs
    // off from the BASE again, not from the accumulated streak. With
    // the streak still at 5+ the next rebuild could not arrive before
    // 2400ms; cleared, it is due after ~150ms. The 1200ms ceiling
    // separates the two regimes with wide margin on both sides.
    // Capture the healthy tenure BEFORE inducing the failure, then
    // trigger the failing cycle with an ADMISSION, not
    // noteDemandChanged(): that wake only resolves a PARKED
    // #waitForInput and is lost when the loop is mid-cycle (the
    // healthy wave's self-echo drain) — a feed record instead
    // guarantees the next cycle runs and reads the throwing policy.
    const failing = host.spaceServer(space)!;
    blowUp = true;
    const failTx = clientRuntime.edit();
    input.withTx(failTx).set({ value: 1_001 });
    expect((await failTx.commit()).error).toBeUndefined();
    await withStuckNet(
      failing.whenParked,
      "the failing tenure's park to complete",
    );
    const failedAgainAt = Date.now();
    const countBefore = activationTimes.length;
    const trigger = clientRuntime.edit();
    input.withTx(trigger).set({ value: 1_002 });
    expect((await trigger.commit()).error).toBeUndefined();
    await activationLog.reached(countBefore + 1);
    const rebuildGap = activationTimes[countBefore] - failedAgainAt;
    expect(rebuildGap).toBeGreaterThanOrEqual(140);
    expect(rebuildGap).toBeLessThanOrEqual(1_200);

    // Quiesce before teardown: the tenure that just re-activated read
    // the policy while it still threw (or is about to) — let the doomed
    // park finish and a HEALTHY tenure serve before afterEach closes
    // the server, or a self-initiated park races server.close() into
    // the closed engine (observed: SqliteError at releaseExecutionLease).
    blowUp = false;
    const finalTx = clientRuntime.edit();
    input.withTx(finalTx).set({ value: 1_003 });
    expect((await finalTx.commit()).error).toBeUndefined();
    const finalSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= finalSeq);
  });

  it("a serving-runtime foreign-space write refuses at ACCUMULATION: the action fails loudly and counted, the wave and the loop survive (RULED 2026-08-14 (c))", async () => {
    // The lunch-wall trigger end to end: a wish materialization on the
    // serving runtime resolves against the SERVICE identity's home
    // space and writes it mid-wave. Pre-ruling, that write sealed fine
    // and the wave DIED at the commit step (#foreignEngineFor) —
    // loop-failed → park → (pre-containment) permanent zombie. Ruled
    // (c): the write refuses at accumulation, only the wish action
    // fails, the wave commits everything else, and the loop never
    // parks at all.
    host = newHost({ flushDeadlineMs: 2_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const engine = await server.engineForSpace(space);

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "foreign-refusal-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    await activated();
    const first = host.spaceServer(space)!;
    const authoredSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);

    // The trigger: a stamped serving-side tx writing a FOREIGN space
    // (the profile-bootstrap shape — the wish resolved the service's
    // home space, not the served space).
    const foreignSigner = await Identity.fromPassphrase(
      "serving loop foreign home",
    );
    const foreignSpace = foreignSigner.did() as MemorySpace;
    const profileCell = servingRuntime!.getCell<{ name: string }>(
      foreignSpace,
      "profile-bootstrap-doc",
      undefined,
    );
    await profileCell.sync();
    const probeTx = servingRuntime!.edit();
    stampWaveRunContext(probeTx, {
      actionId: "wish/profile",
      kind: "derivation",
    });
    profileCell.withTx(probeTx).set({ name: "bootstrap" });
    const committed = await probeTx.commit();
    // Action-scoped: THIS commit fails, loudly and counted.
    expect(committed.error).toBeDefined();
    expect(committed.error!.message).toContain("foreign-space write");
    expect(host.stats().foreignWriteRefusals).toBeGreaterThanOrEqual(1);

    // The loop SURVIVES — no loop-failed park, no tenure change: the
    // same SpaceServer instance keeps serving, and a subsequent client
    // write is drained by it.
    const tx2 = clientRuntime.edit();
    input.withTx(tx2).set({ value: 2 });
    expect((await tx2.commit()).error).toBeUndefined();
    const authored2 = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authored2);
    expect(host.spaceServer(space)).toBe(first);
    expect(first.active).toBe(true);
  });

  it("close() during a mid-flight activation leaves no serving zombie: the activated space parks and the lease frees (thread r3731191438)", async () => {
    host = newHost({ flushDeadlineMs: 1_000, idleParkMs: 600_000 });
    // Initiate close WHILE the activation is mid-flight (createRuntime
    // awaits this hook, deterministically interleaving the two).
    let closeStarted: Promise<void> | undefined;
    const closeRaces = new ArrivalLog<void>();
    onServingRuntime = () => {
      closeStarted = host!.close();
      closeRaces.record();
      return Promise.resolve();
    };
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "close-race-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await closeRaces.reached(1);
    await closeStarted;

    // After close() resolves: nothing serves this space, and the lease
    // row is free for a successor process — the pre-fix close returned
    // while the activation completed behind it, leaving an active
    // SpaceServer renewing a lease nobody could take.
    expect(host.spaceServer(space)?.active ?? false).toBe(false);
    const engine = await server.engineForSpace(space);
    const rival = executionLeaseHolder("did:key:close-race-rival");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
    releaseExecutionLease(engine, { space, holder: rival });
  });

  it("a service-principal session alone is not demand: session-open activation is gated like the admission path (thread r3731191525)", async () => {
    host = newHost({ flushDeadlineMs: 1_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();

    // A session under the SERVICE identity (a loopback plane, not a
    // client): its open must NOT activate the space — the loop would
    // hold a runtime and the lease with no client demanding anything.
    const serviceManager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const serviceRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: serviceManager,
    });
    try {
      const probe = serviceRuntime.getCell<{ value: number }>(
        space,
        "service-session-probe",
        undefined,
      );
      await probe.sync();
      // A wrong activation would settle like any other, and a real
      // client session's does below — so the FIRST activation this host
      // ever settles is the discriminator.
      expect(activations.entries).toEqual([]);
      expect(host.spaceServer(space)).toBeUndefined();

      // A real CLIENT session still activates.
      openClient();
      const clientProbe = clientRuntime.getCell<{ value: number }>(
        space,
        "service-session-probe",
        undefined,
      );
      await clientProbe.sync();
      await activated();
    } finally {
      await serviceRuntime.dispose();
      await serviceManager.close();
    }
  });

  it("parks an idle space with no live sessions (IDLE_PARK_MS), releasing the lease", async () => {
    server = newSharedServer({ sessionTtlMs: 50 });
    host = newHost({
      flushDeadlineMs: 500,
      idleParkMs: 100,
    });
    onServingRuntime = () => Promise.resolve();
    openClient();

    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "idle-park-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();

    await activated();
    const holder = host.spaceServer(space)!.holder;

    // Drop the client: its session detaches and expires (TTL 50ms), the
    // loop idles past IDLE_PARK_MS, and the space parks — releasing the
    // lease row (a rival can then acquire immediately).
    await clientRuntime.dispose();
    await clientManager.close();
    openClient();
    // The fresh client session keeps OTHER spaces alive only; close it
    // too so the space has no live sessions at all.
    await clientRuntime.dispose();
    await clientManager.close();
    openClient(); // leave a manager for afterEach teardown symmetry

    await parked();
    const engine = await server.engineForSpace(space);
    releaseExecutionLease(engine, { space, holder }); // no-op if released
    const rival = executionLeaseHolder("did:key:idle-rival");
    expect(acquireExecutionLease(engine, { space, holder: rival })).toBe(true);
  });

  it("parks even when the park report throws: the tenure is unregistered and whenParked resolves", async () => {
    // The report is a test diagnostic, and the rest of the host's park
    // handler unregisters the server; `whenParked` resolves after it.
    host = newHost({ idleParkMs: 600_000 });
    openClient();
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "park-observer-throw",
      undefined,
    );
    await clientResult.sync();
    await activated();
    const spaceServer = host.spaceServer(space)!;
    parkObserverThrows = true;
    // `park()` awaits the whole park, so the net belongs on it: a throw
    // that escaped the observer would leave this call unresolved.
    await withStuckNet(
      spaceServer.park("test-park-observer"),
      "the park to complete past a throwing observer",
    );
    await parks.matching((entry) => entry.reason === "test-park-observer");
    expect(host.spaceServer(space)).toBeUndefined();
  });

  it("serves a space whose activation report throws, and recovers it from a failed activation all the same", async () => {
    // The report is a test diagnostic. Here it throws on both of the
    // activation's outcomes: the failure the host recovers from, and the
    // activation that recovery starts, which goes on serving.
    activationObserverThrows = true;
    factoryFailures = 1;
    host = newHost({ idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();
    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "activation-observer-throw-input",
      undefined,
    );
    await input.sync();

    await activated();
    expect(activations.entries).toEqual([
      { space, outcome: "failed" },
      { space, outcome: "active" },
    ]);
    expect(host.spaceServer(space)?.active).toBe(true);

    const engine = await server.engineForSpace(space);
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= authoredSeq);
  });

  it("serves an effectful node behind request-hash memoization: miss fires ONCE via the outbox; recovery memo-hits; retries are input-driven (serving-loop.md §4–§6; T7.Q5, T10.Q4, OW7)", async () => {
    // The egress stub: the serving loop performs the effect (README
    // §3.8's server half); calls are counted per URL, and one URL
    // fails deterministically — the OW7 journey's failure leg.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("/fails")) {
        return Promise.reject(new Error("stubbed egress failure"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "effect-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "effect-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const engine = await server.engineForSpace(space);
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "effect-result",
      undefined,
    );
    await clientResult.sync();

    // Wait for ACTIVATION before writing the url: the harness's
    // factory-time pattern run predates the seal destination (the
    // stage-F "the run here IS the loaded structure" trick), so a url
    // visible at factory time would fire OUTSIDE the outbox. With the
    // url arriving as an authored wave input, the fetch node's miss
    // runs the stage-G path: seal -> defer -> outbox -> completion.
    await activated();
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "effect-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ url: "https://stage-g.test/one" });
    expect((await tx.commit()).error).toBeUndefined();

    // The miss fires exactly once; the completion commits its OWN
    // derived-class commit and the next wave serves the value — the
    // client observes it through ordinary push.
    // 30 s here and on this step's two later observation waits: this
    // file is deliberately real-clock, and under load the wave cycle
    // degrades to deadline-paced waves (flushDeadlineMs 5_000), so a
    // multi-wave leg legitimately overruns 15 s while still
    // progressing (the soak flake signature: rare timeout reds, zero
    // double-egress). Matches the recovery leg's 30 s "loaded box"
    // budget below.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("fetch").key("result"),
      (result: { from?: string } | undefined) =>
        result?.from === "https://stage-g.test/one",
      { stuckLabel: "the first leg's fetch result to render" },
    );
    expect(calls.filter((url) => url.endsWith("/one")).length).toBe(1);
    const stats1 = host.stats();
    // At least one miss/queued/completed (>=, not ===: a stale action
    // re-run may legitimately re-ADMIT the key — the claim-time
    // result-present guard makes the re-admit's flush a no-op, so the
    // EXTERNAL call count above is the exactly-once being pinned).
    expect(stats1.memo.misses).toBeGreaterThanOrEqual(1);
    expect(stats1.outbox.queued).toBeGreaterThanOrEqual(1);
    expect(stats1.outbox.completed).toBeGreaterThanOrEqual(1);
    // The post-completion re-run of the fetch action (its result-cell
    // dirtiness re-arms it in the next wave) resolves from the stored
    // key: the SS4 memo hit, counted live.
    await awaitEach(cycles, () => host!.stats().memo.hits >= 1);

    // Crash/park equivalence (T10.Q4, §6 step 3): park, then
    // re-activate on fresh input — the recovered runtime re-runs the
    // action against COMMITTED state; a first evaluation that sees the
    // stored requestHash memo-hits and re-fires nothing, and one that
    // raced its cell sync re-misses (the accepted at-least-once
    // duplicate). The assertions below pin exactly that contract.
    await host.spaceServer(space)!.park("test-recovery");
    await parked();
    const poke = clientRuntime.getCell<{ n: number }>(
      space,
      "effect-poke",
      undefined,
    );
    const pokeTx = clientRuntime.edit();
    poke.withTx(pokeTx).set({ n: 1 });
    expect((await pokeTx.commit()).error).toBeUndefined();
    // Captured AT the poke commit: a read after re-activation could
    // capture the recovered loop's own derived commit's seq, which W
    // never covers (self-echo is not coverage-owed input — the
    // anti-storm rule; serving-loop.md §3).
    const pokeSeq = Engine.serverSeq(engine);
    await activated();
    // Let the recovered loop claim the poke input before measuring —
    // the recovery churn (structure re-load, a possible re-miss) must
    // be over, or the bound below races it. Generous: recovery on a
    // loaded box legitimately takes several waves.
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= pokeSeq);
    // T10.Q4's ruled contract across recovery: memo hits suppress
    // re-firing COMPLETED effects, and the external call MAY duplicate
    // (at-least-once across crash/park — RULED and accepted; the
    // fired-marker was considered and REJECTED; a recovered runtime
    // whose first evaluation raced its cell sync re-misses once). The
    // pin is therefore BOUNDED, never unbounded growth — the
    // no-timer-retry property is pinned deterministically on the
    // failure leg below.
    expect(calls.filter((url) => url.endsWith("/one")).length)
      .toBeLessThanOrEqual(2);

    // OW7's failure leg: new inputs → new key → the miss fires and
    // FAILS; the failure commits an error-shaped RESULT with the key
    // (§4: retries are input-driven, never timer loops), so the call
    // count stays put until the inputs change again.
    const failTx = clientRuntime.edit();
    clientArg.withTx(failTx).set({ url: "https://stage-g.test/fails" });
    expect((await failTx.commit()).error).toBeUndefined();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("fetch").key("error"),
      (error: unknown) => error !== undefined,
      { stuckLabel: "the failing fetch's error to render" },
    );
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);
    // No timer retry, pinned DETERMINISTICALLY (round-2 thread 10): a
    // fixed wall-clock sleep proves nothing about a forbidden retry
    // armed on a longer interval or delayed by scheduling. Drive the
    // loop through additional full waves instead — input-driven
    // activity on an UNRELATED doc, each claimed by the watermark —
    // and assert the failed key still did not re-fire after the loop
    // demonstrably cycled several times.
    const retryProbe = clientRuntime.getCell<{ n: number }>(
      space,
      "no-timer-retry-probe",
      undefined,
    );
    for (let i = 1; i <= 3; i++) {
      // Head captured BEFORE the probe commit: a post-commit read can
      // capture the loop's own derived commit's seq, which W never
      // covers (self-echo is not coverage-owed input — the same trap
      // the recovery leg's poke documents). The probe's authored seq
      // is > seqBefore, and the only coverage-owed input in this quiet
      // phase, so W > seqBefore proves the loop claimed it.
      const seqBefore = Engine.serverSeq(engine);
      const probeTx = clientRuntime.edit();
      retryProbe.withTx(probeTx).set({ n: i });
      expect((await probeTx.commit()).error).toBeUndefined();
      await awaitAdmitted(server, () => readWatermarkSeq(engine) > seqBefore);
    }
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);

    // The input-driven retry: a THIRD url re-fires (fresh key), and the
    // effectful node recovers.
    const retryTx = clientRuntime.edit();
    clientArg.withTx(retryTx).set({ url: "https://stage-g.test/two" });
    expect((await retryTx.commit()).error).toBeUndefined();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("fetch").key("result"),
      (result: { from?: string } | undefined) =>
        result?.from === "https://stage-g.test/two",
      { stuckLabel: "the second leg's fetch result to render" },
    );
    expect(calls.filter((url) => url.endsWith("/two")).length).toBe(1);
    // FINAL stability re-check, after every later leg's waves and
    // writebacks have run: the steady-state legs stay exactly-once (a
    // broken memo-hit rule or a timer retry landing late would surface
    // here), and the recovery leg stays within its at-least-once bound.
    expect(calls.filter((url) => url.endsWith("/one")).length)
      .toBeLessThanOrEqual(2);
    expect(calls.filter((url) => url.endsWith("/fails")).length).toBe(1);
  });

  it("survives the deterministic A→B→A input cycle: the returning input re-fires instead of starving on a dead in-flight entry (completion-visibility F1a)", async () => {
    // The no-race wedge this pins closed: pre-F1a, a served effect's
    // completion resolved its verdict inline but the serving replica's
    // accept PARKED awaiting a catch-up marker that engine-plane commits
    // never stage — so the whenApplied retirement barrier never
    // resolved and the effect's in-flight entry never retired. An input
    // cycle A→B→A re-admits key A while the DEAD entry still holds it:
    // the re-admit dedupes forever, no effect fires, and the client's
    // value never arrives (starvation, no timing required).
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "cycle-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "cycle-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "cycle-result",
      undefined,
    );
    await clientResult.sync();
    await activated();
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "cycle-arg",
      undefined,
    );
    await clientArg.sync();
    const observes = (leg: string) =>
      (clientResult.key("fetch").key("result").get() as {
        from?: string;
      } | undefined)?.from === `https://stage-g.test/${leg}`;
    const writeUrl = async (leg: string) => {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ url: `https://stage-g.test/${leg}` });
      expect((await tx.commit()).error).toBeUndefined();
    };

    // A: served and observed (30 s legs: real-clock file — under load
    // the wave cycle degrades to deadline-paced waves, see the memo
    // test's budget note).
    await writeUrl("a");
    await awaitReplica(clientManager, () => observes("a"));
    // B: a fresh key, served and observed; the memo state now holds B.
    await writeUrl("b");
    await awaitReplica(clientManager, () => observes("b"));
    // Back to A — the primary regression pin: at the pre-fix tree this
    // starves (the re-admit of key A dedupes against the never-retired
    // first entry; no effect fires; this wait times out).
    await writeUrl("a");
    await awaitReplica(clientManager, () => observes("a"));

    // The returning leg is a genuine re-miss (B's completion overwrote
    // the stored request hash), so A fired at least twice — the lower
    // bound IS the regression pin (a starving re-admit leaves it at 1)
    // — and B at least once. The upper bounds carry the same
    // at-least-once allowance the memo test's recovery leg documents
    // (round-2 thread 19): under load-degraded deadline-paced waves a
    // stale evaluation may legitimately re-miss ONCE per leg before
    // the completion becomes readable, so exact counts flake; bounded,
    // never zero (starvation) and never runaway.
    const aCalls = calls.filter((url) => url.endsWith("/a")).length;
    const bCalls = calls.filter((url) => url.endsWith("/b")).length;
    expect(aCalls).toBeGreaterThanOrEqual(2);
    expect(aCalls).toBeLessThanOrEqual(3);
    expect(bCalls).toBeGreaterThanOrEqual(1);
    expect(bCalls).toBeLessThanOrEqual(2);

    // And the served value STAYS: no post-arrival destroyer wipe (the
    // F2 half — a torn hash would wipe it on the next wave). The
    // scheduler settles, then the value is still there.
    await awaitEach(cycles, () => host!.stats().memo.inflight === 0);
    expect(observes("a")).toBe(true);
  });

  it("serves BOTH result cells when two DISTINCT nodes issue byte-identical inputs: per-target keys keep every requester's closure (round-2 headline)", async () => {
    // The round-2 headline regression: with the outbox key = kind +
    // input hash ONLY, two distinct recipe nodes issuing identical
    // inputs collided — the first node's closure ran (writing ITS OWN
    // pending/result/error cells) and the second's was dropped at
    // admit, so the second node's cells stayed pending forever. The
    // key now carries the result-cell identity (effectTargetKey), so
    // each node keeps its own effect while same-node re-admits still
    // dedupe.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { one: any; two: any }>(",
            "  ({ url }) => ({",
            "    one: fetchJsonUnchecked({ url }),",
            "    two: fetchJsonUnchecked({ url }),",
            "  }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "two-node-arg",
        undefined,
      );
      const result = runtime.getCell<{ one: unknown; two: unknown }>(
        space,
        "two-node-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const clientResult = clientRuntime.getCell<{
      one: { result?: { from?: string } };
      two: { result?: { from?: string } };
    }>(
      space,
      "two-node-result",
      undefined,
    );
    await clientResult.sync();
    await activated();
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "two-node-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ url: "https://stage-g.test/shared" });
    expect((await tx.commit()).error).toBeUndefined();

    // BOTH nodes' cells serve. The pre-fix tree wedges exactly one of
    // these waits (whichever node's closure was admitted second).
    const served = (key: "one" | "two") =>
      (clientResult.key(key).key("result").get() as
        | { from?: string }
        | undefined)
        ?.from === "https://stage-g.test/shared";
    await awaitReplica(clientManager, () => served("one"));
    await awaitReplica(clientManager, () => served("two"));

    // Egress bounded: the contract pinned here is per-requester
    // DELIVERY with bounded calls — >=1 (a future response-sharing
    // fan-out may serve both nodes from one egress without breaking
    // this test) and <=4 (one per node plus the documented
    // at-least-once re-miss allowance per node).
    const shared = calls.filter((url) => url.endsWith("/shared")).length;
    expect(shared).toBeGreaterThanOrEqual(1);
    expect(shared).toBeLessThanOrEqual(4);
  });

  it("retires every served effect: the in-flight count returns to baseline after each completion settles — no monotonic leak (completion-visibility F1a)", async () => {
    // Pre-F1a, EVERY served effect leaked one permanently-in-flight
    // outbox entry and one unresolved whenApplied waiter (the parked
    // accept's marker never arrives for engine-plane commits). The pin:
    // across N sequential served effects, memo.inflight returns to 0
    // after each settles — not monotone growth.
    const calls: string[] = [];
    servingFetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ from: url }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { fetchJsonUnchecked, pattern } from 'commonfabric';",
            "export default pattern<{ url: string }, { fetch: any }>(",
            "  ({ url }) => ({ fetch: fetchJsonUnchecked({ url }) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ url: string }>(
        space,
        "liveness-arg",
        undefined,
      );
      const result = runtime.getCell<{ fetch: unknown }>(
        space,
        "liveness-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const clientResult = clientRuntime.getCell<
      { fetch: { result?: unknown; error?: unknown } }
    >(
      space,
      "liveness-result",
      undefined,
    );
    await clientResult.sync();
    await activated();
    const clientArg = clientRuntime.getCell<{ url: string }>(
      space,
      "liveness-arg",
      undefined,
    );
    await clientArg.sync();

    for (const leg of ["n1", "n2", "n3"]) {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ url: `https://stage-g.test/${leg}` });
      expect((await tx.commit()).error).toBeUndefined();
      await waitForCellValue(
        clientRuntime,
        clientResult.key("fetch").key("result"),
        (result: { from?: string } | undefined) =>
          result?.from === `https://stage-g.test/${leg}`,
        { stuckLabel: "this leg's fetch result to render" },
      );
      // The retirement-liveness pin: the completion settled (the value
      // is client-visible), so the whenApplied barrier resolved and the
      // entry retired. Pre-fix this stays at 1, 2, 3 — the leak.
      await awaitEach(cycles, () => host!.stats().memo.inflight === 0);
    }
    expect(host.stats().outbox.completed).toBeGreaterThanOrEqual(3);
  });

  it("commits an effect completion as its OWN derived-class commit, annotations sourced from the outbox carriage captured at the original run's seal (serving-loop.md §4; T7.Q4)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();

    // Activation via the client's demand.
    const watched = clientRuntime.getCell<{ value?: number }>(
      space,
      "completion-target",
      undefined,
    );
    await watched.sync();
    const kick = clientRuntime.getCell<{ n: number }>(
      space,
      "completion-kick",
      undefined,
    );
    const kickTx = clientRuntime.edit();
    kick.withTx(kickTx).set({ n: 1 });
    expect((await kickTx.commit()).error).toBeUndefined();
    await activated();
    const engine = await server.engineForSpace(space);
    const spaceServer = host.spaceServer(space)!;

    // The ORIGINAL run: a stamped tx with an ACTING identity (the
    // carriage's attribution source — in Phase 2+ the stamper supplies
    // it; here the test does) enqueues the effect and seals into the
    // loop's wave. Its post-commit effect defers to the outbox and runs
    // AFTER the wave commit; the writeback — marked with the effect
    // key — commits as the §4 completion.
    const effectKey = "fetchTest:completion-e2e";
    const completed = Promise.withResolvers<void>();
    const serving = servingRuntime!;
    const target = serving.getCell<{ value?: number }>(
      space,
      "completion-target",
      undefined,
    );
    const scopedBase = serving.getCell<{ note?: string }>(
      space,
      "completion-scoped",
      undefined,
    );
    const scoped = serving.getCellFromLink<{ note?: string }>({
      ...scopedBase.getAsNormalizedFullLink(),
      scope: "user",
    });
    await target.sync();
    const originalTx = serving.edit();
    stampWaveRunContext(originalTx, {
      actionId: "test/fetch-node",
      kind: "derivation",
      acting: { user: "user:alice", session: "sess-9" },
    });
    target.withTx(originalTx).set({});
    originalTx.enqueuePostCommitEffect({
      id: effectKey,
      kind: "fetchTest-start",
      flush: () => {
        const work = serving.editWithRetry((tx) => {
          markEffectCompletion(tx, effectKey);
          target.withTx(tx).set({ value: 7 });
          scoped.withTx(tx).set({ note: "scoped completion" });
        }).then(({ error }) => {
          if (error !== undefined) {
            throw new Error(`completion write failed: ${error.message}`);
          }
          completed.resolve();
        });
        serving.trackAsyncWork(work);
      },
    });
    expect((await originalTx.commit()).error).toBeUndefined();
    await completed.promise;

    // The completion commit: derived-class under the holder, carrying
    // derivedThrough (protocol.md §4: every derived commit carries
    // it), EMPTY consequenceOf, and the annotation pair sourced from
    // the outbox carriage — the acting identity of the ORIGINAL run
    // and the scope_key resolved against the carriage identity. It is
    // its OWN commit: the wave that carried the original run's write
    // committed separately.
    const rows = engine.database.prepare(
      `SELECT seq, class, holder, derived_through, annotations,
              consequence_of
       FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as Array<{
      seq: number;
      class: string;
      holder: string;
      derived_through: number | null;
      annotations: string | null;
      consequence_of: string | null;
    }>;
    // BOTH the wave commit (the original stamped run's write, acting
    // attribution) and the completion carry annotations; the completion
    // is the one holding the SCOPED op's addressing half.
    const annotated = rows.filter((row) => row.annotations !== null).map(
      (row) => ({
        row,
        decoded: decodeMemoryBoundary(row.annotations!) as Array<
          Record<string, unknown>
        >,
      }),
    );
    const withScoped = annotated.filter(({ decoded }) =>
      decoded.some((annotation) => annotation.scopeKey !== undefined)
    );
    expect(withScoped.length).toBe(1);
    const completion = withScoped[0].row;
    expect(completion.holder).toBe(spaceServer.holder);
    expect(completion.derived_through).not.toBeNull();
    const annotations = withScoped[0].decoded;
    const expectedScopeKey = resolveScopeKey("user", {
      principal: serviceSigner.did(),
      sessionId: "unused",
    });
    // Every op carries the carriage's acting identity; the scoped op
    // additionally carries its scope_key (protocol.md §1's
    // addressing/attribution pair).
    expect(annotations.length).toBe(2);
    for (const annotation of annotations) {
      expect(annotation.actingUser).toBe("user:alice");
      expect(annotation.actingSession).toBe("sess-9");
    }
    expect(
      annotations.some((annotation) =>
        annotation.scopeKey === expectedScopeKey
      ),
    ).toBe(true);
    // The wave's own commit (the original run's write) is separate —
    // the completion never passed §3d's sealing.
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // In-process dirtiness + push: the client observes the completion
    // value through its ordinary subscription.
    await waitForCellValue(
      clientRuntime,
      watched.key("value"),
      (value: number | undefined) => value === 7,
      { stuckLabel: "the watched value to reach 7" },
    );
    expect(host.stats().outbox.completed).toBeGreaterThanOrEqual(1);
  });

  it("T17 lifecycle identity carriage: a TURN-key completion inherits the demanded run's identity through its outbox carriage, while a carriage-less LIFECYCLE-key completion (llmDialog:lifecycle:*'s shape) falls back to the WAVE identity with no acting attribution", async () => {
    // The round-2 T17 finding, pinnable only now that the per-(action ×
    // instance) run supply exists (stage P2-F): pre-supply no run ever
    // carried an identity, so "completion identity = carriage identity"
    // and "completion identity = wave fallback" were indistinguishable.
    // With a DEMANDED identity on the original run the two shapes
    // split, and this pin binds BOTH observables:
    // - the turn's own effect key has a live carriage captured at the
    //   run's seal → its completion's scoped op resolves under the
    //   DEMANDED instance key and every op carries the acting pair;
    // - the lifecycle subkey (deliberately NOT the turn's key —
    //   llm-dialog.ts's pin/unpin, which must not tear the turn's
    //   in-flight dedupe) has NO carriage → its scoped op resolves
    //   under the serving session's WAVE identity and carries no
    //   attribution. Sound while `pinnedCells` is space-scope; if that
    //   cell is ever scoped per-user/per-session, THIS assertion is the
    //   one the change must flip (the llm-dialog NOTE's revisit
    //   trigger, made mechanical).
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();

    // Activation via the client's demand.
    const kick = clientRuntime.getCell<{ n: number }>(
      space,
      "t17-kick",
      undefined,
    );
    await kick.sync();
    const kickTx = clientRuntime.edit();
    kick.withTx(kickTx).set({ n: 1 });
    expect((await kickTx.commit()).error).toBeUndefined();
    await activated();
    const engine = await server.engineForSpace(space);
    const serving = servingRuntime!;

    const demanded = {
      principal: "did:key:t17-carol",
      sessionId: "carol-s1" as never,
    };
    const demandedKey = resolveScopeKey("user", demanded);
    const waveKey = resolveScopeKey("user", serving.scopeKeyIdentity);
    expect(demandedKey).not.toBe(waveKey);

    // The ORIGINAL run: stamped through the production seam with the
    // DEMANDED identity (the run supply's output shape), it enqueues
    // the turn's effect. The carriage captured at its seal carries the
    // demanded scopeKeyIdentity AND the acting the seal SETTLES from the
    // run's discovered scope (fan-out stage B, RULED 2026-08-16 — design
    // §F: the run writes a USER-scoped instance, so it acts as the USER;
    // a user-scoped instance value belongs to all of the user's sessions
    // and carries no session — pre-stage-B #stampRun stamped the full
    // pair eagerly).
    const turnKey = "llmDialogTest:t17-turn";
    const turnBase = serving.getCell<{ value?: number }>(
      space,
      "t17-turn-result",
      undefined,
    );
    const turnScoped = serving.getCellFromLink<{ value?: number }>({
      ...turnBase.getAsNormalizedFullLink(),
      scope: "user",
    });
    const lifecycleBase = serving.getCell<{ note?: string }>(
      space,
      "t17-lifecycle-scoped",
      undefined,
    );
    const lifecycleScoped = serving.getCellFromLink<{ note?: string }>({
      ...lifecycleBase.getAsNormalizedFullLink(),
      scope: "user",
    });
    const lifecycleSpace = serving.getCell<{ pins?: string[] }>(
      space,
      "t17-lifecycle-pins",
      undefined,
    );
    await turnBase.sync();
    const completed = Promise.withResolvers<void>();
    const runTx = serving.edit();
    serving.stampServerRun(runTx, {
      actionId: "test/t17-turn-node",
      kind: "derivation",
      scopeKeyIdentity: demanded,
      actionScopeKey: demandedKey,
    });
    turnScoped.withTx(runTx).set({ value: 1 });
    runTx.enqueuePostCommitEffect({
      id: turnKey,
      kind: "llmDialogTest-start",
      flush: () => {
        const work = (async () => {
          // The LIFECYCLE-key completions first (carriage-less by
          // construction — no effect under these keys is in flight):
          // one SCOPED write (the hazard the NOTE warns about) and one
          // SPACE write (today's real pinnedCells shape).
          {
            const { error } = await serving.editWithRetry((tx) => {
              markEffectCompletion(tx, "llmDialog:lifecycle:pin");
              lifecycleScoped.withTx(tx).set({ note: "lifecycle scoped" });
            });
            if (error !== undefined) {
              throw new Error(`lifecycle scoped completion: ${error.message}`);
            }
          }
          {
            const { error } = await serving.editWithRetry((tx) => {
              markEffectCompletion(tx, "llmDialog:lifecycle:unpin");
              lifecycleSpace.withTx(tx).set({ pins: ["a"] });
            });
            if (error !== undefined) {
              throw new Error(`lifecycle space completion: ${error.message}`);
            }
          }
          // The TURN-key completion: rides the carriage captured at the
          // original run's seal.
          {
            const { error } = await serving.editWithRetry((tx) => {
              markEffectCompletion(tx, turnKey);
              turnScoped.withTx(tx).set({ value: 7 });
            });
            if (error !== undefined) {
              throw new Error(`turn completion: ${error.message}`);
            }
          }
          completed.resolve();
        })();
        serving.trackAsyncWork(work);
      },
    });
    expect((await runTx.commit()).error).toBeUndefined();
    await completed.promise;

    type AnnotationRow = {
      scopeKey?: string;
      actingUser?: string;
      actingSession?: string;
    };
    const annotatedCommits = () =>
      (engine.database.prepare(
        `SELECT annotations FROM "commit"
         WHERE class = 'derived' AND annotations IS NOT NULL`,
      ).all() as Array<{ annotations: string }>).map((row) =>
        decodeMemoryBoundary(row.annotations) as unknown as AnnotationRow[]
      );

    // The turn completion: scoped op under the DEMANDED key, the acting
    // USER on every op (the carriage's identity, not the wave's; a
    // user-scoped instance carries the user only — §F). TWO
    // demanded-key commits must exist — the wave commit carrying the
    // original run's write AND the completion's own derived commit —
    // so the count is what proves the COMPLETION inherited the
    // identity rather than only the stamped run.
    const demandedKeyCommits = () =>
      annotatedCommits().filter((annotations) =>
        annotations.some((a) => a.scopeKey === demandedKey)
      );
    await awaitAdmitted(server, () => demandedKeyCommits().length >= 2);
    expect(demandedKeyCommits().length).toBe(2);
    for (const annotations of demandedKeyCommits()) {
      for (const annotation of annotations) {
        expect(annotation.actingUser).toBe(demanded.principal);
        expect(annotation.actingSession).toBeUndefined();
      }
    }

    // The lifecycle completion's scoped op: the WAVE identity's key —
    // never the demanded key — and NO acting attribution.
    const lifecycleCommits = annotatedCommits().filter((annotations) =>
      annotations.some((a) => a.scopeKey === waveKey)
    );
    expect(lifecycleCommits.length).toBe(1);
    for (const annotation of lifecycleCommits[0]) {
      expect(annotation.actingUser).toBeUndefined();
      expect(annotation.actingSession).toBeUndefined();
    }

    // The scoped-value split, end to end: the demanded instance's row
    // holds the turn value; the wave instance's row holds the lifecycle
    // note. Neither leaked into the other's instance.
    const scopeKeysOf = (docId: string): string[] =>
      (engine.database.prepare(
        `SELECT DISTINCT scope_key FROM revision WHERE id = :id`,
      ).all({ id: docId }) as Array<{ scope_key: string }>).map((row) =>
        row.scope_key
      );
    expect(scopeKeysOf(turnBase.getAsNormalizedFullLink().id))
      .toEqual([demandedKey]);
    expect(scopeKeysOf(lifecycleBase.getAsNormalizedFullLink().id))
      .toEqual([waveKey]);

    // The SPACE-scope lifecycle write (today's real pinnedCells shape):
    // its completion carries no annotations at all — space addressing,
    // no attribution (protocol.md §1's service-write posture).
    const pinsDocRows = engine.database.prepare(
      `SELECT DISTINCT scope_key FROM revision WHERE id = :id`,
    ).all({ id: lifecycleSpace.getAsNormalizedFullLink().id }) as Array<
      { scope_key: string }
    >;
    expect(pinsDocRows.map((row) => row.scope_key)).toEqual(["space"]);
  });

  it("threads per-run DEMANDED identities through the production stamper seam: two runs, two instances, two carriages (M1 at cardinality 2; T7.Q4's m-4 discharge)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();
    openClient();

    // Activation via the client's demand.
    const kick = clientRuntime.getCell<{ n: number }>(
      space,
      "fanout-kick",
      undefined,
    );
    await kick.sync();
    const kickTx = clientRuntime.edit();
    kick.withTx(kickTx).set({ n: 1 });
    expect((await kickTx.commit()).error).toBeUndefined();
    await activated();
    const engine = await server.engineForSpace(space);
    const serving = servingRuntime!;

    const identities = [
      {
        label: "alice",
        identity: {
          principal: "did:key:fanout-alice",
          sessionId: "alice-s1" as never,
        },
      },
      {
        label: "bob",
        identity: {
          principal: "did:key:fanout-bob",
          sessionId: "bob-s1" as never,
        },
      },
    ] as const;
    const waveKey = resolveScopeKey("user", serving.scopeKeyIdentity);

    // TWO runs of one action, each stamped with its DEMANDED identity
    // through the PRODUCTION seam (runtime.stampServerRun -> the
    // SpaceServer's #stampRun -> the wave run context). Each demanded
    // instance derives its OWN slot doc (per-instance result cells —
    // the landed depth; same-doc replica-read instancing is the owed
    // scheduler follow-up, and the same-doc ENGINE fold is pinned at
    // the wave/sink level). Each run also enqueues an effect whose
    // carriage must carry ITS identity into the completion — the
    // register's m-4 note made real: the carriage carries a DIFFERENT
    // key per run, never the wave identity's.
    const docIds: string[] = [];
    const completions: Promise<void>[] = [];
    for (const [index, { label, identity }] of identities.entries()) {
      const outBase = serving.getCell<{ total?: number }>(
        space,
        `fanout-user-result-${label}`,
        undefined,
      );
      const outScoped = serving.getCellFromLink<{ total?: number }>({
        ...outBase.getAsNormalizedFullLink(),
        scope: "user",
      });
      docIds.push(outBase.getAsNormalizedFullLink().id);
      const runTx = serving.edit();
      serving.stampServerRun(runTx, {
        actionId: "test/fanout-node",
        kind: "derivation",
        scopeKeyIdentity: identity,
        actionScopeKey: resolveScopeKey("user", identity),
      });
      outScoped.withTx(runTx).set({ total: index + 1 });
      const effectKey = `fanoutTest:${label}`;
      const done = Promise.withResolvers<void>();
      completions.push(done.promise);
      runTx.enqueuePostCommitEffect({
        id: effectKey,
        kind: "fanoutTest-start",
        flush: () => {
          const work = serving.editWithRetry((tx) => {
            markEffectCompletion(tx, effectKey);
            outScoped.withTx(tx).set({ total: (index + 1) * 11 });
          }).then(({ error }) => {
            if (error !== undefined) {
              throw new Error(`completion failed: ${error.message}`);
            }
            done.resolve();
          });
          serving.trackAsyncWork(work);
        },
      });
      expect((await runTx.commit()).error).toBeUndefined();
    }
    await Promise.all(completions);

    // Every scoped row — the wave's writes AND the completions' — lands
    // under the RUN'S demanded instance key, never the wave/service
    // identity's. The completion half is T7.Q4's m-4 discharge: the
    // outbox carriage captured at each run's seal carries a DIFFERENT
    // per-run key.
    for (const [index, { identity }] of identities.entries()) {
      const expectedKey = resolveScopeKey("user", identity);
      await awaitAdmitted(server, () => {
        const rows = engine.database.prepare(
          `SELECT DISTINCT scope_key FROM revision WHERE id = :id`,
        ).all({ id: docIds[index] }) as Array<{ scope_key: string }>;
        return rows.some((row) => row.scope_key === expectedKey);
      });
      const keys = (engine.database.prepare(
        `SELECT DISTINCT scope_key FROM revision WHERE id = :id`,
      ).all({ id: docIds[index] }) as Array<{ scope_key: string }>).map((
        row,
      ) => row.scope_key);
      expect(keys).toEqual([expectedKey]);
      expect(keys.includes(waveKey)).toBe(false);
    }
    // Basis rows keyed per (action, instance) — serving-loop.md §3b's
    // action_scope_key from each run's demanded identity.
    const basisKeys = new Set(
      (engine.database.prepare(
        `SELECT DISTINCT action_scope_key FROM scheduler_basis
         WHERE action = :action`,
      ).all({ action: "test/fanout-node" }) as Array<
        { action_scope_key: string }
      >).map((row) => row.action_scope_key),
    );
    for (const { identity } of identities) {
      expect(basisKeys.has(resolveScopeKey("user", identity))).toBe(true);
    }
  });

  it("carries the demanding session's identity into the SpaceServer's demand registry (M1 demand carriage at cardinality 2)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    onServingRuntime = () => Promise.resolve();

    // TWO principals, one user-scoped root each: the watch registry
    // must carry each demander's identity, deduped per INSTANCE — the
    // demand half of scopes.md §5's "the DEMAND supplies the identity".
    openClient();
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    try {
      const aliceCellBase = clientRuntime.getCell<{ v?: number }>(
        space,
        "fanout-demand-root",
        undefined,
      );
      const aliceScoped = clientRuntime.getCellFromLink<{ v?: number }>({
        ...aliceCellBase.getAsNormalizedFullLink(),
        scope: "user",
      });
      await aliceScoped.sync();
      const bobCellBase = bobRuntime.getCell<{ v?: number }>(
        space,
        "fanout-demand-root",
        undefined,
      );
      const bobScoped = bobRuntime.getCellFromLink<{ v?: number }>({
        ...bobCellBase.getAsNormalizedFullLink(),
        scope: "user",
      });
      await bobScoped.sync();
      const rootDocId = aliceCellBase.getAsNormalizedFullLink().id;

      // Activation + a demand-load pass.
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "fanout-demand-kick",
        undefined,
      );
      await kick.sync();
      const kickTx = clientRuntime.edit();
      kick.withTx(kickTx).set({ n: 1 });
      expect((await kickTx.commit()).error).toBeUndefined();
      await activated();

      // The server-side watch registry carries BOTH identities…
      const roots = server.watchedRootsForSpace(space, {
        excludePrincipal: serviceSigner.did(),
      });
      const scopedEntries = roots.filter((root) =>
        root.id === rootDocId && root.scope === "user"
      );
      const principals = new Set(
        scopedEntries.map((root) => root.identity?.principal),
      );
      expect(principals.has(aliceSigner.did())).toBe(true);
      expect(principals.has(bobSigner.did())).toBe(true);

      // …and the SpaceServer's demand registry records them per
      // instance after its next demand-load pass.
      await awaitEach(cycles, () => {
        const identities = host!.spaceServer(space)
          ?.demandedIdentitiesOf(rootDocId) ?? [];
        const seen = new Set(identities.map((i) => i.principal));
        return seen.has(aliceSigner.did()) && seen.has(bobSigner.did());
      });
    } finally {
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("supplies the demanded (user, session) identity to the piece's derivation runs END TO END: the demand registry stamps the runs, and the derived commit's annotations + basis rows carry the demanding actor (stage P2-F; protocol.md §1, LT6's acting half)", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });

    // A real pattern served at activation (the first test's shape): the
    // demanded root is its RESULT doc. Its derivation reads a PER-USER
    // input (fan-out stage B, RULED 2026-08-16 — design §F: attribution
    // derives from the scope a run DISCOVERS, so only a node that reads
    // scoped state acts as anyone; a space-only `n + 1` runs once as the
    // probe and carries NO acting — pre-stage-B the demand's pair was
    // stamped on it eagerly, F10's over-keying).
    let argumentSchema: unknown;
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
            "type Mine = Writable<number | Default<0>>;",
            "export default pattern<{ n: number; mine?: PerUser<Mine> }, { total: number }>(",
            "  ({ n, mine }) => { const mineCell: Mine = mine!; return { total: computed(() => n + 1 + ((mineCell.get() as number | undefined) ?? 0)) }; },",
            ");",
          ].join("\n"),
        }],
      }, { space });
      argumentSchema = compiled.argumentSchema;
      const argument = runtime.getCell<{ n: number }>(
        space,
        "p2f-supply-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "p2f-supply-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    openClient();
    const engine = await server.engineForSpace(space);

    // Alice's demand, BOTH halves: the ordinary space subscription (the
    // value pull, under the result schema so it reaches the computed doc
    // behind `total`) and the USER-scoped subscription — the demand row
    // that carries her (user, session) identity into the registry
    // (scopes.md §5: the DEMAND supplies the run identity).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "p2f-supply-result",
      TOTAL_RESULT_SCHEMA,
    );
    await clientResult.sync();
    const rootDocId = clientResult.getAsNormalizedFullLink().id;
    const scopedResult = clientRuntime.getCellFromLink<{ total: number }>({
      ...clientResult.getAsNormalizedFullLink(),
      scope: "user",
    });
    await scopedResult.sync();

    await activated();
    // The demand registry carries alice's identity for the piece root
    // (the landed M1 carriage; the run SUPPLY consumes it below).
    await awaitEach(
      cycles,
      () =>
        (host!.spaceServer(space)?.demandedIdentitiesOf(rootDocId) ?? [])
          .some((identity) => identity.principal === aliceSigner.did()),
    );
    const demanded = host!.spaceServer(space)!.demandedIdentitiesOf(
      rootDocId,
    ).find((identity) => identity.principal === aliceSigner.did())!;
    const expectedInstanceKey = resolveScopeKey("user", demanded as never);

    // The authored input: wakes the loop; the piece's derivation run
    // serves alice's demand. Alice's per-user `mine` is written THROUGH
    // the argument schema, so the PerUser slot narrows into her instance
    // (the redirect at the space slot is what makes the derivation's
    // read of it a user-scoped read — a never-written PerUser slot reads
    // at its base scope, stage A's residual (ii)).
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "p2f-supply-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    const typedArg = clientRuntime.getCell<{ mine: number }>(
      space,
      "p2f-supply-arg",
      argumentSchema as never,
    );
    await typedArg.sync();
    const mineTx = clientRuntime.edit();
    typedArg.key("mine").withTx(mineTx).set(5);
    expect((await mineTx.commit()).error).toBeUndefined();
    // No seq-target staging wait here: a serverSeq read after the
    // commit RACES the loop's own wave commit (when the wave lands
    // first, the read includes the wave's own seq, which W never
    // covers on a then-quiet space — self-echoes advance no
    // coverage). The acting-annotation wait below IS the gate this
    // test exists for; it resolves exactly when the wave commits.

    // THE SUPPLY'S OBSERVABLE (red-first: pre-P2-F the demanded
    // derivation ran under the wave fallback and its writes carried NO
    // acting annotation — userless): the derived commits' per-write
    // annotations carry the DEMANDING session's actor (protocol.md §1
    // ATTRIBUTION at the run granularity).
    const actingRows = () => {
      const rows = engine.database.prepare(
        `SELECT annotations FROM "commit" WHERE class = 'derived' AND
         annotations IS NOT NULL`,
      ).all() as Array<{ annotations: string }>;
      return rows.flatMap((row) =>
        decodeMemoryBoundary(row.annotations) as unknown as Array<{
          actingUser?: string;
          actingSession?: string;
        }>
      ).filter((annotation) => annotation.actingUser !== undefined);
    };
    await awaitAdmitted(
      server,
      () => actingRows().some((a) => a.actingUser === aliceSigner.did()),
    );
    const aliceAnnotations = actingRows().filter((a) =>
      a.actingUser === aliceSigner.did()
    );
    // A USER-scoped instance value belongs to all of the user's sessions:
    // it carries the user and NO session (design §F, RULED 2026-08-16;
    // a session-scoped instance would carry the pair). Pre-stage-B the
    // representative session rode every user-instance annotation.
    expect(aliceAnnotations.length).toBeGreaterThan(0);
    expect(
      aliceAnnotations.every((a) => a.actingSession === undefined),
    ).toBe(true);
    // No annotation names the service identity as the actor: the
    // demanded node ran as its demander, never as the service.
    expect(
      actingRows().some((a) => a.actingUser === serviceSigner.did()),
    ).toBe(false);

    // Basis rows key per (action, INSTANCE) — the run's TRUE instance
    // (S4, server-execution v2 stage A): the demanded run's DISCOVERED
    // scope resolved against its identity. This derivation reads alice's
    // per-user input, so its rows land under alice's user instance; a
    // demanded run that reads only space keys `space` (the stage-A pins).
    const basisKeys = new Set(
      (engine.database.prepare(
        `SELECT DISTINCT action_scope_key FROM scheduler_basis`,
      ).all() as Array<{ action_scope_key: string }>).map((row) =>
        row.action_scope_key
      ),
    );
    expect(basisKeys.has(expectedInstanceKey)).toBe(true);
    expect(
      basisKeys.has(
        resolveScopeKey("user", { principal: serviceSigner.did() }),
      ),
    ).toBe(false);
  });
});
