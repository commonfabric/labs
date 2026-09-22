// Server-execution v2 Phase 2 gate: the serving loop, live
// (testing.md §5's `sx2-serving-loop` — counters, amplification, and
// the settle discipline). Headless: a PiecesController client drives
// the real counter pattern against toolshed; in the ON arm the
// toolshed's ExecutorHost serves the space and this test asserts the
// serving-loop gates from `/api/health/stats` COUNTERS — never logs,
// never text-polling (testing.md §3–§4):
//
// - the client settles via `waitForSettled` (the watermark doc — the
//   poll-loop replacement);
// - ONE authoritative run per upstream change, waves ≈ authored input
//   batches (ballpark, testing.md §4);
// - amplification `derivedCommits / (authoredSeen − effectAcks)` ≤ 2
//   on this pure workload (the §4 budget — a TRIGGER: a breach fails
//   with the numbers so a human inspects the why);
// - the serving loop settles against the REAL toolshed while nothing
//   follows a piece's source origin on its behalf (the plan's Phase 2
//   revisit (b)): a serving tenure opens no piece, so it fetches no
//   pattern route, and its settle must reach quiescence without one.
//   A full stale-pointer roll-forward journey stays a follow-up.
//
// OFF arm: the same workload runs client-derived (today's posture,
// byte-identical); the servingLoop stats block is absent and the
// ON-arm assertions are skipped explicitly.

import { debugStr } from "@commonfabric/data-model";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  waitForSettled,
  watermarkCell,
} from "@commonfabric/runner/executor/watermark";
import type { MemorySpace } from "@commonfabric/runner";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, SPACE_NAME } = env;

// The arm this process runs in: the explicit env value, else the
// first-party default (ON since the server-execution v2 Phase 7 flip —
// the deployed-topology presets resolve an unset flag to it, and so does
// the toolshed the harness started).
const FLAG_ON = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === undefined
  ? SERVER_EXECUTION_DEFAULT_ENABLED
  : Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";

type ServingLoopStats = {
  waves: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;
  structureLoadFailures: number;

  /** S1 (RULED 2026-08-19): drain-settle quiescence advances — the
   * advance-only waves the budgets below subtract. */
  settleAdvances: { count: number };
};

const fetchServingLoopStats = async (): Promise<
  ServingLoopStats | undefined
> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: ServingLoopStats };
  return body.servingLoop;
};

/** Bounded poll for a counter condition (stage P2-F, the unskip's
 * flake diagnosis): counters lag the observable they witness by an
 * in-process notice hop — the feed has two producers (the admission
 * hook's async notify, the loop's sync post-commit note), so a
 * point-read right after `waitForSettled` can catch the accounting a
 * beat before the late notice drains. The CONDITION is unchanged;
 * only the read is given its bounded moment to arrive. */
