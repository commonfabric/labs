// Server-execution v2 Phase 3 gate: events-down, live
// (testing.md §5's `sx2-events`). A PiecesController client drives the
// counter pattern's `increment` stream against toolshed:
//
// - SERVER-PROCESSED handlers: a fire commits ONLY the event append;
//   the SpaceServer runs the handler authoritatively and the derived
//   consequence renders (events.md §2, §7);
// - DUPLICATE SUBMISSION: two fires sharing one caller eventId land
//   ONE consequence (the dedupe horizon + the queue's
//   duplicate-as-delivered classification — events.md §4, §5);
// - RAPID-FIRE COALESCING: N fires faster than wave time yield the
//   final-only value with ≪N derived commits (D-v2-2's
//   commit-level batching; counters, never logs — testing.md §4);
// - the same-client observation latency is RECORDED as context; the
//   binding ≤300 ms p50 propagation gate is measured on
//   `lunch-poll-vote` UNMODIFIED (testing.md §5), not here.
//
// OFF arm: the client runs handlers and commits their writes as today
// — byte-identical posture, asserted explicitly.
//
// The kill-between-event-and-consequence restart gate lives in the
// runner suite (`executor-events-down.test.ts`), where the host can
// actually be killed; this browser-facing surface cannot restart
// toolshed.

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
import { type MemorySpace, sendEvent } from "@commonfabric/runner";
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

type EventStats = {
  derivedCommits: number;

  /** Per-space attribution (#6158): lets the logged ratio name THIS
   * test's space instead of the host-global total. */
  derivedCommitsBySpace?: Record<string, number>;
  events: {
    appended: number;
    processed: number;
    skippedIdempotent: number;
  };
};

const fetchStats = async (): Promise<EventStats | undefined> => {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  const body = await response.json() as { servingLoop?: EventStats };
  return body.servingLoop;
};

