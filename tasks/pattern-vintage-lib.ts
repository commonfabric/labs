/**
 * Stage 3 of the pattern-update regime: capturing a vintage, comparing it, and
 * reporting on what the comparison found.
 *
 * Tier 1 (`pattern-compat`) records a contract per pattern and proves the next
 * one is compatible with it. Tier 2 records a real prior STATE per pattern and
 * proves the next version can still read it. Capture and replay live in
 * `packages/piece/test/state-continuity-harness.ts` and the task shell in
 * `pattern-vintage.ts`. Where a fixture lives and how its path parses is
 * `pattern-vintage-layout.ts`, which this module re-exports, so one import
 * serves a caller working with vintages.
 */

import { exists } from "@std/fs";

import {
  isStoredArgumentSchemaRefusal,
  resolveSystemPatternSource,
  STORED_ARGUMENT_SCHEMA_REFUSAL,
} from "@commonfabric/runner";

import {
  VINTAGE_SPACES_SUFFIX,
  vintageCompanionDir,
} from "../packages/piece/test/vintage-layout.ts";

import {
  AUTO,
  parseVintagePath,
  PINNED,
  type VintageRef,
  VINTAGES_DIR,
} from "./pattern-vintage-layout.ts";

// The layout is re-exported here because this module is what a caller working
// with vintages reaches for.
export { AUTO, parseVintagePath, PINNED, type VintageRef, VINTAGES_DIR };
export {
  collectVintages,
  stampFor,
  VINTAGE_GATE,
  VINTAGE_SUFFIX,
  vintageDir,
  vintageFileName,
  vintageRecordName,
} from "./pattern-vintage-layout.ts";

/**
 * How many generations of one test key the working tree keeps.
 *
 * A bound on CHECKOUTS, not on history. A vintage costs ~9 KiB of git history
 * per generation — packfile delta search makes adjacent generations of a
 * near-identical store nearly free — and 3.5 MiB of working-tree disk in every
 * clone, forever. Those are different orders of magnitude and only the second
 * one argues for a limit.
 *
 * Four is chosen to be small enough to matter on disk and large enough that a
 * key keeps a real span of history rather than just "the last one".
 */
export const AUTO_GENERATIONS_KEPT = 4;

/**
 * The AUTO fixtures to delete so no test key keeps more than `keep` of them.
 *
 * Pure, and returns paths rather than deleting, so the selection can be tested
 * without a filesystem — and so the one property that must never regress is
 * checkable by reading the return value: **it can only ever name a fixture
 * under an `auto/` directory.** That is not a rule written down and obeyed, it
 * is the shape of the function. The tier filter comes first, before any
 * sorting or slicing, so there is no ordering of the later steps that could
 * reach a pinned vintage.
 *
 * This matters more than it looks. A deep vintage cannot be recaptured — the
 * pattern that wrote it no longer exists in runnable form — and a pruner is
 * invoked by people who are doing something else and not reading its output.
 */
export function autoGenerationsToPrune(
  vintages: readonly VintageRef[],
  keep: number = AUTO_GENERATIONS_KEPT,
): string[] {
  const byKey = new Map<string, VintageRef[]>();
  for (const vintage of vintages) {
    if (vintage.tier !== AUTO) continue;
    const group = byKey.get(vintage.testKey);
    if (group === undefined) byKey.set(vintage.testKey, [vintage]);
    else group.push(vintage);
  }
  const doomed: string[] = [];
  for (const group of byKey.values()) {
    // Newest first, so the survivors are the newest `keep`. Sorted on the
    // STAMP rather than the path: both begin with the same directory, but a
    // path sort would order by identity once the stamps tie, and the stamp is
    // the only field that means age.
    const ordered = [...group].sort((left, right) =>
      right.stamp.localeCompare(left.stamp)
    );
    doomed.push(...ordered.slice(Math.max(keep, 0)).map((v) => v.path));
  }
  return doomed.sort();
}

/**
 * Delete pruned fixtures, refusing anything that is not an AUTO generation.
 *
 * The refusal is redundant with `autoGenerationsToPrune`, which structurally
 * cannot name a pinned fixture, and it stays anyway. This is the only code in
 * the repository that deletes a vintage, the thing it deletes cannot be
 * recreated, and the cost of the check is a string comparison. A second lock
 * on the one irreversible door is worth more than the line it costs.
 *
 * A companion directory goes with its primary file. It is part of the fixture
 * rather than a fixture of its own — nothing enumerates it — so leaving one
 * behind would strand a directory nothing will ever read or clean up again.
 */
export async function removeVintages(
  paths: readonly string[],
  root: string = VINTAGES_DIR,
): Promise<void> {
  for (const path of paths) {
    const ref = parseVintagePath(path, root);
    if (ref?.tier !== AUTO) {
      throw new Error(
        `refusing to prune ${path}: retention only ever deletes an ${AUTO} ` +
          `generation, and this is ${
            ref === undefined ? "not a vintage at all" : `tier ${ref.tier}`
          }`,
      );
    }
    await Deno.remove(path);
    await Deno.remove(vintageCompanionDir(path), { recursive: true })
      .catch(() => {});
  }
}

/**
 * The newest AUTO generation of one test key — what a release would promote.
 *
 * Promotion is the moment an auto capture stops being regenerable and starts
 * being evidence: a pinned vintage is never pruned and is the only tier that
 * credits coverage. The NEWEST is chosen because it is the generation closest
 * to what shipped, which is what a release wants to keep.
 *
 * That is deliberately NOT the deepest evidence. The newest generation is the
 * one a future version has the LEAST to migrate across, and the oldest — the
 * one retention deletes first — is the strongest test. Promotion optimizes for
 * "what shipped" rather than for depth, and pinning an older generation
 * instead is a `git mv` anyone can do by hand.
 */
