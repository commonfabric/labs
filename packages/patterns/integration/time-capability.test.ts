// Behavioral verification of the always-on capability gate (W1). The static
// migration replaced raw clock reads in lift/computed/pattern-body contexts with
// the reactive #now wish, leaving Date.now()/Math.random() only inside handlers.
// This test instantiates real migrated patterns with the gate ON, materializes
// their lifts, and asserts the scheduler reports no TimeCapabilityError.
//
// Enforcement is dynamic — the gate throws only when a clock/entropy helper is
// actually called — so a green run proves the absence of a clock read only in
// the lifts/branches a bare offline instantiation materializes. Branches gated on
// user input, a populated input list, or a network/LLM result are not exercised
// here and would need their triggering events or a fuller environment.
//
// A lift-context violation does not reject create()/idle(); the scheduler
// catches it, logs it, and leaves the dependent cell unpopulated. We therefore
// observe it through runtime.scheduler.onError. The negative-control fixture
// proves this harness actually catches a violation; the positive control proves
// the sanctioned #now path does not trip the gate.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { initializeCapabilityGateController } from "./capability-gate-controller.ts";
import { moduleByteCache } from "./pieces-controller.ts";

const ROOT = join(import.meta.dirname!, "..");

// Instantiate a pattern with the gate on, materialize its lifts, and return the
// messages of any TimeCapabilityErrors the scheduler reported.
async function timeCapabilityErrors(rel: string): Promise<string[]> {
  const cc = await initializeCapabilityGateController(
    `${rel}-${crypto.randomUUID()}`,
  );
  const errors: string[] = [];
  cc.runtime.scheduler.onError((err) => {
    if (err?.name === "TimeCapabilityError") errors.push(err.message);
  });
  let cancel: (() => void) | undefined;
  try {
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: join(ROOT, rel), root: ROOT },
    );
    // A lift-context violation is reported via onError (above) and swallowed; a
    // pattern-body or handler-setup violation instead rejects create(). Capture
    // both as the same finding.
    const piece = await cc.create(program, { start: true });
    // A sink keeps the result reactive so its computeds actually evaluate.
    const resultCell = cc.getResult(piece.getCell());
    cancel = resultCell.sink(() => {});
    await cc.runtime.idle();
    await cc.synced();
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeCapabilityError") errors.push(err.message);
    else throw e;
  } finally {
    cancel?.();
    await cc.dispose();
  }
  if (errors.length > 0) {
    console.log(`[time-capability] ${rel}:\n  - ${errors.join("\n  - ")}`);
  }
  return errors;
}

// Patterns touched by the #now clock migration that instantiate fully offline
// (no network/LLM/oauth needed to materialize their initial lifts). The network-
// or oauth-bound migrated patterns (Google/Airtable/Gmail) still render offline,
// but are out of this offline suite's scope. budget-tracker/expense-form is
// intentionally omitted: its migration moved the only clock read into handlers,
// so it has no lift/body clock read for the gate to catch and its assertion
// would be vacuous (it also throws an unrelated TypeError when instantiated
// standalone without seeded input).
const MIGRATED_OFFLINE_PATTERNS = [
  "habit-tracker/habit-tracker.tsx",
  "calendar/calendar.tsx",
  "factory-outputs/parking-coordinator/main.tsx",
  // Games — not part of the #now migration, but they read entropy/clock only in
  // handlers (move/join/reset actions), so they must stay gate-clean. Pinned here
  // as a fast check; the whole pattern set is swept in time-capability-full.test.ts.
  "battleship/multiplayer/lobby.tsx",
  "card-piles/main.tsx",
  "scrabble/scrabble.tsx",
];

// Deliberately excluded from the offline assertion:
// - notes/daily-journal.tsx embeds ../system/suggestion.tsx. Option-3
//   (framework-provided bash sandboxId) has landed, so Suggestion no longer
//   reads entropy at pattern body and daily-journal is gate-clean; it is swept
//   by time-capability-full.test.ts rather than pinned in this fast offline
//   subset (Suggestion pulls in llmDialog/bash, out of this subset's scope).
// - weekly-calendar/weekly-calendar.tsx fails offline instantiation with a
//   ModuleVerificationError (its event.tsx sub-module is not verifiable against
//   the in-memory store), which is unrelated to the time gate. It needs a
//   verified-module environment to behaviorally verify.

interface CapabilityCase {
  name: string;
  run: () => Promise<void>;
}

const CAPABILITY_CASES: CapabilityCase[] = [
  {
    name: "catches a lift-context clock read (negative control)",
    run: async () => {
      const errors = await timeCapabilityErrors(
        "integration/fixtures/lift-clock-violation.tsx",
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("ambient clock");
    },
  },
  {
    name: "allows the #now reactive clock in a computed (positive control)",
    run: async () => {
      const errors = await timeCapabilityErrors(
        "integration/fixtures/lift-now-wish-ok.tsx",
      );
      expect(errors).toEqual([]);
    },
  },
  ...MIGRATED_OFFLINE_PATTERNS.map((rel): CapabilityCase => ({
    name: `materializes ${rel} with no lift-context clock read`,
    run: async () => {
      const errors = await timeCapabilityErrors(rel);
      expect(errors).toEqual([]);
    },
  })),
  {
    name: "uses the process-wide pattern integration compile cache",
    run: async () => {
      const cc = await initializeCapabilityGateController(
        `compile-cache-${crypto.randomUUID()}`,
      );
      try {
        expect(cc.runtime.moduleByteCache).toBe(moduleByteCache);
      } finally {
        await cc.dispose();
      }
    },
  },
];

describe("capability gate (W1): patterns read the clock only in handlers", () => {
  for (const testCase of CAPABILITY_CASES) {
    it(testCase.name, testCase.run);
  }
});
