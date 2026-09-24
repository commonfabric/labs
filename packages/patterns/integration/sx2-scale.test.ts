// Server-execution v2 Phase 6 gate: budgets and scale, live
// (testing.md §5's `sx2-scale`; docs/plans/server-execution-v2.md
// Phase 6). Headless: PiecesController clients drive real patterns
// against toolshed; in the ON arm the toolshed's ExecutorHost serves
// the spaces and this suite asserts the Phase-6 gates from
// `/api/health/stats` COUNTERS and watermark settles — never logs,
// never text-polling (testing.md §3–§4):
//
// - BUDGET ISOLATION (the plan's "a deliberate LLM fan-out loop in one
//   space leaves a second space's propagation latency inside budget"):
//   space A floods NETWORK effects (a fetch fan-out against a
//   deliberately slow local endpoint — the same egress class as an LLM
//   fan-out, CI-runnable without provider keys), space B runs the
//   plain counter workload; B's settle latency mid-flood stays inside
//   budget, and A's per-space budget ENGAGES
//   (`outbox.budgetDeferrals` counts — the fan-out exceeds the
//   default 16-outstanding cap);
// - FLAT ACCUMULATION (the plan's "cf-checkbox in-suite ≈ isolated",
//   held as its substance: server latency must stay flat as spaces
//   accumulate — v1 measured 4 s isolated vs 138 s in-suite): a fresh
//   space's settle latency after N accumulated served spaces stays in
//   the ballpark of the first space's;
// - PUSH PRIORITY (protocol.md §3; verification-coverage.md OW8): the
//   ON-arm stats carry the `servingLoop.push` counter block (the
//   deterministic frame-ORDER pin lives in
//   packages/memory/test/v2-push-priority.test.ts — a live mixed batch
//   is timing-shaped, so the gate here asserts only that the counter
//   block is WIRED in the ON arm — present and non-negative — not a
//   forced reorder);
// - NO POLL-LOOPS (the plan's "no integration test needs a poll-loop
//   for 'is the server done'"): the sx2 gate family itself is audited —
//   server-done waits ride `waitForSettled`, never text-polling.
//
// OFF arm: the same workloads run client-derived (byte-identical
// writes); the servingLoop stats block is absent, settles ride
// `synced()`, and the ON-arm assertions are skipped explicitly.

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

/** The Phase-6 budget-isolation calibration. The spec budget for the
 * push hot path is 300 ms p50 LAN on a quiet box (README §3.3);
 * CI boxes are neither quiet nor calibrated, so the gate binds a
 * decisive-but-noise-tolerant envelope: absolute ceiling + a multiple
 * of the same box's own baseline. A coupled flood (v1's failure mode)
 * blows both by an order of magnitude. */
const SETTLE_BUDGET_ABSOLUTE_MS = 5_000;
const SETTLE_BUDGET_BASELINE_MULTIPLE = 5;
const ACCUMULATION_ABSOLUTE_MS = 2_500;
const ACCUMULATION_BASELINE_MULTIPLE = 4;

/** How hard space A's fan-out floods (> the default 16-outstanding
 * per-space cap, so the budget visibly engages in the ON arm). */
const FLOOD_PIECES = 20;
const SLOW_ENDPOINT_DELAY_MS = 2_500;

type ServingLoopStats = {
  waves: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;
  outbox: {
    queued: number;
    completed: number;
    failed: number;
    budgetDeferrals: number;
  };
  push?: {
    prioritizedSessions: number;
    followerSessions: number;
    mixedFlushes: number;
  };
};

const fetchServingLoopStats = async (): Promise<
  ServingLoopStats | undefined
> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: ServingLoopStats };
  return body.servingLoop;
};

/** Bounded counter read (the two-producer notice hop — see
 * sx2-serving-loop): the CONDITION is a counter predicate, the wait
 * gives the in-process notice its beat to drain. */