export function newestAutoGeneration(
  vintages: readonly VintageRef[],
  testKey: string,
): VintageRef | undefined {
  return vintages
    .filter((v) => v.tier === AUTO && v.testKey === testKey)
    .sort((left, right) => right.stamp.localeCompare(left.stamp))[0];
}

/**
 * Where a promoted fixture lands: the same name, under `pinned/`.
 *
 * The stamp and identity are carried over UNCHANGED, so a promoted vintage
 * still records when it was captured and by which test — restamping it would
 * date the promotion instead, and the capture date is what says which
 * generation of the world it holds.
 */
export function promotedPath(ref: VintageRef): string {
  const cut = ref.path.lastIndexOf("/");
  const fileName = ref.path.slice(cut + 1);
  const upToTier = ref.path.slice(0, cut);
  const tierCut = upToTier.lastIndexOf("/");
  return `${upToTier.slice(0, tierCut)}/${PINNED}/${fileName}`;
}

/**
 * Pattern keys that MUST have a pinned vintage.
 *
 * Derived from the runtime's own constants rather than a hand-kept list, so
 * the gate cannot drift from what actually auto-updates. These are the space
 * ROOTS: the runtime resolves their source pointer to a current identity and
 * swaps the pattern in place onto a root a user already has, with no structural
 * check on the way in. A change they cannot read bricks a live piece.
 *
 * Deliberately NOT "everything under `system/`". That directory also holds
 * personal variants (`*-ben.tsx`) and support modules that are not patterns,
 * and requiring a vintage for those would either wedge the gate on files that
 * cannot be materialized or pad coverage with fixtures nobody replays. Any
 * other TEST can still be pinned
 * deliberately (`--update <test key>`) — a vintage that exists is always
 * replayed; it is only being REQUIRED that this list governs.
 */
const PATTERN_ROUTE_MARKER = "/patterns/";

/**
 * A recorded `main` as a path under `packages/patterns/`, or `undefined`.
 *
 * Two spellings reach a manifest and only one is a repo path. A pattern
 * imported locally records `/packages/patterns/x.tsx`; one loaded BY URL — as
 * `lunch-poll/main.tsx` does for `profile-create` — records the route the
 * toolshed serves it at, `/api/patterns/system/profile-create.tsx`. Resolving
 * the second against the repo root looks for `<repo>/api/patterns/...`, which
 * does not exist, and the replay reports a pattern that is right there as
 * unresolvable.
 *
 * The route prefix is the same `/patterns/` marker `requiredPatternKeys` keys
 * on, for the same reason: it is where `PatternsServer` mounts the directory.
 *
 * `patternsPrefix` is a parameter rather than a constant so the gate stays
 * exercisable against a temp tree — the suite's fixtures record
 * `/patterns/x.tsx`, the repo's record `/packages/patterns/x.tsx`, and a
 * hardcoded prefix would quietly make every synthetic fixture unmappable.
 */
export function patternKeyFromMain(
  main: string | undefined,
  patternsPrefix: string,
): string | undefined {
  if (main === undefined) return undefined;
  if (main.startsWith(patternsPrefix)) return main.slice(patternsPrefix.length);
  // The route EXACTLY, not "/api" plus the marker somewhere later. Matching
  // loosely turned `/api/anything/at/all/patterns/x.tsx` into the repo key
  // `x.tsx`, so an unrelated served path would resolve to a real source file
  // and be replayed as though it were that pattern — a wrong answer rather
  // than a refused one, which is the shape this gate must never produce.
  const route = "/api/patterns/";
  if (main.startsWith(route)) return main.slice(route.length);
  return undefined;
}

/**
 * The route a system pattern source names.
 *
 * The runtime's constants are `system:` refs, addressed relative to the
 * patterns route; the gate maps routes to fixture keys. A source that names no
 * route is handed back unchanged, so it reaches the unmapped check below rather
 * than disappearing from the required set.
 */
function patternRoute(source: string): string {
  return resolveSystemPatternSource(source) ?? source;
}

export function requiredPatternKeys(
  systemPatternUrls: readonly string[],
): string[] {
  const keys: string[] = [];
  for (const source of systemPatternUrls) {
    const url = patternRoute(source);
    const at = url.indexOf(PATTERN_ROUTE_MARKER);
    if (at === -1) continue;
    keys.push(url.slice(at + PATTERN_ROUTE_MARKER.length));
  }
  return [...new Set(keys)].sort();
}

/**
 * The URLs `requiredPatternKeys` could not turn into a pattern key.
 *
 * `requiredPatternKeys` skips what it does not recognize, which is right for a
 * derivation and catastrophic for a gate: reroute the patterns endpoint and
 * every required key silently disappears, leaving a gate that insists on
 * nothing. The caller checks this and refuses to run rather than passing an
 * empty requirement, so a drift in the runtime's own constants is loud.
 */
export function unmappedPatternUrls(
  systemPatternUrls: readonly string[],
): string[] {
  return systemPatternUrls.filter((source) =>
    !patternRoute(source).includes(PATTERN_ROUTE_MARKER)
  );
}

/**
 * Required patterns that no fixture actually replayed.
 *
 * Judged from what the replay COVERED, not from the fixture tree's shape. A
 * fixture is named after the test that produced it and routinely covers several
 * patterns, so "a directory exists for X" and "X was replayed" are different
 * questions — and only the second is evidence.
 */