const waitForStats = async (
  predicate: (stats: ServingLoopStats) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<ServingLoopStats> => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const stats = await fetchServingLoopStats();
    if (stats !== undefined && predicate(stats)) return stats;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label} — last stats: ` +
          debugStr`$quote,long${stats}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("sx2 serving loop (Phase 2 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  let latestValue: number | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: `${SPACE_NAME}-sx2-loop`,
      apiUrl: new URL(API_URL),
      identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "counter",
      "counter.tsx",
    );
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath },
    );
    piece = await cc.create(program, { start: true });
    // The live reader is the DEMAND (serving-loop.md §1): it keeps the
    // piece reactive locally AND is the client subscription the serving
    // loop maps to server-side demand in the ON arm.
    const resultCell = cc.getResult(piece.getCell());
    sinkCancel = resultCell.sink((value: unknown) => {
      latestValue = (value as { value?: number } | undefined)?.value;
    });
    // Settle ROUND ONE before the measured window (testing.md §6: the
    // budget is "for the steady-state interaction window, measured
    // between first and last user action"): under the flag the result
    // doc's server-derived required properties ($NAME et al) are
    // legitimately LATE — the scheduler-tell ruling (protocol §1,
    // 2026-08-07) makes creation authored and round one server-run —
    // and `PiecePropIo.set` validates against the replica's
    // instantaneous view with no convergence step, so a write in the
    // creation window fails `missing required property $NAME`. That
    // set-validation convergence question is an ESCALATED design fork
    // (converge-before-validate vs relax), deliberately not resolved
    // here; this gate measures the steady-state window the spec
    // defines.
    if (FLAG_ON) {
      const runtime = cc.runtime;
      const space = piece.getCell().getAsNormalizedFullLink()
        .space as MemorySpace;
      await runtime.storageManager.synced();
      await waitForSettled(runtime, space, 1, { timeoutMs: 30_000 });
    }
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("serves authored inputs within the amplification budget, settling on waitForSettled (testing.md §3–§4)", async () => {
    const stats0 = await fetchServingLoopStats();
    if (!FLAG_ON) {
      // OFF arm: no serving loop exists; the workload still runs
      // client-derived, byte-identical to today.
      assertEquals(stats0, undefined);
      await piece.result.set(5, ["value"]);
      await cc.runtime.storageManager.synced();
      assertEquals(await piece.result.get(["value"]), 5);
      return;
    }
    assert(
      stats0 !== undefined,
      "the ON arm must expose the servingLoop stats block",
    );

    const runtime = cc.runtime;
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;

    const watermarkBefore =
      (watermarkCell(runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;

    // Three authored inputs — the steady-state interaction window the
    // §4 budget is measured over. Written as DIRECT cell writes (the
    // UI-binding shape — an ordinary authored commit to the value
    // path): `PiecePropIo.set`'s whole-result schema validation is the
    // ESCALATED set-validation fork's surface (it validates against
    // the replica's instantaneous view while the ON arm makes
    // server-derived required properties legitimately late), and this
    // gate measures the SERVING LOOP, not the controller's validation.
    const resultCell = cc.getResult(piece.getCell());
    for (const value of [10, 20, 30]) {
      const tx = runtime.edit();
      resultCell.withTx(tx).key("value").set(value);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(`authored write failed: ${committed.error.message}`);
      }
    }
    await runtime.storageManager.synced();

    // Settle via the WATERMARK, never text-polling: the target derives
    // from the OBSERVED pre-write watermark (a literal target the
    // creation window already passed would resolve vacuously) — the
    // three authored inputs each advanced the space head by at least
    // one, so W must reach past watermarkBefore + 3.
    const settledSeq = await waitForSettled(
      runtime,
      space,
      watermarkBefore + 3,
      { timeoutMs: 30_000 },
    );
    assert(
      settledSeq >= watermarkBefore + 3,
      `W=${settledSeq} must cover the inputs past ${watermarkBefore}`,
    );

    // The value is authoritative AFTER settle (one-shot assertion — the
    // watermark answered "when", this answers "what").
    assertEquals(latestValue, 30);

    // The three authored notices are counted within a bounded moment
    // of the settle (the two-producer notice hop above); the
    // amplification arithmetic then reads ONE coherent snapshot.
    const stats1 = await waitForStats(
      (stats) => stats.authoredSeen - stats0.authoredSeen >= 3,
      "the authored inputs to be counted (>= 3)",
    );
    const authored = stats1.authoredSeen - stats0.authoredSeen;
    const derived = stats1.derivedCommits - stats0.derivedCommits;
    const acks = stats1.effectAcks - stats0.effectAcks;
    const waves = stats1.waves - stats0.waves;
    // FLAGGED EDIT (W3.1 S1, RULED 2026-08-19): the drain-settle
    // quiescence advance mints ONE advance-only wave per quiescence
    // transition (a bookkeeping-only derived commit carrying the
    // watermark over the tail derivations — the swatch-stall class
    // fix). Those waves are counted in `settleAdvances` precisely so
    // budget arithmetic can subtract them: they are latch-bounded by
    // design (never per-wave, never self-chasing — pinned in
    // executor-settle-advance.test.ts), so including them would make
    // these TRIGGER budgets fire on designed behavior, not runaway
    // amplification. Both budgets below measure the CONTENT waves.
    const advances = stats1.settleAdvances.count -
      stats0.settleAdvances.count;
    assert(derived >= 1, "the loop must have derived at least one wave");
    // ONE authoritative run per upstream change, coalescing allowed:
    // waves stay in the ballpark of authored input batches
    // (testing.md §4's single-run gate).
    assert(
      waves - advances <= authored + 2,
      `waves delta ${waves} (minus ${advances} quiescence advances) ` +
        `must stay in the ballpark of ${authored} authored batches`,
    );
    // The §4 amplification budget — a TRIGGER, not a silent gate: a
    // breach fails WITH the numbers so a human inspects the why.
    const logicalWrites = authored - acks;
    const ratio = (derived - advances) / Math.max(1, logicalWrites);
    assert(
      ratio <= 2,
      `amplification (${derived}−${advances})/${logicalWrites} = ` +
        `${ratio.toFixed(2)} ` +
        "exceeds the ≤2 pure-workload budget (testing.md §4) — inspect " +
        "before re-baselining",
    );
    // The advances themselves stay latch-bounded: at most one per
    // quiescence transition — a small constant over three inputs, far
    // below one-per-wave (the executor pins carry the exact guarantee).
    assert(
      advances <= authored + 1,
      `quiescence advances ${advances} exceed the once-per-transition ` +
        `bound over ${authored} inputs — the S1 latch is broken`,
    );
  });

  it("keeps the serving loop settled while nothing follows a piece's origin for it (the Phase 2 revisit (b) surface)", async () => {
    if (!FLAG_ON) return;
    // Following a piece's source origin belongs to whoever opens the
    // piece (serving-loop.md §3e), and a serving tenure opens none.
    // The verification is machinery-level and stated so: the served
    // piece above reached watermark-covered quiescence against
    // toolshed's real routes, and the demanded structure kept loading.
    // A full stale-pointer roll-forward journey is the named
    // follow-up.
    const stats = await fetchServingLoopStats();
    assert(stats !== undefined);
    const runtime = cc.runtime;
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;
    const watermarkBefore =
      (watermarkCell(runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;
    {
      const resultCell = cc.getResult(piece.getCell());
      const tx = runtime.edit();
      resultCell.withTx(tx).key("value").set(41);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(`authored write failed: ${committed.error.message}`);
      }
    }
    await runtime.storageManager.synced();
    const settledSeq = await waitForSettled(
      runtime,
      space,
      watermarkBefore + 1,
      { timeoutMs: 30_000 },
    );
    assert(settledSeq >= watermarkBefore + 1);
    // The value arrives on the ordinary subscription push, which the
    // watermark settle does not order — same bounded wait as the first
    // gate's value read (the settle answered "when", this answers
    // "what").
    {
      const deadline = Date.now() + 10_000;
      while (latestValue !== 41) {
        if (Date.now() > deadline) {
          throw new Error(
            `client sink never observed 41 (latest: ${latestValue})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assertEquals(latestValue, 41);
    // Non-vacuity first (review thread r3739139538): the failure-count
    // equality below proves nothing if the loop did no work in this
    // window — pin that the serving loop actually consumed the
    // authored input and derived. Bounded waits, not point reads: the
    // settle target derives from a pre-write watermark observation, so
    // a background wave (the updater's own activity) can satisfy it
    // before THIS input's wave lands — the counters are the witness
    // that the input itself was consumed.
    const after = await waitForStats(
      (candidate) =>
        candidate.authoredSeen > stats.authoredSeen &&
        candidate.derivedCommits > stats.derivedCommits,
      "the serving loop to consume the authored input and derive",
    );
    assertEquals(
      after.structureLoadFailures,
      stats.structureLoadFailures,
      "the demanded-structure load path must stay clean under the " +
        "server-side updater posture",
    );
  });
});
