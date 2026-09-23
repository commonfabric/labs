#!/usr/bin/env -S deno run -A

/**
 * Tier 2's gate: replay every pinned vintage under TODAY's pattern source.
 *
 * Tier 1 (`deno task pattern-compat`) proves the contract a pattern declares is
 * still compatible with every contract it has declared before. That is a
 * statement about schemas. This proves the stronger thing schemas cannot say:
 * that a real document written by an older version is still materializable by
 * the version about to be merged.
 *
 * Precisely what a green run asserts, per fixture: today's source RESOLVES for
 * every recorded instantiation, the setup that carries the artifact each root
 * NAMES onto that root is not refused and completes, the root then reads as
 * something rather than nothing, AND every value the vintage held is still
 * readable afterwards.
 *
 * It asserts two things about the exemption list as well, and a clean replay
 * does not excuse either. Every path in `ACCEPTED_STATE_DROPS` must still
 * forgive something in a vintage inside its own `capturedThrough` window — an
 * entry that has stopped removing anything has outlived the removal it was
 * granted for, and the run exits 1 naming it. And an entry whose pattern no
 * fixture records is UNJUDGEABLE rather than stale: nothing replays it, so
 * nothing can say whether it is still needed, and that fails too rather than
 * sitting unexamined.
 *
 * That last clause is the one that makes this a state-continuity gate rather
 * than an applies-cleanly gate. An update can materialize perfectly and still
 * lose data: move where a field is stored — `.for("journal")` becomes
 * `.for("journalMoved")` — and the declared contract does not change by a byte
 * while every document written under the old name goes unreachable. Nothing
 * throws. Measured on the real `home.tsx`, that now exits 1 naming the key and
 * showing what was there.
 *
 * The comparison reads the vintage under the root's OWN stored schema, so it
 * sees the data as the version that wrote it did, and compares only keys that
 * were present BEFORE: an update may legitimately ADD a field — that is what
 * `Default<>` is for — so a new key is not a finding, while an existing key
 * whose value changed is. That schema is relaxed at its `unknown` positions
 * first, on both sides: a schema-driven read resolves nothing there, so a key
 * an index signature covers would otherwise arrive as `undefined` however much
 * state it holds — indistinguishable from a key the document does not hold.
 *
 * It compares STATE, not renderings. `$UI` and its variants are recomputed by
 * the setup and the stored rendering never matches a fresh one, so comparing
 * them would red every pattern edit while saying nothing about data; every
 * other key is compared, `$NAME` included. Excluding those NAMES is not enough
 * on its own — a `map`-body hoist is a recorded instantiation whose whole
 * result is a vnode, under no `$UI` — so a rendering is recognized by shape
 * too, wherever it sits. What a root holds at a cell or stream position is
 * compared as the DOCUMENT it points at, so a field that moved to a different
 * doc is still a finding.
 *
 *   deno task pattern-vintage                                  # replay; fail on a stranded fixture
 *   deno task pattern-vintage --only topics/topics.test.tsx    # replay matching fixtures alone
 *   deno task pattern-vintage --update topics/topics.test.tsx  # first pinned fixture
 *   deno task pattern-vintage --capture-changed                # capture a generation where due
 *   deno task pattern-vintage --pin topics/topics.test.tsx     # promote the newest generation
 *
 * `--only` takes one value per flag and may be repeated, matching any fixture
 * whose repository-relative path holds it. A fixture's replay stands alone —
 * it restores its own store, drives its own roots and compares against its own
 * manifest — so leaving the others out changes nothing about what this one
 * asserts. What it does change is what the run may conclude afterwards, so a
 * filtered run makes none of the three whole-tree judgements below: whether
 * every required pattern is covered, whether an accepted removal still forgives
 * anything, and whether one names a pattern no fixture records. Those are
 * questions about the store, and a filtered run has not read it.
 *
 * `--update` always names a TEST path, never a pattern path — a fixture is
 * produced by RUNNING a test, and covers whatever that test instantiates, which
 * is routinely several patterns none of which share its name. `system/x.tsx`
 * names no test and captures nothing.
 *
 * There is no bare `--update`, and no list of what CI replays. Every fixture
 * under the vintages tree is replayed by the plain command, so committing a
 * captured fixture is the whole of adding one. A default seed set would only
 * ever serve a MISSING fixture, and that is exactly when nothing on disk knows
 * which test covers the pattern.
 *
 * `--update` can only ADD. It never rewrites or deletes an existing fixture,
 * for the reason Tier 1's baselines are append-only: a command that could
 * replace a vintage could replace the very vintage that would have caught a
 * break. Deleting one is a deliberate act that shows up in review as a deleted
 * file. Naming keys explicitly does not weaken that — a key that already has a
 * pinned vintage is skipped whichever way it was asked for.
 *
 * ## The two tiers
 *
 * `pinned/` is evidence: never pruned, and the only tier that credits
 * coverage. `auto/` is history: captured automatically wherever today's source
 * has moved past every generation on disk, and pruned by count.
 *
 * That split is what makes the gate get STRONGER over time rather than just
 * staying green. A single pinned vintage only ever proves today's source can
 * read one particular old world; a run of generations proves it can read every
 * world the pattern has passed through. Accumulating them is cheap in the only
 * place it is permanent — git deltas adjacent generations of a near-identical
 * store to ~9 KiB — and bounded where it is not, since each one also costs
 * 3.5 MiB of working-tree disk in every clone.
 *
 * NO writing command runs in CI, and there are three: `--update`,
 * `--capture-changed` and `--pin`. CI runs the plain gate, which only ever
 * READS the tree. A gate that wrote its own evidence would be grading its own
 * homework, so all three land in the working tree to be committed and reviewed
 * like any other change.
 *
 * `--capture-changed` refuses to capture onto a red tree, which is also what
 * removes the need for a rule about capturing mid-edit: a generation is a
 * record of a world that worked, and a release promotes from a branch that
 * already passed.
 *
 * That discipline is enforced HERE, in what the command will do, and otherwise
 * rests on review — deliberately, and unlike Tier 1, whose baselines have a
 * mechanical checker (`tasks/check-baselines-append-only.ts`). There is no
 * equivalent gate over `packages/piece/test/vintages/`, so a deleted fixture is
 * caught by a human reading the diff and nothing else. Recapturing one is
 * therefore a decision to make out loud, not a routine step.
 *
 * This file is the shell — roots, argument parsing, printing, exit code. The
 * work is in `pattern-vintage-run.ts`, which takes its roots as arguments so
 * the gate can be proved to FAIL against a deliberately broken pattern
 * (`pattern-vintage-run.test.ts`).
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { Identity } from "@commonfabric/identity";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  HOME_PATTERN_SOURCE,
} from "../packages/piece/src/system-pattern-url.ts";
import {
  deriveRequiredPatternKeys,
  recordExistsUnder,
  reportBreakRegistryFindings,
} from "./pattern-break-registry-guards.ts";
import { readOnlyArguments } from "./only-arguments.ts";
import {
  armVerdictGuard,
  type CommandOutput,
  describeCaptureOutcome,
  describePinOutcome,
  isClean,
  relativeToRepo,
  reportCapturesSuperseded,
  reportDropsApplied,
  reportFailures,
  reportNothingMatched,
  reportNothingReplayed,
  reportOnlyWithCapture,
  reportReplaySummary,
  reportUncovered,
  reportUnknownFlags,
  reportUpdateNeedsATestKey,
  uncoveredRequiredPatterns,
  unknownFlags,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  captureChangedGenerations,
  captureMissing,
  type GateRoots,
  pinNewestGeneration,
  replayAll,
} from "./pattern-vintage-run.ts";
import {
  ACCEPTED_STATE_DROPS,
  acceptedDropKey,
} from "./pattern-vintage-accepted-drops.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);

/**
 * One fixed identity for every capture and replay.
 *
 * A vintage restores under whichever DID the replaying runtime uses, so a
 * deterministic signer keeps a fixture addressable across machines and runs.
 * (Measured: a cross-DID restore reads correctly anyway — the space is
 * whichever file the server opens — so this is reproducibility, not
 * correctness. A label lowering `CurrentPrincipal` would make it correctness
 * too.)
 */
