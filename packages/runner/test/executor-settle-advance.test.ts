// Server-execution v2 stage C, W3.1 — S1: the drain-settle quiescence
// advance (RULED 2026-08-19; protocol.md §4's amendment). The swatch
// stall's fix seat (stage-c/swatch-stall-rootcause.md §4): on a quiet
// space the watermark froze BELOW the tail derivations' own seqs — W
// covered inputs only, so a client speculation layer whose floor
// includes a PUSHED derived commit's seq (a re-derivation that read a
// served value; the stall's diverged tombstone is the known producer)
// had no reachable retirement until the next authored commit anywhere
// in the space (probe-verified: one keystroke healed a 60-s stall
// within one 500 ms poll, while explicit settles did nothing).
//
// S1: at drain-settle — the serving loop reaching quiescence for the
// space (a true settle, no contributions, no pending events, the drain
// empty) — W advances over the space's own committed derived tail, so
// every retirement predicate gated on `W ≥ floor` fires without
// waiting for an unrelated authored commit. Pins:
//
//  1. frozen-W reproduction (the i10 shape): a served derivation
//     commits ABOVE the last authored coverage; the space quiesces; W
//     advances to cover it WITHOUT any new authored commit — and the
//     advance reaches the CLIENT through the ordinary watermark-doc
//     push (RED on the pre-S1 tip: W stays below the tail forever).
//     The client clause is PUSH-HALF honest (combined review
//     2026-08-19, F3): a watermark sink installed before any advance
//     exists must observe a delivered value above the authored
//     coverage — with the advance wave's `noteExecutorCommit` skipped
//     (probe S1-P1), `waitForSettled` self-satisfies through its own
//     fresh subscription's initial pull, and THIS clause goes red.
//  2. the diverged layer retires at quiescence (the report §5 probe
//     shape, minimal seam): a client re-derivation reads the PUSHED
//     derived value and seals a layer whose value DIVERGES from the
//     confirmed one under it; with no authored traffic at all the
//     layer retires on the quiescence advance and the healed confirmed
//     value renders (RED on the pre-S1 tip: masked indefinitely).
//  3. idempotence / no self-chase: once quiescence has advanced W, a
//     quiet space commits NOTHING further — the advance-only wave is
//     never chased (the #coverageHead comment's commit-storm class),
//     and the counter stays flat.
//  4. OFF witness: the advance lives inside SpaceServer's wave cycle —
//     the OFF arm constructs no SpaceServer, derives nothing, and
//     holds no watermark doc at all.
//  5. busy-space neutrality: under a continuous input stream the
//     advance never fires mid-stream (quiescence never holds); it
//     fires once at the trailing quiescence transition.
//  6. the latch survives a mid-seal content fold (combined review
//     2026-08-19, F2): content sealing into the advance wave's
//     still-open commit window (between the gate snapshot and the wave
//     detach) arms the latch and the seal-consume must NOT erase it —
//     the folded content's seq sits above the advance's target, so a
//     consumed latch strands it below W until the next authored input
//     (RED on the pre-fix code: W frozen below the folded seq). The
//     consume is gated on `contentContributionCount === 0`.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  readWatermarkSeq,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  waitForSettled,
  watermarkCell,
  watermarkDocLink,
} from "../src/executor/watermark.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { markEffectCompletion } from "../src/executor/effect-completion.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitEach,
  awaitReplica,
} from "./support/serving-waits.ts";
import { waitOnDelivery } from "./support/wait-on-delivery.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const spaceSigner = await Identity.fromPassphrase("settle advance space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("settle advance service");
const aliceSigner = await Identity.fromPassphrase("settle advance alice");

