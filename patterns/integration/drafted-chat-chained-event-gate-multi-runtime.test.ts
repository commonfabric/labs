/**
 * The chained-event serve-order gate, pinned deterministically.
 *
 * An action whose SERVED handler reads a precondition cell written by
 * an immediately-preceding event (draft → send) is racy by design
 * under ON: events on different streams have no cross-stream
 * serve-order guarantee (events.md §2 — per stream, commit-seq order;
 * across streams, no claim), and the drafted chat fixture's send
 * silently skips an empty draft. A UI that commits a draft this way
 * must keep its control disabled until the draft state the CLICKING
 * session sees is non-empty, so tests must gate the same way. Ungated, the race reproduced nightly under CI
 * load (2026-08-22, runs 32543810077 / 32547606642: "bob's
 * post-lockdown message arrives at alice" timing out with quiescence
 * clean and zero errors — the message was never appended, not slow).
 *
 * This file makes the race DETERMINISTIC instead of load-statistical:
 * two sessions of one user (the draft is PerUser, so both see it), the
 * draft-writing session's WebSocket delayed by 300 ms, and the draft
 * fired with `idle: false` so it is provably still in flight when the
 * other session acts. Delay injection at the racy seam — the
 * repository's standard for pinning a load flake. Ungated, this
 * topology fails 2/2 with the exact CI signature (recorded in
 * docs/history/plans/server-execution-v2/optimize/
 * arrival-wait-hardening-report.md); the two steps below pin the two
 * honest gates that close it.
 */

import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "drafted-chat",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The resolved posture, exactly as the harness resolves it (canonical
// env mapping, else the first-party default). Step 2 pins an ON-only
// primitive and self-skips on the OFF arm.
const SERVER_EXECUTION_ON =
  experimentalOptionsFromEnv(Deno.env.get).serverExecution ??
    SERVER_EXECUTION_DEFAULT_ENABLED;

async function fireSend(session: MultiRuntimeSession): Promise<void> {
  await session.send("sendMessage");
}

async function messageBodies(session: MultiRuntimeSession): Promise<string[]> {
  return (((await session.read(["messages"])) as any[]) ?? [])
    .map((m) => m?.body);
}

describe("group chat chained-event gates across sessions", () => {
  let harness: MultiRuntimeHarness | undefined;
  let sender: MultiRuntimeSession;
  let writer: MultiRuntimeSession;

  // One harness for both steps (they share the saved profile); built in
  // the first step rather than beforeAll so a create failure names the
  // step. Sessions: same user twice — the draft is PerUser, so the
  // writer's draft is the sender's draft, like two tabs of one user.
  async function ensureHarness(): Promise<MultiRuntimeHarness> {
    if (harness !== undefined) return harness;
    const alice = await Identity.fromPassphrase("chained-event-gate alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "sender", identity: alice },
        // Every frame on the writer's socket (both directions) is
        // delayed, so a fire-and-continue draft is deterministically
        // still in flight when the sender acts.
        { label: "writer", identity: alice, wsDelayMs: 300 },
      ],
    });
    sender = harness.session("sender");
    writer = harness.session("writer");

    // Profile first, gated and awaited, so the message draft is the only
    // variable in the steps.
    await sender.send("setProfileDraft", "Alice");
    await sender.awaitEventConsequences();
    await sender.send("saveProfile");
    await harness.waitFor(
      "alice's profile is saved",
      async () => (await sender.read(["currentProfileName"])) === "Alice",
    );
    return harness;
  }

  it("firing the send once the SENDER observes the draft appends the message (the UI-enablement gate, both arms)", async () => {
    try {
      // Inside the try: a harness-creation throw must still hit this
      // step's dispose arm rather than leak workers and sockets.
      const h = await ensureHarness();
      await writer.send("setMessageDraft", "Observed body", undefined, {
        idle: false,
      });
      // The real UI's gate: the clicking session's own view of the draft
      // is non-empty (the send button's disabled state derives from
      // exactly this read). Under ON, sender-visibility implies the
      // draft's commit is in the space's history; under OFF it implies
      // the sender's local handler will read it. Both arms ordered.
      await h.waitFor(
        "the sender observes the chained draft",
        async () => (await sender.read(["messageDraft"])) === "Observed body",
      );
      await fireSend(sender);
      await h.waitFor(
        "the observed-draft message arrives at both sessions",
        async () =>
          (await messageBodies(sender)).includes("Observed body") &&
          (await messageBodies(writer)).includes("Observed body"),
      );
    } catch (error) {
      // Dispose AND forget: the next step must not reuse a disposed
      // harness (it re-creates instead).
      await harness?.dispose();
      harness = undefined;
      throw error;
    }
  });

  it("awaitEventConsequences alone is a sufficient gate under ON (the overlay primitive the same-session helpers rely on)", async () => {
    try {
      // Inside the try for the same leak-safety as step 1.
      const h = await ensureHarness();
      if (!SERVER_EXECUTION_ON) {
        // The primitive being pinned is the speculation overlay's
        // intent quiescence, which exists only on the ON arm; under OFF
        // the handler runs in the FIRING session's own runtime, so
        // consequence-arrival at the writer orders nothing for the
        // sender — the step above carries the OFF arm.
        console.log(
          "[chained-event-gate] OFF arm: awaitEventConsequences step " +
            "self-skips (no overlay; the primitive is ON-only)",
        );
        return;
      }
      await writer.send("setMessageDraft", "Quiescence body", undefined, {
        idle: false,
      });
      // The overlay gate: the draft event's terminal consequence has
      // arrived back at the writer, so its commit is in the space's
      // history — every later-fired event is served against a view
      // that includes it. No sender-visibility wait: this step's teeth
      // are that the primitive ALONE suffices (sabotage it to resolve
      // early and the 300 ms delay makes this step fail
      // deterministically with the CI signature).
      await writer.awaitEventConsequences();
      await fireSend(sender);
      await h.waitFor(
        "the quiescence-gated message arrives at both sessions",
        async () =>
          (await messageBodies(sender)).includes("Quiescence body") &&
          (await messageBodies(writer)).includes("Quiescence body"),
      );
    } finally {
      await harness?.dispose();
      harness = undefined;
    }
  });
});