export function uncoveredRequiredPatterns(
  requiredKeys: readonly string[],
  covered: ReadonlySet<string>,
): string[] {
  return requiredKeys.filter((key) => !covered.has(key)).sort();
}

/** A vintage that could not be replayed under today's source. */
export interface ReplayFailure {
  /** The TEST whose fixture this failure came from. */
  testKey: string;

  /** Repo-relative fixture path. */
  path: string;

  detail: string;
}

/** A readable message for anything thrown across the task's I/O boundary. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An absolute path back to a repo-relative one, for readable output. */
export function relativeToRepo(path: string, repoRoot: string): string {
  const prefix = `${repoRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Promote an AUTO generation to `pinned/`, with `git mv`.
 *
 * `git mv` rather than a plain rename, because the point of promotion is that
 * the move lands in a COMMIT: a release promotes a fixture out of the prunable
 * tier so retention can never reach it, and a rename git has not been told
 * about shows up as a delete plus an add — which is exactly the diff that
 * looks like someone destroying a vintage, in a tree whose append-only
 * discipline rests on people reading diffs.
 *
 * The companion directory moves too, and moves FIRST — for RECOVERABILITY, not
 * for visibility. Measured, both orders leave the same wreckage if the
 * promotion is interrupted between the two moves: an enumerated fixture whose
 * companion is missing, which fails loudly on the next replay, plus an
 * invisible orphan directory, differing only in which tier it lands in.
 *
 * What differs is whether the operator can finish the job. With the companion
 * first, re-running `--pin` completes the promotion: `newestAutoGeneration`
 * still finds the primary in `auto/`, and the `exists` check below skips the
 * companion that already moved. With the primary first, the primary is in
 * `pinned/`, `newestAutoGeneration` returns nothing, the command reports there
 * is nothing to promote, and the half-moved fixture needs fixing by hand. That
 * is also what makes the `exists` check load-bearing rather than defensive.
 */
export async function promoteVintage(ref: VintageRef): Promise<string> {
  const destination = promotedPath(ref);
  // Never promote ONTO an existing pinned vintage. `git mv` refuses this on
  // its own ("destination exists"), which is precisely why the guard has to be
  // here: the untracked fallback is a plain rename, which overwrites in
  // silence — and untracked is the normal state of a generation captured
  // minutes ago, so the one path with no protection was the common one.
  //
  // A collision needs the same stamp AND identity in both tiers, which is
  // unlikely and totally destructive: this is the only fixture-writing
  // operation that could destroy a pinned vintage, and a pinned vintage cannot
  // be recaptured. `captureVintage` and `removeVintages` both refuse the
  // equivalent; promotion was the gap.
  const companion = vintageCompanionDir(ref.path);
  const companionDestination = vintageCompanionDir(destination);
  // BOTH halves are checked, because a fixture is the pair. Guarding only the
  // primary leaves the companion able to collide on its own, and that
  // collision is the silent one: `git mv` moves a directory INTO an existing
  // directory of that name rather than refusing, so the promoted companion
  // ends up nested one level down while the stale leftover keeps the name the
  // replay reads. Measured, on the tracked path — untracked fails loudly with
  // ENOTEMPTY, so the safer-looking branch was the corrupting one.
  //
  // The companion check is CONDITIONAL on there being a source companion to
  // move, and that conjunct is not belt-and-braces: it is what keeps an
  // interrupted promotion resumable. Half-done, the companion is already in
  // `pinned/` and the primary is still in `auto/` — exactly the state the
  // companion-first order exists to produce — so re-running `--pin` must
  // finish the job rather than refuse. With the conjunct dropped, that
  // recovery is refused and the operator is left to move files by hand.
  const collision = (await exists(destination))
    ? destination
    : (await exists(companion)) && (await exists(companionDestination))
    ? companionDestination
    : undefined;
  if (collision !== undefined) {
    throw new Error(
      `cannot promote ${ref.path}: ${collision} already exists, and a ` +
        `promotion never overwrites a vintage — delete it and its ` +
        `${VINTAGE_SPACES_SUFFIX} directory deliberately first`,
    );
  }
  await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
    recursive: true,
  });
  if (await exists(companion)) {
    await gitMove(companion, companionDestination);
  }
  await gitMove(ref.path, destination);
  return destination;
}

/**
 * `git mv`, falling back to a plain rename for anything git does not track.
 *
 * The fallback is not defensive tidiness, it is the common case. A generation
 * captured minutes ago is UNTRACKED, and capture-then-promote in one sitting is
 * the most natural first use of these two commands. Measured, not reasoned
 * about: the first real `--pin` run died on exactly this.
 *
 * Where the fixture IS tracked, `git mv` is what runs, because there the staged
 * rename is the entire point — renaming a committed fixture behind git's back
 * reads in review as a delete plus an add, which is the diff that looks like
 * someone destroying a vintage.
 *
 * Which of the two applies is decided by ASKING git, rather than by matching
 * its error text. The first attempt matched on "not under version control" and
 * was wrong twice over: `git mv` resolves the repository from the process's
 * working directory rather than the file's, so the same untracked fixture
 * produces a different message ("is outside repository") depending on where
 * the command was invoked from — and every unmatched message became a crash.
 * `cwd` is pinned to the fixture's own directory for the same reason.
 */
async function gitMove(from: string, to: string): Promise<void> {
  const cwd = from.slice(0, from.lastIndexOf("/"));
  const tracked = await new Deno.Command("git", {
    args: ["ls-files", "--error-unmatch", from],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!tracked.success) {
    // Untracked, or not in a repository at all. Either way there is no index
    // entry to move, so the rename IS the whole operation.
    await Deno.rename(from, to);
    return;
  }
  const result = await new Deno.Command("git", {
    args: ["mv", from, to],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git mv ${from} ${to} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
}

/**
 * Everything a command wants to say, and the code it wants to exit with.
 *
 * Returned rather than printed so the OUTPUT is testable, not just the
 * decision behind it. That is where this file's defects have actually lived:
 * across five review rounds the recurring fault was never a wrong decision, it
 * was the wrong text printed for a correct one — a remedy that did not fit the
 * situation, or a promise about output the function did not control. Text
 * assembled inside the task shell is text no test can read.
 */
export interface CommandOutput {
  out?: string;
  err?: string;
  code: number;
}

/** What `--pin` says, given what it decided. */
export function describePinOutcome(
  outcome:
    | { kind: "needs-one-key"; given: number }
    | {
      kind: "nothing-to-pin";
      testKey: string;
      vintages: readonly VintageRef[];
    }
    | { kind: "promoted"; from: string; to: string }
    | { kind: "failed"; from: string; detail: string },
  repoRoot: string,
): CommandOutput {
  switch (outcome.kind) {
    case "needs-one-key":
      return { err: reportPinNeedsOneTestKey(outcome.given), code: 1 };
    case "nothing-to-pin":
      return {
        err: reportNothingToPin(outcome.testKey, outcome.vintages),
        code: 1,
      };
    case "failed":
      return {
        err: `Could not promote ${
          relativeToRepo(outcome.from, repoRoot)
        }: ${outcome.detail}`,
        code: 1,
      };
    case "promoted":
      return {
        out: [
          `  ${relativeToRepo(outcome.from, repoRoot)}`,
          `  → ${relativeToRepo(outcome.to, repoRoot)}`,
        ].join("\n"),
        code: 0,
      };
  }
}

/** What `--capture-changed` says, given what it decided. */
export function describeCaptureOutcome(
  outcome:
    | { kind: "refused-red"; failures: readonly ReplayFailure[] }
    | { kind: "all-current"; replayed: number }
    | {
      kind: "captured";
      captured: readonly string[];
      pruned: readonly string[];
      problems: readonly string[];
    },
  repoRoot: string,
): CommandOutput {
  switch (outcome.kind) {
    case "refused-red":
      return {
        err: `\n${reportFailures(outcome.failures)}\n\n${
          reportCaptureRefusedOnRed(outcome.failures.length)
        }`,
        code: 1,
      };
    case "all-current":
      // An EMPTY tree exits 1, on STDERR. The message says this is the moment
      // someone is most likely to believe the regime is running when it is
      // not — and an exit code is the half of that message anything scripting
      // this can read. Pairing that text with the healthy exit code would make
      // "there is nothing here" indistinguishable from "everything is
      // current"; the plain gate calls the same tree a failure.
      //
      // The stream matters as much as the code, and splitting this case in two
      // is exactly how it went wrong: every other nonzero exit in both
      // commands explains itself on stderr, so leaving this one on stdout made
      // `cmd 2>err.log >/dev/null || cat err.log` report a bare exit 1 with no
      // reason at all.
      return outcome.replayed === 0
        ? { err: reportEveryGenerationCurrent(0), code: 1 }
        : { out: reportEveryGenerationCurrent(outcome.replayed), code: 0 };
    case "captured": {
      const lines = [
        ...outcome.captured.map((p) => `  + ${relativeToRepo(p, repoRoot)}`),
        ...outcome.pruned.map((p) => `  - ${relativeToRepo(p, repoRoot)}`),
      ];
      // No blank stdout line when every capture failed and nothing was
      // pruned: `out: ""` still prints, so the errors would arrive under a
      // leading empty line that looks like truncated output.
      const out = lines.length > 0 ? lines.join("\n") : undefined;
      // A capture that partly failed still REPORTS what it wrote, then exits
      // 1. Suppressing the list would leave files on disk that the command
      // just claimed not to have made.
      return outcome.problems.length > 0
        ? {
          out,
          err:
            `\n${outcome.problems.length} generation(s) were not captured:\n${
              outcome.problems.join("\n")
            }`,
          code: 1,
        }
        : { out, code: 0 };
    }
  }
}

/** Every flag this task understands. Anything else is a mistake, not a hint. */
export const KNOWN_FLAGS = [
  "--update",
  "--capture-changed",
  "--pin",
  "--only",
] as const;

/** The flag that restricts a replay, in the form that carries its value. */
const ONLY_PREFIX = "--only=";

/** Whether a fixture path is one a filter asked for. */
export function replayFilterTakes(
  path: string,
  only: readonly string[],
): boolean {
  return only.length === 0 || only.some((value) => path.includes(value));
}

/** What the task prints when a filter matched no fixture in the tree. */
export function reportNothingMatched(only: readonly string[]): string {
  return [
    `Replayed 0 vintages — no fixture's path holds ${
      only.map((value) => `\`${value}\``).join(" or ")
    }.`,
    "A filter that matches nothing proves nothing, so it is a failure.",
  ].join("\n");
}

/** What the task prints when a filter is paired with a capture command. */
export function reportOnlyWithCapture(): string {
  return [
    "`--only` restricts a replay and every command that captures or pins " +
    "reads the whole tree, so the two cannot be given together.",
    "Run the capture on its own, then replay what you want.",
  ].join("\n");
}

/**
 * Flags the task does not recognize.
 *
 * A misspelled flag is silently a DIFFERENT COMMAND here, and the difference
 * is invisible: `--capture-chnged` matches no branch, so the run falls through
 * to the plain gate, replays everything, prints a healthy summary and exits 0.
 * Someone who meant to capture a generation is told the tree is fine. `--pinn`
 * is worse — the stray positional is discarded and the same clean pass is
 * printed instead of a promotion.
 *
 * For a gate whose every other design decision is about never reading as
 * success by accident — `armVerdictGuard`, the `replayed`/`candidates`/
 * `targets` floors, the per-fixture root control — accepting an unrecognized
 * flag and exiting 0 is the same failure in the argument parser.
 */
export function unknownFlags(args: readonly string[]): string[] {
  const known = new Set<string>(KNOWN_FLAGS);
  // A SINGLE dash counts. Testing for `--` was the same defect this function
  // exists to prevent, sitting inside the fix for it: measured, a dropped
  // leading dash (`-capture-changed`, `-x`) fell straight through to the plain
  // gate and exited 0 with a healthy summary. No legitimate argument here
  // begins with a dash — the positional filter is `!arg.startsWith("--")` and
  // a test key is a path — so widening costs nothing.
  //
  // `--` alone is exempt. It is the conventional end-of-flags separator and
  // `deno task` forwards it verbatim, so rejecting it refused the ordinary
  // `deno task pattern-vintage -- --update <key>` invocation.
  return args.filter((arg) =>
    arg.startsWith("-") && arg !== "--" && !known.has(arg) &&
    !arg.startsWith(ONLY_PREFIX)
  );
}

/** What the task prints when it was handed a flag it does not know. */
export function reportUnknownFlags(unknown: readonly string[]): string {
  return [
    `Unrecognized flag(s): ${unknown.join(", ")}.`,
    "",
    "Stopping rather than guessing. An unknown flag matches no command here,",
    "so the run would fall through to the plain gate, replay everything and",
    "exit 0 — reporting the tree healthy to someone who asked for something",
    "else entirely.",
    "",
    `Known flags: ${KNOWN_FLAGS.join(", ")}.`,
  ].join("\n");
}

/** What `--pin` prints when it was not given exactly one test key. */
export function reportPinNeedsOneTestKey(given: number): string {
  return [
    given === 0
      ? "`--pin` names the TEST whose newest auto generation to promote."
      : `\`--pin\` promotes one test key at a time; ${given} were named.`,
    "",
    "  deno task pattern-vintage --pin topics/topics.test.tsx",
    "",
    "Promotion is a deliberate act per fixture — it moves a generation into",
    "the tier retention can never reach, and pinning a batch by accident is",
    "not undone by pinning less next time.",
  ].join("\n");
}

