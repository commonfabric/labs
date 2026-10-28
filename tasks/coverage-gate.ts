#!/usr/bin/env -S deno run -A

/**
 * The coverage gates, as the job that joins the lanes reaches them.
 *
 * A measured set is one suite's units over one workspace member's lines,
 * and its gate is a test the plan chooses by score. The lanes run every
 * unit of each set whose gate the plan chose, with coverage turned on, and
 * each writes one report per set. This adds those reports up per set,
 * scores each set over its member's own lines, and compares the count
 * against what the same set measured at the newest `main` commit the
 * branch contains, which the manifest carries; on the default branch, it
 * compares against what the parent commit's own run measured. A rise
 * fails the gate, unless the pull request's description accepts it.
 *
 * Which gates were chosen is worked out here by packing the plan the lanes
 * packed, from the same tree, the same manifest, and the lane count and
 * scale the job counting the lanes handed them, rather than read out of
 * what a lane reported. Two answers to that question would let a lane
 * talk this into judging something it did not measure, or into skipping
 * something it did.
 *
 * Every gate it judges is recorded as a test, so that the publisher scores
 * it like any other. A gate fails the run only where the change reaches its
 * set, so a run on the default branch records what its gates found and
 * fails for none of them.
 *
 * On a pull request it also writes the comment the pull request is left
 * with, which the Pull Request Comments workflow posts: a fork's pull
 * request gets a read-only token here, and cannot be commented on.
 *
 *   deno run -A tasks/coverage-gate.ts --base origin/main --scale 1 --of 5 \
 *     --reports artifacts [--comment coverage-comment.json --pr 123]
 *   deno run -A tasks/coverage-gate.ts --full --default-branch --of 30 \
 *     --reports artifacts
 */

import * as path from "@std/path";
import { walk } from "@std/fs/walk";
import { utf8Compare } from "@commonfabric/utils/utf8";
import {
  type CoverageFigures,
  type Environment,
  FragmentWriter,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  changedFiles,
  COVERAGE_FAILURE_MARKER,
  COVERAGE_REPORT_FILE,
  landedFiles,
  measuredSetOfReport,
  planOver,
  resolveManifest,
} from "./ci-lane.ts";
import {
  acceptedCoverageDebt,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
} from "./ci-check-lib.ts";
import { firstCoverageAt } from "./post-main-report.ts";
import { baselinesFrom } from "./test-selection/baselines.ts";
import { collectMeasuredSetDebt } from "./coverage-metrics.ts";
import { say } from "./step-summary.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";
import { loadTopology } from "./test-topology.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  coverageGateIdentity,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "./test-topology/coverage-gates.ts";
import type { CoverageGateSelection } from "./test-selection/coverage.ts";
import { fetchManifest, type ManifestFetch } from "./test-selection/store.ts";
import type { CoverageBaseline } from "./test-selection/manifest.ts";

/** What the command line asked for. */
export interface GateOptions {
  /**
   * What the change is measured against. Required on a pull request: with
   * no diff the change reaches no set and nothing fails, which reads
   * exactly like a change that touched nothing, so a workflow that lost the
   * flag would pass every pull request and say nothing.
   */
  base?: string;

  /**
   * Whether the run ran every test, which chooses every gate. The default
   * branch's run does, and so does a pull request that asks for it.
   */
  full: boolean;

  /**
   * What multiplies a budgeted run's tests chosen by score, as the job
   * counting the lanes decided. One where not given.
   */
  scale?: number;

  /**
   * How many lanes the run had, as the job counting them decided. Where
   * it is not given, the plan counts them itself, the same way.
   */
  of?: number;

  /**
   * Whether the run is the default branch's, which has no change for a
   * gate to fail and judges every gate for its record alone.
   */
  defaultBranch: boolean;

  /** Where the lanes' coverage reports were downloaded to. */
  reports: string;

  /** The pull request's description, which is where an acceptance is. */
  body: string;

