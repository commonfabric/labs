#!/usr/bin/env -S deno run --allow-read
//
// Fails CI when a known-weakness TRIPWIRE has been resolved — or removed.
//
// A tripwire asserts that a weakness is STILL PRESENT, so that fixing the
// weakness breaks the build. The break is the point: it is the only structural
// reminder that some fixes carry an obligation elsewhere in the repo, months
// later, for someone who has no reason to know the obligation exists.
//
// This check deliberately DUPLICATES the assertion made by the tripwire's unit
// test, and lives in a different task family. A failing unit test can be
// deleted, skipped, or "fixed" by an agent doing mechanical assertion repair;
// silencing the obligation should require finding and neutering BOTH, in two
// places, in one diff that a reviewer can see. It also verifies the test file
// is still present and intact, so deleting it fails here instead of quietly
// succeeding.
//
// Usage: deno run --allow-read ./tasks/check-tripwires.ts

import { dirname, fromFileUrl, join } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { COVERAGE_ARTIFACT } from "@commonfabric/test-support/records";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

const banner = (lines: string[]): string => {
  const bar = "=".repeat(78);
  return `\n${bar}\n${lines.join("\n")}\n${bar}\n`;
};

export interface Tripwire {
  name: string;

  /** The unit test that must remain present and intact. */
  testFile: string;

  /** A marker the test file must still contain, so gutting it is caught. */
  sentinel: string;

  /** True while the weakness is still present. Resolving it fails the check. */
  stillWeak: () => Promise<boolean>;

  /** Printed when the weakness is resolved: what the resolver must now do. */
  obligation: string[];
}

/**
 * Every job in `deno.yml` that ships the test records it produced, by its
 * identifier. More than one of them is what makes a check over the whole
 * run's records a job of its own: it has to wait for each and gather what
 * each shipped. A job shipping the run's coverage measurements alone ships
 * no test's record, and is not one of them.
 */
export async function shippingJobs(
  repoRoot: string = REPO_ROOT,
): Promise<string[]> {
  const workflow = await Deno.readTextFile(
    join(repoRoot, ".github/workflows/deno.yml"),
  );
  const jobs = workflow.slice(workflow.indexOf("jobs:\n"));
  const starts = [...jobs.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\n/gm)];
  return starts.filter((start, at) => {
    const job = jobs.slice(start.index, starts[at + 1]?.index ?? jobs.length);
    return job.includes("uses: ./.github/actions/test-records-ship") &&
      !job.includes(`artifact: ${COVERAGE_ARTIFACT}\n`);
  }).map((start) => start[1]!);
}

export const TRIPWIRES: Tripwire[] = [
  {
    name: "one-post-test-job",
    testFile: "tasks/post-test-jobs-tripwire.test.ts",
    sentinel: "@tripwire:one-post-test-job",
    // Every test job in `deno.yml` ships its own records, so a check over the
    // whole run's records waits for all of them and gathers what each
    // shipped. That is why `Coverage Check` and `Test Topology Store Check`
    // are separate jobs, each keeping a list of the jobs to wait for.
    stillWeak: async () => (await shippingJobs()).length > 1,
    obligation: [
      "  ONE JOB NOW SHIPS THE RUN'S TEST RECORDS. Good. Now finish the job.",
      "",
      "  `Coverage Check` and `Test Topology Store Check` are separate jobs",
      "  for one reason: each reads what every test job produced, and there",
      "  were many of them. Each therefore carries its own list of jobs to",
      "  wait for, and pays a checkout, a Deno setup, an install and an",
      "  artifact download to read a file. That reason has just gone.",
      "",
      "    1. Merge both into the single job that ships the run's records,",
      "         as steps after the shipping step. Neither needs a runner of",
      "         its own once the records are already on that runner's disk.",
      "",
      "    2. Delete both jobs' `needs:` lists with them. They are the third",
      "         and fourth hand-maintained copies of the job matrix, and a",
      "         job added without being added to one silently narrows what",
      "         the check sees.",
      "",
      "    3. Take them out of `Status`, which no longer waits for jobs that",
      "         do not exist.",
      "",
      "    4. The store half still needs the commit its records were made at",
      "         and refuses records from another. Inside the shipping job",
      "         that is the job's own commit, so pass it directly rather",
      "         than reading it back from a downloaded artifact's facts.",
      "",
      "    5. deno task test, in tasks/",
      "         The workflow-shape tests hold each of those jobs to waiting",
      "         for every job that ships records. Merged into the shipping",
      "         job there is nothing left to wait for, so those assertions",
      "         are what say the merge is complete.",
      "",
      "  THEN delete this tripwire: remove its entry from",
      "  tasks/check-tripwires.ts and delete the test file. Reaching you at",
      "  this moment was its only job.",
      "",
      "  Background: docs/plans/pull-request-test-selection.md",
    ],
  },
  {
    name: "space-key-derivation",
    testFile:
      "packages/toolshed/routes/ingest-channels/space-key-derivation-tripwire.test.ts",
    sentinel: "@tripwire:space-key-derivation",
    // Named-space keys derive from `Identity.fromPassphrase("common user")`,
    // ignoring the calling user entirely (packages/identity/src/session.ts).
    // So anyone who knows a space NAME can reconstruct its private key.
    // That derivation supports the legacy space names used during development
    // and nothing else, and is removed once those development-only spaces have
    // been migrated (docs/plans/random-space-identities.md).
    stillWeak: async () => {
      const name = "check-tripwires-probe-space";
      const alice = await createSession({
        identity: await Identity.fromPassphrase("check-tripwires-alice"),
        spaceName: name,
      });
      const bob = await createSession({
        identity: await Identity.fromPassphrase("check-tripwires-bob"),
        spaceName: name,
      });
      const fromPublicConstants =
        await (await Identity.fromPassphrase("common user")).derive(name);
      // Weak while two different users collide AND the key is reconstructible
      // from repo constants alone.
      return alice.space === bob.space &&
        fromPublicConstants.did() === alice.space;
    },
    obligation: [
      "  SPACE-KEY DERIVATION HAS BEEN FIXED. Good. Now finish the job.",
      "",
      "  Until now, anyone who knew a space NAME could reconstruct its private",
      "  key, sign as that space, grant themselves OWNER, and mint an ingest",
      "  channel entirely legitimately. Your fix stops that going forward and",
      "  RETRACTS NOTHING ALREADY ISSUED. A minted token is a durable append",
      "  capability into a user's space.",
      "",
      "    1. deno task audit-ingest-channels",
      "         Record what exists and who owns it.",
      "",
      "    2. deno task retire-ingest-channels --reason space-key-derivation-fix",
      "         Dry run first, then again with --confirm. Devices holding a",
      "         retired token get a 403 telling them to re-pair; owners re-mint",
      "         with 'cf ingest mint' when ready.",
      "",
      "    3. Sweep space ACLs for concrete OWNER grants nobody can account for.",
      "         NOT OPTIONAL, and no tooling covers it. Retiring a token does",
      "         not remove an ACL entry an attacker granted themselves — and",
      "         that entry is what lets them simply mint again tomorrow.",
      "",
      "    4. deno task audit-ingest-channels",
      "         Confirm nothing is left active.",
      "",
      "  THEN delete this tripwire: remove its entry from tasks/check-tripwires.ts",
      "  and delete the test file. Reaching you at this moment was its only job.",
      "",
      "  Background: docs/features/self-serve-ingest-channels.md",
    ],
  },
];