/** What `--pin` prints when a key has no auto generation to promote. */
export function reportNothingToPin(
  testKey: string,
  vintages: readonly VintageRef[],
): string {
  const keys = [
    ...new Set(vintages.filter((v) => v.tier === AUTO).map((v) => v.testKey)),
  ].sort();
  const alreadyPinned = vintages.some(
    (v) => v.tier === PINNED && v.testKey === testKey,
  );
  return [
    `No ${AUTO} generation of ${testKey} to promote.`,
    "",
    ...(alreadyPinned
      ? [
        `${testKey} already has a pinned vintage, and promotion only ever`,
        "moves a generation the automatic capture produced. To pin a NEWER",
        "one, capture it first:",
        "",
        "  deno task pattern-vintage --capture-changed",
        "",
        "which captures only where today's source has moved past every",
        "generation on disk — so it does nothing if this key is current.",
      ]
      : keys.length === 0
      ? [
        "Nothing in the tree has one. Auto generations are captured by:",
        "",
        "  deno task pattern-vintage --capture-changed",
      ]
      : [
        "Keys that do have one:",
        "",
        ...keys.map((key) => `  ${key}`),
      ]),
  ].join("\n");
}

/** What `--capture-changed` prints when it will not capture onto a red tree. */
export function reportCaptureRefusedOnRed(failures: number): string {
  return [
    `Captured nothing: ${failures} fixture(s) failed to replay.`,
    "",
    "A generation is a record of a world that WORKED. Capturing beside a",
    "failure would mint one from a run whose verdict is red, and the fixture",
    "would then be replayed by everyone else as though it were evidence.",
    "",
    "Fix the failures above, or delete the fixture that can no longer replay",
    "— deliberately, so it shows up in the diff — and run this again.",
  ].join("\n");
}