const FIXTURE_SIGNER = await Identity.fromPassphrase("pattern vintage fixture");

/** The commands that read the whole tree to decide what they should do. */
const CAPTURE_FLAGS = ["--update", "--capture-changed", "--pin"] as const;

/**
 * Print what a command decided to say and exit with the code it chose.
 *
 * `never` rather than `void`, and the annotation is doing real work even
 * though `Deno.exit` already guarantees it — but the work is HERE, not at the
 * call sites. Measured: changing it to `void` produces no call-site error at
 * all, because no `emit` call has code after it inside its own block, so
 * `never` has no control flow to narrow. What it does catch is a future `emit`
 * that can return: adding a bare `return;` to this body is a compile error on
 * the spot. That is the thing that would otherwise let a command fall through
 * into the plain gate below.
 */
function emit(shown: CommandOutput): never {
  if (shown.out !== undefined) console.log(shown.out);
  if (shown.err !== undefined) console.error(shown.err);
  Deno.exit(shown.code);
}

async function main() {
  const roots: GateRoots = {
    // Absolute, so the task behaves the same whatever directory it is invoked
    // from — the workspace runner does not run it from the repo root.
    repoRoot: REPO_ROOT,
    patternsRoot: `${REPO_ROOT}/packages/patterns`,
    vintagesRoot: `${REPO_ROOT}/${VINTAGES_DIR}`,
    signer: FIXTURE_SIGNER,
  };

  // Before anything else: a flag this task does not know is a MISTAKE, not a
  // no-op. Unhandled, it falls through to the plain gate and exits 0 having
  // answered a question nobody asked.
  const unknown = unknownFlags(Deno.args);
  if (unknown.length > 0) emit({ err: reportUnknownFlags(unknown), code: 1 });

  // Which fixtures this invocation replays, and whether that is all of
  // them. Coverage of the required patterns and the audit of accepted
  // removals are judged over every fixture's replay, which a filtered run
  // has not done, so a filtered run does not make them.
  // A lane passes one exact fixture path per `--only`; a person passes a
  // fragment. Each is matched against a fixture's repository-relative path.
  const filter = readOnlyArguments(Deno.args);
  if ("error" in filter) emit({ err: filter.error, code: 1 });
  const only = filter.only;
  const whole = only.length === 0;
  // A capture reads the whole tree to decide what is due, and a positional
  // it takes is a test key rather than a fixture, so a filter beside one is
  // an invocation that cannot mean what it says.
  if (!whole && CAPTURE_FLAGS.some((flag) => Deno.args.includes(flag))) {
    emit({ err: reportOnlyWithCapture(), code: 1 });
  }

  // The required set comes from the runtime's OWN constants, so the gate
  // cannot drift from what actually auto-updates, and a constant that stopped
  // deriving a key would leave it requiring nothing.
  //
  // Below the unknown-flag check on purpose. A record typo and a mistyped flag
  // are both ordinary authoring slips, and whichever runs first is the one
  // reported — so the flag, which decides what this invocation even does, is
  // answered before the registries are judged. Still ahead of every replay.
  const required = deriveRequiredPatternKeys(
    [HOME_PATTERN_SOURCE, DEFAULT_APP_PATTERN_SOURCE],
  );
  if ("error" in required) emit({ err: required.error, code: 1 });
  const registryReport = reportBreakRegistryFindings({
    requiredPatternKeys: required.keys,
    recordExists: recordExistsUnder(REPO_ROOT),
  });
  if (registryReport !== undefined) emit({ err: registryReport, code: 1 });

  if (Deno.args.includes("--update")) {
    // A capture NAMES the test to run. There is no default set, and deriving
    // one is not possible in the case that would need it: the seed list only
    // ever did work when a fixture was MISSING, and nothing on disk knows
    // which test covers a pattern whose fixture is gone — a test need not be
    // named after what it drives. A hand-kept list papered over that and
    // introduced a seam instead: the required PATTERNS come from the runtime's
    // URL constants, so adding one no listed test instantiates left the gate
    // red while `--update` reported everything fine and exited 0.
    //
    // The guidance moved to where someone actually needs it —
    // `reportUncovered`, which fires exactly when a required pattern has no
    // fixture and can now name the test where one is known.
    const named = Deno.args.filter((arg) => !arg.startsWith("--"));
    if (named.length === 0) {
      console.error(reportUpdateNeedsATestKey());
      Deno.exit(1);
    }
    const { captured, problems } = await captureMissing(
      roots,
      named,
      new Date(),
    );
    if (captured.length === 0 && problems.length === 0) {
      console.log(`Already pinned: ${named.join(", ")}.`);
    }
    for (const path of captured) {
      console.log(`  + ${relativeToRepo(path, REPO_ROOT)}`);
    }
    if (problems.length > 0) {
      console.error(`\n${problems.length} vintage(s) could not be captured:`);
      for (const problem of problems) console.error(problem);
      Deno.exit(1);
    }
    return;
  }

  if (Deno.args.includes("--pin")) {
    emit(describePinOutcome(
      await pinNewestGeneration(
        roots,
        Deno.args.filter((arg) => !arg.startsWith("--")),
      ),
      REPO_ROOT,
    ));
  }

  const replay = await replayAll(roots, { recordResults: true, only });

  if (Deno.args.includes("--capture-changed")) {
    emit(describeCaptureOutcome(
      await captureChangedGenerations(roots, replay, new Date()),
      REPO_ROOT,
    ));
  }

  // Coverage is judged against the SAME list that was replayed. A second walk
  // would be a second answer to one question, and "replayed nothing" paired with
  // "everything is covered" is the disagreement that reads as a pass.
  const uncovered = whole
    ? uncoveredRequiredPatterns([...required.keys], replay.covered)
    : [];

  if (uncovered.length > 0) {
    console.error(reportUncovered(
      uncovered,
      replay.coveredBy,
      new Set(replay.failures.map((failure) => failure.testKey)),
    ));
  }
  if (replay.replayed === 0) {
    console.error(
      `\n${whole ? reportNothingReplayed() : reportNothingMatched(only)}`,
    );
  }
  if (replay.failures.length > 0) {
    console.error(`\n${reportFailures(replay.failures)}`);
  }

  if (replay.capturesSuperseded.length > 0) {
    console.log(`\n${reportCapturesSuperseded(replay.capturesSuperseded)}`);
  }

  if (replay.dropsApplied.size > 0) {
    console.log(`\n${reportDropsApplied(replay.dropsApplied)}`);
  }

  // Which patterns this run is in a position to judge: a fixture's manifest
  // names it, so a replay either used its entries or proved they were not
  // needed. An unfiltered run walks every fixture in the tree, which is what
  // makes this a fact about the whole store and what the two audits below
  // rest on; a filtered run knows only about what it replayed, so it makes
  // neither of them.
  const judged = new Set(
    [...replay.covered, ...replay.coveredBy.keys()],
  );
  // An accepted removal that forgave nothing is an exemption outliving what it
  // was granted for — the same rule Tier 1's accepted breaks carry, asked per
  // PATH so an entry cannot keep a line nothing needs.
  const staleDrops = !whole ? [] : ACCEPTED_STATE_DROPS
    .filter((drop) => judged.has(drop.pattern))
    .flatMap((drop) =>
      drop.paths
        .map((path) => acceptedDropKey(drop.pattern, path))
        .filter((pair) => !replay.dropsApplied.has(pair))
    );
  if (staleDrops.length > 0) {
    console.error(
      `\n${staleDrops.length} accepted removal path(s) in ` +
        `tasks/pattern-vintage-accepted-drops.ts forgive nothing: ` +
        `${staleDrops.join(", ")}. No replayed vintage holds them, so the ` +
        `comparison would pass without them — remove those paths.`,
    );
  }
  // An entry for a pattern no fixture records is not stale, it is UNJUDGEABLE:
  // nothing replayed could have needed it, so the run has no evidence either
  // way. Reported separately because the remedy differs — capture a vintage
  // that covers the pattern, or drop an entry that was never load-bearing.
  const unjudgeableDrops = !whole ? [] : ACCEPTED_STATE_DROPS
    .filter((drop) => !judged.has(drop.pattern))
    .map((drop) => drop.pattern);
  if (unjudgeableDrops.length > 0) {
    console.error(
      `\n${unjudgeableDrops.length} accepted removal(s) in ` +
        `tasks/pattern-vintage-accepted-drops.ts name a pattern no fixture ` +
        `records: ${unjudgeableDrops.join(", ")}. An exemption nothing can ` +
        `audit is one nobody can retire — capture a vintage covering the ` +
        `pattern, or remove the entry.`,
    );
  }

  // CANDIDATES and TARGETS are the soundness floor, not `updated`. A run where
  // nothing changed legitimately updates nothing — that is the common case, and
  // the auto-updater fires on the same condition. But a run with no candidates,
  // or none that today's source could be applied to, examined no update targets
  // at all — the shape that has read as success three separate times here.
  if (
    !isClean(replay.failures, uncovered, replay) || staleDrops.length > 0 ||
    unjudgeableDrops.length > 0
  ) {
    Deno.exit(1);
  }
  console.log(reportReplaySummary(replay));
}

if (import.meta.main) {
  // Reaching a verdict is part of passing. Measured: a pattern that does not
  // compile, and a truncated fixture, both leave `harness.resolve()`'s promise
  // pending forever while the real error surfaces as a rejection nobody
  // awaits — so `main` never returns, the event loop drains, and the process
  // would exit 0 having replayed nothing and printed nothing.
  armVerdictGuard(globalThis, Deno.exit);
  await main();
  // Only the clean path gets here; every other exit is `Deno.exit(1)` above.
  // Exiting explicitly is what keeps the guard from firing on a success.
  Deno.exit(0);
}
