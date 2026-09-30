#!/usr/bin/env -S deno run -A

/**
 * The coverage gate, as the job that joins the lanes runs it.
 *
 * A measured set is one suite's units over one workspace member's lines.
 * The lanes run every unit of every set the change reaches, with coverage
 * turned on, and each writes one report per set. This adds those reports
 * up per set, scores each set over its member's own lines, and compares
 * the count against what the same set measured at the newest `main`
 * commit the branch contains. A rise fails, unless the pull request's
 * description accepts it.
 *
 * Which sets are gated is worked out here from the topology and the diff,
 * by the same function the lanes run, rather than read out of what a lane
 * reported. Two answers to that question would let a lane talk this into
 * gating something it did not measure, or into skipping something it did.
 *
 * On a pull request it also writes the comment the pull request is left
 * with, which the Pull Request Comments workflow posts: a fork's pull
 * request gets a read-only token here, and cannot be commented on.
 *
 *   deno run -A tasks/coverage-gate.ts --base origin/main --reports artifacts \
 *     [--comment coverage-comment.json --pr 123]
 */

import * as path from "@std/path";
import { walk } from "@std/fs/walk";
import {
  changedFiles,
  COVERAGE_REPORT_FILE,
  manifestMoment,
  measuredSetOfReport,
} from "./ci-lane.ts";
import {
  acceptedCoverageDebt,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
} from "./ci-check-lib.ts";
import { collectMeasuredSetDebt } from "./coverage-metrics.ts";
import { say } from "./step-summary.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";
import { loadTopology } from "./test-topology.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  coverageGateFor,
  type CoverageGateSelection,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "./test-selection/coverage.ts";
import { fetchManifest } from "./test-selection/store.ts";
import type { CoverageBaseline } from "./test-selection/manifest.ts";

/** What the command line asked for. */
export interface GateOptions {
  /**
   * What the change is measured against. Required: with no diff the gate
   * reaches no set and passes, which reads exactly like a change that
   * touched nothing, so a workflow that lost the flag would pass every
   * pull request and say nothing.
   */
  base: string;

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
  const options: Partial<GateOptions> & Omit<GateOptions, "base"> = {
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
      default:
        return undefined;
    }
  }
  const base = options.base;
  if (base === undefined) return undefined;
  if (commentPath === undefined && prNumber === undefined) {
    return { ...options, base };
  }
  // A comment with no pull request has nowhere to go, and a pull request
  // with no comment file would be told nothing; either is a workflow that
  // lost a flag.
  if (commentPath === undefined || prNumber === undefined) return undefined;
  return { ...options, base, comment: { path: commentPath, prNumber } };
}

/**
 * The reports each measured set has, by the directory a lane wrote them
 * under, gathered from wherever the lanes' artifacts were unpacked.
 *
 * A set's units are ordinary mandatory items, so the packer spreads them
 * over as many lanes as it likes and each lane writes the part it ran.
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
    // each forced set, rather than an absent directory reading as a set
    // with no coverage.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found;
}

/** What the gate decided about one measured set. */
export interface SetVerdict {
  /** The suite and member the set pairs, as one name. */
  set: string;

  /** The workspace member whose lines were counted. */
  member: string;

  /** What this run measured, absent where no report measured the set. */
  uncoveredLines?: number;

  /** The `main` run this is compared against. */
  baseline?: { commit: string; uncoveredLines: number };

  /** Lines the pull request's description accepts for this member. */
  accepted?: number;

  /** How far above the baseline this run came, where it came above it. */
  rise?: number;

  outcome:
    | "passed"
    | "rose"
    | "accepted"
    | "no-baseline"
    | "no-report"
    | "not-forced"
    | "nothing-measured"
    | "not-scored";
}

/** What the gate came to over one change. */
export interface GateReport {
  /** Whether the gate ran at all. */
  ran: boolean;

  /** Why it did not, where it did not. */
  off?: string;

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

  /** The reports the lanes wrote, by set name. */
  reports: ReadonlyMap<string, readonly string[]>;

  members: readonly string[];

  /** The members some measured set scores, which an acceptance may name. */
  measured: readonly string[];

  baselines: readonly CoverageBaseline[];