/** What `--capture-changed` prints when no key needs a new generation. */
export function reportEveryGenerationCurrent(replayed: number): string {
  // An empty tree is a DIFFERENT statement, and the vacuous one is worse than
  // useless: "all 0 fixture(s) are current" asserts currency about a tree that
  // proved nothing, at the exact moment someone is most likely to believe the
  // regime is running when it is not. `--capture-changed` cannot help here —
  // it only ever adds a generation beside an existing one — so it says what
  // will.
  if (replayed === 0) {
    return [
      "Captured nothing: there are no fixtures to capture a generation FROM.",
      "",
      "A generation is captured beside an existing fixture, for a test key the",
      "tree already covers. With nothing there, the first fixture for a key is",
      "a deliberate act:",
      "",
      "  deno task pattern-vintage --update <test path>",
    ].join("\n");
  }
  return [
    `Captured nothing: all ${replayed} fixture(s) are current.`,
    "",
    "Every target each fixture recorded still compiles to the identity it",
    "captured, so a fresh capture would record the same world and cost a file",
    "to say so.",
  ].join("\n");
}

/**
 * What the gate prints when a pattern has no vintage.
 *
 * The report is the gate's entire interface to whoever trips it, so it is
 * built here and tested rather than assembled inline: a gate that fails with
 * an unclear message costs more than one that fails a little late.
 */
