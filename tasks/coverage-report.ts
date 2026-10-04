#!/usr/bin/env -S deno run -A

/**
 * What the full run publishes about coverage.
 *
 * Two quantities come out of the same reports the lanes wrote. The
 * repository-wide uncovered-line count is the merge of every report,
 * scored over every tracked source file, and it is a trend: the dashboard
 * shows it and nothing gates on it. Each measured set's count is one
 * suite's units over one workspace member's lines, and it is the baseline
 * the coverage gate compares a pull request against.
 *
 * Both go into the record store as measurements in the run's spool, which
 * the job's shipping step gathers and the relay stores under the job's
 * context; `tasks/coverage-records.ts` is how. That context names the
 * commit and the run, so the measurements carry neither.
 *
 * Nothing here fails a run. A rise in the repository-wide figure reaches
 * the change that caused it through the run report on its pull request,
 * and a rise in a measured set reaches it through the gate before it
 * lands.
 *
 *   deno run -A tasks/coverage-report.ts --reports coverage-artifacts
 */

import * as path from "@std/path";
import { walk } from "@std/fs/walk";
import type { Environment } from "@commonfabric/test-support/records";
import {
  coverageMetricForGroup,
  measuredSetCoverageMetric,
} from "./ci-check-lib.ts";
import { recordCoverage } from "./coverage-records.ts";
import {
  collectCoverageDebtMetricsFromCoverage,
  collectMeasuredSetDebt,
  type CoverageDebtMetric,
} from "./coverage-metrics.ts";
import { addLcovReport, type LcovFileCoverage } from "./lcov.ts";
import { collectSetReports } from "./coverage-gate.ts";
import { appendSummary } from "./step-summary.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";
import { loadTopology } from "./test-topology.ts";
import {
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "./test-selection/coverage.ts";
import {
  COMPILE_CACHE_STATE_FILE,
  COVERAGE_FAILURE_MARKER,
  measuredSetOfReport,
} from "./ci-lane.ts";

/** What the command line asked for. */
export interface ReportOptions {
  /** Where the lanes' coverage reports were downloaded to. */
  reports: string;

  /** The tree the reports are scored against. */
  root: string;
}

/**
 * Reads the command line, or returns undefined for one this cannot act
 * on.
 */
export function parseReportArgs(
  args: readonly string[],
  root: string = Deno.cwd(),
): ReportOptions | undefined {
  let reports = "coverage-artifacts";
  const rest = [...args];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = rest.shift();
    if (value === undefined || flag !== "--reports") return undefined;
    reports = value;
  }
  return { reports, root };
}

/**
 * Where the lanes' reports were downloaded to, resolved against the tree
 * being scored rather than against the working directory, which is what
 * the coverage gate does with the same argument.
 */
function reportsDirectory(options: ReportOptions): string {
  return path.resolve(options.root, options.reports);
}

/** What the lanes' artifacts hold. */
export interface LaneReports {
  /**
   * The line coverage of every LCOV report found, merged by source file.
   * Read one report at a time, because a full run's reports joined are
   * past the longest string a process can hold.
   */
  coverage: Map<string, LcovFileCoverage>;

  /**
   * Whether a lane that opened the pattern compile byte cache found it not
   * restored. False where no lane opened it.
   */
  cold: boolean;
}

/**
 * Every LCOV report under a directory, and the record each lane that opened
 * the compile byte cache left of whether it found the cache restored.
 */
