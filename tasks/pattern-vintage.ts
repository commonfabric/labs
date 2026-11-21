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
 *   deno task pattern-vintage --only apps/topics/topics.test.tsx    # replay matching fixtures alone
 *   deno task pattern-vintage --update apps/topics/topics.test.tsx  # first pinned fixture
 *   deno task pattern-vintage --capture-changed                # capture a generation where due
 *   deno task pattern-vintage --pin apps/topics/topics.test.tsx     # promote the newest generation
 *
 * `--only` takes one value per flag and may be repeated. It restricts the
 * replay to the fixtures whose repository-relative path contains one of the
 * values. Each fixture's replay restores its own store, drives its own roots,
 * and compares against its own manifest, so its result is the same whether or
 * not other fixtures replay.
 *
 * A filtered run skips the three checks that need every fixture replayed:
 * whether every required pattern is covered, whether each accepted removal
 * still applies to some fixture, and whether each accepted removal names a
 * pattern that some fixture records.
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
 * equivalent gate over `runtime/piece/test/vintages/`, so a deleted fixture is
 * caught by a human reading the diff and nothing else. Recapturing one is
 * therefore a decision to make out loud, not a routine step.
 *
 * This file is the shell — roots, argument parsing, printing, exit code. The
 * work is in `pattern-vintage-run.ts`, which takes its roots as arguments so
 * the gate can be proved to FAIL against a deliberately broken pattern
 * (`pattern-vintage-run.test.ts`).
 */

import { Identity } from "@commonfabric/identity";
import { type CommandOutput, emit } from "./command-output.ts";
import { judgeBreakRegistries } from "./pattern-break-registry-guards.ts";
import { REPO_ROOT } from "./pattern-files.ts";
import {
  describeCaptureOutcome,
  describePinOutcome,
  isClean,
  judgeWholeTree,
  relativeToRepo,
  replayScope,
  reportCapturesSuperseded,
  reportDropsApplied,
  reportEmptyReplay,
  reportFailures,
  reportReplaySummary,
  reportUncovered,
  reportUnknownFlags,
  reportUpdateNeedsATestKey,
  unknownFlags,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  captureChangedGenerations,
  captureMissing,
  type GateRoots,
  pinNewestGeneration,
  type Progress,
  replayAll,
} from "./pattern-vintage-run.ts";
import {
  ACCEPTED_STATE_DROPS,
  type AcceptedStateDrop,
} from "./pattern-vintage-accepted-drops.ts";

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

/** The tree this checkout holds, replayed under the fixture signer. */
const ROOTS: GateRoots = {
  // Absolute, so the task behaves the same whatever directory it is invoked
  // from — the workspace runner does not run it from the repo root.
  repoRoot: REPO_ROOT,
  patternsRoot: `${REPO_ROOT}/patterns`,
  vintagesRoot: `${REPO_ROOT}/${VINTAGES_DIR}`,
  signer: FIXTURE_SIGNER,
};

/** Where `runPatternVintage()` reads its facts from, where not this tree. */
export interface VintageGateOptions {
  roots?: GateRoots;

  /** The patterns that auto-update, which the required set is derived from. */
  systemPatternUrls?: readonly string[];

  /**
   * The removals the replay forgives and the tree is audited against. The
   * registries judged ahead of any replay are the shipped ones whatever this
   * holds.
   */
  acceptedDrops?: readonly AcceptedStateDrop[];

  /** Whether the replay writes one record per fixture into the run's spool. */
  recordResults?: boolean;

  /** Receives a line as each replay or capture step of the run begins. */
  progress?: Progress;
}

/**
 * Run the gate, or the writing command `args` names, and say what it decided.
 */