export function reportUncovered(
  uncovered: readonly string[],
  coveredBy: ReadonlyMap<string, { testKey: string; pinned: boolean }> =
    new Map(),
  failedTestKeys: ReadonlySet<string> = new Set(),
): string {
  // Every branch below is chosen from a fact this function was HANDED, never
  // from one it infers about output it does not control. That distinction is
  // the whole design of this report, and it was arrived at expensively: across
  // four review rounds the recurring defect was always the same shape — a
  // remedy printed for a situation it did not fit — and always because the
  // text was reasoning about something out of frame.
  //
  // The last version got as far as refusing to guess: it listed BOTH possible
  // remedies and told the reader to work out which applied from the failures
  // printed below. Honest, and still the reader's problem to solve. `failures`
  // carries a `testKey`, so which fixtures failed is knowable here — and once
  // known, each pattern gets the one remedy that fits it.
  //
  // Three situations, and each is a question with an answer in hand: does a
  // fixture NAME this pattern (`coveredBy`), did that fixture FAIL
  // (`failedTestKeys`), and is it the tier that credits coverage (`pinned`).
  const named = uncovered.filter((key) => coveredBy.has(key));
  const unnamed = uncovered.filter((key) => !coveredBy.has(key));
  const broken = named.filter((key) =>
    failedTestKeys.has(coveredBy.get(key)!.testKey)
  );
  // Recorded by an AUTO generation that replayed FINE. The generation is real
  // and it works; it just does not credit coverage, because retention can
  // delete it and coverage that retention can delete is not coverage. The
  // remedy is to move it into the tier retention cannot reach.
  const promotable = named.filter((key) =>
    !failedTestKeys.has(coveredBy.get(key)!.testKey) &&
    !coveredBy.get(key)!.pinned
  );
  // Recorded by a PINNED fixture that replayed without failing, and still not
  // credited. Deliberately NOT given a remedy: every route to it that can be
  // named ends in a failure, so reaching it means the gate's own accounting
  // disagrees with itself, and any instruction printed here would be a guess
  // about a state whose cause is unknown. Saying so is the useful output.
  const unexplained = named.filter((key) =>
    !failedTestKeys.has(coveredBy.get(key)!.testKey) &&
    coveredBy.get(key)!.pinned
  );
  return [
    `${uncovered.length} auto-updating pattern(s) are not covered by a pinned`,
    "vintage this run replayed:",
    "",
    ...uncovered.map((key) => {
      const from = coveredBy.get(key);
      return from === undefined
        ? `  ${key}`
        : `  ${key}  (recorded by ${from.testKey})`;
    }),
    "",
    "These patterns auto-update onto a root someone is already using, so a",
    "change that cannot read the old state bricks that piece.",
    ...(broken.length > 0
      ? [
        "",
        "Recorded by a fixture that FAILED this run. The failure printed below",
        "carries the remedy for that particular fault; capturing another",
        "fixture would change nothing:",
        "",
        ...broken.map((key) => `  ${key}  ${coveredBy.get(key)!.testKey}`),
      ]
      : []),
    ...(promotable.length > 0
      ? [
        "",
        `Recorded by an ${AUTO} generation that replayed cleanly. Auto`,
        "generations are pruned by count, so letting one credit coverage would",
        "let retention delete a pattern's only evidence. Promote it:",
        "",
        ...[...new Set(promotable.map((key) => coveredBy.get(key)!.testKey))]
          .map((testKey) => `  deno task pattern-vintage --pin ${testKey}`),
      ]
      : []),
    ...(unexplained.length > 0
      ? [
        "",
        "Recorded by a PINNED fixture that replayed without failing, and still",
        "not credited. No remedy is printed because there is no known route to",
        "this state — the gate's own accounting is disagreeing with itself, and",
        "an instruction here would be a guess. Worth reporting as a gate bug:",
        "",
        ...unexplained.map((key) => `  ${key}  ${coveredBy.get(key)!.testKey}`),
      ]
      : []),
    ...(unnamed.length > 0
      ? [
        "",
        "Nothing this run could READ names the rest. That is either a pattern",
        "no fixture covers, or a fixture too broken to say what it holds — the",
        "failures below tell which. For the first, capture the TEST that",
        "instantiates it, a test path rather than a pattern path because a",
        "fixture is produced by RUNNING a test:",
        "",
        "  deno task pattern-vintage --update <test path>",
        "",
        "e.g. `--update topics/topics.test.tsx`. Which test that is cannot be",
        "derived: a test need not be named after what it drives, and nothing",
        "on disk knows until a fixture exists.",
      ]
      : []),
  ].join("\n");
}

/** What the gate prints when a committed vintage no longer replays. */
export function reportFailures(failures: readonly ReplayFailure[]): string {
  return [
    `${failures.length} vintage(s) could not be replayed:`,
    "",
    ...failures.flatMap(({ testKey, path, detail }) => [
      `  ${testKey}`,
      `    ${path}`,
      `    ${detail}`,
    ]),
    "",
    "This is state a deployed piece is holding RIGHT NOW. The automatic updater",
    "performs no structural check, so nothing at runtime will stop this change",
    "from reaching it.",
  ].join("\n");
}

/**
 * What the gate prints for the derived sub-pattern targets it held back.
 *
 * Each line is a target whose captured state the replay did not hold today's
 * source to, because the state is a hoist: derivation the updated source re-runs
 * and re-supplies for itself. Naming the rule beside the count is the point — a
 * run that held something back and said only how many is a run whose reader has
 * to go and find out on what grounds.
 *
 * One target is named once however many vintages raised it, so the count is
 * targets held back rather than times one was.
 */