  /** Which of these commits the tree under test holds most recently. */
  nearest: (commits: readonly string[]) => Promise<string | undefined>;

  /** Lines accepted, by the name the description gave. */
  accepted: ReadonlyMap<string, number>;

  testsFailed: boolean;
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
 * Scores every set the change reached that some run measured, and says
 * whether the change may proceed.
 *
 * Every set the change reached rather than only the ones the cap left
 * forced. The cap bounds what a change is made to run, which is a cost;
 * whether a number may be compared against the baseline turns on whether
 * the set ran whole, which is a different question. A run that measured
 * a set for its own reasons — the full run measures every one of them —
 * has produced a comparison that is exactly as sound as a forced one, and
 * discarding it would leave the gate silent over work already paid for.
 *
 * Three states report rather than fail, and each is a case where the
 * comparison would be against something other than the change. A set with
 * no baseline is one nothing has measured on `main` yet, and the first
 * pull request to reach a new package should not inherit the whole of
 * that package's debt. A set the cap left unforced that no run measured
 * has no number at all. And a run with a failing test measures coverage
 * through that failure, which says nothing about whether the change was
 * tested.
 *
 * Three states fail whatever else happened. A forced set with no report,
 * and a forced set whose reports name no line of its member, are sets the
 * change was made to measure and that nothing measured. A lane that
 * stopped before writing its report, an upload that carried nothing, a
 * download that found nothing, and a lane that wrote an empty report all
 * look the same from here, and passing would pass a rise that nothing
 * measured. And an acceptance naming something no gate in this repository
 * measures was written to have an effect and has none.
 */
export async function runGate(input: GateInput): Promise<GateReport> {
  const unknown = unknownAcceptances(input.accepted, input.measured);
  const forced = new Set(input.gate.sets.map(measuredSetName));
  const verdicts: SetVerdict[] = [];
  let ok = unknown.length === 0;
  for (const ref of input.gate.reached) {
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
      if (forced.has(set)) {
        ok = false;
        verdicts.push({
          set,
          member,
          outcome: measured === undefined ? "no-report" : "nothing-measured",
        });
      } else {
        verdicts.push({ set, member, outcome: "not-forced" });
      }
      continue;
    }
    const uncoveredLines = measured.uncoveredLines;
    if (input.testsFailed) {
      verdicts.push({ set, member, uncoveredLines, outcome: "not-scored" });
      continue;
    }
    const base = await nearestBaseline(
      input.baselines,
      ref.suite,
      member,
      input.nearest,
    );
    if (base === undefined) {
      verdicts.push({ set, member, uncoveredLines, outcome: "no-baseline" });
      continue;
    }
    const baseline = {
      commit: base.commit,
      uncoveredLines: base.uncoveredLines,
    };
    const rise = uncoveredLines - base.uncoveredLines;
    if (rise <= 0) {
      verdicts.push({
        set,
        member,
        uncoveredLines,
        baseline,
        outcome: "passed",
      });
      continue;
    }
    if (accepted !== undefined && rise <= accepted) {
      verdicts.push({
        set,
        member,
        uncoveredLines,
        baseline,
        accepted,
        rise,
        outcome: "accepted",
      });
      continue;
    }
    ok = false;
    verdicts.push({
      set,
      member,
      uncoveredLines,
      baseline,
      ...(accepted === undefined ? {} : { accepted }),
      rise,
      outcome: "rose",
    });
  }
  return {
    ran: verdicts.some((verdict) => verdict.uncoveredLines !== undefined),
    ...(input.gate.off === undefined ? {} : { off: input.gate.off }),
    verdicts,
    unknownAcceptances: unknown,
    ok,
  };
}

