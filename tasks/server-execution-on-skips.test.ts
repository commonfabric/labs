import { assertEquals } from "@std/assert";
import {
  SERVER_EXECUTION_ON_SKIPS,
  type ServerExecutionOnSkip,
  serverExecutionOnStepSkip,
  validateServerExecutionOnSkips,
} from "./server-execution-on-skips.ts";

const repoRoot = new URL("../", import.meta.url);

Deno.test("every skip entry names an existing file (no stale lists)", async () => {
  const problems = await validateServerExecutionOnSkips(repoRoot);
  assertEquals(problems, []);
});

Deno.test("validation flags missing files and duplicates, and passes real files", async () => {
  const lists: Record<string, ServerExecutionOnSkip[]> = {
    patterns: [
      // A file that really exists, resolved against the real repo root.
      {
        file: "integration/counter.test.ts",
        phase: "phase-2",
        reason: "placeholder",
      },
    ],
    runner: [
      {
        file: "integration/does-not-exist.test.ts",
        phase: "phase-3",
        reason: "placeholder",
      },
      {
        file: "integration/does-not-exist.test.ts",
        phase: "phase-3",
        reason: "placeholder",
      },
    ],
    "runtime-client": [],
    shell: [],
  };
  const problems = await validateServerExecutionOnSkips(
    repoRoot,
    lists as typeof SERVER_EXECUTION_ON_SKIPS,
  );
  assertEquals(problems, [
    "runner: skip entry names a missing file: integration/does-not-exist.test.ts",
    "runner: duplicate skip entry for integration/does-not-exist.test.ts",
    "runner: skip entry names a missing file: integration/does-not-exist.test.ts",
  ]);
});

Deno.test("the patterns list is EMPTY after the ruled 3b close and the flip bar's list-EMPTY precondition is met", () => {
  // The patterns list is EMPTY again — lunch-poll-vote's FILE entry, the
  // LAST entry in any suite, lifted 2026-08-28 (the THIRD lift) on the
  // owner-ruled 3b close: the owner ruled "go with (1) plus the (2-D)
  // kick", and both mechanisms are landed red-first — (1) event-driven
  // re-supply (a supply-class replication failure parks under the WANTED
  // identity and the matching persist RECORD re-issues it; the
  // registration-time map check covers a record that landed inside the
  // read window) and (2-D) the sidecar serve-time closure kick (the
  // demanding space's supplier registered at page-serve time, covered by
  // the ticket await). Campaign R 8/8 quiet-and-loaded at the lift head,
  // and the lift PR's own ON-lane board is the direct-CI unskip probe
  // (PROBE 6). What stays open is recorded in the register's RULING block
  // (cross-replica never-records supplier; prior-session third-space
  // closure; the recursive-(b) sliver). Evidence chain:
  // verification-coverage.md OW45's lunch blocks.

  // The list is EMPTY — a new entry reddens this pin, so a re-skip is a
  // deliberate change, never a leftover.
  assertEquals(SERVER_EXECUTION_ON_SKIPS.patterns.length, 0);
  // The topic-board pivot-baseline entry is GONE (#6304 fixed): the
  // guard lookup for that step resolves nothing, so the case runs in
  // the ON lane — it is that issue's acceptance test.
  assertEquals(
    serverExecutionOnStepSkip(
      "patterns",
      "integration/topic-board-child-contract.test.ts",
      "builds one pivot row per topic, claiming no edges before any mention",
    ),
    undefined,
  );
  // The default-app reload STEP entry is GONE (LIFTED 2026-08-28 under the
  // owner's surface reading of the ruled bar): its guard lookup resolves
  // NOTHING, so the ON arm RUNS that step — the lift's standing proof, and the
  // pin that makes a silent re-skip impossible.
  assertEquals(
    serverExecutionOnStepSkip(
      "patterns",
      "integration/default-app.test.ts",
      "should persist and reload every rapidly created notebook note",
    ),
    undefined,
  );
  assertEquals(SERVER_EXECUTION_ON_SKIPS.shell.length, 0);
});

Deno.test("the runtime-client list is EMPTY — the OW33 triage (2026-08-22) lifted both STEP entries (CT-1606 PerUser header render; single-navigateTo dispatch) on 12/12 green at the true ON topology — so the full suite runs, and the in-file guard resolves to no entry", () => {
  assertEquals(SERVER_EXECUTION_ON_SKIPS["runtime-client"].length, 0);
  // The lifted steps' guard lookups resolve to NOTHING, so the steps RUN
  // on the ON arm — pinned so a re-skip is a deliberate entry, never a
  // leftover. The `onArmStepSkip` guard calls stay in client.test.ts (the
  // binding mechanism for any future entry) and are inert without one.
  for (
    const step of [
      "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
      "dispatches one navigateTo when a rendered handler changes local state",
    ]
  ) {
    assertEquals(
      serverExecutionOnStepSkip(
        "runtime-client",
        "integration/client.test.ts",
        step,
      ),
      undefined,
    );
  }
});

Deno.test("validation binds a step entry: the file must name the step and call the guard", async () => {
  const lists: Record<string, ServerExecutionOnSkip[]> = {
    patterns: [],
    runner: [
      // A real file that neither names this step nor calls the guard.
      {
        file: "integration/basic-persistence.test.ts",
        step: "a step basic-persistence.test.ts does not contain",
        phase: "phase-7",
        reason: "placeholder",
      },
    ],
    "runtime-client": [
      // Duplicate step entries are flagged like duplicate files.
      {
        file: "integration/client.test.ts",
        step:
          "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
        phase: "phase-7",
        reason: "placeholder",
      },
      {
        file: "integration/client.test.ts",
        step:
          "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
        phase: "phase-7",
        reason: "placeholder",
      },
    ],
    shell: [],
  };
  const problems = await validateServerExecutionOnSkips(
    repoRoot,
    lists as typeof SERVER_EXECUTION_ON_SKIPS,
  );
  assertEquals(problems, [
    'runner: step skip entry names a step integration/basic-persistence.test.ts does not contain: "a step basic-persistence.test.ts does not contain"',
    "runner: integration/basic-persistence.test.ts carries a step skip entry but never calls serverExecutionOnStepSkip — the entry would be decoration",
    "runtime-client: duplicate skip entry for integration/client.test.ts :: renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
  ]);
});

Deno.test("the runner list is EMPTY and NO suite carries any entry — the ON-skip registry is EMPTY after the ruled 3b close", () => {
  // The runner list emptied with the arrival-witness lift (RULED 2026-08-22,
  // candidate (B) of the OW33 fork memo); the LAST list anywhere emptied
  // (a third time) with the lunch-poll-vote ruled-3b-close lift
  // (2026-08-28). This pin holds the whole-registry EMPTY state: any new
  // entry in ANY suite reddens it, so a skip is a deliberate change,
  // never a leftover.
  assertEquals(SERVER_EXECUTION_ON_SKIPS.runner.length, 0);
  // The whole registry: every suite's list is EMPTY — the flip PR's
  // list-EMPTY precondition (the header's contract) is MET and stays
  // pinned. The flip bar itself remains a green ON lane, not merely
  // this empty registry.
  for (const [suite, skips] of Object.entries(SERVER_EXECUTION_ON_SKIPS)) {
    assertEquals(
      skips.map((skip) => skip.file),
      [],
      `${suite}: the ON-skip registry is EMPTY since the lunch-poll-vote ` +
        "ruled-3b-close lift (2026-08-28)",
    );
  }
});