export function reportCapturesSuperseded(
  targets: readonly string[],
): string {
  const held = [...new Set(targets)].sort();
  return [
    `Held ${held.length} derived sub-pattern target(s) back, each with the ` +
    `rule that held it: a hoist is derivation the updated source re-runs and ` +
    `re-supplies (root contracts still gate):`,
    ...held.map((target) => `  ${target}`),
  ].join("\n");
}

/**
 * What the gate prints for the paths an accepted removal forgave.
 *
 * Each line is a `pattern` and `path` pair whose vintage held a value today's
 * source no longer reads. The exemption list is named in the text rather than
 * left to the reader, because the list is where the entry is retired once the
 * removal it was granted for is done with.
 */
export function reportDropsApplied(pairs: Iterable<string>): string {
  const forgiven = [...pairs].sort();
  return [
    `Held ${forgiven.length} path(s) back from their vintage, by accepted ` +
    `removal (tasks/pattern-vintage-accepted-drops.ts):`,
    ...forgiven.map((pair) => `  ${pair}`),
  ].join("\n");
}

/**
 * What the gate prints when it PASSES — built here and tested, for the same
 * reason the failure reports are: it is the whole of what a green run tells
 * whoever reads the log, and a claim assembled inline is one nothing checks.
 *
 * "all mappable" is stated unconditionally and that is safe: `replayVintage`
 * reports every unaddressable root as a FAILURE and this line is only reached
 * once `isClean` has found none. Saying it positively rather than printing a
 * caveat beside a pass is the point — a green verdict with a footnote about
 * skipped roots is how narrowed coverage reads as success.
 *
 * `targets` sits beside `candidates` because the two differ, and the gap is the
 * honest measure of what was examined: a recorded instantiation is only an
 * upgrade target if today's source can be applied to it (a test pattern and a
 * keyless session pointer are neither). Stating only `candidates` would
 * overstate what a green run bought.
 */
export function reportReplaySummary(
  counts: {
    replayed: number;
    candidates: number;
    targets: number;
    changed: number;
    updated: number;
    servedRoute: number;
  },
): string {
  // Served routes are PRINTED, not merely counted. They are targets the run
  // deliberately did not identity-compare, so a summary that omitted them
  // described more coverage than the run bought — and the count existed for
  // exactly that reason while nothing displayed it.
  const served = counts.servedRoute > 0
    ? ` ${counts.servedRoute} target(s) were served routes and not ` +
      `identity-compared.`
    : "";
  return `Replayed ${counts.replayed} vintage(s): ${counts.candidates} ` +
    `recorded instantiation(s), all mappable to a file; ${counts.targets} ` +
    `upgrade target(s), ${counts.changed} changed since capture, ` +
    `${counts.updated} updated cleanly with no state stranded.${served}`;
}

/**
 * What `--update` prints when it was given no test to capture.
 *
 * There is deliberately no default set. A capture RUNS the named key as a
 * test, and the only moment a default would help is when a fixture is missing
 * — precisely when nothing on disk can say which test covers the pattern,
 * because a test need not be named after what it drives. A hand-kept list
 * looked like an answer and was a seam: the required PATTERNS derive from the
 * runtime's URL constants, so adding one that no listed test instantiates left
 * the gate red while this command reported everything fine and exited 0.
 */
export function reportUpdateNeedsATestKey(): string {
  return [
    "`--update` needs the TEST to capture, and was given none.",
    "",
    "  deno task pattern-vintage --update <test path>",
    "",
    "e.g. `--update topics/topics.test.tsx`. It is a test path, not a pattern",
    "path: a fixture is produced by RUNNING a test, and covers whatever that",
    "test instantiates — routinely several patterns, none of which need share",
    "its name.",
    "",
    `Every fixture already under ${VINTAGES_DIR}/ is replayed by`,
    "`deno task pattern-vintage` with no list anywhere, so a captured fixture",
    "is covered from the moment it is committed.",
  ].join("\n");
}

/** What the gate prints when it found no fixture to replay at all. */
export function reportNothingReplayed(): string {
  return [
    "Replayed 0 vintages — this gate covered NOTHING.",
    "",
    "A run that replays nothing proves nothing, so it is a failure rather than",
    "a pass. Either the fixture tree is missing (a bad checkout, or a path that",
    "moved without this task moving with it) or every file under it was",
    "declined as not a fixture. Capture one by naming the TEST that writes",
    "the state — a test path, not a pattern path, because a fixture is produced",
    "by RUNNING a test:",
    "",
    "  deno task pattern-vintage --update <test path>",
    "",
    "e.g. `--update system/home.test.tsx`. Bare `--update` captures nothing:",
    "there is no default set, because the one case a default would serve is a",
    "MISSING fixture, and nothing on disk knows which test covers a pattern",
    "whose fixture is gone.",
  ].join("\n");
}

/** What the gate prints when it cannot tell which patterns it must cover. */
export function reportUnmappedUrls(unmapped: readonly string[]): string {
  return [
    `${unmapped.length} system pattern URL(s) no longer name a pattern:`,
    "",
    ...unmapped.map((url) => `  ${url}`),
    "",
    "The required set is derived from these so the gate cannot drift from what",
    "actually auto-updates. A URL that no longer contains `/patterns/` derives",
    "nothing, which would leave the gate requiring nothing at all — so it stops",
    "here instead. Teach `requiredPatternKeys` the new route shape.",
  ].join("\n");
}