  /**
   * Whether anything else in the run failed. Coverage measured through a
   * failing run says nothing about whether the change was tested, and the
   * run is already red, so the gate reports what the lanes measured rather
   * than adding a failure.
   */
  testsFailed: boolean;

  /**
   * Where to write the pull-request comment, and the pull request it is
   * for. Absent where there is no pull request to comment on.
   */
  comment?: { path: string; prNumber: number };

  root: string;
}

/** Reads the command line, or returns undefined for a malformed one. */
export function parseGateArgs(
  args: readonly string[],
  root: string = Deno.cwd(),
): GateOptions | undefined {
  const options: GateOptions = {
    full: false,
    defaultBranch: false,
    reports: "coverage-artifacts",
    body: "",
    testsFailed: false,
    root,
  };
  let commentPath: string | undefined;
  let prNumber: number | undefined;
  const rest = [...args];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    if (flag === "--tests-failed") {
      options.testsFailed = true;
      continue;
    }
    if (flag === "--full") {
      options.full = true;
      continue;
    }
    if (flag === "--default-branch") {
      options.defaultBranch = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--base":
        options.base = value;
        break;
      case "--reports":
        options.reports = value;
        break;
      case "--body":
        options.body = value;
        break;
      case "--comment":
        commentPath = value;
        break;
      case "--pr":
        if (!/^[1-9][0-9]*$/.test(value)) return undefined;
        prNumber = Number(value);
        break;
      case "--of":
        if (!/^[1-9][0-9]*$/.test(value)) return undefined;
        options.of = Number(value);
        break;
      case "--scale": {
        const scale = Number(value);
        if (value.trim() === "" || !Number.isFinite(scale) || scale < 0) {
          return undefined;
        }
        options.scale = scale;
        break;
      }
      default:
        return undefined;
    }
  }
  // A pull request names what its change is measured against, and the
  // default branch's run, which runs everything, names nothing. Either
  // other shape is a workflow that lost a flag.
  if (options.defaultBranch !== (options.base === undefined)) return undefined;
  if (options.defaultBranch && !options.full) return undefined;
  // A full run chooses nothing by score, so a scale beside it would be one
  // nothing honored.
  if (options.full && options.scale !== undefined) return undefined;
  if (commentPath === undefined && prNumber === undefined) return options;
  // A comment with no pull request has nowhere to go, and a pull request
  // with no comment file would be told nothing; either is a workflow that
  // lost a flag. The default branch has no pull request to comment on.
  if (commentPath === undefined || prNumber === undefined) return undefined;
  if (options.defaultBranch) return undefined;
  return { ...options, comment: { path: commentPath, prNumber } };
}

/**
 * The reports each measured set has, by the directory a lane wrote them
 * under, gathered from wherever the lanes' artifacts were unpacked.
 *
 * Choosing a set's gate places its units wherever they fit, so the packer
 * spreads them over as many lanes as it likes and each lane writes the
 * part it ran.
 * The set is what joins them again, which is why the report is named for
 * the set rather than for the lane.
 *
 * The key is the directory rather than the set the directory stands for.
 * The suite that wrote it is the one that names it, so a reader that
 * worked the set back out of the name would be a second answer to that
 * question, and the two could disagree.
 */