/**
 * Every reason a single tripwire is failing, as printable banners. Empty means
 * intact. Pure and exported so the evasion paths are covered by tests rather
 * than by remembering to try them by hand.
 */
export async function checkTripwire(
  tripwire: Tripwire,
  repoRoot: string = REPO_ROOT,
): Promise<string[]> {
  const failures: string[] = [];

  {
    // 1. The weakness must still be present. If it is not, the obligation is due.
    if (!(await tripwire.stillWeak())) {
      failures.push(banner(tripwire.obligation));
      return failures;
    }

    // 2. The unit test must still exist and still carry its sentinel. Deleting or
    //    gutting it must fail here rather than silently removing the reminder.
    const path = join(repoRoot, tripwire.testFile);
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch {
      failures.push(banner([
        `  TRIPWIRE REMOVED: ${tripwire.name}`,
        "",
        `  ${tripwire.testFile}`,
        "  is missing, but the weakness it guards is still present.",
        "",
        "  A tripwire is the only structural reminder that fixing that weakness",
        "  carries an obligation elsewhere. Restore the file. If you genuinely",
        "  intend to remove the reminder, remove its entry from",
        "  tasks/check-tripwires.ts in the same commit, so the decision is",
        "  visible in review rather than silent.",
      ]));
      return failures;
    }

    if (!source.includes(tripwire.sentinel)) {
      failures.push(banner([
        `  TRIPWIRE GUTTED: ${tripwire.name}`,
        "",
        `  ${tripwire.testFile}`,
        `  no longer contains its sentinel (${tripwire.sentinel}).`,
        "",
        "  The file exists but does not identify itself as a tripwire, which",
        "  usually means the assertion was rewritten to pass. The weakness it",
        "  guards is still present, so the reminder is still needed.",
      ]));
    }

    // 3. Disabling the test is the other way to silence it quietly.
    for (const disabled of [".ignore(", ".skip(", "ignore: true"]) {
      if (source.includes(disabled)) {
        failures.push(banner([
          `  TRIPWIRE DISABLED: ${tripwire.name}`,
          "",
          `  ${tripwire.testFile} contains "${disabled}".`,
          "",
          "  A skipped tripwire is worse than none: it reads as covered.",
        ]));
      }
    }
  }

  return failures;
}

export async function main(
  tripwires: readonly Tripwire[] = TRIPWIRES,
  report: (message: string) => void = console.error,
): Promise<number> {
  let failed = false;
  for (const tripwire of tripwires) {
    for (const failure of await checkTripwire(tripwire)) {
      report(failure);
      failed = true;
    }
  }
  if (failed) return 1;
  console.log(`check-tripwires: ${tripwires.length} tripwire(s) intact.`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