export async function collectReports(at: string): Promise<LaneReports> {
  const coverage = new Map<string, LcovFileCoverage>();
  const cacheStates = new Set<string>();
  try {
    for await (const entry of walk(at, { includeDirs: false })) {
      if (path.extname(entry.path) === ".lcov") {
        addLcovReport(coverage, await Deno.readTextFile(entry.path), {
          mapPath: path.normalize,
        });
      } else if (path.basename(entry.path) === COMPILE_CACHE_STATE_FILE) {
        cacheStates.add((await Deno.readTextFile(entry.path)).trim());
      }
    }
  } catch (error) {
    // Nothing was downloaded, which the caller reads as a run that
    // reported nothing rather than as a run that covered nothing.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // A state this reader does not know is read as cold, so that a record
  // it cannot read withholds the figure from a trend rather than letting a
  // cold run's figure through.
  return {
    coverage,
    cold: [...cacheStates].some((state) => state !== "warm"),
  };
}

/**
 * Whether a report measured anything, which is one file record carrying
 * at least one line.
 *
 * A lane writes a report for a profile directory whatever that directory
 * holds, so a report file says that a lane got as far as converting and
 * not that it measured. A record naming a file and carrying no line says
 * nothing about that file either, which is the rule the measured sets are
 * scored by.
 */
function measuresAnything(
  coverage: ReadonlyMap<string, LcovFileCoverage>,
): boolean {
  for (const record of coverage.values()) {
    if (record.lineHits.size > 0) return true;
  }
  return false;
}

/**
 * The repository-wide figures: every metric group's uncovered lines and
 * the workspace total, scored over the merge of every report.
 *
 * Every report merges rather than only the ones a measured set names,
 * because this is the figure for the whole repository and every lane's
 * work contributes to it.
 *
 * A run that measured nothing publishes nothing. Scoring a report that
 * holds no record charges every tracked line as uncovered, which states a
 * measurement the run did not make; the dashboard charts this series, so
 * one run's spike and the next run's recovery would both be invented.
 */
export async function repositoryFigures(
  options: ReportOptions,
  reports: LaneReports,
): Promise<CoverageDebtMetric[]> {
  if (!measuresAnything(reports.coverage)) return [];
  return await collectCoverageDebtMetricsFromCoverage({
    rootDir: options.root,
    coverage: reports.coverage,
  });
}

/** A workspace member path spelled the way the topology spells it. */
function memberName(member: string): string {
  return member.replace(/^\.\//, "");
}

/**
 * Each measured set's figure: its member's lines measured by that
 * suite's units alone.
 *
 * A set with no report is left out rather than published as a complete
 * measurement of nothing. The gate reads the newest baseline the branch
 * contains, so a run that lost a set's report leaves the previous run's
 * figure standing, where a zero-coverage figure would tell every later
 * pull request that the member's whole source had gone uncovered.
 *
 * So is a set a lane marked as measured through a failing test. That
 * run stayed green because a flake rate excused the failure, and the
 * number is short by whatever the failing test would have reached, so
 * publishing it holds every later pull request to a bar this run did not
 * clear either.
 */
export async function measuredSetFigures(
  options: ReportOptions,
): Promise<CoverageDebtMetric[]> {
  const suites = await loadTopology(options.root);
  const members = (await readWorkspaceMembers(
    path.join(options.root, "deno.jsonc"),
  )).map(memberName);
  const reports = await collectSetReports(reportsDirectory(options));
  const marked = await markedSets(reportsDirectory(options));
  const figures: CoverageDebtMetric[] = [];
  for (const ref of measuredSets(suites)) {
    if (marked.has(measuredSetDirectory(ref))) continue;
    const found = reports.get(measuredSetDirectory(ref));
    if (found === undefined || found.length === 0) continue;
    // A set's units are spread over as many lanes as the packer liked, so
    // its figure is the union of what each of them reached.
    const lcov = (await Promise.all(found.map((at) => Deno.readTextFile(at))))
      .join("\n");
    const debt = await collectMeasuredSetDebt({
      rootDir: options.root,
      lcov,
      member: ref.set.member,
      members,
    });
    // A report with a record for none of the member's files measured
    // nothing, whatever it says about the lines. Publishing it would
    // hand the gate a baseline no run of the set stands behind.
    if (debt.files === 0) continue;
    figures.push({
      name: measuredSetCoverageMetric(measuredSetName(ref)),
      uncoveredLines: debt.uncoveredLines,
    });
  }
  return figures;
}

/**
 * The measured sets some lane marked as measured through a failing test,
 * by the directory a lane writes a set's report under.
 *
 * Walked for rather than looked for beside a report, because a lane
 * writes the marker whether or not it also wrote a report there: a lane
 * that ran a set's unit and saw it fail may have collected no profile
 * for it, and the set's baseline still must not be published from
 * another lane's report.
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
    // `collectReports` does.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return marked;
}

/** Says what this run measured, in the job summary. */
export function summarize(figures: readonly CoverageDebtMetric[]): string {
  const workspace = figures.find((figure) =>
    figure.name === coverageMetricForGroup("workspace")
  );
  const lines = ["## Coverage", ""];
  if (workspace !== undefined) {
    lines.push(
      `The workspace holds ${workspace.uncoveredLines} uncovered lines.`,
    );
  } else {
    lines.push("No lane reported coverage.");
  }
  lines.push("", `${figures.length} figures published.`);
  return `${lines.join("\n")}\n`;
}

/**
 * Records what this run measured in the spool `env` names, and says what it
 * published.
 */
export async function report(
  options: ReportOptions,
  env: Environment,
): Promise<string> {
  const reports = await collectReports(reportsDirectory(options));
  const figures = [
    ...await repositoryFigures(options, reports),
    ...await measuredSetFigures(options),
  ];
  recordCoverage(
    figures.map((figure) => [figure.name, figure.uncoveredLines]),
    reports.cold,
    env,
  );
  return summarize(figures);
}

/**
 * Runs the report the way the job runs it, and answers with the status it
 * would exit with: two for a command line this cannot read, zero
 * otherwise.
 *
 * Zero whatever the figures came to. Coverage is a trend on the default
 * branch, and a landed change that added an uncovered line must not turn
 * anything red for it.
 *
 * `env` is where the run's spool is looked up, and the default is an empty
 * environment, so a caller that does not hand one over records nothing.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
  env: Environment = () => undefined,
): Promise<number> {
  const options = parseReportArgs(args, root);
  if (options === undefined) {
    console.error("usage: coverage-report.ts [--reports <dir>]");
    return 2;
  }
  const summary = await report(options, env);
  console.log(summary);
  appendSummary(summary);
  return 0;
}

if (import.meta.main) {
  Deno.exitCode = await main(Deno.args, Deno.cwd(), Deno.env.get);
}