/**
 * What the gate prints when the process is about to end without a verdict.
 *
 * Measured, twice: a pattern that fails to compile and a truncated fixture BOTH
 * reject a promise nobody awaits while `harness.resolve()`'s own promise never
 * settles. `main` never reaches its verdict, the event loop drains, and the
 * process exits 0 having replayed nothing and printed nothing. A gate that goes
 * green because the thing it gates is too broken to test is worse than no gate,
 * so reaching a verdict is itself part of passing.
 */
export function reportNoVerdict(reason?: unknown): string {
  return [
    "The vintage gate ended without reaching a verdict.",
    "",
    "Something the replay awaited never settled — a pattern that does not",
    "compile and a corrupt fixture both do this, because the failure surfaces",
    "as an unhandled rejection while the promise stays pending forever. The",
    "gate proved nothing, so it fails.",
    "",
    reason === undefined
      ? "  (no rejection was observed; look for an unresolved await)"
      : `  last unhandled rejection: ${describeError(reason)}`,
  ].join("\n");
}

/**
 * Make "ended without a verdict" fail instead of pass.
 *
 * `beforeunload` fires when the event loop is about to drain, which is the last
 * moment at which a run that never finished is still distinguishable from one
 * that did. The caller's clean path exits explicitly, so anything that reaches
 * this listener did not get there.
 *
 * Takes its `target` and `exit` rather than reaching for `globalThis` and
 * `Deno.exit`, so the wiring itself is testable — the guard is the one piece of
 * this gate whose failure mode is silence, and an untested guard against
 * silence is a comment.
 */
export function armVerdictGuard(
  target: EventTarget,
  exit: (code: number) => void,
  log: (message: string) => void = console.error,
): void {
  let lastRejection: unknown;
  target.addEventListener("unhandledrejection", (event) => {
    lastRejection = (event as { reason?: unknown }).reason;
  });
  target.addEventListener("beforeunload", () => {
    log(reportNoVerdict(lastRejection));
    exit(1);
  });
}

/**
 * Whether the run passes. Split out so the exit condition is stated once and
 * tested, rather than being an `if` at the bottom of `main` that a later edit
 * can quietly invert — a gate that exits 0 on failure is worse than no gate.
 *
 * `counts.candidates` and `counts.targets` are the soundness floor, NOT the
 * number updated. A run where no pattern changed legitimately updates nothing,
 * which is the common case and the same condition the auto-updater fires on. A
 * run with no CANDIDATES examined no update targets at all — the shape that has
 * read as success three separate times in this tier's history. `targets` is the
 * same floor one step further in: recorded instantiations that today's source
 * cannot be applied to (a test pattern, a keyless session pointer) are not
 * coverage, so a run whose every candidate was one of those applied nothing
 * either, and must not read as a pass.
 *
 * `replayed` is part of the condition and not just a number to print: zero
 * replays is the shape a broken gate takes, not the shape a clean tree takes.
 */
export function isClean(
  failures: readonly ReplayFailure[],
  uncovered: readonly string[],
  counts: { replayed: number; candidates: number; targets: number },
): boolean {
  return failures.length === 0 && uncovered.length === 0 &&
    counts.replayed > 0 && counts.candidates > 0 && counts.targets > 0;
}

/**
 * Whether a recorded instantiation is a transformer-emitted pattern hoist —
 * an anonymous sub-pattern the compiler derives from the source (a mapped
 * row's body), as opposed to a pattern an author exports. The `__cfPattern_N`
 * name is the transformer's own emission convention, and N is a builder node
 * id with no stability across edits — which is exactly why nothing durable
 * may be addressed by it. The per-file counter starts at 1, so
 * `__cfPattern_0` is not a name the transformer mints.
 *
 * Spelling IS provenance, because registration enforces it: the runner
 * refuses an authored builder-artifact export in this namespace
 * (`RESERVED_HOIST_EXPORT`, `pattern-manager.ts`), and every path that runs
 * a pattern — the runtime's, and this gate's own capture and replay
 * compiles — goes through that seam. A symbol with this shape in a manifest
 * or the artifact index is the transformer's.
 */
export function isDerivedHoistSymbol(symbol: string): boolean {
  return /^__cfPattern_[1-9]\d*$/.test(symbol);
}

/**
 * Whether a materialization error is setup refusing the STORED ARGUMENT
 * against the candidate schema — the classification the runner exports a
 * constant for, tolerated here in both the Error and the stringified form a
 * replay outcome may carry.
 */
export function isStoredArgumentRefusal(error: unknown): boolean {
  if (isStoredArgumentSchemaRefusal(error)) return true;
  return typeof error === "string" &&
    error.startsWith(`${STORED_ARGUMENT_SCHEMA_REFUSAL}:`);
}

/**
 * Which hold-back rule covers a refused update, or `undefined` when none
 * does and the refusal must fail the run.
 *
 * The whole partition in one place, and the returned string is the reason
 * the report prints beside the target: a refusal is held back only for a
 * DERIVED hoist, and only in the two shapes that are supersession rather
 * than loss — captures the re-run derivation re-supplies, and a hoist
 * today's source no longer emits under the recorded (renumbered) id.
 * Anything else about a hoist, and everything about an authored artifact,
 * is the caller's failure to report.
 *
 * `missingArtifact` is passed as the materializer's own verdict rather than
 * read out of `error`, whose text is arbitrary propagated prose.
 */
export function hoistSupersessionReason(
  symbol: string,
  error: unknown,
  missingArtifact: boolean,
): string | undefined {
  if (!isDerivedHoistSymbol(symbol)) return undefined;
  if (isStoredArgumentRefusal(error)) return "stored arguments superseded";
  if (missingArtifact) return "hoist no longer emitted";
  return undefined;
}