describe("S1 drain-settle quiescence advance (RULED 2026-08-19)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
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
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
      onEffectRetired: retirements.record,
      onWaveCycle: cycles.record,
    });

  /** Resolves once the space has an ACTIVE tenure. The serving pattern
   * run rides `createRuntime`, so this is also the barrier a client's
   * own edits stand behind: a run committing beside them reads a basis
   * their writes have already moved, and the activation fails. */
  const activated = (): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );

  let activations: ArrivalLog<{ space: string; outcome: string }>;

  /** Each in-flight effect as the outbox retires it — the counts that
   * drop with it move inside the outbox's own continuations. */
  let retirements: ArrivalLog<void>;

  /** Each wave cycle as it ends — the loop arms its input wait
   * synchronously after one. */
  let cycles: ArrivalLog<MemorySpace>;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    onServingRuntime = undefined;
    activations = new ArrivalLog();
    retirements = new ArrivalLog();
    cycles = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  /** The serving graph: a real pattern run server-side at activation
   * (the loaded structure), same shape as the serving-loop E2E. */
  const servePattern = (argName: string, resultName: string) => {
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        argName,
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        resultName,
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
  };

  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    // A flag-ON CLIENT (no serving posture): the speculation overlay
    // exists, and the watermark doc arrives via ordinary push.
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  };

  /** Every derived-class commit's seq, ascending (the space's derived
   * tail is the last). */
  const derivedSeqs = (engine: Engine.Engine): number[] =>
    (engine.database.prepare(
      `SELECT seq FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number }[]).map((row) => row.seq);

  const authoredCount = (engine: Engine.Engine): number =>
    (engine.database.prepare(
      `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'authored'`,
    ).get() as { n: number }).n;

  const maxAuthoredSeq = (engine: Engine.Engine): number =>
    (engine.database.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
    ).get() as { n: number }).n;

  it("pin 1 — frozen-W (the i10 shape): the watermark advances over the tail derivation at drain-settle, with NO new authored commit, and the advance reaches the client via the ordinary push", async () => {
    servePattern("s1-arg", "s1-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    // F3 (combined review 2026-08-19): the PUSH-half witness. A sink on
    // the watermark doc installed BEFORE any advance exists observes
    // every LATER value only through the production push path — the
    // advance wave's `noteExecutorCommit` marks the watermark doc's
    // dirty key, and the refresh delivers exactly the dirty keys; the
    // initial sync pull at subscribe time can only see the pre-input
    // watermark (below every authored seq this test mints). So a
    // DELIVERED value above the authored coverage is push-half
    // evidence the `waitForSettled` clause below cannot give (probe
    // S1-P1: with the advance wave's `noteExecutorCommit` skipped,
    // `waitForSettled` self-satisfies through the initial pull of its
    // own fresh subscription — THIS clause is the one that goes red).
    const pushedWatermarks: number[] = [];
    const wmCell = watermarkCell(clientRuntime, space);
    await wmCell.sync();
    const cancelWmSink = wmCell.sink((value) => {
      if (typeof value?.seq === "number") pushedWatermarks.push(value.seq);
    });

    // The client's demand + the authored input (the wave's trigger).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 6 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The served derivation lands and is pushed (the client observes
    // the derived value) — the derived commit's seq is ABOVE the
    // authored input's.
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    await awaitAdmitted(
      server,
      () => derivedSeqs(engine).some((seq) => seq > authoredSeq),
    );
    const tail = Math.max(
      ...derivedSeqs(engine).filter((seq) => seq > authoredSeq),
    );
    const authoredBefore = authoredCount(engine);

    // THE PIN (RED pre-S1: W freezes at the authored coverage — the
    // report's i10: W 71 vs floor 72 — until the next authored commit
    // anywhere in the space; the input-driven advance can NEVER exceed
    // the highest authored seq, so `W > max authored` is exactly the
    // quiescence advance — both sides recomputed per poll, because the
    // serving side's own structure commits are authored too and can
    // land after this test's sample): at drain-settle the watermark
    // advances over the space's own derived tail. No authored traffic
    // from this test here.
    await awaitAdmitted(
      server,
      () => readWatermarkSeq(engine) > maxAuthoredSeq(engine),
    );
    const advancedW = readWatermarkSeq(engine);
    // The advance covers the CONTENT tail. `tail` was sampled above and
    // may itself be the advance's own bookkeeping-only commit (which W
    // definitionally never covers — chasing it would mint a successor,
    // the commit-storm class), hence the −1 tolerance.
    expect(advancedW).toBeGreaterThanOrEqual(tail - 1);
    // ... and the advance reached the CLIENT through the ordinary
    // watermark-doc push, with no other traffic (waitForSettled rides
    // the client's own subscription).
    const settled = await waitForSettled(clientRuntime, space, advancedW);
    expect(settled).toBeGreaterThanOrEqual(advancedW);
    // No authored commit drove the advance (the heal needs no
    // keystroke): the advance-carrying commits are derived-class.
    expect(authoredCount(engine)).toBe(authoredBefore);

    // The counter: at least one quiescence advance, and the stats block
    // splits it from the per-input settle series (W4's metric reads
    // both).
    const stats = host.stats();
    expect(stats.settleAdvances.count).toBeGreaterThanOrEqual(1);
    expect(stats.settleAdvances.lastDelta).toBeGreaterThanOrEqual(1);
    // F3: the advance was DELIVERED to the pre-installed sink — a value
    // above the final authored coverage arrived through the push path
    // (both sides recomputed per poll, as above).
    await awaitReplica(
      clientManager,
      () => pushedWatermarks.some((seq) => seq > maxAuthoredSeq(engine)),
    );
    cancelWmSink();
    cancelDemand();
  });

  it("pin 2 — the diverged layer retires at quiescence (the report §5 probe shape, minimal seam): a re-derivation over the PUSHED derived value seals a diverged layer; the quiescence advance retires it and the healed value renders — no authored traffic", async () => {
    servePattern("s1b-arg", "s1b-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1b-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1b-arg",
      undefined,
    );
    await clientArg.sync();
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 6 });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);

    // The served value arrives (confirmed at the derived commit's seq,
    // ABOVE the authored coverage) and any first-generation echoes
    // retire (their floors sit at the authored input).
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const overlay = clientRuntime.speculationOverlay;
    expect(overlay).toBeDefined();
    await awaitReplica(clientManager, () => overlay!.entryCount(space) === 0);
    const derivedTail = Math.max(
      ...derivedSeqs(engine).filter((seq) => seq > authoredSeq),
    );
    const authoredBefore = authoredCount(engine);

    // The RE-DERIVATION over the pushed derived value (the stall's
    // poison, minimal seam): a stamped derivation-kind run — the real
    // client seal path; the flag-ON client's seal destination diverts
    // it into the overlay — READS the served result (confirmed at the
    // derived commit's seq, so the entry's floor sits ABOVE every W
    // the pre-S1 server can reach on a quiet space) and WRITES a
    // DIVERGED value over the same doc (the tombstone's shape: the
    // layer masks the healed confirmed value beneath it).
    const specTx = clientRuntime.edit();
    stampSpeculationRunContext(specTx, {
      actionId: "s1-pin2-regressed-rederivation",
      kind: "derivation",
    });
    const seen = clientResult.withTx(specTx).key("total").get();
    expect(seen).toBe(42);
    clientResult.withTx(specTx).key("total").set(999);
    expect((await specTx.commit()).error).toBeUndefined();
    // The diverged layer masks the confirmed value (the stall's render).
    expect(overlay!.entryCount(space)).toBeGreaterThanOrEqual(1);
    expect(clientResult.key("total").get()).toBe(999);

    // THE PIN (RED pre-S1: the layer lingers indefinitely — its floor
    // is the derived commit's seq, and W freezes below it; the sweep's
    // "each new input lifts the previous generation" premise required
    // an authored commit that never comes): the quiescence advance
    // covers the floor, the watermark sink re-sweeps, the layer
    // retires, and the HEALED confirmed value shows through.
    await awaitReplica(clientManager, () => overlay!.entryCount(space) === 0);
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    // No authored commit drove the heal (the report's keystroke probe
    // is exactly what S1 makes unnecessary).
    expect(authoredCount(engine)).toBe(authoredBefore);
    // W covers the CONTENT tail. The engine's very last derived seq may
    // be the quiescence advance's own bookkeeping-only commit, which W
    // definitionally never covers (chasing it would mint a successor —
    // the commit-storm class); `derivedTail` was sampled before the
    // mint, so it is either the content commit (covered exactly) or
    // the advance commit (one above W).
    expect(readWatermarkSeq(engine)).toBeGreaterThanOrEqual(derivedTail - 1);
    cancelDemand();
  });

  it("pins 3+5 — idempotence and busy-space neutrality: the advance fires once per quiescence transition (never per wave, never chasing its own bookkeeping commit), and a quiet space then commits NOTHING further", async () => {
    servePattern("s1c-arg", "s1c-result");
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1c-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1c-arg",
      undefined,
    );
    await clientArg.sync();

    // PIN 5 (busy neutrality): a continuous input stream — commits
    // fired back-to-back, unawaited settles — keeps the space busy;
    // the advance must not fire mid-stream (quiescence never holds
    // while the feed carries the next input).
    const EDITS = 10;
    for (let i = 1; i <= EDITS; i++) {
      const editTx = clientRuntime.edit();
      clientArg.withTx(editTx).set({ n: i });
      expect((await editTx.commit()).error).toBeUndefined();
    }
    const lastAuthored = Engine.serverSeq(engine);
    await waitForSettled(clientRuntime, space, lastAuthored);
    // Let the trailing quiescence transition land its advance.
    await awaitAdmitted(
      server,
      () => host!.stats().settleAdvances.count >= 1,
    );
    const stats = host.stats();
    // Far below one-per-wave: the stream coalesces into waves whose
    // cycles end with the next input already in the feed — only real
    // quiescence transitions fire (the trailing one, plus at most a
    // couple of genuine mid-stream gaps on a slow box).
    expect(stats.settleAdvances.count).toBeLessThanOrEqual(4);
    expect(stats.settleAdvances.count).toBeGreaterThanOrEqual(1);

    // PIN 3 (idempotence / no self-chase): W now covers the derived
    // tail; the advance-only wave's own commit is NOT chased (the
    // #coverageHead commit-storm class), and a quiet space commits
    // NOTHING further — counters and the engine head stay flat.
    await awaitAdmitted(server, () => {
      const seqs = derivedSeqs(engine);
      const tail = seqs.length === 0 ? 0 : seqs[seqs.length - 1];
      // Quiet: W has caught the last CONTENT commit. The advance
      // wave's own seq sits one above W, uncovered by design.
      return readWatermarkSeq(engine) >= tail - 1;
    });
    const advancesBefore = host.stats().settleAdvances.count;
    const wavesBefore = host.stats().waves;
    // The quiet claim, observed rather than sampled over a window: a
    // re-arming latch keeps finding work of its own, so its loop never
    // reaches the input wait. The suspension IS the claim, and the
    // counters are read at it — unmoved, with no poke of the test's own
    // to allow for.
    const quietServer = host.spaceServer(space)!;
    await awaitEach(cycles, () => quietServer.suspendedOnInput);
    expect(host.stats().settleAdvances.count).toBe(advancesBefore);
    expect(host.stats().waves).toBe(wavesBefore);
    cancelDemand();
  });

  it("pin 4 — OFF witness: the advance path is structurally unreached off the serving posture — no SpaceServer, no derived commits, no watermark doc", async () => {
    // No host at all (the OFF arm has no serving loop to run the
    // advance); an OFF client authors and derives locally.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      // OFF: no experimental.serverExecution.
    });
    const engine = await server.engineForSpace(space);

    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_PATTERN }],
    }, { space });
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "off-arg",
      undefined,
    );
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "off-result",
      compiled.resultSchema,
    );
    await clientArg.sync();
    await clientResult.sync();
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, clientArg, clientResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = clientResult.sink(() => {});
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    // OFF derives client-side and commits as today: derived-class
    // commits and the watermark doc do not exist, so neither does any
    // advance (readWatermarkSeq's absent-doc read is 0).
    expect(derivedSeqs(engine).length).toBe(0);
    expect(readWatermarkSeq(engine)).toBe(0);
    cancelDemand();
  });

  it("pin 6 — the latch survives a mid-seal content fold (combined review 2026-08-19, F2): content sealing into the advance wave's still-open commit window leaves the latch ARMED, so the NEXT quiescence covers the folded tail — no stall until the next authored input", async () => {
    servePattern("s1f-arg", "s1f-result");
    // THE MID-SEAL INJECTION SEAM (the review's interleaving, made
    // deterministic): between the quiescence gate's snapshot and the
    // wave detach, the cycle awaits the watermark tx's commit — any
    // transaction sealing in that window joins the still-open closing
    // wave (`#openWave` reuses `#currentWave`; a serving-runtime
    // `commit()` resolves at SEAL acceptance, before the wave commits,
    // so awaiting it inside the window cannot deadlock). The wrapper
    // below intercepts the serving runtime's `edit()`: when an ARMED
    // one-shot sees a watermark ["seq"] write whose value exceeds every
    // authored seq (exactly pin 1's quiescence-advance discriminator —
    // an input-driven advance can never exceed the authored head), it
    // commits a DERIVATION-kind content write before letting the
    // watermark tx commit — the wave then carries BOTH the advance and
    // the content, and `advanceTo` (computed before the fold) sits
    // BELOW the folded commit's seq.
    const FOLD_DOC_ID = "of:s1-pin6-mid-seal-fold";
    // The server's engine store is get-or-create and memoized, so
    // fetching it before the host opens hands the interceptor below the
    // same instance the serving loop will use.
    const engine = await server.engineForSpace(space);
    let armed = false;
    let injectionDone = false;
    const foldInjections = new ArrivalLog<void>();
    let foldError: string | undefined;
    const innerSetup = onServingRuntime;
    onServingRuntime = async (runtime) => {
      await innerSetup?.(runtime);
      const originalEdit = runtime.edit.bind(runtime);
      type Tx = ReturnType<Runtime["edit"]>;
      (runtime as { edit: () => Tx }).edit = () => {
        const tx = originalEdit();
        const origWrite = tx.writeValueOrThrow.bind(tx);
        let watermarkSeqValue: number | undefined;
        (tx as { writeValueOrThrow: typeof origWrite }).writeValueOrThrow = (
          link,
          value,
        ) => {
          if (
            link.id === SERVER_EXECUTION_WATERMARK_DOC_ID &&
            typeof value === "number"
          ) {
            watermarkSeqValue = value;
          }
          return origWrite(link, value);
        };
        const origCommit = tx.commit.bind(tx);
        (tx as { commit: typeof origCommit }).commit = async () => {
          if (
            armed && !injectionDone &&
            watermarkSeqValue !== undefined &&
            watermarkSeqValue > maxAuthoredSeq(engine)
          ) {
            injectionDone = true;
            foldInjections.record();
            const foldTx = originalEdit();
            stampWaveRunContext(foldTx, {
              actionId: "s1-pin6-mid-seal-fold",
              kind: "derivation",
            });
            foldTx.writeValueOrThrow(
              {
                ...watermarkDocLink(space),
                id: FOLD_DOC_ID as ReturnType<
                  typeof watermarkDocLink
                >["id"],
                path: [],
              },
              { folded: true },
            );
            const folded = await foldTx.commit();
            if (folded.error !== undefined) {
              foldError = folded.error.message;
            }
          }
          return origCommit();
        };
        return tx;
      };
    };
    host = newHost();
    openClient();

    // The ordinary S1 flow first (pin 1's shape), UNARMED: input,
    // served derivation, the first quiescence advance completes clean.
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "s1f-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "s1f-arg",
      undefined,
    );
    await clientArg.sync();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    await awaitAdmitted(
      server,
      () => readWatermarkSeq(engine) > maxAuthoredSeq(engine),
    );

    // ARM, then drive ONE more content generation: the quiescence
    // advance for ITS tail is the one the seam poisons. Arming happens
    // BEFORE the input exists, so the injection cannot race the
    // advance.
    armed = true;
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 7 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitForCellValue(
      clientRuntime,
      clientResult.key("total"),
      (total: number | undefined) => total === 49,
      { stuckLabel: "the client's total to reach 49" },
    );
    await foldInjections.reached(1);
    expect(foldError).toBeUndefined();

    // The interleaving REALLY happened (loud abort, not a vacuous
    // green): the folded content write and the advance's watermark
    // write landed in the SAME wave commit.
    await awaitAdmitted(
      server,
      () =>
        (Engine.selectCommitsSince(engine, {
          fromSeq: 0,
          limit: 10_000,
        }) as Array<{ seq: number; writes?: Array<{ id: string }> }>)
          .some((record) =>
            (record.writes ?? []).some((write) => write.id === FOLD_DOC_ID)
          ),
    );
    const commits = Engine.selectCommitsSince(engine, {
      fromSeq: 0,
      limit: 10_000,
    }) as Array<{ seq: number; writes?: Array<{ id: string }> }>;
    const foldCommits = commits.filter((record) =>
      (record.writes ?? []).some((write) => write.id === FOLD_DOC_ID)
    );
    expect(foldCommits.length).toBe(1);
    const foldSeq = foldCommits[0].seq;
    expect(
      (foldCommits[0].writes ?? []).some((write) =>
        write.id === SERVER_EXECUTION_WATERMARK_DOC_ID
      ),
    ).toBe(true);
    const authoredBefore = authoredCount(engine);

    // THE PIN (RED on the unfixed code: the fold's content ARMED the
    // latch and the advance's seal-consume immediately erased it —
    // `advanceTo` sits below the folded seq, the next echo cycle finds
    // the latch false, and W freezes below the folded content until
    // the next authored input, which never comes): with the consume
    // gated on the wave having stayed bookkeeping-only, the latch
    // stays armed and the NEXT quiescence covers the folded tail.
    await awaitAdmitted(server, () => readWatermarkSeq(engine) >= foldSeq);
    // No authored commit drove the recovery.
    expect(authoredCount(engine)).toBe(authoredBefore);
    // And the client heals through the ordinary push.
    const settled = await waitForSettled(clientRuntime, space, foldSeq);
    expect(settled).toBeGreaterThanOrEqual(foldSeq);
    cancelDemand();
  });
  for (const mode of ["empty", "content", "overlay"] as const) {
    const writeback = mode !== "empty";
    const withOverlay = mode === "overlay";
    it(`${withOverlay ? "retires a divergent layer over its own completion" : writeback ? "covers its own completion tail" : "keeps an empty completion from creating a commit"} while another accepted request remains unresolved`, async () => {
      const ready = Promise.withResolvers<Runtime>();
      onServingRuntime = (runtime) => {
        ready.resolve(runtime);
        return Promise.resolve();
      };
      host = newHost();
      openClient();
      const clientResult = clientRuntime.getCell<{
        value?: number;
        pending?: boolean;
      }>(space, "s1-effect-result");
      await clientResult.sync();
      const cancelDemand = clientResult.sink(() => {});
      const releaseFirst = Promise.withResolvers<void>();
      const releaseOther = Promise.withResolvers<void>();
      const wmCell = watermarkCell(clientRuntime, space);
      let cancelWatermark: (() => void) | undefined;
      let holdWatermark = false;
      const heldNotices: Array<
        Parameters<typeof server.noteExecutorCommit>[0]
      > = [];
      const noteExecutorCommit = server.noteExecutorCommit.bind(server);
      if (withOverlay) {
        await wmCell.sync();
        cancelWatermark = wmCell.sink(() => {});
        // The existing subscription receives the completion before the
        // advance-only notice, allowing a client derivation to observe it.
        server.noteExecutorCommit = (notice) => {
          if (
            holdWatermark && notice.space === space &&
            notice.class === "derived" && notice.writes.length > 0 &&
            notice.writes.every((write) =>
              write.id === SERVER_EXECUTION_WATERMARK_DOC_ID
            )
          ) {
            heldNotices.push(notice);
          } else {
            noteExecutorCommit(notice);
          }
        };
      }
      try {
        const serving = await ready.promise;
        await activated();
        const engine = await server.engineForSpace(space);
        const result = serving.getCell<{
          value?: number;
          pending?: boolean;
        }>(space, "s1-effect-result");
        await result.sync();
        const issuedFirst = Promise.withResolvers<void>();
        const issuedOther = Promise.withResolvers<void>();
        const completedFirst = Promise.withResolvers<void>();
        let otherCompleted = false;
        const original = serving.edit();
        stampWaveRunContext(original, {
          actionId: "s1-effect-start",
          kind: "derivation",
        });
        result.withTx(original).set({});
        original.enqueuePostCommitEffect({
          id: "s1-first-effect",
          kind: "fetchTest-start",
          flush: async () => {
            issuedFirst.resolve();
            await releaseFirst.promise;
            try {
              const completion = serving.edit();
              markEffectCompletion(completion, "s1-first-effect");
              if (writeback) {
                result.withTx(completion).set({ value: 7, pending: false });
              }
              expect((await completion.commit()).error).toBeUndefined();
              completedFirst.resolve();
            } catch (error) {
              completedFirst.reject(error);
              throw error;
            }
          },
        });
        original.enqueuePostCommitEffect({
          id: "s1-other-effect",
          kind: "fetchTest-start",
          flush: async () => {
            issuedOther.resolve();
            await releaseOther.promise;
            otherCompleted = true;
          },
        });
        expect((await original.commit()).error).toBeUndefined();
        await Promise.all([issuedFirst.promise, issuedOther.promise]);
        const id = result.getAsNormalizedFullLink().id;
        const originalRecord = Engine.selectCommitsSince(engine, {
          fromSeq: 0,
          limit: 10_000,
        }).findLast((record) => record.writes.some((write) => write.id === id));
        expect(originalRecord).toBeDefined();
        await awaitAdmitted(
          server,
          () => readWatermarkSeq(engine) >= originalRecord!.seq,
        );
        expect(host.stats().memo.inflight).toBe(2);
        if (withOverlay) {
          await waitOnDelivery({
            manager: clientManager,
            wants: (deliveredSpace, id) =>
              deliveredSpace === space &&
              id === SERVER_EXECUTION_WATERMARK_DOC_ID,
            predicate: () => (wmCell.get()?.seq ?? 0) >= originalRecord!.seq,
            label: "the original wave's watermark to reach the client",
          });
          holdWatermark = true;
        }
        const headBefore = Engine.serverSeq(engine);
        const authoredBefore = authoredCount(engine);
        releaseFirst.resolve();
        await completedFirst.promise;
        // The count drops when the outbox retires the effect, and an
        // empty completion commits nothing for an admission wait to wake
        // on, so this reads the count again on each retirement.
        await awaitEach(retirements, () => host!.stats().memo.inflight === 1);
        expect(otherCompleted).toBe(false);
        const completionRecords = Engine.selectCommitsSince(engine, {
          fromSeq: headBefore,
          limit: 10_000,
        }).filter((record) => record.writes.some((write) => write.id === id));
        if (writeback) {
          expect(completionRecords).toHaveLength(1);
          const completion = completionRecords[0];
          expect(completion.class).toBe("derived");
          expect(completion.holder).toBe(host.spaceServer(space)!.holder);
          if (withOverlay) {
            await waitOnDelivery({
              manager: clientManager,
              wants: (deliveredSpace, deliveredId) =>
                deliveredSpace === space && deliveredId === id,
              predicate: () => clientResult.key("value").get() === 7,
              label: "the committed completion to reach the client",
            });
            expect(wmCell.get()?.seq ?? 0).toBeLessThan(completion.seq);
            const overlay = clientRuntime.speculationOverlay!;
            const speculative = clientRuntime.edit();
            stampSpeculationRunContext(speculative, {
              actionId: "s1-completion-rederivation",
              kind: "derivation",
            });
            expect(clientResult.withTx(speculative).key("value").get()).toBe(7);
            clientResult.withTx(speculative).key("pending").set(true);
            expect((await speculative.commit()).error).toBeUndefined();
            expect(overlay.entryCount(space)).toBeGreaterThanOrEqual(1);
            expect(clientResult.key("pending").get()).toBe(true);
            expect(Engine.readState(engine, { id })?.document).toMatchObject({
              value: { value: 7, pending: false },
            });
            holdWatermark = false;
            for (const notice of heldNotices.splice(0)) {
              noteExecutorCommit(notice);
            }
          }
          await awaitAdmitted(
            server,
            () => readWatermarkSeq(engine) >= completion.seq,
          );
          if (withOverlay) {
            await waitOnDelivery({
              manager: clientManager,
              wants: (deliveredSpace, deliveredId) =>
                deliveredSpace === space &&
                (deliveredId === SERVER_EXECUTION_WATERMARK_DOC_ID ||
                  deliveredId === id),
              predicate: () =>
                clientRuntime.speculationOverlay!.entryCount(space) === 0 &&
                clientResult.key("pending").get() === false,
              label:
                "the divergent pending layer to retire after completion coverage",
            });
            expect(clientResult.key("value").get()).toBe(7);
          }
        } else {
          expect(completionRecords).toEqual([]);
          expect(Engine.serverSeq(engine)).toBe(headBefore);
        }
        expect(otherCompleted).toBe(false);
        expect(host.stats().memo.inflight).toBe(1);
        expect(authoredCount(engine)).toBe(authoredBefore);
      } finally {
        holdWatermark = false;
        for (const notice of heldNotices) noteExecutorCommit(notice);
        server.noteExecutorCommit = noteExecutorCommit;
        releaseFirst.resolve();
        releaseOther.resolve();
        cancelWatermark?.();
        cancelDemand();
      }
    });
  }
  it("preserves a completion committed inside an older advance's seal window", async () => {
    const engine = await server.engineForSpace(space);
    const ready = Promise.withResolvers<Runtime>();
    const injected = Promise.withResolvers<void>();
    const completionId = "of:s1-completion-mid-advance";
    let armed = false;
    let injectionStarted = false;
    let selectedAdvance: number | undefined;
    onServingRuntime = (runtime) => {
      const edit = runtime.edit.bind(runtime);
      runtime.edit = () => {
        const tx = edit();
        const write = tx.writeValueOrThrow.bind(tx);
        let watermark: number | undefined;
        tx.writeValueOrThrow = (link, value) => {
          if (
            link.id === SERVER_EXECUTION_WATERMARK_DOC_ID &&
            typeof value === "number"
          ) {
            watermark = value;
          }
          return write(link, value);
        };
        const commit = tx.commit.bind(tx);
        tx.commit = async () => {
          if (
            armed && !injectionStarted && watermark !== undefined &&
            watermark > maxAuthoredSeq(engine)
          ) {
            injectionStarted = true;
            selectedAdvance = watermark;
            try {
              const completion = edit();
              markEffectCompletion(completion, "s1-mid-advance-effect");
              completion.writeValueOrThrow({
                ...watermarkDocLink(space),
                id: completionId as ReturnType<typeof watermarkDocLink>["id"],
                path: [],
              }, { value: 7 });
              expect((await completion.commit()).error).toBeUndefined();
              injected.resolve();
            } catch (error) {
              injected.reject(error);
              throw error;
            }
          }
          return commit();
        };
        return tx;
      };
      ready.resolve(runtime);
      return Promise.resolve();
    };
    host = newHost();
    openClient();
    const clientResult = clientRuntime.getCell<unknown>(
      space,
      "s1-completion-seed",
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    try {
      const serving = await ready.promise;
      await activated();
      armed = true;
      const seed = serving.edit();
      stampWaveRunContext(seed, {
        actionId: "s1-completion-seed",
        kind: "derivation",
      });
      serving.getCell<unknown>(space, "s1-completion-seed").withTx(seed).set({
        ready: true,
      });
      expect((await seed.commit()).error).toBeUndefined();
      await injected.promise;
      const completion = Engine.selectCommitsSince(engine, { fromSeq: 0 }).find(
        (record) => record.writes.some((write) => write.id === completionId),
      );
      expect(completion).toBeDefined();
      expect(completion!.class).toBe("derived");
      expect(completion!.seq).toBeGreaterThan(selectedAdvance!);
      expect(
        completion!.writes.some((write) =>
          write.id === SERVER_EXECUTION_WATERMARK_DOC_ID
        ),
      ).toBe(false);
      const authoredBefore = authoredCount(engine);
      await awaitAdmitted(
        server,
        () => readWatermarkSeq(engine) >= completion!.seq,
      );
      const advances = Engine.selectCommitsSince(engine, { fromSeq: 0 }).filter(
        (record) =>
          record.class === "derived" && record.writes.length === 1 &&
          record.writes[0].id === SERVER_EXECUTION_WATERMARK_DOC_ID,
      );
      expect(advances).toHaveLength(2);
      await awaitAdmitted(
        server,
        () => host!.stats().settleAdvances.count === advances.length,
      );
      expect(authoredCount(engine)).toBe(authoredBefore);
    } finally {
      cancelDemand();
    }
  });
});
