// Server-execution v2 Phase 4 gate: the client-effect channel, live
// (testing.md §5's `sx2-effect-channel`). A PiecesController client
// drives the sx2-navigate fixture's `go` stream against toolshed:
//
// - the SERVED navigateTo (builtins.md §4's split contract): the fire
//   commits ONLY the event; the SpaceServer computes the target and
//   writes the §5 intent into the FIRING session's effects instance,
//   which the client reads back through its OWN subscription (the
//   instance resolves from the authenticated session — the client
//   names no key, T2.Q3);
// - OPTIMISTIC-ENACT RECONCILE (T2.Q7): the flag-ON client's
//   speculative run enacts the navigation immediately, carrying the
//   same deterministic nonce — the authoritative intent CONVERGES on
//   it. When the served round-trip wins that race instead, the
//   arriving intent enacts and the speculative run stands down. Either
//   way the journey ends with exactly ONE navigation;
// - ACK + RETIREMENT (protocol.md §5): the channel acks by nonce (an
//   ordinary authored write of the session's own `acks[nonce]` mark)
//   and the next wave retires the acked entry — the instance drains,
//   and nothing resurrects.
//
// OFF arm: navigateTo runs client-side exactly as today — the
// navigation enacts locally and NO effects doc exists anywhere.
//
// The RELOAD-between-intent-and-ack journey (LT8) lives in the runner
// suite (`executor-effect-channel.test.ts`), where the runtime can be
// torn down over a persisted session; this surface cannot reload its
// controller (a fresh controller is a fresh session until protocol
// §5's client-side session persistence lands — OW20's trigger).

import { debugStr } from "@commonfabric/data-model";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { env } from "@commonfabric/integration";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { waitForSettled } from "@commonfabric/runner/executor/watermark";
import type { MemorySpace } from "@commonfabric/runner";
import {
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { defer } from "@commonfabric/utils/defer";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";
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

type EffectStats = { effectAcks: number };

const fetchStats = async (): Promise<EffectStats | undefined> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: EffectStats };
  return body.servingLoop;
};

