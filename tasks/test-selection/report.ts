/**
 * What a run on the default branch found that the pull request behind it
 * could not have found for itself.
 *
 * Selection means some regressions land and the run on the default
 * branch catches them. That trade is only acceptable if the change that
 * caused one finds out without anybody going looking, so this builds the
 * comment that tells it. Everything here is a pure function over three
 * runs' records — this one, the one before it on the default branch, and
 * the pull request's own — the manifest that pull request's run
 * resolved, and the coverage figures the two default-branch runs
 * measured. The gathering and the posting are in
 * `tasks/post-main-report.ts`.
 *
 * Five properties keep this on the right side of the dashboard's rule
 * that reporting is about the system and never about individuals, and
 * each is a constraint on what is written here rather than an
 * observation about it. The comment's subject is a commit and a test,
 * and no author is named. Nothing is counted per author, per team, or
 * per anything, and no history is kept anywhere. A test the selector
 * declined to run is described as coverage this design traded away,
 * because the author did not miss it. A test the store has seen
 * disagreeing with itself is labelled as one, with the evidence
 * behind the label. And every note says what to do, in a comment that
 * is edited in place rather than repeated.
 */

import {
  ALIAS_DIRECTORY,
  type CoverageFigures,
  type FlakeEvidence,
  type TestIdentity,
  testIdentityKey,
  testIdentityOfKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { isLaneMeasurement } from "../lane-measurement.ts";
import type { WithheldReason } from "./manifest.ts";
import {
  COVERAGE_COMMENT_LINES,
  EXCLUDED_FROM_COVERAGE_GATE,
  FLAKE_WINDOW_DAYS,
  LOCAL_COVERAGE_MAX_SETS,
  RENAME_MARGIN,
  RENAME_SIMILARITY,
  RENAME_SUGGESTIONS,
} from "./policy.ts";

/**
 * The hidden marker that makes the comment findable, so a second run
 * edits the first run's comment rather than adding another one.
 */
export const MAIN_REPORT_MARKER = "<!-- main-run-report -->";

/**
 * What one identity did across a whole run. A run holds several records
 * for one identity whenever a lane repeats it, whenever it is sharded,
 * and whenever an attempt is re-run, so the outcome of a run is a fold
 * of those rather than any one of them. `mixed` is the test disagreeing
 * with itself at one commit, which is the same judgement the scorer
 * makes and the only evidence of a flake a single run can hold.
 */
export type Verdict = "pass" | "fail" | "mixed" | "skip";

/** What every identity in one run did, by its canonical key. */
export type RunOutcomes = ReadonlyMap<string, Verdict>;

/**
 * Folds a run's records into one verdict per identity, leaving out the
 * lane's measurements of itself.
 *
 * A lane writes what its setup and each of its batches cost through the
 * record machinery every test uses, and a batch that ended badly is
 * written as a failure. Those are not tests, and what this feeds is a
 * comment about tests.
 */
export function outcomesOf(
  records: Iterable<TestRecord>,
): Map<string, Verdict> {
  const seen = new Map<string, { pass: boolean; fail: boolean }>();
  for (const record of records) {
    if (isLaneMeasurement(record.test)) continue;
    const key = testIdentityKey(record.test);
    const already = seen.get(key) ?? { pass: false, fail: false };
    if (record.outcome === "pass") already.pass = true;
    if (record.outcome === "fail") already.fail = true;
    seen.set(key, already);
  }
  const outcomes = new Map<string, Verdict>();
  for (const [key, { pass, fail }] of seen) {
    outcomes.set(
      key,
      pass && fail ? "mixed" : fail ? "fail" : pass ? "pass" : "skip",
    );
  }
  return outcomes;
}

/**
 * What the pull request's own run did, and what the store knew when it
 * ran.
 *
 * Both halves are needed and neither stands in for the other. Its
 * records say whether it ran a test, which is the only thing that
 * settles the question; the manifest says why it did not, which is the
 * part only this system can answer.
 */
export interface PullRequestView {
  /**
   * What its run recorded, absent when that run could not be read. A
   * missing run is said to be missing rather than read as a run that
   * skipped everything.
   */
  ran?: RunOutcomes;

  /** Whether a manifest was resolved for it at all. */
  manifest: boolean;

  /** The identities the packing over that manifest reached. */
  selected: ReadonlySet<string>;

  /** The identities that manifest held back, against the reason. */
  withheld: ReadonlyMap<string, WithheldReason>;

  /**
   * How often the store saw each identity disagree with itself, and over
   * how many runs. Every identity the manifest holds is a key here, so
   * membership is also the answer to whether the store has ever seen a
   * test; the value is absent for a manifest written before the counts
   * were published.
   */
  flakes: ReadonlyMap<string, FlakeEvidence | undefined>;

  /** The weighted catches behind each identity the store knows. */
  catches: ReadonlyMap<string, number>;

  /**
   * The invocation unit each identity the store knows lives in, as
   * `"<suite>\t<unit>"`. What it answers is whether a unit ran at all:
   * records exist only for tests that ran, so a test missing from a run
   * whose unit produced no records at all is a test nothing judged
   * rather than a test that left.
   */
  units: ReadonlyMap<string, string>;
}

/** A view saying that neither half could be read. */
export function unknownPullRequest(): PullRequestView {
  return {
    manifest: false,
    selected: new Set(),
    withheld: new Map(),
    flakes: new Map(),
    catches: new Map(),
    units: new Map(),
  };
}

/** What the pull request's own run did about one test. */
export type Selection =
  | "passed-there"
  | "failed-there"
  | "skipped-there"
  | "withheld-flaky"
  | "not-selected"
  | "unrecorded"
  | "did-not-run"
  | "unknown";

/**
 * What the pull request's own run did, where that leaves something for
 * this comment to say. A test its run failed too is one its run found,
 * so nothing about it belongs in a comment about what a later run found
 * that it could not have.
 */
export type ReportedSelection = Exclude<Selection, "failed-there">;

/** A test that passed in the previous run and failed in this one. */
export interface FirstFailure {
  test: TestIdentity;
  selection: ReportedSelection;

  /**
   * Present when the store has seen the test disagree with itself, with
   * the runs it saw that among. A reader weighs the two: one in five is
   * not the claim one in five thousand is.
   */
  flakes?: FlakeEvidence;
}

/** A rise in the repository's whole uncovered-line count. */
export interface CoverageRise {
  from: number;
  to: number;

  /**
   * The source groups the change touched that rose as well, which is as
   * near as this gets to saying where a test would go.
   */
  groups: Array<{ group: string; from: number; to: number }>;
}

/** Which route let a measured set's rise reach the default branch. */
export type MeasuredSetRoute =
  | "excluded"
  | "over-the-cap"
  | "elsewhere"
  | "gated";

/** A rise in one measured set's number. */
export interface MeasuredSetRise {
  /** The suite and the member the set pairs, as one name. */
  set: string;

  /** The workspace member whose lines rose. */
  member: string;

  from: number;
  to: number;
  route: MeasuredSetRoute;

  /** Present for `excluded`: the reason the exclusion list gives. */
  reason?: string;

  /** Present for `over-the-cap`: how many measured sets were reached. */
  touched?: number;
}

/** A test this change added which has already disagreed with itself. */
export interface FlakyNewTest {
  test: TestIdentity;
}

/** A rename that left a test's history behind, and the line that bridges it. */
export interface RenameSuggestion {
  from: TestIdentity;
  to: TestIdentity;

  /** The weighted catches the bridge would bring back. */
  catches: number;

  /** The line to append to the alias file, exactly as it must be written. */
  aliasLine: string;
}

/** Everything one run on the default branch has to tell one pull request. */
export interface Report {
  firstFailures: FirstFailure[];
  coverageRise?: CoverageRise;
  measuredSetRises: MeasuredSetRise[];
  flakyNewTests: FlakyNewTest[];
  renames: RenameSuggestion[];
}

/** Whether a report holds anything at all worth saying. */
export function reportIsEmpty(report: Report): boolean {
  return report.firstFailures.length === 0 &&
    report.coverageRise === undefined &&
    report.measuredSetRises.length === 0 &&
    report.flakyNewTests.length === 0 &&
    report.renames.length === 0;
}

/** What the reporter learned about one run, and what it is comparing to. */
export interface ReportInput {
  /** What this run's records said. */
  current: RunOutcomes;

  /**
   * What the previous run on the default branch said. It has to be a run
   * that finished, because a run still uploading is a run that has not
   * judged everything it is going to.
   */
  previous: RunOutcomes;

  /** What the pull request behind this commit did, and what it knew. */
  pullRequest: PullRequestView;

  /** Every coverage figure this run measured. */
  coverage: CoverageFigures;

  /** The same figures from the previous run on the default branch. */
  coverageBefore: CoverageFigures;

  /** The source groups this change touched. */
  touched: ReadonlySet<string>;

  /**
   * The measured sets the change reached, and whether the coverage gate
   * ran over them. Worked out from the declarations by the same function
   * the gate runs, so the note and the gate cannot come to different
   * answers about which sets were gated.
   */
  coverageGate: { reached: readonly string[]; ran: boolean };

  /** The day the comment is written, which dates an alias line. */
  day: string;
}

/** The identity a canonical key names, for keys this module produced. */
function identityOf(key: string): TestIdentity {
  const test = testIdentityOfKey(key);
  if (test === undefined) {
    throw new Error(`not a test identity key: ${key}`);
  }
  return test;
}

/**
 * How the pull request stood towards one test.
 *
 * Its own records decide first, because whether it ran a test is a fact
 * about what it did rather than a projection of what it would have done.
 * The manifest only says why it did not.
 */
export function selectionOf(
  view: PullRequestView,
  key: string,
): Selection {
  if (view.ran === undefined) return "unknown";
  const there = view.ran.get(key);
  if (there === "pass") return "passed-there";
  if (there === "fail" || there === "mixed") return "failed-there";
  // A skip and no record at all ask the same question — why did this run
  // not judge it — and part company at the end: a skip is a run that
  // reached the test and passed over it, and no record is a run that did
  // not say either way.
  const withheld = view.withheld.get(key);
  if (withheld === "flaky") return "withheld-flaky";
  // With a manifest, the packing says whether the test was to have run:
  // an identity the packing reached, and one the store has never seen,
  // are both identities that run.
  if (view.manifest && view.flakes.has(key) && !view.selected.has(key)) {
    return "not-selected";
  }
  if (there === "skip") return "skipped-there";
  return view.manifest ? "unrecorded" : "did-not-run";
}

/**
 * The tests that failed for the first time at this commit: each passed in
 * the previous run on the default branch and failed in this one.
 *
 * The comparison is what stops the comment landing on whoever merged
 * next after somebody else broke something. A test that was already
 * failing produces nothing here, however long it has been failing, and a
 * test the previous run never judged produces nothing either.
 *
 * A test that both passed and failed in this run produces nothing
 * either. That is the test disagreeing with itself at one commit, which
 * is what the scorer calls flake evidence rather than a catch, and
 * calling it a first failure would say the change broke something that
 * broke on its own.
 *
 * Nor does a test the pull request's own run failed. This comment
 * carries what a later run found that the pull request's run could not
 * have found for itself, and a failure it reported is not that.
 */
export function firstFailures(input: ReportInput): FirstFailure[] {
  const failures: FirstFailure[] = [];
  for (const [key, verdict] of input.current) {
    if (verdict !== "fail") continue;
    if (input.previous.get(key) !== "pass") continue;
    const selection = selectionOf(input.pullRequest, key);
    if (selection === "failed-there") continue;
    const flakes = input.pullRequest.flakes.get(key);
    failures.push({
      test: identityOf(key),
      selection,
      ...(flakes === undefined || flakes.flakes === 0 ? {} : { flakes }),
    });
  }
  return failures.sort(byIdentity);
}

function byIdentity(
  a: { test: TestIdentity },
  b: { test: TestIdentity },
): number {
  const left = testIdentityKey(a.test);
  const right = testIdentityKey(b.test);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The rise in the repository's whole uncovered-line count, when there is
 * one worth mentioning.
 *
 * Never a failure, because the run is green and a red default branch for
 * one uncovered line would make its color mean nothing. And never for
 * one line: `COVERAGE_COMMENT_LINES` is what a change has to add before
 * the comment mentions it at all.
 *
 * A change that touched no source at all is not asked about. The
 * repository-wide figure moves a little between runs on its own, so a
 * documentation or workflow change would otherwise be told about a rise
 * it could not have caused. Nor is a pair of runs only one of which found
 * the compile cache cold: a cold run reaches compile branches a warm one
 * does not, so its count sits lower with nothing about the tests changed.
 */
export function coverageRise(input: ReportInput): CoverageRise | undefined {
  if (input.touched.size === 0) return undefined;
  if (input.coverageBefore.cold !== input.coverage.cold) return undefined;
  const wasBy = input.coverageBefore.groups;
  const isBy = input.coverage.groups;
  const before = wasBy.get("workspace");
  const after = isBy.get("workspace");
  if (before === undefined || after === undefined) return undefined;
  if (after - before < COVERAGE_COMMENT_LINES) return undefined;
  const groups: CoverageRise["groups"] = [];
  for (const group of [...input.touched].sort()) {
    const was = wasBy.get(group);
    const is = isBy.get(group);
    if (was === undefined || is === undefined || is <= was) continue;
    groups.push({ group, from: was, to: is });
  }
  return { from: before, to: after, groups };
}

/**
 * Each measured set whose number rose, and what let the rise past the
 * coverage gate.
 *
 * Three of the four are the ways a rise reaches the default branch with
 * the gate never having had an opinion, and they call for different
 * things: nothing, a look at the exclusion list, and a look at the
 * change respectively. The fourth is the state where the gate did
 * measure the set and passed it, which means the two measurements
 * disagree and is worth saying plainly rather than describing as one of
 * the other three.
 */
export function measuredSetRises(input: ReportInput): MeasuredSetRise[] {
  // A change that touched no source at all could not have moved which
  // lines any set's tests reach, and the figures move a little between
  // runs on their own.
  if (input.touched.size === 0) return [];
  const before = input.coverageBefore.sets;
  const after = input.coverage.sets;
  const { reached, ran } = input.coverageGate;
  const rises: MeasuredSetRise[] = [];
  for (const [set, lines] of after) {
    const was = before.get(set);
    if (was === undefined || lines <= was) continue;
    const member = set.slice(set.indexOf("/") + 1);
    // The exclusion list is asked first, because a member on it carries
    // no set the gate would have measured whatever else was reached.
    const excluded = EXCLUDED_FROM_COVERAGE_GATE.get(member);
    const rise: MeasuredSetRise = {
      set,
      member,
      from: was,
      to: lines,
      route: excluded !== undefined
        ? "excluded"
        : !ran && reached.length > 0
        ? "over-the-cap"
        : ran && reached.includes(set)
        ? "gated"
        : "elsewhere",
    };
    if (rise.route === "over-the-cap") rise.touched = reached.length;
    if (rise.route === "excluded") rise.reason = excluded;
    rises.push(rise);
  }
  return rises.sort((a, b) => a.set < b.set ? -1 : 1);
}

/**
 * Tests this change added which have already disagreed with themselves.
 *
 * A test counts as added by this change when this run ran it, the
 * previous run on the default branch did not, and the store has never
 * seen it. That third condition is what stops a run that shipped only
 * part of its records from making every test in the missing part look
 * new: a test the store already knows is a test that has run before,
 * whatever the previous run managed to upload.
 *
 * The evidence that it is flaky is a pass and a failure at this one
 * commit, across the repeats a lane runs, across shards, and across
 * attempts.
 */
export function flakyNewTests(input: ReportInput): FlakyNewTest[] {
  const flaky: FlakyNewTest[] = [];
  if (!input.pullRequest.manifest) return flaky;
  for (const [key, verdict] of input.current) {
    if (verdict !== "mixed") continue;
    if (input.previous.has(key)) continue;
    if (input.pullRequest.flakes.has(key)) continue;
    flaky.push({ test: identityOf(key) });
  }
  return flaky.sort(byIdentity);
}

/**
 * The groups a test name is nested under, and the part that is the test's
 * own: everything before and after the last separator its runner writes
 * between them.
 */
export function partsOf(name: string): { chain: string; leaf: string } {
  const at = name.lastIndexOf(" > ");
  return at < 0
    ? { chain: "", leaf: name }
    : { chain: name.slice(0, at), leaf: name.slice(at + 3) };
}

/**
 * How alike two names are, between zero and one.
 *
 * The two parts of a name are compared separately and the lower answer
 * is the one taken, because either part alone answers a different
 * question. Two tests under one group share the whole chain, so a
 * comparison over the whole name says how deep the nesting is. Two tests
 * under different groups routinely share a leaf — "returns undefined"
 * sits under dozens of them — so a comparison over the leaf alone calls
 * every pair of those a rename.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = partsOf(left);
  const b = partsOf(right);
  return Math.min(
    subsequenceShare(a.chain, b.chain),
    subsequenceShare(a.leaf, b.leaf),
  );
}

function subsequenceShare(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  // The classic subsequence table, one row at a time: the names are test
  // names rather than files, so the table is small.
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    const row = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j++) {
      row[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(row[j - 1]!, previous[j]!);
    }
    previous = row;
  }
  return previous[right.length]! / longest;
}

/**
 * The renames that discarded history, each with the line that brings it
 * back and the catches that line is worth.
 *
 * A rename is never inferred into the alias file: this suggests a line
 * and says what it would restore, and somebody appends it. Three things
 * have to hold before one is offered, because a wrong bridge silently
 * credits one test with another's record and the whole score rests on
 * catch attribution. The departing test must have caught something, or
 * there is nothing to bring back. The arriving name must be one the
 * store has never seen, or it is not a new name at all. And the pairing
 * must be clear: alike past `RENAME_SIMILARITY`, and ahead of every
 * other candidate by `RENAME_MARGIN`, because two candidates the same
 * distance away is a question rather than an answer, and an arrival two
 * departures both point at answers for neither. And the unit the
 * departing test lived in has to have run here, or its absence is a
 * suite that did not run rather than a test that left.
 *
 * At most `RENAME_SUGGESTIONS` are offered. A change that ends a whole
 * area produces as many departures as it removed tests, and a wall of
 * suggestions is one nobody reads.
 */
export function renames(input: ReportInput): RenameSuggestion[] {
  const ranHere = unitsThatRan(input);
  const gone = [...input.previous.keys()].filter((key) =>
    !input.current.has(key) && (input.pullRequest.catches.get(key) ?? 0) > 0 &&
    ranHere.has(input.pullRequest.units.get(key) ?? "")
  );
  const arrived = [...input.current.keys()].filter((key) =>
    !input.previous.has(key) && !input.pullRequest.flakes.has(key)
  );
  const suggestions: RenameSuggestion[] = [];
  for (const key of gone) {
    const from = identityOf(key);
    let best: { test: TestIdentity; score: number } | undefined;
    let runnerUp = 0;
    for (const candidate of arrived) {
      const to = identityOf(candidate);
      if (to.k !== from.k || to.s !== from.s || to.v !== from.v) continue;
      const score = nameSimilarity(from.n, to.n);
      if (best === undefined || score > best.score) {
        runnerUp = best?.score ?? runnerUp;
        best = { test: to, score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (best === undefined || best.score < RENAME_SIMILARITY) continue;
    if (best.score - runnerUp < RENAME_MARGIN) continue;
    suggestions.push({
      from,
      to: best.test,
      catches: input.pullRequest.catches.get(key)!,
      aliasLine: aliasLineFor(from, best.test, input.day),
    });
  }
  // An arrival two departures both point at answers for neither of them.
  // Appending both lines would credit one test with two tests' records,
  // which is the whole of what these guards are for.
  const claims = new Map<string, number>();
  for (const suggestion of suggestions) {
    const to = testIdentityKey(suggestion.to);
    claims.set(to, (claims.get(to) ?? 0) + 1);
  }
  return suggestions
    .filter((suggestion) => claims.get(testIdentityKey(suggestion.to)) === 1)
    .sort((a, b) => byIdentity({ test: a.from }, { test: b.from }))
    .slice(0, RENAME_SUGGESTIONS);
}

/**
 * The invocation units this run produced records for.
 *
 * A test with no record in a run either did not run or does not exist,
 * and only the first is worth saying nothing about. A unit that produced
 * a record for any of the tests in it ran, so a test of that unit with
 * no record is one the tree no longer holds.
 */
function unitsThatRan(input: ReportInput): Set<string> {
  const ran = new Set<string>();
  for (const key of input.current.keys()) {
    const unit = input.pullRequest.units.get(key);
    if (unit !== undefined) ran.add(unit);
  }
  return ran;
}

/**
 * One line of the alias file, ready to append. The key order is the
 * order the file is written in, so a suggested line and a hand-written
 * one look the same.
 */
export function aliasLineFor(
  from: TestIdentity,
  to: TestIdentity,
  day: string,
): string {
  return JSON.stringify({
    date: day,
    from: { k: from.k, s: from.s, n: from.n },
    to: { k: to.k, s: to.s, n: to.n },
  });
}

/** Everything one run has to say to the pull request behind its commit. */
export function buildReport(input: ReportInput): Report {
  const rise = coverageRise(input);
  return {
    firstFailures: firstFailures(input),
    ...(rise === undefined ? {} : { coverageRise: rise }),
    measuredSetRises: measuredSetRises(input),
    flakyNewTests: flakyNewTests(input),
    renames: renames(input),
  };
}

/**
 * A test identity as the comment writes it.
 *
 * A test name is repository content reaching a comment posted with a
 * write token. A code span cannot cross a line break and is closed by a
 * run of backticks as long as the one that opened it, so the name is put
 * on one line and fenced by more backticks than it holds. Without both,
 * the rest of a name renders as Markdown in a comment nobody wrote.
 */
export function shownIdentity(test: TestIdentity): string {
  const text = oneLine(
    `[${test.k}] ${test.s}: ${test.n}` +
      (test.v === undefined ? "" : ` (${test.v})`),
  );
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** One line of a name, with every control character made a space. */
function oneLine(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

/** What the comment says about what the pull request's own run did. */
const SELECTION_PROSE: Record<ReportedSelection, string> = {
  "passed-there": "This pull request ran it, and it passed there. So this " +
    "is either a flake or an interaction with another change, and it is " +
    "worth looking at before assuming this change caused it.",
  "skipped-there": "This pull request's own run reached it and skipped " +
    "it, and no manifest says selection is why, so the test skips itself " +
    "under some condition that held there and not here.",
  "not-selected": "This pull request did not run it. Test selection traded " +
    "that coverage away deliberately: the test was not worth its time " +
    "against the budget, so nothing here was missed. This failure raises " +
    "its score, so the next change in this area will run it.",
  "withheld-flaky": "This pull request could not have run it: the store " +
    "holds it back as too flaky to judge a change by. It runs on the " +
    "default branch anyway, where no execution of it passed at this " +
    "commit and none failed in the previous run. What the store counts " +
    "as a flake is a test passing and failing at one commit, which is " +
    "not what either of those two runs saw. A failure of it does not " +
    "fail the run on that branch, so nothing is red for this.",
  unrecorded: "This pull request's own run was to have run it and " +
    "recorded nothing for it, so what it did there is not known. A test " +
    "job that fails before it uploads leaves its share of a run's records " +
    "behind like this.",
  "did-not-run": "This pull request did not run it, and there is no " +
    "manifest to say why.",
  unknown: "The pull request's own run could not be read, so there is " +
    "nothing to say about whether it ran this test.",
};

/** What the comment says about each route past the coverage gate. */
const ROUTE_PROSE: Record<MeasuredSetRoute, string> = {
  excluded: "The member is on `EXCLUDED_FROM_COVERAGE_GATE`, so it carries " +
    "no measured set and nothing gates it. The exclusion list is what to " +
    "look at.",
  "over-the-cap": "The change reached more measured sets than " +
    `\`LOCAL_COVERAGE_MAX_SETS\` (${LOCAL_COVERAGE_MAX_SETS}) ` +
    "allows, so the coverage gate did not run at all. There is nothing " +
    "to do about the gate; the rise itself is the thing to look at.",
  elsewhere: "The change did not touch this member, so the gate had " +
    "nothing to compare and something elsewhere moved which lines this " +
    "set's tests reach. The change is what to look at.",
  gated: "The gate measured this set on the pull request and passed " +
    "it, so the two measurements disagree. That is worth looking at on " +
    "its own, before the rise.",
};

/**
 * The comment, or nothing when the run found nothing to say. Every note
 * ends in what to do about it, and the marker at the top is what makes
 * the next run edit this comment rather than add another.
 */
export function renderReport(
  report: Report,
  context: { commit: string; runUrl: string },
): string | undefined {
  if (reportIsEmpty(report)) return undefined;
  const out: string[] = [MAIN_REPORT_MARKER];
  out.push(
    `The run on the default branch at [\`${
      context.commit.slice(0, 12)
    }\`](${context.runUrl}) found this, which the run on this pull request ` +
      "could not have found for itself.",
  );

  if (report.firstFailures.length > 0) {
    out.push("");
    out.push("### Failing for the first time at this commit");
    out.push("");
    out.push(
      "Each of these passed in the previous run on the default branch and " +
        "failed in this one.",
    );
    for (const failure of report.firstFailures) {
      out.push("");
      out.push(`- ${shownIdentity(failure.test)}`);
      out.push(`  ${SELECTION_PROSE[failure.selection]}`);
      if (failure.flakes !== undefined) {
        const { flakes, runs } = failure.flakes;
        out.push(
          `  The store has seen this test disagree with itself ${
            flakes === 1 ? "once" : `${flakes} times`
          } in ${runs} ${runs === 1 ? "run" : "runs"} over the last ` +
            `${FLAKE_WINDOW_DAYS} days, so this failure may be its own ` +
            "and not the change's.",
        );
      }
    }
  }

  if (report.coverageRise !== undefined) {
    const { from, to, groups } = report.coverageRise;
    out.push("");
    out.push("### Coverage debt");
    out.push("");
    out.push(
      `The repository's uncovered-line count went from ${from} to ${to} ` +
        "between the run before this commit and the run at it, a rise of " +
        `${to - from}. Nothing failed for it and nothing will: the ` +
        "repository-wide number is a trend rather than a gate.",
    );
    out.push("");
    if (groups.length > 0) {
      out.push(
        "Of that, these source groups the change touched rose. A test over " +
          "them is what brings the number back down.",
      );
      out.push("");
      for (const group of groups) {
        out.push(
          `- \`${group.group}\`: ${group.from} to ${group.to}, ` +
            `a rise of ${group.to - group.from}`,
        );
      }
    } else {
      out.push(
        "None of it is in a source group the change touched, so the rise " +
          "is somewhere else in the repository.",
      );
    }
  }

  if (report.measuredSetRises.length > 0) {
    out.push("");
    out.push("### A measured set reaches less of its package than it did");
    out.push("");
    out.push(
      "The coverage gate exists to catch this before it lands. It did not, " +
        "and this is why.",
    );
    for (const rise of report.measuredSetRises) {
      out.push("");
      out.push(
        `- \`${rise.set}\`: ${rise.from} to ${rise.to} uncovered lines. ` +
          ROUTE_PROSE[rise.route],
      );
      if (rise.reason !== undefined) {
        out.push(`  The list gives the reason: ${rise.reason}`);
      }
      if (rise.touched !== undefined) {
        out.push(`  The change reached ${rise.touched} measured sets.`);
      }
    }
  }

  if (report.flakyNewTests.length > 0) {
    out.push("");
    out.push("### A new test that turned out to be flaky");
    out.push("");
    out.push(
      "This change added these, and they have already disagreed with " +
        "themselves. A test that does that is worth either fixing or " +
        "removing: while it stands, selection holds it back rather than " +
        "judging changes by it, so it protects nothing.",
    );
    for (const flaky of report.flakyNewTests) {
      out.push(`- ${shownIdentity(flaky.test)}`);
    }
  }

  if (report.renames.length > 0) {
    out.push("");
    out.push("### A rename that discarded a test's history");
    out.push("");
    out.push(
      "A test's score is built on what it has caught, over unbounded " +
        "history, so a renamed test drops to the floor. A line in " +
        `\`${ALIAS_DIRECTORY}/\`, in the file named after the test's file, ` +
        "bridges the two halves. A rename is never inferred, so this is a " +
        "suggestion rather than a change: append the line if the pairing " +
        "is right, and ignore it if it is not.",
    );
    for (const rename of report.renames) {
      out.push("");
      out.push(
        `- ${shownIdentity(rename.from)} appears to have become ` +
          `${shownIdentity(rename.to)}, which would bring back ` +
          `${rename.catches.toFixed(1)} weighted catches.`,
      );
      out.push("");
      out.push("  ```json");
      out.push(`  ${rename.aliasLine}`);
      out.push("  ```");
    }
  }

  return out.join("\n");
}

/**
 * What replaces a report that no longer holds. A re-run that clears
 * every note has to withdraw what the earlier attempt said, because a
 * comment nobody corrects is one people learn to distrust.
 */
export function renderWithdrawal(
  context: { commit: string; runUrl: string },
): string {
  return [
    MAIN_REPORT_MARKER,
    `The run on the default branch at [\`${
      context.commit.slice(0, 12)
    }\`](${context.runUrl}) found nothing to report about this change. ` +
    "Whatever an earlier attempt of it reported here no longer holds.",
  ].join("\n");
}