export async function collectSetReports(
  reportsDir: string,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  try {
    for await (
      const entry of walk(reportsDir, {
        includeDirs: false,
        exts: [".lcov"],
      })
    ) {
      if (path.basename(entry.path) !== COVERAGE_REPORT_FILE) continue;
      const name = measuredSetOfReport(entry.path);
      if (name === undefined) continue;
      found.set(name, [...found.get(name) ?? [], entry.path]);
    }
  } catch (error) {
    // Nothing was downloaded. Every set then has no report, which fails
    // each chosen gate, rather than an absent directory reading as a set
    // with no coverage.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found;
}

/**
 * The measured sets some lane marked as measured through a failing test,
 * by the directory a lane writes a set's report under.
 *
 * Walked for rather than looked for beside a report, because a lane
 * writes the marker whether or not it also wrote a report there: a lane
 * that ran a set's unit and saw it fail may have collected no profile
 * for it, and the set's number is short whichever lane's report it is
 * read from.
 */
export async function markedSets(reportsDir: string): Promise<Set<string>> {
  const marked = new Set<string>();
  try {
    for await (
      const entry of walk(reportsDir, { includeDirs: false, exts: [".txt"] })
    ) {
      if (path.basename(entry.path) !== COVERAGE_FAILURE_MARKER) continue;
      const set = measuredSetOfReport(entry.path);
      if (set !== undefined) marked.add(set);
    }
  } catch (error) {
    // Nothing was downloaded, which the caller reads the same way
    // `collectSetReports` does.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return marked;
}

/** What the gate decided about one measured set. */
export interface SetVerdict {
  /** The suite and member the set pairs, as one name. */
  set: string;

  /** The workspace member whose lines were counted. */
  member: string;

  /**
   * Whether its failure fails the run: the change reaches the set, and the
   * run is not excusing the gate as too flaky to judge a change by.
   */
  gating: boolean;

  /** What this run measured, absent where no report measured the set. */
  uncoveredLines?: number;

  /** The `main` run this is compared against. */
  baseline?: { commit: string; uncoveredLines: number };

  /** Lines the pull request's description accepts for this member. */
  accepted?: number;

  /**
   * How long reaching the verdict took, for a gate the plan chose. A gate
   * it did not choose reached none.
   */
  durationMs?: number;

  outcome:
    | "passed"
    | "rose"
    | "accepted"
    | "no-baseline"
    | "no-report"
    | "nothing-measured"
    | "not-scored"
    | "not-chosen";
}

/** What the gate came to over one change. */
export interface GateReport {
  verdicts: SetVerdict[];

  /** Acceptances naming something no gate in this repository measures. */
  unknownAcceptances: string[];

  /** Whether the pull request may proceed as far as coverage is concerned. */
  ok: boolean;
}

/**
 * The accepted names that are not a member some measured set scores, which
 * is the only thing an acceptance is read for.
 *
 * An acceptance naming anything else was written to have an effect and has
 * none, so it fails here rather than passing for one that worked. That
 * includes a workspace member no set scores, whose rise nothing gates.
 */
export function unknownAcceptances(
  accepted: ReadonlyMap<string, number>,
  measured: readonly string[],
): string[] {
  const known = new Set(measured);
  return [...accepted.keys()]
    .filter((name) => !known.has(name))
    .sort();
}

/** What the gate reads beyond the working tree. */
export interface GateInput {
  root: string;
  gate: CoverageGateSelection;

  /**
   * The gates the run excuses, by the key of their identity, whose failure
   * is recorded and fails nothing.
   */
  excused: ReadonlySet<string>;

  /** The reports the lanes wrote, by set name. */
  reports: ReadonlyMap<string, readonly string[]>;

  /** The sets some lane measured through a failing test, by set name. */
  marked: ReadonlySet<string>;

  members: readonly string[];

  /** The members some measured set scores, which an acceptance may name. */
  measured: readonly string[];

  baselines: readonly CoverageBaseline[];

  /** Which of these commits the tree under test holds most recently. */
  nearest: (commits: readonly string[]) => Promise<string | undefined>;

  /** Lines accepted, by the name the description gave. */
  accepted: ReadonlyMap<string, number>;

  testsFailed: boolean;

  /**
   * Whether the run is the default branch's, where nothing a gate finds
   * fails the run, a misnamed acceptance included.
   */
  defaultBranch: boolean;
}

/**
 * The baseline for one set measured at the newest default-branch commit
 * the tree under test contains.
 *
 * A baseline the branch does not contain measures a tree the branch does
 * not have, so a rise against it is not the branch's rise. Which of the
 * ones it does contain is newest is decided by their order in the
 * default branch's history, which is the order in which the trees they
 * measured came into being. When a run was created says something about
 * the machine that ran it, and a re-run of an older commit is what
 * separates the two.
 */
export async function nearestBaseline(
  baselines: readonly CoverageBaseline[],
  suite: string,
  member: string,
  nearest: (commits: readonly string[]) => Promise<string | undefined>,
): Promise<CoverageBaseline | undefined> {
  const mine = baselines
    .filter((base) => base.suite === suite && base.member === member);
  const commit = await nearest([...new Set(mine.map((base) => base.commit))]);
  return commit === undefined
    ? undefined
    : mine.find((base) => base.commit === commit);
}

/**
 * Reaches the verdict of every gate the plan chose, names every gate the
 * change reached that it did not, and says whether the change may proceed.
 *
 * A gate the plan did not choose forced nothing, so nothing measured its
 * set, and it is reported as such rather than failed.
 *
 * Four verdicts compare nothing. A set with no baseline is one nothing has
 * measured on `main` yet, and the first pull request to reach a new
 * package should not inherit the whole of that package's debt. A run with
 * a failing test measures coverage through that failure, and so does a
 * set a lane marked as measured through one it excused: either says
 * nothing about whether the change was tested. And a set no report
 * measured, or whose reports name no line of its member, has no count. A
 * lane that stopped before writing its report, an upload that carried
 * nothing, a download that found nothing, and a lane that wrote an empty
 * report all look the same from here.
 *
 * The last of those is the one that fails, where the gate is gating, along
 * with a rise: the plan chose the gate, so the change was made to measure
 * the set, and passing would pass a rise that nothing measured. An
 * acceptance naming something no gate in this repository measures fails
 * too, since it was written to have an effect and has none.
 */
export async function runGate(input: GateInput): Promise<GateReport> {
  const unknown = unknownAcceptances(input.accepted, input.measured);
  const chosen = new Set(input.gate.sets.map(measuredSetName));
  const reached = new Set(input.gate.reached.map(measuredSetName));
  const verdicts: SetVerdict[] = [];
  let ok = input.defaultBranch || unknown.length === 0;
  const judged = [
    ...input.gate.sets,
    ...input.gate.reached.filter((ref) => !chosen.has(measuredSetName(ref))),
  ].sort((a, b) => utf8Compare(measuredSetName(a), measuredSetName(b)));
  for (const ref of judged) {
    const set = measuredSetName(ref);
    const member = ref.set.member;
    const gating = !input.defaultBranch && reached.has(set) &&
      !input.excused.has(testIdentityKey(coverageGateIdentity(ref)));
    if (!chosen.has(set)) {
      verdicts.push({ set, member, gating, outcome: "not-chosen" });
      continue;
    }
    const started = performance.now();
    const verdict = await judge(input, ref, gating);
    verdicts.push({
      ...verdict,
      durationMs: Math.round(performance.now() - started),
    });
    if (gating && FAILING.has(verdict.outcome)) ok = false;
  }
  return { verdicts, unknownAcceptances: unknown, ok };
}

/** The outcomes that fail a gate that is gating. */
const FAILING: ReadonlySet<SetVerdict["outcome"]> = new Set([
  "rose",
  "no-report",
  "nothing-measured",
]);

/** Helper for `runGate()`, which reaches one chosen gate's verdict. */
async function judge(
  input: GateInput,
  ref: CoverageGateSelection["sets"][number],
  gating: boolean,
): Promise<SetVerdict> {
  const set = measuredSetName(ref);
  const member = ref.set.member;
  const accepted = input.accepted.get(member);
  const paths = input.reports.get(measuredSetDirectory(ref)) ?? [];
  const measured = paths.length === 0
    ? undefined
    : await collectMeasuredSetDebt({
      rootDir: input.root,
      lcov: (await Promise.all(
        paths.map((at) => Deno.readTextFile(at)),
      )).join("\n"),
      member,
      members: input.members,
    });
  // A set's tests always load some of their own member's source, so a
  // report naming no file of this member measured nothing, rather than
  // covering nothing. Like a missing report, it has no count to score.
  if (measured === undefined || measured.files === 0) {
    return {
      set,
      member,
      gating,
      outcome: measured === undefined ? "no-report" : "nothing-measured",
    };
  }
  const uncoveredLines = measured.uncoveredLines;
  if (input.testsFailed || input.marked.has(measuredSetDirectory(ref))) {
    return { set, member, gating, uncoveredLines, outcome: "not-scored" };
  }
  const base = await nearestBaseline(
    input.baselines,
    ref.suite,
    member,
    input.nearest,
  );
  if (base === undefined) {
    return { set, member, gating, uncoveredLines, outcome: "no-baseline" };
  }
  const baseline = {
    commit: base.commit,
    uncoveredLines: base.uncoveredLines,
  };
  const rise = uncoveredLines - base.uncoveredLines;
  if (rise <= 0) {
    return { set, member, gating, uncoveredLines, baseline, outcome: "passed" };
  }
  if (accepted !== undefined && rise <= accepted) {
    return {
      set,
      member,
      gating,
      uncoveredLines,
      baseline,
      accepted,
      outcome: "accepted",
    };
  }
  return {
    set,
    member,
    gating,
    uncoveredLines,
    baseline,
    ...(accepted === undefined ? {} : { accepted }),
    outcome: "rose",
  };
}

/**
 * The records the gates a report judged leave, one for each gate the plan
 * chose, under the identity `coverageGateIdentity()` gives its set.
 *
 * A rise no acceptance covers fails, and a set compared and found no higher
 * passes. Every other verdict is a skip. One that compared nothing says
 * nothing about whether the set rose, and a pass or a failure there would
 * score the gate for a measurement it did not make. An accepted rise is a
 * rise a person let through rather than a set that did not rise, and the
 * acceptance is usually written after a run that recorded the rise as a
 * failure and before a run of the same commit, so a pass for it would read
 * as the gate disagreeing with itself.
 */
export function gateRecords(
  suites: readonly Suite[],
  report: GateReport,
): TestRecord[] {
  const byName = new Map(
    measuredSets(suites).map((ref) => [measuredSetName(ref), ref]),
  );
  return report.verdicts.flatMap((verdict) => {
    const ref = byName.get(verdict.set);
    if (ref === undefined || verdict.durationMs === undefined) return [];
    return [{
      line: "record" as const,
      test: coverageGateIdentity(ref),
      outcome: verdict.outcome === "rose"
        ? "fail" as const
        : verdict.outcome === "passed"
        ? "pass" as const
        : "skip" as const,
      durationMs: verdict.durationMs,
    }];
  });
}

/**
 * Appends `records` to the spool `env` names. Nothing is written where it
 * names none, and a write that fails warns, as every producer's does, and
 * fails nothing.
 */
export function recordGates(
  records: readonly TestRecord[],
  env: Environment,
): void {
  if (records.length === 0) return;
  const writer = FragmentWriter.openForRun(env);
  if (writer === undefined) return;
  for (const record of records) writer.append(record);
  writer.close();
}

/** What each outcome means, in the words the summary uses. */
const OUTCOME_PROSE: Record<SetVerdict["outcome"], string> = {
  passed: "no rise",
  rose: "rose",
  accepted: "rose, accepted",
  "no-baseline": "no baseline on `main` yet, so nothing to compare",
  "no-report": "no lane reported one, so a rise cannot be ruled out",
  "nothing-measured": "the reports name no line of this member, so a " +
    "rise cannot be ruled out",
  "not-scored": "measured through a failing test, so this is not scored",
  "not-chosen": "the plan did not choose this gate, so nothing measured " +
    "the set",
};

/** The lines the job summary carries. */
export function formatGateReport(report: GateReport): string[] {
  return underHeading(gateFindings(report));
}

/**
 * Puts what the gate found under the heading that the job summary and the
 * comment both open with.
 */
function underHeading(findings: readonly string[]): string[] {
  return ["## Coverage gate", "", ...findings];
}

/** What the gate found, as the lines that go under its heading. */
function gateFindings(report: GateReport): string[] {
  const lines: string[] = [];
  if (report.unknownAcceptances.length > 0) {
    lines.push(
      "These acceptances name no workspace member a measured set scores, " +
        "so nothing would ever consult them:",
      "",
    );
    for (const name of report.unknownAcceptances) lines.push(`- \`${name}\``);
    lines.push("");
  }
  if (report.verdicts.length === 0) {
    lines.push(
      "This change reaches no measured set, and the plan chose no coverage " +
        "gate, so there is nothing to compare.",
    );
    return lines;
  }
  lines.push("| Measured set | Baseline | This run | Change | Outcome |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const verdict of report.verdicts) {
    const now = verdict.uncoveredLines;
    const was = verdict.baseline?.uncoveredLines;
    const change = now !== undefined && was !== undefined
      ? `${now - was >= 0 ? "+" : ""}${now - was}`
      : "";
    // A finding that would fail a gating gate is recorded alike by one that
    // is not gating, and says so, since the run stays green over it.
    const recordedOnly = !verdict.gating && FAILING.has(verdict.outcome)
      ? "; recorded, and fails nothing here"
      : "";
    lines.push(
      `| ${verdict.set} | ${was ?? ""} | ${now ?? ""} | ${change} | ` +
        `${OUTCOME_PROSE[verdict.outcome]}${recordedOnly} |`,
    );
  }
  const failing = report.verdicts.filter((verdict) =>
    verdict.gating && FAILING.has(verdict.outcome)
  );
  if (failing.some((verdict) => verdict.outcome !== "rose")) {
    lines.push("");
    lines.push(
      "The plan chose a gate whose set no lane's report measured, so the " +
        "gate fails without having measured it. A report that measures the " +
        "set has to reach the gate.",
    );
  }
  if (failing.some((verdict) => verdict.outcome === "rose")) {
    lines.push("");
    lines.push(
      "This is a coverage failure rather than a test failure. Write tests " +
        "that cover the new code. If some of it cannot be covered, also " +
        "write tests that cover other uncovered lines of the same package, " +
        "in the suite of each set that rose. Every line they cover lowers " +
        "that set's count, whether or not this change wrote it.",
    );
  }
  return lines;
}

/**
 * The comment a pull request is left with, given what the gate found.
 *
 * A gate that did not pass says what it found in full. One that passed says
 * so in a collapsed summary, which the poster only ever writes over an
 * earlier failure's comment, so that a failure the author was told about
 * does not stand once it is fixed.
 */
export function gateComment(
  prNumber: number,
  passed: boolean,
  findings: readonly string[],
): CoverageCommentPayload {
  if (!passed) {
    return {
      prNumber,
      state: "regressed",
      body: [COVERAGE_SUGGESTION_MARKER, ...underHeading(findings)].join("\n"),
    };
  }
  return {
    prNumber,
    state: "resolved",
    body: [
      COVERAGE_SUGGESTION_MARKER,
      "<details>",
      "<summary>The coverage gate in the <strong>Status</strong> job " +
      "passes.</summary>",
      "",
      ...findings,
      "",
      "</details>",
    ].join("\n"),
  };
}

/**
 * Which of a set of commits the tree under test holds most recently, or
 * nothing where it holds none of them.
 *
 * A checkout too shallow to reach any of them answers with nothing, and
 * every set is then reported as having no baseline rather than gated.
 */
export function nearestOnBranch(
  root: string,
): (commits: readonly string[]) => Promise<string | undefined> {
  return async (commits: readonly string[]) => {
    if (commits.length === 0) return undefined;
    const wanted = new Set(commits);
    // The tree's own history, every commit ahead of the ones it descends
    // from, read until one of them appears. Git stops on its own once
    // nothing is reading, so what this walks is the distance back to the
    // answer rather than the whole of the history.
    const child = new Deno.Command("git", {
      args: ["rev-list", "--topo-order", "HEAD"],
      cwd: root,
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const decoder = new TextDecoder();
    let carried = "";
    let found: string | undefined;
    // Leaving the loop cancels the stream, which is what leaves nothing
    // reading. Awaiting the status is what reaps git.
    for await (const chunk of child.stdout) {
      carried += decoder.decode(chunk, { stream: true });
      const lines = carried.split("\n");
      carried = lines.pop() ?? "";
      for (const line of lines) {
        if (wanted.has(line)) {
          found = line;
          break;
        }
      }
      if (found !== undefined) break;
    }
    await child.status;
    return found;
  };
}

/**
 * The commit under test's first parent, or nothing for a commit with no
 * parent.
 */
export async function parentCommit(root: string): Promise<string | undefined> {
  const result = await new Deno.Command("git", {
    args: ["rev-parse", "--verify", "--quiet", "HEAD^"],
    cwd: root,
    stdout: "piped",
    stderr: "null",
  }).output();
  return result.success
    ? new TextDecoder().decode(result.stdout).trim()
    : undefined;
}

/**
 * The only commit a default-branch gate compares against, which is
 * `parent`, as the walk `nearestOnBranch()` gives a pull request.
 *
 * A verdict on the default branch is attributed to the commit that reached
 * it, so it compares that commit with its parent and with nothing else. A
 * baseline further back holds every commit in between, a rise one of them
 * brought and its pull request accepted among them.
 */
export function onlyAt(
  parent: string | undefined,
): (commits: readonly string[]) => Promise<string | undefined> {
  return (commits) =>
    Promise.resolve(
      parent !== undefined && commits.includes(parent) ? parent : undefined,
    );
}

/** What a default-branch gate reads its parent's run through. */
export interface ParentRuns {
  /**
   * The coverage figures the push run at a commit measured, and when that
   * run was created, or nothing where they cannot be had.
   */
  figuresAt(
    commit: string,
  ): Promise<{ figures: CoverageFigures; startedAt: string } | undefined>;
}

/** The runs as GitHub reports them. */
const GITHUB_RUNS: ParentRuns = { figuresAt: firstCoverageAt };

/**
 * The baselines the push run at `commit` measured, read from that run, for
 * a default-branch gate. These come ahead of the manifest's, which serve a
 * set only where these hold none: the publisher carries a run's figures
 * into a manifest hours after the run, and the parent's figures are usually
 * uploaded minutes before its child's gates are judged. What this finds
 * depends on when it asks, so two attempts of one run can differ, one
 * comparing and one not.
 *
 * A run's figures leave out every set a unit of which failed in it, as the
 * publisher's do. Where the parent's run has not uploaded them, they cannot
 * be read, or the run cannot be found, this gives nothing and says so,
 * without waiting: nothing a gate finds fails the default branch, and a
 * gate left with no baseline compares nothing.
 */
export async function parentRunBaselines(
  commit: string,
  runs: ParentRuns,
): Promise<CoverageBaseline[]> {
  let found;
  let why = "";
  try {
    found = await runs.figuresAt(commit);
  } catch (error) {
    why = ` (${error})`;
  }
  if (found === undefined) {
    say([
      `No coverage figures of the run at the parent commit ${commit} could ` +
      `be read${why}, so no gate compares against that run.`,
      "",
    ]);
    return [];
  }
  return baselinesFrom(found.figures, commit, found.startedAt);
}

/** What the gate reaches for beyond its own arguments. */
export interface GateDeps {
  topology?: (root: string) => Promise<Suite[]>;

  /** Where the manifest comes from, read at a moment, as a lane reads it. */
  manifest?: (options: { at: string }) => Promise<ManifestFetch>;

  /** Where a default-branch gate reads its parent's run. */
  parentRuns?: ParentRuns;

  /**
   * Where the run's spool is looked up, for the records the gates leave.
   * The default is an empty environment, so a caller that does not hand
   * one over records nothing.
   */
  env?: Environment;
}

/** Runs the gate the way the job runs it, and answers with its status. */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
  deps: GateDeps = {},
): Promise<number> {
  const options = parseGateArgs(args, root);
  if (options === undefined) {
    console.error(
      "usage: coverage-gate.ts --base <ref> [--full | --scale <n>] " +
        "[--of <lanes>] [--reports <dir>] [--body <text>] [--tests-failed] " +
        "[--comment <path> --pr <number>]\n" +
        "       coverage-gate.ts --full --default-branch [--of <lanes>] " +
        "[--reports <dir>] [--body <text>] [--tests-failed]",
    );
    return 2;
  }
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const fetched = await resolveManifest({ root: options.root }, {
    manifest: deps.manifest ?? fetchManifest,
  });
  // A budgeted plan packed without the manifest the lanes read could name
  // gates they did not choose, and the lanes refuse to pack without it for
  // the same reason. The full run chooses every gate whatever the store
  // says, and lacks only its baselines.
  if (fetched.unreachable && !options.full) {
    return await conclude(options, false, [
      `The manifest store could not be read (${fetched.absent}), so which ` +
      `gates the lanes chose cannot be worked out.`,
    ]);
  }
  const changed = await changedFiles(options.root, options.base);
  const planned = planOver({
    suites,
    manifest: fetched.manifest,
    changed,
    landed: options.full ? new Set() : await landedFiles(
      options.root,
      options.base,
      fetched.manifest?.commit,
    ),
    full: options.full,
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    ...(options.of === undefined ? {} : { lanes: options.of }),
  });
  let accepted: ReadonlyMap<string, number> = new Map();
  try {
    accepted = acceptedCoverageDebt(options.body);
  } catch (error) {
    // A marker this cannot read was written to have an effect. Saying so
    // and stopping is the answer on a pull request; carrying on would gate
    // the change as though nobody had accepted anything. The default
    // branch has no change to stop, and judges its gates over no
    // acceptance at all.
    if (!options.defaultBranch) {
      return await conclude(options, false, [`${error}`]);
    }
    say([`${error}`, ""]);
  }
  const parent = options.defaultBranch
    ? await parentCommit(options.root)
    : undefined;
  const report = await runGate({
    root: options.root,
    gate: planned.coverage,
    excused: new Set(
      planned.laid.nonGating.map((entry) => testIdentityKey(entry.test)),
    ),
    reports: await collectSetReports(
      path.resolve(options.root, options.reports),
    ),
    marked: await markedSets(path.resolve(options.root, options.reports)),
    members: (await readWorkspaceMembers(
      path.join(options.root, "deno.jsonc"),
    )).map((member) => member.replace(/^\.\//, "")),
    measured: [...new Set(measuredSets(suites).map((ref) => ref.set.member))],
    baselines: [
      ...parent === undefined
        ? []
        : await parentRunBaselines(parent, deps.parentRuns ?? GITHUB_RUNS),
      ...fetched.manifest?.coverageBaselines ?? [],
    ],
    nearest: options.defaultBranch
      ? onlyAt(parent)
      : nearestOnBranch(options.root),
    accepted,
    testsFailed: options.testsFailed,
    defaultBranch: options.defaultBranch,
  });
  recordGates(gateRecords(suites, report), deps.env ?? (() => undefined));
  return await conclude(options, report.ok, gateFindings(report));
}

/**
 * Helper for {@link main}, which says what the gate found in the job's
 * summary, and in the pull-request comment where one was asked for, and
 * returns the gate's exit status.
 */
async function conclude(
  options: GateOptions,
  passed: boolean,
  findings: readonly string[],
): Promise<number> {
  say(underHeading(findings));
  // A run whose tests failed scored nothing, so a pass says nothing about
  // the rise a comment may already report, and the comment is left as it
  // was. A failure the gate found in such a run is still written.
  if (options.comment !== undefined && !(passed && options.testsFailed)) {
    const payload = gateComment(options.comment.prNumber, passed, findings);
    await Deno.writeTextFile(
      path.resolve(options.root, options.comment.path),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
  return passed ? 0 : 1;
}

if (import.meta.main) {
  Deno.exitCode = await main(Deno.args, Deno.cwd(), { env: Deno.env.get });
}