export async function runPatternVintage(
  args: readonly string[],
  options: VintageGateOptions = {},
): Promise<CommandOutput> {
  const {
    roots = ROOTS,
    systemPatternUrls,
    acceptedDrops = ACCEPTED_STATE_DROPS,
    recordResults = false,
    progress,
  } = options;
  const { repoRoot } = roots;

  // Before anything else: a flag this task does not know is a MISTAKE, not a
  // no-op. Unhandled, it falls through to the plain gate and exits 0 having
  // answered a question nobody asked.
  const unknown = unknownFlags(args);
  if (unknown.length > 0) return { err: reportUnknownFlags(unknown), code: 1 };

  // The fixtures this run replays. A lane passes one exact fixture path per
  // `--only`, and a person may pass part of a path.
  const scope = replayScope(args);
  if ("error" in scope) return { err: scope.error, code: 1 };
  const { only, whole } = scope;

  // The required set comes from the runtime's OWN constants, so the gate
  // cannot drift from what actually auto-updates, and a constant that stopped
  // deriving a key would leave it requiring nothing.
  //
  // Below the unknown-flag check on purpose. A record typo and a mistyped flag
  // are both ordinary authoring slips, and whichever runs first is the one
  // reported — so the flag, which decides what this invocation even does, is
  // answered before the registries are judged. Still ahead of every replay.
  const required = judgeBreakRegistries({ systemPatternUrls });
  if ("error" in required) return { err: required.error, code: 1 };

  const named = args.filter((arg) => !arg.startsWith("--"));
  if (args.includes("--update")) {
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
    if (named.length === 0) {
      return { err: reportUpdateNeedsATestKey(), code: 1 };
    }
    const { captured, problems } = await captureMissing(
      roots,
      named,
      new Date(),
      progress,
    );
    const out = captured.length === 0 && problems.length === 0
      ? [`Already pinned: ${named.join(", ")}.`]
      : captured.map((path) => `  + ${relativeToRepo(path, repoRoot)}`);
    if (problems.length > 0) {
      return {
        ...(out.length > 0 ? { out: out.join("\n") } : {}),
        err: [
          `\n${problems.length} vintage(s) could not be captured:`,
          ...problems,
        ].join("\n"),
        code: 1,
      };
    }
    return { out: out.join("\n"), code: 0 };
  }

  if (args.includes("--pin")) {
    return describePinOutcome(
      await pinNewestGeneration(roots, named),
      repoRoot,
    );
  }

  const replay = await replayAll(roots, {
    recordResults,
    only,
    acceptedDrops,
    progress,
  });

  if (args.includes("--capture-changed")) {
    return describeCaptureOutcome(
      await captureChangedGenerations(roots, replay, new Date(), progress),
      repoRoot,
    );
  }

  // Coverage is judged against the SAME list that was replayed. A second walk
  // would be a second answer to one question, and "replayed nothing" paired with
  // "everything is covered" is the disagreement that reads as a pass.
  const { uncovered, staleDrops, unjudgeableDrops } = judgeWholeTree(
    whole,
    [...required.keys],
    replay,
    acceptedDrops,
  );

  const out: string[] = [];
  const err: string[] = [];
  if (uncovered.length > 0) {
    err.push(reportUncovered(
      uncovered,
      replay.coveredBy,
      new Set(replay.failures.map((failure) => failure.testKey)),
    ));
  }
  if (replay.replayed === 0) err.push(`\n${reportEmptyReplay(only)}`);
  if (replay.failures.length > 0) {
    err.push(`\n${reportFailures(replay.failures)}`);
  }

  if (replay.capturesSuperseded.length > 0) {
    out.push(`\n${reportCapturesSuperseded(replay.capturesSuperseded)}`);
  }

  if (replay.dropsApplied.size > 0) {
    out.push(`\n${reportDropsApplied(replay.dropsApplied)}`);
  }

  if (staleDrops.length > 0) {
    err.push(
      `\n${staleDrops.length} accepted removal path(s) in ` +
        `tasks/pattern-vintage-accepted-drops.ts forgive nothing: ` +
        `${staleDrops.join(", ")}. No replayed vintage holds them, so the ` +
        `comparison would pass without them — remove those paths.`,
    );
  }
  if (unjudgeableDrops.length > 0) {
    err.push(
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
  const failed = !isClean(replay.failures, uncovered, replay) ||
    staleDrops.length > 0 || unjudgeableDrops.length > 0;
  if (!failed) out.push(reportReplaySummary(replay));
  return {
    ...(out.length > 0 ? { out: out.join("\n") } : {}),
    ...(err.length > 0 ? { err: err.join("\n") } : {}),
    code: failed ? 1 : 0,
  };
}

if (import.meta.main) {
  emit(
    await runPatternVintage(Deno.args, {
      recordResults: true,
      progress: (line) => console.error(line),
    }),
  );
}