describe("sx2 events (Phase 3 gates)", () => {
  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let sinkCancel: (() => void) | undefined;
  let latestValue: number | undefined;

  /** Sink-driven value waits (round-2 thread T9): the sink callback IS
   * the delivery channel, so value conditions resolve from it directly
   * — no polling loop, and a paused/slow worker only delays the
   * resolve instead of burning the retry budget. The timeout is purely
   * the failure bound. */
  const valueWaiters: Array<{
    predicate: (value: number | undefined) => boolean;
    settle: () => void;
  }> = [];
  const waitForValue = (
    predicate: (value: number | undefined) => boolean,
    label: string,
    timeoutMs = 60_000,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (predicate(latestValue)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        timeoutMs,
      );
      valueWaiters.push({
        predicate,
        settle: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: `${SPACE_NAME}-sx2-events`,
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
    const resultCell = cc.getResult(piece.getCell());
    sinkCancel = resultCell.sink((value: unknown) => {
      latestValue = (value as { value?: number } | undefined)?.value;
      for (let index = valueWaiters.length - 1; index >= 0; index -= 1) {
        if (valueWaiters[index].predicate(latestValue)) {
          valueWaiters.splice(index, 1)[0].settle();
        }
      }
    });
  });

  afterAll(async () => {
    sinkCancel?.();
    if (cc) await cc.dispose();
  });

  const settleAfter = async (space: MemorySpace, before: number) => {
    await cc.runtime.storageManager.synced();
    await waitForSettled(cc.runtime, space, before + 1, {
      timeoutMs: 30_000,
    });
  };

  it("server-processed handlers, duplicate submission, and rapid-fire coalescing (events.md §2/§4/§5; D-v2-2)", async () => {
    const resultCell = cc.getResult(piece.getCell());
    await resultCell.pull();
    const space = piece.getCell().getAsNormalizedFullLink()
      .space as MemorySpace;

    if (!FLAG_ON) {
      // OFF arm, byte-identical: the client runs the handler and
      // commits its write as today; no serving loop exists.
      assertEquals(await fetchStats(), undefined);
      resultCell.key("increment").send(undefined as never);
      await cc.runtime.idle();
      await cc.runtime.storageManager.synced();
      await waitForValue(
        (value) => (value ?? 0) >= 1,
        "the client-committed increment",
      );
      return;
    }

    // ---- server-processed handler + observation latency (context) ----
    const stats0 = await fetchStats();
    assert(stats0 !== undefined, "the ON arm exposes servingLoop stats");
    const watermarkBefore =
      (watermarkCell(cc.runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;
    const fireStart = performance.now();
    resultCell.key("increment").send(undefined as never);
    await cc.runtime.idle();
    // The echo renders immediately (speculation.md §3); the
    // AUTHORITATIVE value arrives with the settle.
    await settleAfter(space, watermarkBefore);
    await waitForValue(
      (value) => (value ?? 0) >= 1,
      "the served consequence to render",
    );
    const observeMs = performance.now() - fireStart;
    const stats1 = await fetchStats();
    assert(stats1 !== undefined);
    assert(
      stats1.events.appended > stats0.events.appended,
      "the fire committed an event append (events.appended counted)",
    );
    assert(
      stats1.events.processed > stats0.events.processed,
      "the server processed the event (events.processed counted)",
    );
    console.log(
      `[sx2-events] fire -> settled+rendered in ${observeMs.toFixed(0)}ms ` +
        "(context; the binding p50 gate rides lunch-poll-vote)",
    );

    // ---- duplicate submission (events.md §5) ----
    const beforeDup = (latestValue ?? 0) as number;
    const dupWatermark =
      (watermarkCell(cc.runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;
    // The caller-supplied eventId travels WITH the session it was
    // chosen within (main's WS-D invocation-identity contract — an
    // unscoped id is refused); the same (id, session, stream) pair
    // scopes to the same durable delivery id, which is exactly what
    // the dedupe horizon needs to see a duplicate.
    sendEvent(
      resultCell.key("increment"),
      undefined,
      undefined,
      { eventId: "sx2-dup-1", session: "sx2-dup-session" },
    );
    sendEvent(
      resultCell.key("increment"),
      undefined,
      undefined,
      { eventId: "sx2-dup-1", session: "sx2-dup-session" },
    );
    await cc.runtime.idle();
    await settleAfter(space, dupWatermark);
    await waitForValue(
      (value) => (value ?? 0) >= beforeDup + 1,
      "the deduped consequence",
    );
    // One consequence, not two: the duplicate deduped at the horizon.
    assertEquals(latestValue, beforeDup + 1);

    // ---- rapid-fire coalescing (D-v2-2; testing.md §5) ----
    const N = 10;
    const statsBefore = await fetchStats();
    assert(statsBefore !== undefined);
    const rapidWatermark =
      (watermarkCell(cc.runtime, space).get() as { seq?: number } | undefined)
        ?.seq ?? 0;
    const beforeRapid = (latestValue ?? 0) as number;
    for (let i = 0; i < N; i++) {
      resultCell.key("increment").send(undefined as never);
    }
    await cc.runtime.idle();
    await settleAfter(space, rapidWatermark);
    await waitForValue(
      (value) => (value ?? 0) >= beforeRapid + N,
      "all N consequences (final-only value)",
    );
    assertEquals(latestValue, beforeRapid + N);
    const statsAfter = await fetchStats();
    assert(statsAfter !== undefined);
    const derivedDelta = statsAfter.derivedCommits -
      statsBefore.derivedCommits;
    assert(
      statsAfter.events.processed - statsBefore.events.processed >= N,
      "all N events processed",
    );
    // The derived-commit RATIO is a LOAD OBSERVATION, not a gate
    // (RULED 2026-08-21 — owner: "i like (3) as well", on the
    // ow-sx2-coalescing-gate dispositions): this surface's append queue
    // serializes one commit round trip per event, so how many appends a
    // wave finds queued is round-trip time vs wave time — a fast idle
    // server legitimately derives N commits for N events while
    // coalescing nothing is wrong. The coalescing CONTRACT is pinned
    // where its premise can be constructed instead:
    // packages/runner/test/executor-events-down.test.ts's
    // constructed-queue-depth step (K entries queued ahead of one drain
    // → exactly one consequence-carrying derived commit). The ratio
    // stays LOGGED here for the record; this surface's gates are the
    // two deterministic asserts (processed ≥ N above; the final-only
    // value at the waitForValue + assertEquals).
    const spaceDelta = (statsAfter.derivedCommitsBySpace?.[space] ?? 0) -
      (statsBefore.derivedCommitsBySpace?.[space] ?? 0);
    console.log(
      `[sx2-events] rapid-fire: ${N} events -> ${derivedDelta} derived ` +
        `commit(s) host-wide (${spaceDelta} in this space — ` +
        `derivedCommitsBySpace, #6158), processed +${
          statsAfter.events.processed - statsBefore.events.processed
        }`,
    );
  });
});
