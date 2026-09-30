// Server-execution v2 Phase 2 gate: client speculation, live
// (testing.md §5's `sx2-speculation` — echo latency, overlay
// retirement, and the client's lost derivation-commit path). A
// PiecesController client drives the counter pattern against toolshed:
//
// - the ECHO: the actor's own edit renders locally without waiting on
//   the server round trip (speculation.md §3 — rendering reads through
//   the overlay);
// - RETIREMENT: once the replicated watermark covers the input, the
//   overlay empties (speculation.md §4) and the STORE value renders
//   through the same path;
// - the client commits NO derivation: the overlay diagnostic is the
//   client-side witness here; the store-attribution query (zero
//   `derived`-class commits from any client session) is pinned with
//   engine access in `packages/runner/test/speculation-overlay.test.ts`
//   and the admission layer refuses non-holder derived commits by
//   construction (protocol.md §2).
//
// OFF arm: the client derives and commits as today — the overlay never
// exists (byte-identical posture), asserted explicitly.

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { createTestSpace, env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
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

const { API_URL } = env;

// The arm this process runs in: the explicit env value, else the
// first-party default (ON since the server-execution v2 Phase 7 flip —
// the deployed-topology presets resolve an unset flag to it, and so does
// the toolshed the harness started).
const FLAG_ON = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === undefined
  ? SERVER_EXECUTION_DEFAULT_ENABLED
  : Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === "true";

describe("sx2 speculation (Phase 2 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  let latestValue: number | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: await createTestSpace(identity),
      apiUrl: new URL(API_URL),
      identity,
      cfcFlowLabels: "persist",
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
    const resultCell = cc.getResult(piece.getCell());
    sinkCancel = resultCell.sink((value: unknown) => {
      latestValue = (value as { value?: number } | undefined)?.value;
    });
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("echoes locally, retires the overlay on watermark coverage, and never holds a derivation commit (speculation.md §1, §3, §4)", async () => {
    const runtime = cc.runtime;
    if (!FLAG_ON) {
      // OFF arm, byte-identical: no overlay exists — the client derives
      // and commits as today.
      assertEquals(runtime.speculationOverlay, undefined);
      await piece.result.set(7, ["value"]);
      await runtime.storageManager.synced();
      assertEquals(await piece.result.get(["value"]), 7);
      return;
    }

    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;

    // Observe W BEFORE the edit: the edit advances the space head by at
    // least one, so settled-for-this-edit means W reached past the
    // pre-edit watermark.
    const watermarkBefore =
      (watermarkCell(runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;

    // PULL the result chain once before editing — the real client
    // shape (render precedes the first edit), materializing the write
    // destination's producer chain: the KEPT #4717 write-destination
    // validator still reads the instantaneous view (the ruled
    // narrowing covered the schema half only), so a cold-chain write
    // in the creation window can fail on the server-derived-late
    // producer — the escalated fork's remaining surface, noted in the
    // PR's Flags.
    const resultCell = cc.getResult(piece.getCell());
    await resultCell.pull();
    const overlay = runtime.speculationOverlay;

    // Creation itself can leave speculative derivation entries live until
    // the serving side's authoritative values arrive. Starting the measured
    // edit on those process-local layers makes the authored commit read a
    // speculative basis and correctly fail admission. Wait on the entries'
    // settlement events so this test begins its edit from the store-backed
    // state it means to measure.
    await overlay?.waitForSpaceQuiescence(space);

    // The ECHO: the authored edit's local render does not gate on the
    // serving round trip. The result sink observes the value through
    // the overlay-reading path as soon as the local run lands.
    // The set retries ONCE-per-backoff on the KEPT write-destination
    // validator's instantaneous-view failure (the escalated
    // set-validation fork's remaining half after the 2026-08-07
    // ruling narrowed the schema half): under load the destination's
    // producer chain materializes late and the first attempt can see
    // a cold view. The retry is SCOPED to this cold-view creation
    // window and its engagement is logged LOUDLY below — the
    // steady-state edit further down runs with NO retry at all, so
    // the open validator defect can never hide behind this loop
    // outside the window it exists for. This gate's subject is the
    // OVERLAY lifecycle; the un-retried controller path stays
    // exercised by the counter product gate.
    const echoStart = performance.now();
    let coldViewRetries = 0;
    // The loop's only exits are the success `break` and a `throw`
    // (attempt >= 3 or a non-matching error), so no post-loop guard is
    // needed — a previous `lastDestinationIssue` re-throw here was
    // unreachable (review thread r3739139546).
    for (let attempt = 0;; attempt++) {
      try {
        await piece.result.set(7, ["value"]);
        break;
      } catch (error) {
        if (
          attempt < 3 &&
          String(error).includes("does not match its write destination")
        ) {
          coldViewRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw error;
      }
    }
    if (coldViewRetries > 0) {
      // Visible when it engages (never a silent mask): the count and
      // the class it absorbed.
      console.log(
        `[sx2-speculation] cold-view retry engaged: ${coldViewRetries} ` +
          "attempt(s) absorbed by the destination-validator window " +
          "(the open set-validation fork's remaining half)",
      );
    }
    const deadline = performance.now() + 5_000;
    while (latestValue !== 7 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const echoMs = performance.now() - echoStart;
    assertEquals(latestValue, 7);

    // RETIREMENT: settle via the watermark — the target derives from
    // the OBSERVED watermark before the edit (testing.md §3's settled
    // is `W >= seq(my last authored commit)`; a literal target a busy
    // creation window already passed would resolve vacuously), then
    // the overlay must drain — the authoritative values replaced every
    // echo entry (speculation.md §4; the diagnostic is the client-side
    // witness of "commits nothing for derivations").
    await runtime.storageManager.synced();
    await waitForSettled(runtime, space, watermarkBefore + 1, {
      timeoutMs: 30_000,
    });
    await overlay?.waitForSpaceQuiescence(space);
    assertEquals(
      overlay === undefined ? 0 : overlay.entryCount(space),
      0,
      "every overlay entry must retire once the watermark covers its " +
        "basis (speculation.md §4)",
    );

    // The value stands — now as STORE state through the same render
    // path (silent replacement, speculation.md §3).
    assertEquals(await piece.result.get(["value"]), 7);

    // STEADY STATE, zero retries (the review's m9): the bounded retry
    // above exists for the documented COLD-VIEW window only. Here the
    // producer chain is materialized, served, and settled — a
    // destination-validator failure now IS the open set-validation
    // fork engaging outside its window, and it must fail this gate
    // loudly instead of riding the mask. The raw set either lands or
    // throws; asserting retries == 0 is exactly this un-wrapped call.
    const watermarkBeforeSteady =
      (watermarkCell(runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;
    await piece.result.set(9, ["value"]);
    await runtime.storageManager.synced();
    await waitForSettled(runtime, space, watermarkBeforeSteady + 1, {
      timeoutMs: 30_000,
    });
    assertEquals(await piece.result.get(["value"]), 9);

    // Echo latency is recorded, not gated: the actor-side parity
    // measurement follows testing.md §1's protocol (adjacent arms,
    // quiet box) — this in-suite number is context only.
    console.log(`[sx2-speculation] echo observed after ${echoMs.toFixed(0)}ms`);
  });
});