describe("sx2 effect channel (Phase 4 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  const navigations: string[] = [];
  /** Resolves as the controller enacts its first navigation — the
   * callback's own report, so the wait names the enactment rather than
   * a length turning into a number. Awaited through `awaitNavigation`,
   * which nets it. */
  const firstNavigation = defer<void>();

  /** The first navigation, under a stuck-condition net: this process
   * holds a live connection to the toolshed, so a navigation that never
   * comes has nothing to fail the wait. */
  const awaitNavigation = (): Promise<void> =>
    withStuckNet(firstNavigation.promise, "the first navigation");

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: `${SPACE_NAME}-sx2-effects`,
      apiUrl: new URL(API_URL),
      identity,
      navigateCallback: (target) => {
        navigations.push(target.getAsNormalizedFullLink().id);
        firstNavigation.resolve();
      },
    });
    const sourcePath = join(
      import.meta.dirname!,
      "fixtures",
      "sx2-navigate.tsx",
    );
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath },
    );
    piece = await cc.create(program, { start: true });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("navigate intent → optimistic-enact reconcile → ack → retirement (protocol.md §5; builtins.md §4)", async () => {
    const resultCell = cc.getResult(piece.getCell());
    await resultCell.pull();
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;
    // The client's OWN effects instance: scope "session", no key named
    // (T2.Q3 — the instance resolves from the authenticated session).
    const effectsCell = cc.runtime.getCellFromLink<SessionEffectsDocValue>({
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
      scope: "session",
      path: [],
    });

    if (!FLAG_ON) {
      // OFF arm, byte-identical: navigateTo runs client-side and
      // enacts locally; no effects doc exists anywhere.
      resultCell.key("go").send(undefined as never);
      await cc.runtime.idle();
      await awaitNavigation();
      await cc.runtime.storageManager.synced();
      await effectsCell.sync();
      const value = effectsCell.get();
      // STRICT (cubic review): the OFF arm writes NOTHING to the
      // effects doc — no channel exists, no served intent, no ack, no
      // retirement — so the instance must be strictly absent. Accepting
      // a present-but-empty doc would let a spuriously-created effects
      // instance (an OFF-arm effects-processing regression) pass the
      // very gate meant to catch it.
      assert(
        value === undefined,
        `no effects instance may exist in the OFF arm; got ` +
          debugStr`$quote,long${value}`,
      );
      return;
    }

    // ---- the ON journey: fire → optimistic enact → intent → ack →
    // retire, with exactly ONE navigation end to end ----
    const statsBefore = await fetchStats();
    assert(statsBefore !== undefined, "the ON arm exposes servingLoop stats");
    resultCell.key("go").send(undefined as never);
    await cc.runtime.idle();

    // The enactment (speculation.md §2's allowlisted navigateTo):
    // optimistic, before the authoritative intent's round-trip, or on
    // the channel's delivery of that intent when the served round-trip
    // wins the race. The journey navigates ONCE; the closing assert
    // holds it to that.
    await awaitNavigation();

    // The served intent lands in THIS session's instance and the
    // channel acks it (the authored `acks[nonce]` mark); the next wave
    // RETIRES the acked entry. Completion is judged by the
    // drained-but-PRESENT instance — the retired footprint. The
    // instance is created by the served intent and by nothing else (the
    // OFF arm's strict absence is the same claim from the other side),
    // so a present instance says the intent arrived, and an empty
    // `entries`/`acks` inside it says the ack and the retirement both
    // landed. Sampling the intent itself is not available: its stay in
    // the doc can be a single pair of fast waves, which is why the
    // footprint is what the wait names. The ack counter is asserted
    // below, against the same session's channel. The sync puts the doc
    // in this session's watch set, so the sink the wait sleeps on hears
    // the intent land.
    await effectsCell.sync();
    let sawIntent = false;
    try {
      await waitForCellValue<SessionEffectsDocValue>(
        cc.runtime,
        effectsCell,
        (value) => {
          const entries = Array.isArray(value?.entries) ? value.entries : [];
          if (entries.length > 0) sawIntent = true;
          return value !== undefined && entries.length === 0 &&
            Object.keys(value.acks ?? {}).length === 0;
        },
        // This process holds a live connection to the toolshed, so a wait
        // whose condition never arrives has nothing to fail it. The net is
        // what turns that into the report below.
        { stuckLabel: "the intent to arrive, ack, and retire" },
      );
    } catch (error) {
      // Diagnose WHERE the lifecycle stalled: the stream sidecar's
      // entry says whether the served side consequenced (or dropped)
      // the event; the effects instance says whether the intent
      // arrived/acked.
      const goLink = resultCell.key("go").getAsNormalizedFullLink();
      const sidecarCell = cc.runtime.getCellFromLink<StreamEventsDocValue>({
        space,
        id: streamEntriesDocId({
          id: goLink.id,
          path: [...goLink.path],
          ...(goLink.scope !== undefined ? { scope: goLink.scope } : {}),
        }) as never,
        scope: "space",
        path: [],
      });
      await sidecarCell.sync().catch(() => {});
      await effectsCell.sync().catch(() => {});
      throw new Error(
        `${(error as Error).message}\n  sawIntent=${sawIntent}` +
          debugStr`\n  sidecar=$quote,long${sidecarCell.get()}` +
          debugStr`\n  effects=$quote,long${effectsCell.get()}`,
      );
    }

    // Settle the space (the retirement wave included), then take one
    // more round trip through the same session subscription and drain
    // the runtime behind it: a resurrected intent would have to reach
    // this client that way, and enacting it would have to run here. The
    // convergence stands — ONE navigation, nothing resurrected.
    await cc.runtime.storageManager.synced();
    await waitForSettled(cc.runtime, space, 1, { timeoutMs: 30_000 });
    await effectsCell.sync();
    await cc.runtime.idle();
    assertEquals(
      navigations.length,
      1,
      `the journey converged by nonce — no re-enactment; ` +
        debugStr`navigated to $quote,long${navigations}`,
    );

    // The ack was counted (serving-loop.md §7's effectAcks — the
    // amplification metric's exclusion, testing.md §4).
    const statsAfter = await fetchStats();
    assert(statsAfter !== undefined);
    assert(
      statsAfter.effectAcks > statsBefore.effectAcks,
      "the effect-channel ack was counted",
    );
  });
});