/** What each outcome means, in the words the summary uses. */
const OUTCOME_PROSE: Record<SetVerdict["outcome"], string> = {
  passed: "no rise",
  rose: "rose",
  accepted: "rose, accepted",
  "no-baseline": "no baseline on `main` yet, so nothing to compare",
  "no-report": "no lane reported one, so a rise cannot be ruled out",
  "not-forced": "the cap left this set unforced, and no run measured it",
  "nothing-measured": "the reports name no line of this member, so a " +
    "rise cannot be ruled out",
  "not-scored": "the run has a failing test, so this is not scored",
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
      "This change reaches no measured set, so the coverage gate has " +
        "nothing to compare.",
    );
    return lines;
  }
  if (report.off !== undefined) {
    lines.push(
      `No measured set was forced to run: ${report.off}. A set some run ` +
        `measured anyway is still scored.`,
      "",
    );
  }
  lines.push("| Measured set | Baseline | This run | Change | Outcome |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const verdict of report.verdicts) {
    const now = verdict.uncoveredLines;
    const was = verdict.baseline?.uncoveredLines;
    const change = now !== undefined && was !== undefined
      ? `${now - was >= 0 ? "+" : ""}${now - was}`
      : "";
    lines.push(
      `| ${verdict.set} | ${was ?? ""} | ${now ?? ""} | ${change} | ` +
        `${OUTCOME_PROSE[verdict.outcome]} |`,
    );
  }
  // One line per member rather than per set: the marker names the member,
  // so two sets over one member that both rose are accepted by the larger
  // of the two rises.
  const rose = new Map<string, number>();
  for (const verdict of report.verdicts) {
    if (verdict.outcome !== "rose" || verdict.rise === undefined) continue;
    rose.set(
      verdict.member,
      Math.max(rose.get(verdict.member) ?? 0, verdict.rise),
    );
  }
  if (
    report.verdicts.some((verdict) =>
      verdict.outcome === "no-report" || verdict.outcome === "nothing-measured"
    )
  ) {
    lines.push("");
    lines.push(
      "This change forced a set that no lane's report measured, so the " +
        "gate fails without having measured it. An acceptance does not " +
        "clear this: a report that measures the set has to reach the gate.",
    );
  }
  if (rose.size > 0) {
    lines.push("");
    lines.push(
      "This is a coverage failure rather than a test failure. Cover the " +
        "lines, or accept the rise in the pull request's description:",
    );
    lines.push("");
    lines.push("```text");
    for (const [member, rise] of rose) {
      lines.push(`ACCEPT_COVERAGE_DEBT: ${member} +${rise} lines`);
    }
    lines.push("```");
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

/** What the gate reaches for beyond its own arguments. */
export interface GateDeps {
  topology?: (root: string) => Promise<Suite[]>;
  baselines?: (at: string) => Promise<readonly CoverageBaseline[]>;
}

/**
 * The baselines the manifest current at `at` carries, or none where
 * there is no manifest to read. A set with no baseline is reported
 * rather than failed, so a store that cannot be reached costs the gate
 * its opinion and nothing else.
 */
export async function publishedBaselines(
  at: string,
  fetch?: typeof globalThis.fetch,
): Promise<readonly CoverageBaseline[]> {
  const found = await fetchManifest({
    at,
    ...(fetch === undefined ? {} : { fetch }),
  });
  return found.manifest?.coverageBaselines ?? [];
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
      "usage: coverage-gate.ts --base <ref> [--reports <dir>] " +
        "[--body <text>] [--tests-failed] [--comment <path> --pr <number>]",
    );
    return 2;
  }
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const changed = await changedFiles(options.root, options.base);
  const gate = coverageGateFor(suites, changed);
  const baselines = await (deps.baselines ?? publishedBaselines)(
    manifestMoment({ root: options.root }),
  );
  let accepted: ReadonlyMap<string, number>;
  try {
    accepted = acceptedCoverageDebt(options.body);
  } catch (error) {
    // A marker this cannot read was written to have an effect. Saying so
    // and stopping is the answer; carrying on would gate the change as
    // though nobody had accepted anything.
    return await conclude(options, false, [`${error}`]);
  }
  const report = await runGate({
    root: options.root,
    gate,
    reports: await collectSetReports(
      path.resolve(options.root, options.reports),
    ),
    members: (await readWorkspaceMembers(
      path.join(options.root, "deno.jsonc"),
    )).map((member) => member.replace(/^\.\//, "")),
    measured: [...new Set(measuredSets(suites).map((ref) => ref.set.member))],
    baselines,
    nearest: nearestOnBranch(options.root),
    accepted,
    testsFailed: options.testsFailed,
  });
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

if (import.meta.main) Deno.exitCode = await main();