const waitForStats = async (
  predicate: (stats: ServingLoopStats) => boolean,
  label: string,
  timeoutMs = 20_000,
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** A fetch fan-out piece: one network effect per piece, distinct URL →
 * distinct memo key → a real per-piece egress. */
const FLOOD_PATTERN = [
  "import { fetchJson, pattern } from 'commonfabric';",
  "export default pattern<{ url: string }, { status: string }>(",
  "  ({ url }) => {",
  "    const data = fetchJson<{ ok?: boolean }>({ url });",
  "    return { status: data.result ? 'done' : 'pending' };",
  "  },",
  ");",
].join("\n");

describe("sx2 scale (Phase 6 gates)", () => {
  let slowServer: Deno.HttpServer | undefined;
  let slowPort = 0;
  const controllers: PiecesController[] = [];

  const newController = async (suffix: string): Promise<PiecesController> => {
    const identity = await Identity.generate({ implementation: "noble" });
    const controller = await initializePiecesController({
      space: `${SPACE_NAME}-sx2-scale-${suffix}`,
      apiUrl: new URL(API_URL),
      identity,
    });
    controllers.push(controller);
    return controller;
  };

  /** Stand up the counter pattern with a live reader (the demand the
   * serving loop maps server-side), returning a measured settle:
   * one authored write to `value`, then the arm-appropriate settle —
   * watermark (ON) or synced (OFF) — timed. */
  const standUpCounter = async (
    cc: PiecesController,
  ): Promise<{
    piece: PieceController;
    cancel: () => void;
    settleWrite: (value: number) => Promise<number>;
  }> => {
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
    const piece = await cc.create(program, { start: true });
    const resultCell = cc.getResult(piece.getCell());
    const cancel = resultCell.sink(() => {});
    const runtime = cc.runtime;
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;
    if (FLAG_ON) {
      await runtime.storageManager.synced();
      await waitForSettled(runtime, space, 1, { timeoutMs: 30_000 });
    } else {
      await runtime.storageManager.synced();
    }
    const settleWrite = async (value: number): Promise<number> => {
      const startedAt = Date.now();
      // The settled target derives from the OBSERVED pre-write
      // watermark (the sx2-serving-loop shape): the write advances the
      // space head by ≥1, so W must pass watermarkBefore. Never a
      // server-seq-derived target — those count the loop's own derived
      // echoes, which coverage never claims on a quiet space (the OW26
      // lesson).
      const watermarkBefore = FLAG_ON
        ? ((watermarkCell(runtime, space).get() as
          | { seq?: number }
          | undefined)?.seq ?? 0)
        : 0;
      const tx = runtime.edit();
      resultCell.withTx(tx).key("value").set(value);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(`authored write failed: ${committed.error.message}`);
      }
      await runtime.storageManager.synced();
      if (FLAG_ON) {
        await waitForSettled(runtime, space, watermarkBefore + 1, {
          timeoutMs: 30_000,
        });
      }
      return Date.now() - startedAt;
    };
    return { piece, cancel, settleWrite };
  };

  beforeAll(() => {
    // The deliberately slow local endpoint the fan-out floods — the
    // stand-in for a slow LLM provider, CI-runnable with no keys.
    slowServer = Deno.serve(
      { port: 0, onListen: () => {} },
      async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, SLOW_ENDPOINT_DELAY_MS)
        );
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    slowPort = (slowServer.addr as Deno.NetAddr).port;
  });

  afterAll(async () => {
    for (const controller of controllers) {
      await controller.dispose();
    }
    await slowServer?.shutdown();
  });

  it("a hostile effect fan-out in space A leaves space B's propagation inside budget, and A's per-space budget engages (Phase 6)", async () => {
    const ccB = await newController("quiet");
    const counterB = await standUpCounter(ccB);

    // Baseline: B's settle latency on a quiet server (3 reps, take the
    // max — counters and set relations over single-shot latencies).
    let baseline = 0;
    for (const value of [1, 2, 3]) {
      baseline = Math.max(baseline, await counterB.settleWrite(value));
    }

    const statsBefore = FLAG_ON ? await fetchServingLoopStats() : undefined;
    if (FLAG_ON) {
      assert(
        statsBefore !== undefined,
        "the ON arm must expose the servingLoop stats block",
      );
    }

    // The flood: FLOOD_PIECES fetch fan-out pieces in space A, each a
    // distinct slow URL (distinct memo keys — real per-piece egress),
    // each with a live reader (the demand that makes the ON arm serve
    // its effect).
    const ccA = await newController("flood");
    // The first create compiles (and caches) the pattern; the rest run
    // CONCURRENTLY so the fan-out's effect admissions BUNCH — a serial
    // create chain spreads them past the slow endpoint's window and >16
    // are never outstanding at once, making the budget witness flaky.
    const compiledOnce = await ccA.create(FLOOD_PATTERN, {
      start: true,
      input: { url: `http://127.0.0.1:${slowPort}/slow/seed` },
    });
    const floodCancels: Array<() => void> = [];
    floodCancels.push(ccA.getResult(compiledOnce.getCell()).sink(() => {}));
    const rest = await Promise.all(
      Array.from(
        { length: FLOOD_PIECES - 1 },
        (_, index) =>
          ccA.create(FLOOD_PATTERN, {
            start: true,
            input: { url: `http://127.0.0.1:${slowPort}/slow/${index + 1}` },
          }),
      ),
    );
    for (const piece of rest) {
      floodCancels.push(ccA.getResult(piece.getCell()).sink(() => {}));
    }
    await ccA.runtime.storageManager.synced();

    // Space B's propagation DURING the flood: the isolation gate.
    let midFlood = 0;
    for (const value of [10, 20, 30]) {
      midFlood = Math.max(midFlood, await counterB.settleWrite(value));
    }
    assert(
      midFlood <= SETTLE_BUDGET_ABSOLUTE_MS,
      `space B settle ${midFlood}ms mid-flood exceeds the absolute ` +
        `${SETTLE_BUDGET_ABSOLUTE_MS}ms budget — the fan-out coupled ` +
        "across spaces (Phase 6's isolation gate)",
    );
    assert(
      midFlood <=
        Math.max(
          baseline * SETTLE_BUDGET_BASELINE_MULTIPLE,
          SETTLE_BUDGET_ABSOLUTE_MS / 2,
        ),
      `space B settle ${midFlood}ms mid-flood vs baseline ${baseline}ms ` +
        "exceeds the relative budget — the fan-out coupled across spaces",
    );

    if (FLAG_ON) {
      // The per-space budget ENGAGED: the fan-out exceeds the default
      // 16-outstanding cap, so dispatch holds were counted. This is
      // the counter witness that the flood really rode the budget
      // gate (a vacuously-quiet flood would prove nothing).
      await waitForStats(
        (stats) =>
          stats.outbox.budgetDeferrals >
            (statsBefore?.outbox.budgetDeferrals ?? 0),
        "space A's fan-out to engage the per-space budget " +
          "(outbox.budgetDeferrals)",
        60_000,
      );
    }

    for (const cancel of floodCancels) cancel();
    counterB.cancel();
  });

  it("propagation latency stays flat as served spaces accumulate (the suite-context degradation gate)", async () => {
    // Baseline: the first fresh space.
    const first = await standUpCounter(await newController("acc-first"));
    let baseline = 0;
    for (const value of [1, 2]) {
      baseline = Math.max(baseline, await first.settleWrite(value));
    }
    first.cancel();

    // Accumulate: N more served spaces, each with real work.
    for (let index = 0; index < 8; index++) {
      const accumulated = await standUpCounter(
        await newController(`acc-${index}`),
      );
      await accumulated.settleWrite(1);
      accumulated.cancel();
    }

    // The late fresh space: latency must stay in the first one's
    // ballpark (v1's suite-context degradation was 34×).
    const late = await standUpCounter(await newController("acc-late"));
    let lateLatency = 0;
    for (const value of [1, 2]) {
      lateLatency = Math.max(lateLatency, await late.settleWrite(value));
    }
    late.cancel();
    assert(
      lateLatency <=
        Math.max(
          baseline * ACCUMULATION_BASELINE_MULTIPLE,
          ACCUMULATION_ABSOLUTE_MS,
        ),
      `late-space settle ${lateLatency}ms vs first-space ${baseline}ms — ` +
        "server latency accumulated with space count (the v1 " +
        "suite-context degradation class)",
    );
  });

  it("carries the push-priority counters in the ON arm (protocol.md §3; OW8's counter half)", async () => {
    if (!FLAG_ON) {
      assertEquals(await fetchServingLoopStats(), undefined);
      return;
    }
    const stats = await fetchServingLoopStats();
    assert(stats !== undefined);
    // The counter block exists and is sane; the deterministic ORDER pin
    // is unit-level (packages/memory/test/v2-push-priority.test.ts) —
    // a live mixed batch needs derived and bulk novelty in ONE flush
    // window, which wall-clock timing cannot force reliably here.
    assert(
      stats.push !== undefined,
      "the ON-arm servingLoop stats must carry the push-priority block",
    );
    assert(stats.push.prioritizedSessions >= 0);
    assert(stats.push.followerSessions >= 0);
    assert(stats.push.mixedFlushes >= 0);
  });

  it("keeps the sx2 gate family free of server-done poll-loops (testing.md §3)", async () => {
    // The Phase-6 criterion "no integration test needs a poll-loop for
    // 'is the server done'", enforced where this train owns the tests:
    // the sx2 gate family settles via the watermark. Bounded
    // counter-condition waits (waitForStats) and value-arrival reads
    // after a settle are NOT server-done polls; `waitForCondition` and
    // raw settle-by-sleep are.
    const dir = import.meta.dirname!;
    // Built indirectly so this file's own audit does not self-flag on
    // its assertion message.
    const pollNeedle = ["waitForCondition", "("].join("");
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.name.startsWith("sx2-") || !entry.name.endsWith(".test.ts")) {
        continue;
      }
      const source = await Deno.readTextFile(join(dir, entry.name));
      assert(
        !source.includes(pollNeedle),
        `${entry.name} polls with ${pollNeedle}) — use waitForSettled ` +
          "(testing.md §3)",
      );
      if (entry.name !== "sx2-scale.test.ts") {
        assert(
          source.includes("waitForSettled"),
          `${entry.name} must settle via the watermark helper ` +
            "(testing.md §3)",
        );
      }
    }
  });
});
