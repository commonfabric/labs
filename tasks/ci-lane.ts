#!/usr/bin/env -S deno run -A

/**
 * The script every pull-request lane runs, and the script every lane of
 * the full run on `main` runs.
 *
 * Lanes call this with their own lane number, how many lanes the run has,
 * and how much it runs, and nothing else. Nothing tells a lane what to
 * run: packing is a pure function of the working tree, the manifest, the
 * diff, and those numbers, so every lane computes the same plan over the
 * same inputs and takes its own share of it. That only holds while every lane resolves
 * the same manifest, which is why the moment they resolve it at is when
 * the commit under test was made rather than anything about the run.
 *
 * The full run differs in two values: it runs the whole corpus rather
 * than a budgeted part of it, and it has no diff. A pull request's labels
 * can make its run the full one, or scale how much it chooses by score. Everything else — what
 * the tree holds, what each test costs, how the work groups into lanes,
 * which identities inside a unit are skipped — is the same code, so the
 * two runs cannot come to different answers about the same tree.
 *
 * Once its plan has run and its verdict is settled, a lane of the full run
 * also runs again the units holding a test that failed every time, and
 * ships what those reruns record. That is evidence for the publisher, and
 * it changes neither the plan nor the verdict.
 *
 * No run can fix its number of lanes ahead of time, because the number
 * depends on how much work there is and the job matrix has to exist
 * before anything starts. So one job asks `--lane-count`, which reads a
 * pull request's labels and answers with the count and the arguments
 * every lane takes, and those are the whole of what passes from it to
 * them.
 *
 * A job prints its lane's plan in a step of its own, with `--dry-run`,
 * and then runs the lane with `--described`, which packs the same plan
 * again and names it in one line rather than printing it twice.
 *
 *   deno run -A tasks/ci-lane.ts --lane 3 --of 5 --base origin/main
 *   deno run -A tasks/ci-lane.ts --full --lane 1 --of 4
 *   deno run -A tasks/ci-lane.ts --full --lane-count
 *   deno run -A tasks/ci-lane.ts --lane 1 --of 5 --dry-run
 *   deno run -A tasks/ci-lane.ts --lane 1 --of 5 --described
 */

import { exists } from "@std/fs";
import * as path from "@std/path";
import {
  enclosingNames,
  FragmentWriter,
  NAME_SEPARATOR,
  readRegistrations,
  readWholeRuns,
  recordsDir,
  type TestIdentity,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  commitMoment,
  pinShuffleSeed,
} from "@commonfabric/test-support/shuffle";
import { maxOf } from "@commonfabric/utils/math";
import {
  type CapabilityId,
  COMPILE_CACHE_FILE,
  logTail,
  openCapabilities,
  takeGithubToken,
} from "./ci-capabilities.ts";
import type { CompileCacheState } from "./ci-check-lib.ts";
import {
  capabilitiesBySuite,
  loadTopology,
  wholeUnits,
} from "./test-topology.ts";
import {
  type Invocation,
  type Suite,
  unavailableUnits,
  type Unit,
  type UnitRequest,
} from "./test-topology/suite.ts";
import { collectRecords } from "./test-records-gather.ts";
import { fetchManifest, type ManifestFetch } from "./test-selection/store.ts";
import {
  aroundOf,
  costliestUnschedulable,
  crowdingLine,
  type CrowdingSuite,
  type GateChoice,
  type LaneCount,
  laneCount,
  type Plan,
  plan,
  type PlanInput,
  type Selection,
  type SelectionReason,
  suiteCharge,
  suiteLoad,
  testsOf,
  unholdableSuites,
} from "./test-selection/plan.ts";
import {
  type Census,
  census,
  isStandIn,
  type PricedCensus,
  pricedForRun,
  type PricedManifest,
} from "./test-selection/census.ts";
import {
  type CoverageGateSelection,
  coverageGateSelection,
  measuredMembersOf,
  measuresSuite,
} from "./test-selection/coverage.ts";
import {
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "./test-topology/coverage-gates.ts";
import type {
  Manifest,
  ManifestEntry,
  UnschedulableEntry,
  WithheldReason,
} from "./test-selection/manifest.ts";
import {
  DISCRETIONARY_SECONDS,
  FULL_RUN_LABEL,
  LANE_PROLOGUE_SECONDS,
  LANES_MAX,
  RERUN_BUDGET_SECONDS,
  RERUN_EXECUTIONS,
} from "./test-selection/policy.ts";
import { say } from "./step-summary.ts";
import { outcomesOf, verdictOf } from "./test-selection/report.ts";
import { duration } from "./test-selection/duration.ts";
import { writeLcovReport } from "./write-coverage-lcov.ts";
import {
  batchMeasurementName,
  excusedMeasurementName,
  hooksMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
  laneMeasurementName,
  RERUN_MEASUREMENT_NAME,
} from "./lane-measurement.ts";

/** What the lane was asked to do. */
export interface LaneOptions {
  lane: number;

  /**
   * How many lanes the run has, which the job ahead of the lanes counts.
   * Where it is not given, the lane counts them itself, the same way.
   */
  of?: number;

  /** Run everything the topology holds, which is what `main` does. */
  full: boolean;

  /**
   * What multiplies `DISCRETIONARY_SECONDS`, the seconds a pull request
   * spends on tests chosen by score. One where not given.
   */
  scale?: number;

  /**
   * The labels the pull request carries, one `--label` each, which say
   * whether it runs everything and how much it runs otherwise. Only the
   * job counting the lanes reads them, and it hands the lanes what they
   * decided as `--full` or `--scale`.
   */
  labels?: string[];

  /** Print the plan and run nothing. */
  dryRun: boolean;

  /**
   * The plan was printed already, by a `--dry-run` of the same lane, so
   * the lane names what it runs in one line rather than printing it
   * again. A job does this so that the plan heads a step of its own,
   * where a reader of a running job finds it rather than above thousands
   * of lines of test output; the lane packs the same plan again, from the
   * same tree and manifest, the way every lane packs its siblings' plan.
   */
  described?: boolean;

  /**
   * Print how many lanes the run needs and what to tell each of them, and
   * nothing else. This is what the job ahead of the lanes asks, and it
   * asks it of this script rather than of one of its own so that the
   * number and the lanes that will honor it come from the same code.
   */
  laneCount: boolean;

  /** What the change is measured against. */
  base?: string;

  /**
   * The moment to resolve the manifest at, ISO 8601 UTC, in place of the
   * commit's own. For asking what a lane would have done at a moment
   * that is not this tree's, which is what a dry run against recorded
   * data wants.
   */
  at?: string;

  /**
   * Where the reports converted from coverage profiles go, relative to
   * the root. The job uploads what is under it. The profiles go beside it.
   */
  coverageDir?: string;

  root: string;
}

/** Where coverage goes when the command line names nowhere else. */
export const DEFAULT_COVERAGE_DIR = "coverage";

/**
 * What a lane appends to its coverage directory's name to name the
 * directory it puts the profiles it collects in. The profiles sit beside
 * the directory the job uploads, not in it: one directory of them can
 * hold hundreds of thousands of files, and the upload walks every
 * directory under the path it is given, excluded or not.
 */
export const COVERAGE_PROFILE_SUFFIX = "-raw";

/**
 * Where a lane puts the reports the authored-pattern instrumentation
 * writes, under its coverage directory. They are LCOV already, so they sit
 * among the reports rather than among the profiles, and outside the
 * measured sets' layout, since no set is scored from them.
 */
export const PATTERN_COVERAGE_DIR = "lcov/pattern-runtime";

/** Where a lane puts the reports it converts, under its coverage directory. */
export const COVERAGE_REPORT_DIR = "lcov/sets";

/**
 * What a lane calls each report. One directory per measured set rather
 * than one file per set in a shared directory, because the conversion
 * puts what a report does not cover beside the report, and two sets
 * sharing a directory would share that too.
 */
export const COVERAGE_REPORT_FILE = "coverage.lcov";

/**
 * The measured set a file inside a lane's report layout belongs to, named
 * by the directory the lane wrote it in, or nothing where the file is not
 * inside that layout.
 *
 * The layout is matched whole rather than by its last segment, so that a
 * suite named after one of those segments cannot be read as the layout
 * itself. Whatever the file is — the report, or a marker written beside
 * it — this is the one answer to which set it belongs to, so a reader
 * cannot part company with the lane that wrote it.
 */
export function measuredSetOfReport(at: string): string | undefined {
  const layout = COVERAGE_REPORT_DIR.split("/");
  const parts = at.replaceAll("\\", "/").split("/");
  // The last occurrence rather than the first: a lane whose coverage
  // directory itself lies under a path spelling the layout would
  // otherwise be read from the wrong one, and every report under it
  // dismissed.
  const start = parts.findLastIndex((_, index) =>
    parts.slice(index, index + layout.length).join("/") === COVERAGE_REPORT_DIR
  );
  if (start === -1) return undefined;
  const rest = parts.slice(start + layout.length);
  return rest.length === 3 ? `${rest[0]}/${rest[1]}` : undefined;
}

/** Where this lane's coverage goes, absolute. */
export function coverageRoot(options: LaneOptions): string {
  return path.resolve(
    options.root,
    options.coverageDir ?? DEFAULT_COVERAGE_DIR,
  );
}

/** Where this lane's coverage profiles go, absolute. */
export function profileRoot(options: LaneOptions): string {
  return `${coverageRoot(options)}${COVERAGE_PROFILE_SUFFIX}`;
}

/** Reads the command line, or returns undefined for a malformed one. */
export function parseLaneArgs(
  args: readonly string[],
  root: string = Deno.cwd(),
): LaneOptions | undefined {
  const options: LaneOptions = {
    lane: 1,
    full: false,
    dryRun: false,
    laneCount: false,
    root,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    if (flag === "--full") {
      options.full = true;
      continue;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--described") {
      options.described = true;
      continue;
    }
    if (flag === "--lane-count") {
      options.laneCount = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--lane":
        options.lane = Number(value);
        break;
      case "--of":
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
      case "--label":
        options.labels = [...options.labels ?? [], value];
        break;
      case "--base":
        options.base = value;
        break;
      case "--at":
        options.at = value;
        break;
      case "--coverage-dir":
        options.coverageDir = value;
        break;
      default:
        return undefined;
    }
  }
  if (!Number.isInteger(options.lane) || options.lane < 1) return undefined;
  if (
    options.of !== undefined &&
    (!Number.isInteger(options.of) || options.of < options.lane)
  ) {
    return undefined;
  }
  // The labels decide what `--full` and `--scale` say, so a command line
  // naming either beside them would be saying it twice, and only the
  // count reads them.
  if (
    options.labels !== undefined &&
    (!options.laneCount || options.full || options.scale !== undefined)
  ) {
    return undefined;
  }
  // A full run spends nothing on tests chosen by score, so a scale beside
  // it would be one nothing honored.
  if (options.full && options.scale !== undefined) return undefined;
  // A dry run does nothing but describe, so one told the plan was
  // described already has nothing to do.
  if (options.described && options.dryRun) return undefined;
  return options;
}

/** A label that says how much a pull request runs. */
const SCALE_LABEL = /^ci: (\d+(?:\.\d+)?|\.\d+)x$/;

/** A label in the namespace the run's labels are in, however spelled. */
const RUN_LABEL = /^\s*ci\s*:/i;

/** What a pull request's labels ask of its run. */
export type RequestedRun =
  | { ok: true; full: boolean; scale: number }
  | { ok: false; problem: string };

/**
 * What a pull request's labels ask of its run: everything, under
 * `FULL_RUN_LABEL`; `n` times `DISCRETIONARY_SECONDS` of tests chosen by
 * score, under `ci: <n>x`; and the default where neither is there.
 *
 * A label beginning `ci:` in any spelling is one of these. Any such label
 * this cannot read, and more than one of them, is a problem: running the
 * default instead would run something the label did not ask for, and say
 * nothing.
 */
export function requestedRun(labels: readonly string[]): RequestedRun {
  const asking = labels.filter((label) => RUN_LABEL.test(label)).sort();
  if (asking.length > 1) {
    return {
      ok: false,
      problem: `the labels ${
        asking.map((label) => `\`${label}\``)
          .join(" and ")
      } each say how much this pull request runs, so ` +
        `remove all but one`,
    };
  }
  const label = asking[0];
  if (label === undefined) return { ok: true, full: false, scale: 1 };
  if (label === FULL_RUN_LABEL) return { ok: true, full: true, scale: 1 };
  const scale = SCALE_LABEL.exec(label)?.[1];
  if (scale === undefined) {
    return {
      ok: false,
      problem: `the label \`${label}\` says how much this pull request ` +
        `runs in no form this reads: \`${FULL_RUN_LABEL}\` runs ` +
        `everything, and \`ci: <n>x\`, where <n> is a non-negative ` +
        `decimal such as 0.5 or 2, runs n times the tests chosen by score ` +
        `a pull request runs by default`,
    };
  }
  return { ok: true, full: false, scale: Number(scale) };
}

/**
 * The moment a lane resolves its manifest at: when the commit it is
 * testing was made.
 *
 * What the moment has to be is stable — every lane of a run agreeing, and
 * every later attempt agreeing with the first — rather than exact. The
 * commit satisfies that by construction, where the run does not: GitHub
 * reports `run_started_at` per attempt, so a re-run half a day later
 * reports that later moment, and an attempt resolving at its own start
 * would pack the lanes differently from the attempt it is re-running. A
 * test the first attempt placed in the lane that failed could move to a
 * lane the re-run does not run, leaving `Status` green over a set no
 * attempt ran whole.
 *
 * The commit needs nothing from the service that scheduled the run: no
 * credential, no request, and no failure path where the request is
 * refused. It is the same value on a workstation as in a job, so a dry
 * run answers the question a lane would answer rather than resolving
 * against the clock. And it is the better anchor of the two on its own
 * terms — the manifest worth reading is the one that was current when
 * the tree under test came into being.
 *
 * The seed test order is shuffled by is taken from the same moment, for
 * the same reasons.
 *
 * Throws where the commit's date cannot be read. Reading it can fail in
 * one lane and not in its siblings, and no other moment is one they are
 * sure to share.
 */
export function manifestMoment(
  options: Pick<LaneOptions, "at" | "root">,
): string {
  if (options.at !== undefined) return options.at;
  const moment = commitMoment(options.root);
  if (moment === undefined) {
    throw new Error(
      `ci-lane: cannot read the date of the commit checked out at ` +
        `\`${options.root}\`, which is the moment every lane testing it ` +
        "resolves its manifest at; `--at` names another moment",
    );
  }
  // Git writes the committer's own offset, and manifest names carry UTC,
  // so the two are only comparable once this one is normalized.
  return moment.toISOString();
}

/**
 * What a git command prints in `root`, or an error opening with
 * `failure` and carrying what git said.
 */
async function gitOutput(
  root: string,
  args: readonly string[],
  failure: string,
): Promise<string> {
  const result = await new Deno.Command("git", {
    args: [...args],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${failure}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** A full git object id, in either hash a repository can use. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The paths in what `git … -z` printed. */
function pathsOf(listing: string): Set<string> {
  return new Set(listing.split("\0").filter((path) => path.length > 0));
}

/** The files this change touched, as the repository names them. */
export async function changedFiles(
  root: string,
  base: string | undefined,
): Promise<Set<string>> {
  if (base === undefined) return new Set();
  // A diff that fails throws rather than reading as a change-free pull
  // request, which would drop every unit the change touched out of the
  // mandatory set without saying so, and the lane would pass having run
  // none of them.
  return pathsOf(
    await gitOutput(
      root,
      ["diff", "-z", "--name-only", `${base}...HEAD`],
      `cannot diff against ${base}`,
    ),
  );
}

/**
 * The files `until` gained after `since`, through a `git` that throws
 * when git fails. Where `since` is not an ancestor of `until`, only what
 * `until` gained after the two parted counts, so a file that `until`
 * still holds and `since` deleted is not one of them.
 *
 * `since` comes from a manifest, which is untrusted, so it reaches git
 * only as a full object id. One that is not an object id, or that names
 * no commit `git` can find, gives nothing.
 */
export async function gainedSince(
  git: (...args: string[]) => Promise<string>,
  since: string,
  until: string,
): Promise<Set<string>> {
  if (!OBJECT_ID.test(since)) return new Set();
  const found = await git("rev-list", "--no-walk", "--ignore-missing", since);
  if (found.trim() === "") return new Set();
  return pathsOf(
    await git(
      "diff",
      "-z",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      `${since}...${until}`,
    ),
  );
}

/**
 * The files the default branch gained after `since`, the commit a
 * manifest was published from, and before this change branched off from
 * it at the merge base `changedFiles` diffs against.
 *
 * A unit no manifest has seen is forced into a run unless it is one of
 * these. The default branch's full run runs every unit it holds, so a
 * unit that landed there after the manifest's commit has records the
 * manifest is too old to hold. A unit the change brings with it has none,
 * and neither does one the manifest's own commit already held.
 *
 * A manifest naming no commit this checkout holds leaves nothing known to
 * have landed since it.
 */
export async function landedFiles(
  root: string,
  base: string | undefined,
  since: string | undefined,
): Promise<Set<string>> {
  if (base === undefined || since === undefined) return new Set();
  // A lane that read fewer files than its siblings would pack a plan they
  // are not following, so a listing that fails throws.
  const git = (...args: string[]) =>
    gitOutput(
      root,
      args,
      `cannot list the files ${base} gained after ${since}`,
    );
  const mergeBase = (await git("merge-base", base, "HEAD")).trim();
  return await gainedSince(git, since, mergeBase);
}

/** One suite's share of a lane, and what runs inside it. */
export interface Batch {
  suite: Suite;

  /** Each unit, and the identities inside it that are not to run. */
  units: UnitRequest[];

  /**
   * How many times each unit runs, by unit. Every run must pass.
   *
   * Per unit rather than per batch, because what a repeat is for is
   * catching one test disagreeing with itself. One flaky unit is not a
   * reason to run the rest of the batch again, and running it again
   * would cost the lane time the packer never charged it for.
   */
  runs: Map<Unit, number>;

  /**
   * Seconds the packer charged the lane for this batch: `suiteCharge()`
   * over the selections it holds. The lane records it beside what the
   * batch spent, which is what says how far the calibration was out.
   */
  projected: number;

  /**
   * Every identity the manifest holds in the batch's units, as
   * `knownKey()` names it. A test holding others is recorded on every run
   * where it is one of these, and otherwise only when it fails on its own
   * account. Absent, no such test is known.
   */
  known?: ReadonlySet<string>;
}

/** How `Batch.known` names an identity in a unit. */
function knownKey(unit: Unit, test: TestIdentity): string {
  return `${unit}\t${testIdentityKey(test)}`;
}

/**
 * How many passes a batch makes: the most runs any of its units asks for.
 * Each pass is an invocation of the suite's command of its own.
 */
export function batchRepeats(batch: Batch): number {
  let most = 1;
  for (const runs of batch.runs.values()) most = Math.max(most, runs);
  return most;
}

/** The units of a batch that are still running on the `run`th time round. */
export function unitsForRun(batch: Batch, run: number): UnitRequest[] {
  return batch.units.filter((unit) => (batch.runs.get(unit.unit) ?? 1) >= run);
}

/**
 * Turns a lane's selections into batches. A unit runs once carrying the
 * skip list of everything inside it that was not selected and encloses
 * nothing that was, so choosing one test out of a file leaves its
 * siblings registered as ignored rather than missing.
 *
 * A unit its suite declares whole carries no skip list, because its runner runs
 * every identity in it and reads no list.
 */
export function batchesOf(
  suites: readonly Suite[],
  manifest: PricedManifest,
  selections: readonly Selection[],
): Batch[] {
  const bySuite = new Map<string, Suite>(
    suites.map((suite) => [suite.id, suite]),
  );
  const wholeOf = new Map<Suite, ReadonlySet<Unit>>(
    suites.map((suite) => [suite, new Set(suite.whole)]),
  );
  const inUnit = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.entries) {
    const key = `${entry.suite}\t${entry.unit}`;
    inUnit.set(key, [...inUnit.get(key) ?? [], entry]);
  }
  const batches = new Map<string, Batch>();
  const known = new Map<string, Set<string>>();
  // What each unit was selected for: the names to run, and the most
  // repeats any one of them asked for.
  const selected = new Map<string, { names: Set<string>; repeats: number }>();
  for (const selection of selections) {
    const key = `${selection.entry.suite}\t${selection.entry.unit}`;
    const already = selected.get(key);
    if (already === undefined) {
      selected.set(key, {
        names: new Set([selection.entry.test.n]),
        repeats: selection.repeats,
      });
    } else {
      already.names.add(selection.entry.test.n);
      already.repeats = Math.max(already.repeats, selection.repeats);
    }
  }
  for (const [key, { names, repeats }] of selected) {
    const [suiteId, unit] = key.split("\t") as [string, string];
    const suite = bySuite.get(suiteId);
    if (suite === undefined) continue;
    const all = inUnit.get(key) ?? [];
    // A unit declared whole runs every identity in it, chosen or not.
    const whole = wholeOf.get(suite)!.has(unit);
    // A `describe` that fails as a whole is recorded under its own title,
    // and the outermost `describe` registers one test under its title, so
    // skipping that title skips every leaf inside it. A title enclosing a
    // chosen name therefore stays off the list, and its hooks run, so its
    // own cost is part of what the unit takes.
    const around = new Set([...names].flatMap(enclosingNames));
    const runs = whole
      ? all
      : all.filter((entry) =>
        names.has(entry.test.n) || around.has(entry.test.n)
      );
    const request: UnitRequest = {
      unit,
      skip: whole ? [] : all
        .filter((entry) =>
          !names.has(entry.test.n) && !around.has(entry.test.n)
        )
        .map((entry) => entry.test.n),
      cost: runs.reduce((total, entry) => total + entry.cost, 0),
    };
    const suiteKnows = known.get(suiteId) ?? new Set();
    known.set(suiteId, suiteKnows);
    for (const entry of all) suiteKnows.add(knownKey(unit, entry.test));
    const batch = batches.get(suiteId);
    if (batch === undefined) {
      batches.set(suiteId, {
        suite,
        units: [request],
        runs: new Map([[unit, repeats]]),
        projected: suiteCharge(
          manifest,
          suiteId,
          selections.filter(({ entry }) => entry.suite === suiteId),
        ),
        known: suiteKnows,
      });
    } else {
      batch.units.push(request);
      batch.runs.set(unit, repeats);
    }
  }
  // Both orders are the tree's rather than the packer's, so what a
  // runner is handed is decided by which units are in the batch and
  // never by which pass put them there. A test that leans on running
  // after a sibling then behaves the same on `main` as on a pull
  // request, rather than passing in whichever mode happened to order
  // them the way it wanted.
  const enumerated = new Map<string, number>();
  for (const suite of suites) {
    suite.units.forEach((unit, index) =>
      enumerated.set(`${suite.id}\t${unit}`, index)
    );
  }
  const order = (suiteId: string, unit: string): number =>
    enumerated.get(`${suiteId}\t${unit}`) ?? Number.MAX_SAFE_INTEGER;
  for (const [suiteId, batch] of batches) {
    batch.units.sort((a, b) =>
      order(suiteId, a.unit) - order(suiteId, b.unit) ||
      (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)
    );
  }
  // What a lane costs beyond its tests is fitted from what its batches
  // were seen to take, and a lane that the step timeout or a
  // cancellation stops part way through leaves its later batches unrun
  // and unmeasured. So the order a lane takes its batches in decides
  // which suites the cost model can ever learn, and a suite the model
  // cannot price is one that makes lanes run past the bound they are
  // packed to finish inside. Two keys answer that, in this order.
  //
  // A suite whose charge this run did not measure goes ahead of one
  // whose charge it did, because it is the one worth measuring. That is
  // a suite no lane has run at all, and a suite no lane has run the way
  // this run runs it: what a suite costs with coverage on is unknown
  // until a lane has run it so, whatever it costs without. And within
  // each group the largest share of the lane goes first, because a lane
  // that runs out of time should have spent it on the batch most worth
  // knowing about and dropped the cheap ones. A share is read through
  // `suiteLoad`, which is what the packer charged the lane for the suite's
  // tests, so a suite whose tests run slower than they were measured at,
  // or run several times, is as large here as it was when the lane was
  // filled.
  //
  // Both keys are a function of the plan, and the identifier settles a
  // tie, so every attempt at a lane runs its batches in the same order
  // whatever order the plan listed its selections in.
  const keyed = [...batches.values()].map((batch) => ({
    batch,
    id: batch.suite.id,
    measured: manifest.fitted.has(batch.suite.id) ? 1 : 0,
    seconds: suiteLoad(
      manifest,
      batch.suite.id,
      selections.filter(({ entry }) => entry.suite === batch.suite.id),
    ),
  }));
  return keyed.sort((a, b) =>
    a.measured - b.measured || b.seconds - a.seconds ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ).map(({ batch }) => batch);
}

/** What running one invocation came to. */
interface Outcome {
  ok: boolean;

  /** Whether the lane passed a signal on to the invocation. */
  interrupted: boolean;

  seconds: number;
}

/**
 * Whether a lane has been told to stop, and the commands it passes that
 * on to.
 *
 * A job stops a step that reaches its bound by sending it SIGINT, and
 * SIGTERM if it is still running a few seconds later. The lane passes
 * each signal on to the commands it is running and starts nothing more.
 * A test runner told to stop names the tests it was in the middle of and
 * writes its report before it exits, so a lane cut off by its bound keeps
 * the records of what it finished and says what held it up.
 */
export class LaneStop {
  #signal: Deno.Signal | undefined;
  #running = new Set<Deno.ChildProcess>();
  #signalled = new WeakSet<Deno.ChildProcess>();

  /** The first signal the lane was sent, or undefined if none was. */
  get signal(): Deno.Signal | undefined {
    return this.#signal;
  }

  /** Stops the lane, and passes `signal` on to every command running. */
  receive(signal: Deno.Signal): void {
    this.#signal ??= signal;
    for (const child of this.#running) this.#passOn(child, signal);
  }

  /**
   * Waits for `child` to exit, passing on whatever the lane is sent
   * meanwhile, and says whether it passed anything on. A child that
   * starts after the lane was told to stop is sent the first signal the
   * lane was sent.
   */
  async wait(
    child: Deno.ChildProcess,
  ): Promise<{ status: Deno.CommandStatus; interrupted: boolean }> {
    if (this.#signal !== undefined) this.#passOn(child, this.#signal);
    this.#running.add(child);
    try {
      const status = await child.status;
      return { status, interrupted: this.#signalled.has(child) };
    } finally {
      this.#running.delete(child);
    }
  }

  /** Sends `signal` to `child`, which may have exited already. */
  #passOn(child: Deno.ChildProcess, signal: Deno.Signal): void {
    try {
      child.kill(signal);
      this.#signalled.add(child);
    } catch {
      // Deno refuses to signal a child that has exited, and one that has
      // exited has nothing left to stop.
    }
  }
}

/** Runs one invocation, with the capabilities' environment around it. */
export async function runInvocation(
  invocation: Invocation,
  env: Record<string, string>,
  stop: LaneStop = new LaneStop(),
): Promise<Outcome> {
  const [command, ...args] = invocation.command;
  const startedAt = performance.now();
  const { status, interrupted } = await stop.wait(
    new Deno.Command(command!, {
      args,
      cwd: invocation.cwd,
      env: { ...Deno.env.toObject(), ...env, ...invocation.env },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn(),
  );
  return {
    ok: status.success,
    interrupted,
    seconds: (performance.now() - startedAt) / 1000,
  };
}

/**
 * One figure a lane measured about itself, as a record measuring the lane
 * machinery rather than a test. The publisher reads `setupCost` from these, and
 * fits each suite's figures to them, so they travel as ordinary records through
 * the machinery that already exists and need no pipeline of their own. They
 * stay unmarked whatever variant the batch they measure carried: they measure
 * the lane, not an alternate execution of one test.
 *
 * The record format carries one number and calls it a duration, so which
 * of the lane's figures this is and what it counts are decided by the
 * name.
 */
function measurementRecord(
  name: string,
  figure: number,
  ok: boolean,
): TestRecord {
  return {
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: ok ? "pass" : "fail",
    durationMs: Math.round(figure),
  };
}

/** One span of time a lane measured about itself, in seconds. */
function timingRecord(name: string, seconds: number, ok: boolean): TestRecord {
  return measurementRecord(name, seconds * 1000, ok);
}

/** Appends records to the lane's own spool. */
export function spoolRecords(
  spool: string,
  records: readonly TestRecord[],
): void {
  if (records.length === 0) return;
  const writer = FragmentWriter.open(spool);
  if (writer === undefined) return;
  for (const record of records) writer.append(record);
  writer.close();
}

/** Where one batch's coverage profiles go, and which members write them. */
export interface BatchCoverage {
  /** The directory this suite's profiles go under, absolute. */
  dir: string;

  /**
   * The members to measure, or nothing to measure every member the batch
   * runs, which is what the full run asks for.
   */
  members?: ReadonlySet<string>;

  /**
   * Where the authored-pattern instrumentation writes, for the full run
   * alone. What it measures feeds the repository-wide figure, which only
   * the full run publishes; no measured set is scored from it.
   */
  patternDir?: string;
}

/**
 * What a lane measures, given what the coverage gate decided.
 *
 * A pull request measures the members of the sets the gate is scoring and
 * no others: coverage costs time, and a profile no set is scored from is
 * time spent on something nothing reads. The full run measures every
 * member of every suite, because both the baselines and the
 * repository-wide trend come out of it.
 */
export function batchCoverage(
  options: LaneOptions,
  suiteId: string,
  gate: CoverageGateSelection,
): BatchCoverage | undefined {
  if (!measuresSuite(gate, suiteId, options.full)) return undefined;
  const root = coverageRoot(options);
  const dir = path.join(profileRoot(options), suiteId);
  return options.full
    ? { dir, patternDir: path.join(root, PATTERN_COVERAGE_DIR, suiteId) }
    : { dir, members: measuredMembersOf(gate, suiteId) };
}

/**
 * What a lane writes beside a set's report when the units it measured
 * through held a failure the run did not fail for.
 *
 * Coverage measured through a failing unit is short by whatever that
 * unit would have reached, and a run excusing a flaky failure stays
 * green, so nothing else downstream would know. The report still merges
 * into the repository-wide figure, which is a trend; what this stops is
 * the set's own number becoming the baseline every later pull request is
 * held to.
 */
export const COVERAGE_FAILURE_MARKER = "measured-through-a-failure.txt";

/**
 * The record a lane that opened the pattern compile byte cache leaves of
 * whether it found one restored: `cold` or `warm`, the whole of the file.
 *
 * A cold cache compiles every pattern from scratch, which runs compile
 * branches a warm run never reaches, so it moves the repository-wide
 * figure that the pattern suites contribute to. The record goes at the
 * top of the lane's report directory, which its coverage artifact holds,
 * so that whatever reads the figure can tell a cold run's from a warm
 * one's.
 */
export const COMPILE_CACHE_STATE_FILE = "compile-cache-state.txt";

/**
 * Marks each measured set whose units a lane saw fail, beside the report
 * it wrote for that set.
 */
export async function markMeasuredFailures(
  options: LaneOptions,
  suites: readonly Suite[],
  failed: ReadonlySet<string>,
): Promise<string[]> {
  if (failed.size === 0) return [];
  const root = coverageRoot(options);
  const marked: string[] = [];
  for (const ref of measuredSets(suites)) {
    const hit = ref.set.units.filter((unit) =>
      failed.has(`${ref.suite}\t${unit}`)
    );
    if (hit.length === 0) continue;
    const at = path.join(
      root,
      COVERAGE_REPORT_DIR,
      measuredSetDirectory(ref),
      COVERAGE_FAILURE_MARKER,
    );
    await Deno.mkdir(path.dirname(at), { recursive: true });
    await Deno.writeTextFile(at, `${hit.sort().join("\n")}\n`);
    marked.push(measuredSetName(ref));
  }
  return marked.sort();
}

/**
 * Writes the record of whether the compile byte cache was restored, at the
 * top of the directory the lane's coverage artifact carries.
 */
export async function writeCompileCacheState(
  options: LaneOptions,
  state: CompileCacheState,
): Promise<void> {
  const at = path.join(
    coverageRoot(options),
    path.dirname(COVERAGE_REPORT_DIR),
    COMPILE_CACHE_STATE_FILE,
  );
  await Deno.mkdir(path.dirname(at), { recursive: true });
  await Deno.writeTextFile(at, `${state}\n`);
}

/**
 * Converts every profile directory a lane wrote into one report beside
 * it, and says whether every conversion accounted for what it was given.
 *
 * Every directory is converted rather than only the ones a measured set
 * names, because the repository-wide figure the full run publishes is the
 * merge of all of them. Which of the reports the gate scores is decided
 * from the declarations, so an unscored report costs a conversion and
 * nothing else.
 */
export async function convertCoverage(
  options: LaneOptions,
): Promise<{ ok: boolean; reports: string[] }> {
  const root = coverageRoot(options);
  const profiles = profileRoot(options);
  const reports: string[] = [];
  let ok = true;
  for (const suiteId of await directoriesIn(profiles)) {
    for (const member of await directoriesIn(path.join(profiles, suiteId))) {
      const name = `${suiteId}/${member}`;
      const outcome = await writeLcovReport(
        path.join(profiles, suiteId, member),
        path.join(root, COVERAGE_REPORT_DIR, name, COVERAGE_REPORT_FILE),
      );
      if (!outcome.ok) ok = false;
      reports.push(name);
    }
  }
  return { ok, reports: reports.sort() };
}

/** The subdirectories of a directory, or none where it does not exist. */
async function directoriesIn(at: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(at)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return names.sort();
}

/** What one pass of a batch recorded, and what its processes registered. */
export interface Execution {
  /** The units the pass was asked to run. */
  units: readonly Unit[];

  /**
   * Every record the pass collected. The tests its units' skip lists
   * named are among them, which the batch's own records leave out: none
   * of those ships, but a skipped test reported inside a `describe` shows
   * that `describe` ran as far as its tests.
   */
  records: TestRecord[];

  /**
   * The names the pass's test processes registered, by unit. A unit that
   * is one file is here by the names `readRegistrations()` reads for that
   * file. A unit of several files that one process runs, such as a
   * package's browser tests, is here by the mark its runner leaves on
   * running every test of every file. A unit whose processes said neither
   * is not here.
   */
  registered: Map<string, Set<string>>;
}

/**
 * Runs one batch, once per repeat, gathering each execution's records
 * before the next can reuse a path the runner owns. Every repeat must
 * pass: a repeat is not a retry, and three runs of a test is strictly
 * stricter than one.
 *
 * A record whose kind and scope are outside the suite's declared
 * surfaces, or that a producer marked with a variant the batch did not
 * run in, is kept as its producer wrote it and reported. The batch is
 * not failed for it: the mistake is in the metadata, and the tests it
 * came with either passed or did not. The record then belongs to no
 * suite, which is what the store half of the drift guard fails on.
 *
 * A batch whose lane is told to stop gathers what the execution running
 * then recorded, and starts no other.
 */
export async function runBatch(
  batch: Batch,
  options: LaneOptions,
  workDir: string,
  spool: string | undefined,
  env: Record<string, string>,
  coverage?: BatchCoverage,
  stop: LaneStop = new LaneStop(),
): Promise<{
  ok: boolean;
  records: TestRecord[];
  conflicts: TestRecord[];
  seconds: number;
  unexplained: number;
  executions: Execution[];
}> {
  const records: TestRecord[] = [];
  const conflicts: TestRecord[] = [];
  // What each pass recorded, kept apart from the other passes. Whether a
  // pass ran what it was asked to is a statement about that pass, and a
  // reader taking the batch's records as one list cannot tell a pass that
  // ran from one that stopped part way.
  const executions: Execution[] = [];
  let ok = true;
  let seconds = 0;
  // Executions that ended badly having recorded no failure of their own,
  // which is a failure somewhere the records cannot see: a runner that
  // could not start, a command that died before reporting.
  //
  // Counted per execution rather than over the batch, because an excusal
  // is a statement about one invocation. A repeat that died having
  // recorded nothing sits in the same list of records as a repeat that
  // recorded a failure a flake rate excuses, and a reader taking the
  // batch's records as one list cannot tell that from a batch where
  // every execution ran.
  let unexplained = 0;
  // How many times a pass opened a unit, over every pass.
  let opened = 0;
  // Seconds the records the suite places in a unit took, and what the
  // units' hooks took, over every pass.
  let ran = 0;
  // What each unit's hooks took, once for each pass that opened it.
  const hooks: { unit: string; seconds: number }[] = [];
  for (let run = 1; run <= batchRepeats(batch); run++) {
    if (stop.signal !== undefined) break;
    console.log(
      `ci-lane: starting ${batch.suite.id}, run ${run} of ` +
        `${batchRepeats(batch)}`,
    );
    const outputDir = path.join(workDir, `${batch.suite.id}-${run}`);
    const batchSpool = path.join(outputDir, "spool");
    await Deno.mkdir(batchSpool, { recursive: true });
    const asked = unitsForRun(batch, run);
    opened += asked.length;
    // The tests a unit's skip list named, by unit and name. Each is a test
    // the plan gave another lane, or none, so the skip its process
    // registers is a fact about this lane's share rather than about the
    // test, and it ships no record. A skip the test registers itself is
    // not on this list and ships.
    const skipped = new Set(
      asked.flatMap((request) =>
        request.skip.map((name) => `${request.unit}\t${name}`)
      ),
    );
    // What this pass's units' hooks took, summed over their reports.
    const hooked = new Map<string, number>();
    const execution: Execution = {
      units: asked.map(({ unit }) => unit),
      records: [],
      registered: new Map(),
    };
    executions.push(execution);
    /** Adds `names` to what `unit` registered in this pass. */
    const register = (unit: string, names: Iterable<string>): void => {
      const known = execution.registered.get(unit);
      if (known === undefined) execution.registered.set(unit, new Set(names));
      else for (const name of names) known.add(name);
    };
    const invocations = await batch.suite.command(asked, {
      root: options.root,
      outputDir,
      spoolDir: batchSpool,
      ...(options.base === undefined ? {} : { baseRef: options.base }),
      ...(coverage === undefined ? {} : {
        coverageDir: coverage.dir,
        ...(coverage.members === undefined
          ? {}
          : { measuredMembers: coverage.members }),
        ...(coverage.patternDir === undefined
          ? {}
          : { patternCoverageDir: coverage.patternDir }),
      }),
    });
    for (const invocation of invocations) {
      if (stop.signal !== undefined) break;
      const outcome = await runInvocation(invocation, {
        ...env,
        // Each execution writes into a spool of its own, so a repeat
        // cannot read the previous run's fragments and a failure part
        // way through keeps what finished.
        CF_TEST_RECORDS_DIR: batchSpool,
        ...invocation.env,
      }, stop);
      seconds += outcome.seconds;
      if (!outcome.ok) ok = false;
      const collected = await collectRecords({
        spoolDir: batchSpool,
        interrupted: outcome.interrupted,
        junit: (invocation.junit ?? []).map((output) => ({
          kind: output.kind,
          scope: output.scope,
          glob: output.path,
          ...(output.filePrefix === undefined
            ? {}
            : { prefix: output.filePrefix }),
        })),
        surfaces: batch.suite.recordSurfaces,
        ...(batch.suite.variant === undefined
          ? {}
          : { variant: batch.suite.variant }),
        known: (test, file) => {
          const named = batch.suite.variant === undefined
            ? test
            : { ...test, v: batch.suite.variant };
          const location = batch.suite.locate(
            file === undefined ? { test: named } : { test: named, file },
          );
          return location?.level === "unit" &&
            (batch.known?.has(knownKey(location.unit, named)) ?? false);
        },
      });
      if (
        !outcome.ok &&
        !collected.records.some((record) => record.outcome === "fail")
      ) {
        unexplained += 1;
      }
      for (const record of collected.records) {
        execution.records.push(record);
        const location = batch.suite.locate(record);
        if (location?.level === "unit") {
          if (
            record.outcome === "skip" &&
            skipped.has(`${location.unit}\t${record.test.n}`)
          ) continue;
          ran += record.durationMs / 1000;
        }
        records.push(record);
      }
      for (const conflict of collected.conflicts) conflicts.push(conflict);
      for (const [file, names] of await readRegistrations(batchSpool)) {
        register(file, names);
      }
      for (const marked of await readWholeRuns(batchSpool)) {
        for (const [file, names] of Object.entries(marked.tests)) {
          // A file is placed by the kind and scope its tests record under
          // and the file itself, so one that registered no test still says
          // its unit holds none.
          const location = batch.suite.locate({
            test: { k: marked.kind, s: marked.scope, n: names[0] ?? file },
            file,
          });
          if (location?.level === "unit") register(location.unit, names);
        }
      }
      for (const record of collected.hooks) {
        const location = batch.suite.locate(record);
        if (location?.level !== "unit") continue;
        hooked.set(
          location.unit,
          (hooked.get(location.unit) ?? 0) + record.durationMs / 1000,
        );
      }
      await Deno.remove(batchSpool, { recursive: true }).catch(() => {});
      await Deno.mkdir(batchSpool, { recursive: true });
    }
    for (const [unit, seconds] of hooked) {
      ran += seconds;
      hooks.push({ unit, seconds });
    }
  }
  // A batch that stopped part way measured only the part it ran, and the
  // cost fit reads only a passing batch's measurements.
  if (stop.signal !== undefined) ok = false;
  if (spool !== undefined) {
    spoolRecords(spool, [
      ...records,
      // What the batch spent, what its tests took between them, how many
      // times its passes opened a unit, and how many passes it made. The
      // publisher fits a suite's cost beyond its tests from the four
      // together. The fifth, what the packer charged the lane for the
      // batch, is not fitted from: set beside the first, it says how far
      // the fit the lane was packed by was out.
      //
      // The tests' own time is summed here rather than read back from the
      // records, because a reader has no way to tell which of a report's
      // records came from which batch. It is summed over the records the
      // suite places in a unit, which are the ones a manifest can hold and
      // the packer charges by. A record the suite places in no unit, such
      // as one a wrapper writes for its whole invocation, is part of what
      // the batch spent beyond its units' tests. What each unit's hooks
      // took is in it as well, since the packer charges that through the
      // same correction, and it is also written for each unit each time a
      // pass opened it, which is what the publisher reads it from.
      timingRecord(
        batchMeasurementName(batch.suite.id, coverage !== undefined),
        seconds,
        ok,
      ),
      timingRecord(
        batchMeasurementName(
          batch.suite.id,
          coverage !== undefined,
          "ran",
        ),
        ran,
        ok,
      ),
      measurementRecord(
        batchMeasurementName(
          batch.suite.id,
          coverage !== undefined,
          "units",
        ),
        opened,
        ok,
      ),
      measurementRecord(
        batchMeasurementName(
          batch.suite.id,
          coverage !== undefined,
          "passes",
        ),
        batchRepeats(batch),
        ok,
      ),
      timingRecord(
        batchMeasurementName(
          batch.suite.id,
          coverage !== undefined,
          "projected",
        ),
        batch.projected,
        ok,
      ),
      ...hooks.map(({ unit, seconds }) =>
        timingRecord(
          hooksMeasurementName(batch.suite.id, coverage !== undefined, unit),
          seconds,
          ok,
        )
      ),
    ]);
  }
  return {
    ok,
    records,
    conflicts,
    seconds,
    unexplained,
    executions,
  };
}

/** What reading a batch's records against what it was asked to run found. */
export interface Accounting {
  /** Failing identities whose failure fails the lane. */
  gating: string[];

  /** Failing identities a flake rate excuses, where they are excused. */
  excused: string[];

  /**
   * Identities a pass was asked to run and no record of that pass
   * accounts for, which the tree holds or may hold, by key. An excused
   * failure beside one of these is not excused: an invocation that
   * recorded a failure and then stopped has run almost nothing while
   * satisfying any weaker test.
   */
  unaccounted: Missed[];

  /**
   * Identities a pass was asked to run that the tree holds no test for,
   * as the names that pass's test processes registered show, and that no
   * pass left unaccounted for. A manifest carries one for a test renamed
   * since it was published, in a file the tree still holds.
   * An invocation that stopped cannot have left one of these unrecorded,
   * since there was nothing to record, so an excusal stands beside them.
   */
  absent: string[];

  /**
   * Units a pass was asked to run and recorded nothing for. A unit runs
   * its tests or it does not, so nothing recorded is a runner that ran
   * none of it.
   */
  silent: Missed[];

  /**
   * The units a failure was seen in, whether or not it was excused. A
   * measured set holding one of these measured its member through a
   * failing test.
   */
  failedUnits: string[];
}

/** Something passes of a batch were asked to run, and which missed it. */
export interface Missed {
  /** An identity's key, or a unit. */
  name: string;

  /** The passes that missed it, counting from one. */
  passes: number[];

  /** How many passes ran its unit. */
  of: number;
}

/**
 * Reads one batch's records against what it was asked to run, a pass at
 * a time.
 *
 * Each pass is judged on its own records and its own registrations,
 * since the rule is per invocation and not per set of them: a pass that
 * stopped part way has not run what it was asked to however much the
 * other passes recorded. A suite hands each unit of a pass to one of its
 * invocations, so judging a pass judges each invocation it ran.
 *
 * An identity is accounted for by a record naming it or naming a test
 * inside it. A stand-in is accounted for by its unit recording anything
 * at all: a stand-in is what the packer places for a unit no manifest
 * has seen, and no record will ever carry its name, because a real record
 * is named for a test rather than for a file.
 *
 * An identity that went unaccounted for while its unit recorded costs an
 * excusal rather than the run, unless what the pass registered shows the
 * tree holds no such test. A manifest is hours old by construction, and it
 * holds every identity the default branch recorded in a file the tree
 * still holds, so it names tests renamed since. No run of this tree can
 * record one of those, and its missing record says
 * nothing about whether an invocation stopped, so it is set apart as
 * absent and an excusal stands beside it. Where the pass's registrations
 * say nothing about a unit, as for a suite whose processes leave no name
 * map or a process that stopped before leaving one, the identity stays
 * unaccounted for.
 */
export function accountFor(
  batch: Batch,
  asked: readonly Selection[],
  executions: readonly Execution[],
  nonGating: ReadonlySet<string>,
): Accounting {
  const gating = new Set<string>();
  const excused = new Set<string>();
  const failedUnits = new Set<string>();
  const unaccounted = new Map<string, Missed>();
  const absent = new Set<string>();
  const silent = new Map<string, Missed>();
  const mine = asked.filter(({ entry }) => entry.suite === batch.suite.id);
  for (const [index, { units, records, registered }] of executions.entries()) {
    const pass = index + 1;
    /** Notes that this pass missed `name`, which `unit` holds. */
    const miss = (into: Map<string, Missed>, name: string, unit: string) => {
      const missed = into.get(name) ?? {
        name,
        passes: [],
        of: executions.filter((ran) => ran.units.includes(unit)).length,
      };
      // Once per pass, however many selections name it.
      if (missed.passes.at(-1) !== pass) missed.passes.push(pass);
      into.set(name, missed);
    };
    const heard = new Set<string>();
    const heardUnits = new Set<string>();
    for (const record of records) {
      const location = batch.suite.locate(record);
      if (location?.level === "unit") heardUnits.add(location.unit);
      const key = testIdentityKey(record.test);
      heard.add(key);
      // Ingestion drops the case a `describe` reports for itself wherever a
      // leaf inside it reports, unless the batch knows it or it failed on its
      // own account, so a leaf's record, skipped or not, is what accounts for
      // every other `describe` enclosing it.
      for (const outer of enclosingNames(record.test.n)) {
        heard.add(testIdentityKey({ ...record.test, n: outer }));
      }
      if (record.outcome !== "fail") continue;
      if (location?.level === "unit") failedUnits.add(location.unit);
      (nonGating.has(key) ? excused : gating).add(key);
    }
    for (const unit of units) {
      if (!heardUnits.has(unit)) miss(silent, unit, unit);
    }
    for (const { entry } of mine) {
      if (!units.includes(entry.unit)) continue;
      const key = testIdentityKey(entry.test);
      if (isStandIn(entry)) {
        if (!heardUnits.has(entry.unit)) miss(unaccounted, key, entry.unit);
        continue;
      }
      if (heard.has(key)) continue;
      if (registersNoSuchTest(registered.get(entry.unit), entry.test.n)) {
        absent.add(key);
      } else miss(unaccounted, key, entry.unit);
    }
  }
  /** What was missed, in order of name. */
  const byName = (missed: Map<string, Missed>): Missed[] =>
    [...missed.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  return {
    gating: [...gating].sort(),
    excused: [...excused].sort(),
    unaccounted: byName(unaccounted),
    absent: [...absent].filter((key) => !unaccounted.has(key)).sort(),
    silent: byName(silent),
    failedUnits: [...failedUnits].sort(),
  };
}

/**
 * Whether the names a unit's test processes registered show its tree
 * holds no test named `name`. No registration at all shows nothing.
 *
 * A name is held where it was registered, and where it encloses a name
 * that was: the bdd re-export records each leaf's whole chain and not the
 * `describe` blocks along it, so a nested `describe` is known by the
 * leaves inside it.
 *
 * A name is shown absent only where everything registered that encloses
 * it is a `describe`, which a registered name is where another
 * registered name lies inside it. A registered test holds more than its
 * registration says: the steps its body names as it runs are recorded
 * beneath it and registered nowhere. And a `describe` registered with
 * nothing inside it reads as such a test, which is right, since that is
 * what a process whose bdd re-export recorded no leaves leaves behind,
 * and a leaf missing from it says nothing.
 */
function registersNoSuchTest(
  registered: ReadonlySet<string> | undefined,
  name: string,
): boolean {
  if (registered === undefined) return false;
  const holdsInside = (outer: string): boolean => {
    for (const other of registered) {
      if (other.startsWith(outer + NAME_SEPARATOR)) return true;
    }
    return false;
  };
  if (registered.has(name) || holdsInside(name)) return false;
  return enclosingNames(name).every((outer) =>
    !registered.has(outer) || holdsInside(outer)
  );
}

/** Says what a batch's records came to, where they came to anything. */
export function describeAccounting(
  suite: string,
  accounting: Accounting,
  excusing: boolean,
): void {
  const lines: string[] = [];
  /** One paragraph of the batch's summary, headed and then listed. */
  const section = (head: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(head, "");
    for (const item of items) lines.push(`- ${item}`);
  };
  section(
    `${suite}: ${accounting.gating.length} failures this run fails for:`,
    accounting.gating,
  );
  section(
    excusing
      ? `${suite}: ${accounting.excused.length} failures too flaky to ` +
        `judge a change by, which do not fail this run:`
      : `${suite}: ${accounting.excused.length} failures a flake rate ` +
        `would excuse, which fail this run because a pass of the batch did ` +
        `not account for everything it was asked to run that the tree ` +
        `holds:`,
    accounting.excused,
  );
  // Named whenever there are any, because this is the one list that
  // decides whether an excusal holds. A summary saying the batch left
  // something unaccounted for and not saying what is a message nobody can
  // act on.
  section(
    `${suite}: ${accounting.unaccounted.length} identities a pass has no ` +
      `record of, which the tree holds or may hold:`,
    accounting.unaccounted.map(describeMissed),
  );
  // Named as well, though they decide nothing: a rename among them keeps
  // its history under the old name until an alias joins it to the new
  // one, and this is where its author sees that it needs one.
  section(
    `${suite}: ${accounting.absent.length} identities the tree holds no ` +
      `test for, which a rename since the manifest would explain:`,
    accounting.absent,
  );
  section(
    `${suite}: ${accounting.silent.length} units a pass recorded nothing ` +
      `for, and so did not run:`,
    accounting.silent.map(describeMissed),
  );
  if (lines.length > 0) say(lines);
}

/**
 * Names what passes missed, and which passes did where only some of the
 * passes asked to run it missed it.
 */
function describeMissed({ name, passes, of }: Missed): string {
  if (passes.length === of) return name;
  const which = passes.length === 1
    ? `pass ${passes[0]}`
    : `passes ${passes.slice(0, -1).join(", ")} and ${passes.at(-1)}`;
  return `${name} (${which} of ${of})`;
}

/**
 * The units of a batch holding a test that failed every time the batch
 * ran it, each with those tests by key.
 *
 * A test that both passed and failed in the batch has disagreed with
 * itself at this commit already, so running it again adds nothing. A
 * failure the suite places in none of the batch's units is left out, since
 * a lane can run again only a unit it ran.
 */
export function unsettled(
  batch: Batch,
  records: readonly TestRecord[],
): Map<Unit, Set<string>> {
  const outcomes = outcomesOf(records);
  const held = new Set(batch.units.map(({ unit }) => unit));
  const units = new Map<Unit, Set<string>>();
  for (const record of records) {
    const key = testIdentityKey(record.test);
    if (verdictOf(outcomes.get(key)) !== "fail") continue;
    const location = batch.suite.locate(record);
    if (location?.level !== "unit" || !held.has(location.unit)) continue;
    units.set(location.unit, (units.get(location.unit) ?? new Set()).add(key));
  }
  return units;
}

/** A batch whose failures a lane of the full run runs again. */
export interface Rerun {
  batch: Batch;

  /** The environment the batch ran in. */
  env: Record<string, string>;

  /** What `unsettled()` found in the batch's records. */
  failing: ReadonlyMap<Unit, ReadonlySet<string>>;
}

/** What rerunning a lane's failures came to, with each test by key. */
export interface Reruns {
  /** Seconds the reruns took. */
  seconds: number;

  /** Tests that passed on a rerun. */
  passed: string[];

  /** Tests a rerun recorded, and that never passed. */
  failed: string[];

  /** Tests whose unit ran again, and that no rerun recorded. */
  unrecorded: string[];

  /** Tests whose unit was not run again, for want of budget. */
  unrun: string[];

  /** Records the reruns kept as written, as `runBatch()` reports them. */
  conflicts: TestRecord[];
}

/**
 * Runs again the units holding a test that failed every time its batch
 * ran it, and ships what those runs record as ordinary records.
 *
 * The publisher reads a test that passed and failed at one commit, in one
 * order, as flaky, and a test run once per commit can never do that, so
 * its failures on the full run read as commits breaking it. These reruns
 * give it the pass a flaky test needs, and a test that fails every rerun
 * goes on reading as broken. They collect evidence and decide nothing:
 * what the lane fails for is settled from the batches' own records.
 *
 * A unit runs again as its batch ran it, with the same skip list, so the
 * rerun asks the same tests the same thing. A unit its suite runs whole
 * runs whole again, and is charged for every test it holds. Coverage is
 * off, since nothing scores what a rerun would measure.
 *
 * Each rerun goes to the batch holding the unit that has run again least,
 * across every batch, and offers that batch's units the budget in the same
 * order, so the budget is spread over the lane's failures before it is
 * spent on one of them. A unit starts only where what the packer charges
 * for it fits in what the reruns have left of `RERUN_BUDGET_SECONDS`, and
 * the reruns' own time is what they take off it. A lane told to stop
 * starts no rerun.
 */
export async function rerunFailures(
  reruns: readonly Rerun[],
  manifest: Manifest,
  selections: readonly Selection[],
  options: LaneOptions,
  workDir: string,
  spool: string | undefined,
  stop: LaneStop = new LaneStop(),
): Promise<Reruns> {
  let seconds = 0;
  let passes = 0;
  const passed = new Set<string>();
  const recorded = new Set<string>();
  const reached = new Set<string>();
  const conflicts: TestRecord[] = [];
  const waiting = reruns.map(({ failing }) => new Map(failing));
  // How many times each batch's units have run again.
  const counts = reruns.map(() => new Map<Unit, number>());
  /** What the packer charges for one pass of `batch` over `requests`. */
  const chargeFor = (
    batch: Batch,
    requests: readonly UnitRequest[],
  ): number => {
    const held = new Set(requests.map(({ unit }) => unit));
    return suiteCharge(
      manifest,
      batch.suite.id,
      selections
        .filter(({ entry }) =>
          entry.suite === batch.suite.id && held.has(entry.unit)
        )
        .map(({ entry }) => ({ entry, repeats: 1 })),
    );
  };
  while (stop.signal === undefined) {
    const left = RERUN_BUDGET_SECONDS - seconds;
    let next: number | undefined;
    let least = Infinity;
    for (const [index, { batch }] of reruns.entries()) {
      const pending = waiting[index]!;
      for (const request of batch.units) {
        if (!pending.has(request.unit)) continue;
        const times = counts[index]!.get(request.unit) ?? 0;
        // What is left only shrinks, so a unit that does not fit on its
        // own now never will.
        if (
          times >= RERUN_EXECUTIONS || chargeFor(batch, [request]) > left
        ) {
          pending.delete(request.unit);
          continue;
        }
        if (times < least) {
          least = times;
          next = index;
        }
      }
    }
    if (next === undefined) break;
    const { batch, env } = reruns[next]!;
    const pending = waiting[next]!;
    const count = counts[next]!;
    // The first unit offered fits on its own, so something is chosen. One
    // that fits on its own but not beside those already chosen waits for
    // a later rerun, where it is offered ahead of them.
    const chosen: UnitRequest[] = [];
    let charge = 0;
    const offered = batch.units
      .filter(({ unit }) => pending.has(unit))
      .sort((a, b) => (count.get(a.unit) ?? 0) - (count.get(b.unit) ?? 0));
    for (const request of offered) {
      const charged = chargeFor(batch, [...chosen, request]);
      if (charged > left) continue;
      chosen.push(request);
      charge = charged;
    }
    // Handed over in the batch's own order, as the batch was.
    const units = batch.units.filter((request) => chosen.includes(request));
    for (const { unit } of units) count.set(unit, (count.get(unit) ?? 0) + 1);
    passes += 1;
    const startedAt = performance.now();
    const result = await runBatch(
      {
        ...batch,
        units,
        runs: new Map(units.map(({ unit }) => [unit, 1])),
        projected: charge,
      },
      options,
      path.join(workDir, `rerun-${passes}`),
      undefined,
      env,
      undefined,
      stop,
    );
    seconds += (performance.now() - startedAt) / 1000;
    if (spool !== undefined) spoolRecords(spool, result.records);
    for (const conflict of result.conflicts) conflicts.push(conflict);
    for (const record of result.records) {
      const key = testIdentityKey(record.test);
      recorded.add(key);
      if (record.outcome === "pass") passed.add(key);
    }
    for (const { unit } of units) {
      const keys = [...pending.get(unit)!];
      for (const key of keys) reached.add(key);
      const still = keys.filter((key) => !passed.has(key));
      if (still.length === 0) pending.delete(unit);
      else pending.set(unit, new Set(still));
    }
  }
  const failing = reruns.flatMap(({ failing }) =>
    [...failing.values()].flatMap((keys) => [...keys])
  ).sort();
  return {
    seconds,
    passed: failing.filter((key) => passed.has(key)),
    failed: failing.filter((key) => recorded.has(key) && !passed.has(key)),
    unrecorded: failing.filter((key) => reached.has(key) && !recorded.has(key)),
    unrun: failing.filter((key) => !reached.has(key)),
    conflicts,
  };
}

/** Says what rerunning a lane's failures came to, where it came to anything. */
export function describeReruns(reruns: Reruns): void {
  if (
    reruns.passed.length + reruns.failed.length + reruns.unrecorded.length +
        reruns.unrun.length === 0
  ) {
    return;
  }
  const lines = [
    "## Reruns",
    "",
    `Rerunning failures took ${duration(reruns.seconds)} of ` +
    `${duration(RERUN_BUDGET_SECONDS)}. What a rerun records is evidence ` +
    "for the publisher, and changes nothing about whether this run fails.",
  ];
  /** One paragraph of the summary, headed and then listed. */
  const section = (head: string, keys: readonly string[]): void => {
    if (keys.length === 0) return;
    lines.push("", head, "");
    for (const key of keys) lines.push(`- ${key}`);
  };
  section(
    "Passed on a rerun, so this commit holds both outcomes for them:",
    reruns.passed,
  );
  section("Run again and never passed:", reruns.failed);
  section(
    "Their unit ran again and no rerun recorded them, so nothing was " +
      "learned about them:",
    reruns.unrecorded,
  );
  section(
    "Not run again, because their unit did not fit what was left of the " +
      "budget:",
    reruns.unrun,
  );
  say(lines);
}

/**
 * Prints the end of every log the opened capabilities named.
 *
 * A capability runs outside the test process, so a failure on its side is
 * the half no test record describes, and the directory it wrote to goes
 * when the lane ends. The lane's own output is what survives that — a
 * continuous-integration job keeps it, and a person running a lane is
 * reading it already — so the evidence goes there rather than into an
 * artifact the lane would have to invent a way to upload.
 *
 * Not through `say`: the job summary is rendered prose with a size of its
 * own to keep, and this is a log.
 */
export async function describeCapabilityLogs(
  logs: readonly { capability: string; path: string }[],
  read: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<void> {
  for (const { capability, path: at } of logs) {
    console.log(`\n--- ${capability} log ---`);
    console.log(await logTail(at, read));
    console.log(`--- end of ${capability} log ---`);
  }
}

/**
 * Names the records this lane produced that no suite describes, which is
 * the only report they get before the store half of the drift guard
 * fails on them.
 */
export function describeConflicts(conflicts: readonly TestRecord[]): void {
  if (conflicts.length === 0) return;
  say([
    "These records name a surface the suite that ran them does not " +
    "declare, so they were kept as written rather than marked:",
    "",
    ...[...new Set(conflicts.map((record) => testIdentityKey(record.test)))]
      .map((key) => `- ${key}`),
  ]);
}

/** What a withheld identity is absent for, in words. */
const WITHHELD_REASONS: Record<WithheldReason, string> = {
  flaky: "too noisy to judge a change by",
};

/**
 * Names what the manifest withheld from selection, so that what a lane
 * did not run is visible rather than quietly absent.
 *
 * An identity the change made mandatory comes back in spite of being
 * withheld, since a change touching what a failing test covers is very
 * likely a fix and must be allowed to prove itself. Saying which of them
 * that happened to is the difference between "this did not run" and
 * "this ran because you touched it". An identity in `judged` comes back
 * too, because a coverage gate the plan chose runs the whole of its set.
 */
export function describeWithheld(
  withheld: Manifest["withheld"],
  mandatory: ReadonlyMap<string, SelectionReason>,
  judged: ReadonlySet<string> = new Set(),
): void {
  if (withheld.length === 0) return;
  const lines = [
    "Withheld from selection, so no lane chose them:",
    "",
    "| Identity | Suite | Withheld because | Ran anyway |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of withheld) {
    const key = testIdentityKey(entry.test);
    const back = mandatory.has(key)
      ? "yes, the change reaches it"
      : judged.has(key)
      ? "yes, a coverage gate the plan chose runs its set"
      : "no";
    lines.push(
      `| ${key} | ${entry.suite} | ${WITHHELD_REASONS[entry.reason]} | ` +
        `${back} |`,
    );
  }
  say(lines);
}

/**
 * What one suite's share of a lane was chosen for, and what it costs, the
 * tests `manifest` holds around its selections included.
 */
function chosenFor(
  manifest: Manifest,
  suite: string,
  selections: readonly Selection[],
): { identities: number; seconds: number; why: string } {
  const mine = selections.filter((s) => s.entry.suite === suite);
  const reasons = new Map<SelectionReason, number>();
  for (const selection of mine) {
    reasons.set(selection.reason, (reasons.get(selection.reason) ?? 0) + 1);
  }
  return {
    identities: mine.length,
    seconds: testsOf(mine, aroundOf(manifest, mine)).ran,
    why: [...reasons].sort().map(([reason, count]) => `${reason} ${count}`)
      .join(", "),
  };
}

/**
 * How much of a lane's projection stands on units nothing has measured:
 * how many of its selections are stand-ins, and the seconds of the
 * projection their own cost decides.
 *
 * Read through `suiteLoad`, which is how the packer charges a suite's
 * tests: the seconds are what each suite's charge comes to less what it
 * would come to without its stand-ins, so that they are a share of the
 * projection rather than a second reading of the same quantity. The
 * overheads a lane pays around a stand-in are measured rather than
 * guessed, and are not here.
 */
function standingOnStandIns(
  manifest: Manifest,
  selections: readonly Selection[],
): { units: number; seconds: number } {
  let units = 0;
  let seconds = 0;
  for (
    const [suite, held] of Map.groupBy(selections, ({ entry }) => entry.suite)
  ) {
    const measured = held.filter(({ entry }) => !isStandIn(entry));
    units += held.length - measured.length;
    seconds += suiteLoad(manifest, suite, held) -
      suiteLoad(manifest, suite, measured);
  }
  return { units, seconds };
}

/**
 * Prints what the lane is about to do, for the job summary.
 *
 * Where the lane is running a selection, each batch says what it is
 * expected to take and why each of its identities was chosen. "Why did
 * my test not run" is the question a selected run provokes, and a
 * summary that only names the suites cannot begin to answer it. The
 * seconds in the table are the own time of the tests and of the tests
 * around them, such as a `describe` whose `beforeAll` every run of a unit
 * runs, and not what the lane will take: the overheads the packer charged
 * on top are per lane rather than per identity, and `projectedSeconds` is
 * where the whole figure is.
 *
 * Not all of that time is measured. A unit nothing has recorded is
 * carried on a stand-in whose cost comes from the suite around it, and
 * the projection line says how many of its seconds those account for.
 */
export function describePlan(
  options: LaneOptions,
  batches: readonly Batch[],
  capabilities: readonly CapabilityId[],
  fetched: { objectName?: string; absent?: string },
  unschedulable: readonly UnschedulableEntry[],
  crowding: readonly CrowdingSuite[],
  chosen: {
    /** The manifest these selections were made against and costed by. */
    manifest: Manifest;
    selections: readonly Selection[];
    projectedSeconds: number;
  },
  budget: number,
): void {
  const lines: string[] = [];
  lines.push(`## Lane ${options.lane} of ${options.of}`);
  lines.push("");
  lines.push(
    fetched.absent === undefined
      ? `Manifest: \`${fetched.objectName}\``
      : `Running unselected: ${fetched.absent}`,
  );
  lines.push("");
  lines.push(`Capabilities: ${capabilities.join(", ") || "none"}`);
  lines.push("");
  // A stand-in's cost is taken from the suite around it rather than from
  // the unit it stands for, so a projection resting on several says what
  // the lane would take if those figures held. Somebody reading this
  // beside a lane that ran four times as long is told as much.
  const standing = standingOnStandIns(chosen.manifest, chosen.selections);
  lines.push(
    `Projected: ${duration(chosen.projectedSeconds)} of ${duration(budget)}` +
      (standing.units === 0
        ? ""
        : `, ${duration(standing.seconds)} of it charged to ` +
          `${standing.units} unit${standing.units === 1 ? "" : "s"} ` +
          `nothing has measured`),
  );
  lines.push("");
  lines.push(
    "| Suite | Units | Tests | Their own time | Executions | Chosen |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const batch of batches) {
    const share = chosenFor(
      chosen.manifest,
      batch.suite.id,
      chosen.selections,
    );
    lines.push(
      `| ${batch.suite.id} | ${batch.units.length} | ${share.identities} | ` +
        `${duration(share.seconds)} | ${batchRepeats(batch)} | ` +
        `${share.why} |`,
    );
  }
  // An identity of a suite no lane can hold is past the bound by that
  // suite's fixed charge and by nothing about itself, so the suite's own
  // line below says everything naming it would.
  const unholdable = unholdableSuites(crowding);
  const expensive = unschedulable.filter((entry) =>
    !unholdable.has(entry.suite)
  );
  if (expensive.length > 0) {
    // A discretionary identity costing more than the bound a lane is
    // packed to finish inside runs nowhere, because no lane can hold it
    // inside that bound. Naming it is what turns that into something
    // somebody can act on; the sixty-second rule is where such a test
    // gets split.
    lines.push("");
    lines.push("Nothing can run these, so nothing did:");
    lines.push("");
    // The summary has the withheld and coverage reports to hold after
    // this one, so this one takes a fixed share of it and the count
    // says how much there is.
    const { named, rest } = costliestUnschedulable(expensive);
    for (const entry of named) {
      lines.push(
        `- ${entry.suite}: ${testIdentityKey(entry.test)} costs ` +
          `${duration(entry.cost)}, more than a lane can hold`,
      );
    }
    if (rest.length > 0) lines.push(`- and ${rest.length} more`);
  }
  if (crowding.length > 0) {
    // What a lane pays before it runs anything of a suite. Past a lane's
    // budget nothing can share a lane with one of that suite's tests, so
    // the suite takes a lane per test it places; past the bound no lane
    // can hold it at all. Either way the tests named above are not what
    // is expensive, and a plan that only named them would send somebody
    // to look at the wrong thing.
    lines.push("");
    lines.push("Suites a lane cannot fill around:");
    lines.push("");
    for (const suite of crowding) lines.push(`- ${crowdingLine(suite)}`);
  }
  say(lines);
}

/** What the lane reaches for beyond its own arguments. */
export interface LaneDeps {
  /**
   * Where the manifest comes from, read at a moment. Every caller names
   * one, and the store is named at the command line alone.
   */
  manifest: (options: { at: string }) => Promise<ManifestFetch>;

  /**
   * Where the suites come from. A caller that supplies them is saying
   * what the working tree holds, which is the only way what the lane
   * does with a batch — opening its capabilities, running it, gathering
   * what it recorded — can be exercised without running the
   * repository's real suites to find out.
   */
  topology?: (root: string) => Promise<Suite[]>;

  /**
   * Where the lane writes what it measured about itself. The default is
   * the enclosing run's spool, which is the job the lane is. A caller
   * that supplies one is saying where those measurements go, and a lane
   * run from inside a test needs to, because the enclosing run there is
   * the run testing it and its spool ships.
   */
  spool?: () => string | undefined;

  /**
   * What tells the lane to stop part way through, made once the lane is
   * about to run anything. The command line stops it on SIGINT and
   * SIGTERM; a lane run from inside a test is stopped by the test.
   */
  stop?: () => LaneStop;
}

/**
 * The manifest the lanes testing this checkout's commit resolve, as the
 * store gave it, or why there is none.
 *
 * Anything that reads a manifest for a checkout resolves it here. One
 * that resolved it some other way could be describing a different
 * manifest from the one those lanes read, and nothing it printed would
 * say so.
 */
export async function resolveManifest(
  options: Pick<LaneOptions, "at" | "root">,
  deps: Pick<LaneDeps, "manifest">,
): Promise<ManifestFetch> {
  return await deps.manifest({ at: manifestMoment(options) });
}

/** The manifest this commit belongs to, and what the change touched. */
interface Reading {
  /** The manifest, or nothing where the store holds none for the commit. */
  manifest: Manifest | undefined;

  /** The files the change touched, and none for the full run. */
  changed: ReadonlySet<string>;

  /**
   * The files the default branch gained between the manifest's commit and
   * where the change branched off, and none for the full run.
   */
  landed: ReadonlySet<string>;

  /** Which object the manifest was read from, or why there is none. */
  fetched: { objectName?: string; absent?: string };
}

/**
 * Resolves the manifest this commit belongs to and the files the change
 * touched.
 *
 * Everything that plans anything starts here — a lane, and the job that
 * counts a run's lanes — so the tree and the manifest are
 * resolved one way. Two readers of the same tree that resolved it
 * differently would be the drift this whole path exists to remove,
 * appearing one level above the packer instead of inside it.
 */
async function read(
  options: LaneOptions,
  deps: Pick<LaneDeps, "manifest">,
): Promise<Reading> {
  const manifest = await resolveManifest(options, deps);
  // Every lane of a run packs its share of one plan, and the plan is only
  // one plan if every lane read the same manifest. A manifest never
  // changes once created, so lanes asking about one moment get one answer
  // from the store, but a store one lane could not reach may be one the
  // next lane read. Packing without a manifest then would lay out a plan
  // its siblings are not following, and a test the two plans put in each
  // other's lanes would run in neither while the run reports a pass.
  if (manifest.unreachable) {
    throw new Error(
      `ci-lane: the manifest store could not be read (${manifest.absent}), ` +
        "and a lane that packed without it might not follow the plan the " +
        "other lanes of this run packed from",
    );
  }
  return {
    manifest: manifest.manifest,
    // A full run reads the manifest for what things cost and nothing
    // else, and a run with no diff has touched nothing.
    changed: options.full
      ? new Set<string>()
      : await changedFiles(options.root, options.base),
    landed: options.full ? new Set<string>() : await landedFiles(
      options.root,
      options.base,
      manifest.manifest?.commit,
    ),
    fetched: {
      ...(manifest.objectName === undefined
        ? {}
        : { objectName: manifest.objectName }),
      ...(manifest.absent === undefined ? {} : { absent: manifest.absent }),
    },
  };
}

/** What one run makes of a tree: the tree as it prices it, and packed. */
export interface PlanOver {
  /** The tree read against the manifest, priced the way the run prices it. */
  seen: PricedCensus;

  /** What the tree holds, packed into the run's lanes. */
  laid: Plan;

  /**
   * The measured sets the change reached, and those whose gates the plan
   * chose, which are the sets the lanes measure and the verdicts the job
   * joining them reaches.
   */
  coverage: CoverageGateSelection;
}

/** What a run is asked to do with a tree, beside the tree itself. */
interface RunInput {
  suites: readonly Suite[];
  manifest: Manifest | undefined;
  changed: ReadonlySet<string>;

  /**
   * The files the default branch gained between the manifest's commit and
   * where the change branched off, and none for the full run.
   */
  landed: ReadonlySet<string>;

  full: boolean;

  /** What multiplies `DISCRETIONARY_SECONDS`. One where not given. */
  scale?: number;
}

/**
 * What a run packs a tree into, given the manifest it resolved, what its
 * change touched, whether it is the full run, how much it spends on tests
 * chosen by score, and how many lanes it has: where that is not given, as
 * many as the job ahead of the lanes counts. Pure: the lanes of a run and
 * anything describing what they did compute it here, so the two cannot
 * come to different answers.
 *
 * Whether the run is the full one is the whole of what the two kinds of
 * run differ by here. Under `everything` every identity is required, so
 * the exclusions and the value, density and exploration passes have
 * nothing left to act on and the packer behaves the same way for both.
 *
 * A suite is priced as measured when the run measures it, and a pull
 * request measures the suites of the gates its plan chose, which pricing
 * has to know before the plan is packed. So the plan is packed first with
 * no suite priced as measured, which is the answer wherever it chooses no
 * gate. Where it chose some, it is packed again with those gates' suites
 * priced as measured and only their gates offered, and again with fewer
 * for as long as it then chooses no gate of some of those suites. The
 * suites it may choose from shrink each time, so this ends, and it ends
 * with every suite priced the way the lanes will run it. Every packing
 * has the same number of lanes.
 */
export function planOver(input: RunInput & { lanes?: number }): PlanOver {
  const read = census(
    input.suites,
    input.manifest,
    input.changed,
    input.landed,
  );
  const lanes = input.lanes ?? lanesNeeded(input, read).lanes;
  const packed = (
    gates: readonly GateChoice[],
    measured: ReadonlySet<string>,
  ) => {
    const seen = pricedForRun(
      read,
      input.suites,
      (suite) => input.full || measured.has(suite),
    );
    return { seen, laid: plan({ ...packingOf(input, seen, gates), lanes }) };
  };
  const judging = new Map(
    read.gates.map((gate) => [testIdentityKey(gate.entry.test), gate.judges]),
  );
  let gates = read.gates;
  let measured = new Set<string>();
  let { seen, laid } = packed(gates, measured);
  for (;;) {
    const chosen = new Set(
      laid.gates.flatMap((gate) => {
        const suite = judging.get(testIdentityKey(gate.entry.test));
        return suite === undefined ? [] : [suite];
      }),
    );
    if (
      input.full ||
      (chosen.size === measured.size &&
        [...chosen].every((suite) => measured.has(suite)))
    ) {
      break;
    }
    measured = chosen;
    gates = gates.map((gate) =>
      gate.reached && !chosen.has(gate.judges)
        ? { ...gate, reached: false }
        : gate
    );
    ({ seen, laid } = packed(gates, measured));
  }
  return {
    seen,
    laid,
    coverage: coverageGateSelection(input.suites, read.gates, laid.gates),
  };
}

/** Helper for `planOver` and the lane count: what the packer is given. */
function packingOf(
  input: RunInput,
  seen: PricedCensus,
  gates: readonly GateChoice[],
): Omit<PlanInput, "lanes"> {
  return {
    manifest: seen.manifest,
    mandatory: seen.mandatory,
    capabilities: capabilitiesBySuite(input.suites),
    wholeUnits: wholeUnits(input.suites),
    gates,
    ...(input.full
      ? { policy: "everything" as const }
      : { discretionarySeconds: (input.scale ?? 1) * DISCRETIONARY_SECONDS }),
  };
}

/** What every lane of a run works out before taking its own share. */
export interface LanePlan extends PlanOver {
  /** Which object the manifest was read from, or why there is none. */
  fetched: Reading["fetched"];
}

/**
 * The plan every lane of a run computes over this tree: the manifest
 * this commit belongs to, the tree read against it, and what the tree
 * holds packed into `options.of` lanes, or into as many as the job ahead
 * of the lanes would count where that is not given.
 *
 * A lane runs its own share of this. Anything that describes what a lane
 * would do computes it here rather than packing the tree again, so the
 * description and the lanes cannot disagree about what would run.
 */
export async function lanePlan(
  options: LaneOptions,
  suites: readonly Suite[],
  deps: Pick<LaneDeps, "manifest">,
): Promise<LanePlan> {
  const { manifest, changed, landed, fetched } = await read(options, deps);
  return {
    fetched,
    ...planOver({
      suites,
      manifest,
      changed,
      landed,
      full: options.full,
      scale: options.scale,
      ...(options.of === undefined ? {} : { lanes: options.of }),
    }),
  };
}

/** What the job ahead of the lanes hands them. */
export interface RunLanes {
  /** How many lanes the run has. */
  of: number;

  /**
   * What every lane is told besides its own number and `of`, as words
   * for a command line: the base a pull request's change is measured
   * against, and `--full` or the scale its labels asked for. The job that
   * judges the run's coverage gates is told the same.
   */
  args: string[];
}

/**
 * How many lanes a run takes, and what to tell each of them: as many as
 * it needs, up to `LANES_MAX`.
 *
 * This is the whole of what the job ahead of the lanes decides. The lanes
 * then read the same tree against the same manifest and take their own
 * share, so nothing about what runs passes through a job output and there
 * is no second packing to disagree with theirs.
 *
 * Everything else goes to the error stream, because this answers on the
 * standard one and a job reads the answer from there: notes about what
 * the count rests on, and what each lane at that count is projected to
 * take, which also goes to the job summary.
 */
export async function runLanes(
  options: LaneOptions,
  deps: LaneDeps,
): Promise<RunLanes> {
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const { manifest, changed, landed } = await read(options, deps);
  const input: RunInput = {
    suites,
    manifest,
    changed,
    landed,
    full: options.full,
    scale: options.scale,
  };
  const { lanes, capped } = lanesNeeded(
    input,
    census(suites, manifest, changed, landed),
  );
  const { laid } = planOver({ ...input, lanes });
  if (capped) {
    const short = [
      ...(laid.overflowed > 0 ? ["a lane may run past its budget"] : []),
      ...(laid.discretionarySeconds < laid.discretionaryTargetSeconds
        ? [
          `its tests chosen by score get ` +
          `${duration(laid.discretionarySeconds)} of the ` +
          `${duration(laid.discretionaryTargetSeconds)} it asked for`,
        ]
        : []),
    ];
    console.error(
      `ci-lane: this run needs more than ${LANES_MAX} lanes and takes ` +
        `${LANES_MAX}, the most LANES_MAX allows` +
        (short.length === 0 ? "" : `, so ${short.join(", and ")}`),
    );
  }
  // Where the store gave no manifest, nothing was calibrated, and the
  // prologue is the figure the lanes' budget was derived from.
  describeLanes(
    laid,
    manifest?.calibration.prologue ?? LANE_PROLOGUE_SECONDS,
  );
  return {
    of: lanes,
    args: [
      ...(options.base === undefined ? [] : ["--base", options.base]),
      ...(options.full ? ["--full"] : ["--scale", String(options.scale ?? 1)]),
      ...(options.at === undefined ? [] : ["--at", options.at]),
    ],
  };
}

/**
 * What each lane of a run is projected to take, on the error stream and
 * in the job summary, since the count is the whole of what this answers
 * on the standard one. The lanes pack this same plan, so what a lane is
 * projected to take here is what it projects for itself.
 */
export function describeLanes(laid: Plan, prologue: number): void {
  const longest = Math.max(
    0,
    maxOf(laid.lanes.map((lane) => lane.projectedSeconds)),
  );
  say([
    `## The run's ${laid.lanes.length} lane(s)`,
    "",
    `Each is packed against ${duration(laid.budgetSeconds)} of work, and ` +
    `the job around it takes about ${duration(prologue)} more to set up ` +
    `and ship. The longest is projected to take ` +
    `${duration(longest + prologue)} in all. ` +
    (laid.discretionarySeconds > 0
      ? `Tests chosen by score take up to ` +
        `${duration(laid.discretionarySeconds)} of the work. `
      : "") +
    `A lane holding a test that failed every time may start up to ` +
    `${duration(RERUN_BUDGET_SECONDS)} of reruns after that.`,
    "",
    "| Lane | Tests | Projected work | Projected job |",
    "| --- | --- | --- | --- |",
    ...laid.lanes.map((lane) =>
      `| ${lane.lane} | ${lane.selections.length} | ` +
      `${duration(lane.projectedSeconds)} | ` +
      `${duration(lane.projectedSeconds + prologue)} |`
    ),
  ], console.error);
}

/**
 * How many lanes a run takes, up to `LANES_MAX`, counted over the tree
 * priced with no suite measured, which is how its plan is first packed.
 */
function lanesNeeded(input: RunInput, read: Census): LaneCount {
  const { suites } = input;
  const seen = pricedForRun(read, suites, () => input.full);
  const packing = packingOf(input, seen, read.gates);
  if (seen.unmeasured === seen.manifest.entries.length) {
    // Nothing at all has a measured cost, so a cost model here would be
    // arithmetic over a figure this invented, and the answer would be
    // wrong by whatever that figure is wrong by. It errs in the
    // direction that breaks a run, too: too few lanes means every one of
    // them runs past the bound it is packed to finish inside, where too
    // many means some jobs finish early.
    //
    // So a lane per suite with anything to run goes in as a floor. It
    // needs no number nobody measured, and it keeps the count growing as
    // test surfaces are added.
    //
    // The packing is still asked what it would need, and the larger of
    // the two wins. Its answer is only as good as the stand-in costs
    // behind it, which is why it cannot be the whole of this — but those
    // costs are what the lanes will actually be packed against, so an
    // answer below what they imply is one the lanes cannot honor
    // whatever else is true. That matters most where a stand-in costs
    // more than the bare unmeasured figure: a suite whose measured units
    // have all been renamed away carries what the units it lost cost
    // onto every stand-in, and a count that assumed the bare figure
    // would be out by that whole multiple.
    // A suite of gates holds verdicts, which no lane runs.
    const running = suites.filter((suite) => {
      if (suite.judges !== undefined) return false;
      const unavailable = unavailableUnits(suite);
      return suite.units.some((unit) => !unavailable.has(unit));
    });
    const byCost = laneCount(packing);
    const wanted = Math.max(1, running.length, byCost.lanes);
    console.error(
      `ci-lane: nothing in this tree has a measured cost, so the lane ` +
        `count is ${wanted} — ${running.length} suites with anything to ` +
        `run, and ${byCost.lanes} from packing the stand-ins — rather ` +
        `than a projection from costs nobody has measured`,
    );
    return {
      lanes: Math.min(wanted, LANES_MAX),
      capped: byCost.capped || wanted > LANES_MAX,
    };
  }
  return laneCount(packing);
}

/**
 * The directory the continuous-integration job keeps its own temporary
 * files in, where the lane is running inside one.
 */
function runnerTemp(): string | undefined {
  const at = Deno.env.get("RUNNER_TEMP");
  return at === undefined || at.length === 0 ? undefined : at;
}

/** Runs one lane, and says whether everything in it passed. */
export async function runLane(
  options: LaneOptions,
  deps: LaneDeps,
): Promise<boolean> {
  // Ahead of everything this lane reads, plans, opens or spawns, so that
  // no child of it inherits the token except through the capability.
  const githubToken = takeGithubToken();
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const { seen, fetched, laid, coverage } = await lanePlan(
    options,
    suites,
    deps,
  );
  const mine = laid.lanes.find((lane) => lane.lane === options.lane);
  if (mine === undefined) {
    // A lane outside the run it belongs to. Taking an empty share
    // instead would run nothing and exit zero, reporting a pass over
    // a set no lane ran, which is the one failure of this design
    // that would be silent.
    throw new RangeError(
      `lane ${options.lane} has no share of a plan for ` +
        `${laid.lanes.length} lanes`,
    );
  }
  const batches = batchesOf(suites, seen.manifest, mine.selections);
  const needs = new Set<CapabilityId>();
  for (const batch of batches) {
    for (const capability of batch.suite.needs) needs.add(capability);
  }
  if (options.described) {
    // Enough to tell the plan this runs from the one described, should
    // the two ever differ, and what it was projected to take beside the
    // batches' own timings.
    console.log(
      `ci-lane: running lane ${options.lane} of ${laid.lanes.length} as ` +
        `described: ` +
        `${batches.length} batch(es) of ` +
        `${batches.map((batch) => batch.suite.id).join(", ") || "nothing"}, ` +
        `projected at ${duration(mine.projectedSeconds)} of ` +
        `${duration(laid.budgetSeconds)}, ` +
        (fetched.absent === undefined
          ? `against ${fetched.objectName}`
          : `unselected: ${fetched.absent}`),
    );
  } else {
    // A mandatory identity is placed however much it costs, and this is
    // where a lane says it ran long.
    if (laid.overBudgetSeconds > 0) {
      console.log(
        `ci-lane: the mandatory set puts a lane ` +
          `${duration(laid.overBudgetSeconds)} past its ` +
          `${duration(laid.budgetSeconds)} budget`,
      );
    }
    describePlan(
      { ...options, of: laid.lanes.length },
      batches,
      [...needs].sort(),
      fetched,
      laid.unschedulable,
      laid.crowding,
      {
        manifest: seen.manifest,
        selections: mine.selections,
        projectedSeconds: mine.projectedSeconds,
      },
      laid.budgetSeconds,
    );
    describeWithheld(
      laid.withheld,
      seen.mandatory,
      new Set(
        laid.lanes.flatMap((lane) =>
          lane.selections
            .filter((selection) => selection.reason === "coverage-gate")
            .map((selection) => testIdentityKey(selection.entry.test))
        ),
      ),
    );
  }
  if (options.dryRun) return true;
  const stop = deps.stop?.() ?? new LaneStop();

  // Asked before any batch runs, because the first pattern a batch
  // compiles writes the file whatever the cache held.
  const compileCacheState = needs.has("compile-cache")
    ? await exists(path.join(options.root, COMPILE_CACHE_FILE))
      ? "warm"
      : "cold"
    : undefined;
  const temp = runnerTemp();
  const workDir = await Deno.makeTempDir({
    prefix: "ci-lane-",
    // Under the job's own temporary directory where there is one, which
    // is where a workflow step can upload what a failing lane left
    // behind.
    ...(temp === undefined ? {} : { dir: temp }),
  });
  // A lane that passed leaves nothing behind. A lane that failed in a job
  // keeps what its capabilities wrote, because a server's log is what
  // says why a suite could not reach it, and a workflow step can upload
  // the directory from the job's temporary directory. Anywhere else
  // nothing would collect it, and one directory would accumulate per
  // failed run.
  const leaveWorkDir = async (passed: boolean) => {
    if (passed || temp === undefined) {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  };
  const spool = (deps.spool ?? recordsDir)();
  // Where the work the packer projected starts: opening the capabilities
  // is part of it, and what came before is the prologue.
  const startedAt = performance.now();
  // The directory belongs to the lane from the moment it exists, and a
  // capability that refuses to open is one of the ways the lane ends.
  let opened;
  try {
    opened = await openCapabilities([...needs], {
      root: options.root,
      dryRun: false,
      workDir,
      ...(githubToken === undefined ? {} : { githubToken }),
      report: console.log,
    });
  } catch (error) {
    await leaveWorkDir(false);
    throw error;
  }
  if (spool !== undefined) {
    spoolRecords(
      spool,
      opened.timings.map((timing) =>
        timingRecord(
          `${LANE_MEASUREMENT_PREFIX}setup ${timing.capability}`,
          timing.seconds,
          true,
        )
      ),
    );
  }
  let ok = true;
  const conflicts: TestRecord[] = [];
  // Units a failure was seen in, as `suite\tunit` keys. A set holding one
  // of these measured its member through a failing test, so its number is
  // short by whatever that test would have reached.
  const failedUnits = new Set<string>();
  // What a failure here is allowed not to fail the run for. A pull
  // request holds these back rather than running them, unless a coverage
  // gate its plan chose runs their units, so on a pull request this is
  // only those.
  const nonGating = new Set(
    laid.nonGating.map((entry) => testIdentityKey(entry.test)),
  );
  // Identities a batch excused, and identities a batch failed that could
  // not excuse them. Only the first and not the second went without
  // failing the run.
  const excused = new Set<string>();
  const unexcused = new Set<string>();
  // The batches holding a test that failed every time, which the full run
  // runs again once every batch has run.
  const reruns: Rerun[] = [];
  let rerun: Reruns | undefined;
  try {
    for (const batch of batches) {
      // Two capabilities may export the same name and mean different
      // things by it, and the two server-execution arms can share a lane.
      const env = opened.envFor(batch.suite.needs);
      // A failure never stops the lane: one failing batch would otherwise
      // hide every batch and every repeat after it, and the point of a
      // lane is what it measured. Being told to stop does.
      if (stop.signal !== undefined) break;
      const result = await runBatch(
        batch,
        options,
        workDir,
        spool,
        env,
        batchCoverage(options, batch.suite.id, coverage),
        stop,
      );
      for (const conflict of result.conflicts) conflicts.push(conflict);
      // The records decide, rather than the command's exit status: a
      // runner that failed only on identities a flake rate excuses
      // exits non-zero and has told this run nothing it should stop
      // for, and a runner that exited zero having run none of its unit
      // has. What the exit status is still read for is an execution
      // that ended badly having recorded no failure at all, which the
      // records by themselves cannot describe.
      const accounting = accountFor(
        batch,
        mine.selections,
        result.executions,
        nonGating,
      );
      // An invocation is excused only when it accounted for every
      // identity it was asked to run that the tree holds: one that
      // recorded a failure and then stopped has run almost nothing while
      // satisfying any weaker test.
      const excusing = accounting.unaccounted.length === 0;
      describeAccounting(batch.suite.id, accounting, excusing);
      if (
        accounting.gating.length > 0 || accounting.silent.length > 0 ||
        result.unexplained > 0 ||
        (accounting.excused.length > 0 && !excusing)
      ) {
        ok = false;
      }
      for (const unit of accounting.failedUnits) {
        failedUnits.add(`${batch.suite.id}\t${unit}`);
      }
      for (const key of accounting.excused) {
        (excusing ? excused : unexcused).add(key);
      }
      if (options.full) {
        const failing = unsettled(batch, result.records);
        if (failing.size > 0) reruns.push({ batch, env, failing });
      }
    }
    if (stop.signal !== undefined) {
      ok = false;
      console.log(
        `ci-lane: stopped by ${stop.signal} before finishing its plan; ` +
          `it passes the signal on to whatever test command is running ` +
          `and starts nothing more`,
      );
    }
    // Written once every batch has run, so that a batch that withdrew an
    // excusal is heard before any is recorded, and a report of this run
    // says what it did not fail for from what it did rather than from
    // what the manifest would have it do.
    if (spool !== undefined) {
      spoolRecords(
        spool,
        [...excused].filter((key) => !unexcused.has(key)).sort().map((key) =>
          measurementRecord(excusedMeasurementName(key), 0, true)
        ),
      );
    }
    // After every batch, so that a rerun never displaces the work the lane
    // was packed with, and after the lane's verdict is settled, so that
    // nothing a rerun records can change it.
    if (options.full) {
      rerun = await rerunFailures(
        reruns,
        seen.manifest,
        mine.selections,
        options,
        workDir,
        spool,
        stop,
      );
      for (const conflict of rerun.conflicts) conflicts.push(conflict);
    }
  } catch (error) {
    // A lane whose loop threw has failed, whatever the batches it got
    // through said, and it is the one that most needs what the server
    // wrote. Recorded before the finally below reads it.
    ok = false;
    throw error;
  } finally {
    // Read while the servers are still up: closing one signals it and
    // returns, so a read after that races a shutdown still writing.
    // Only for a lane that failed -- a green run has nothing to explain,
    // and the logs are large.
    if (!ok) await describeCapabilityLogs(opened.logs);
    await opened.close();
    if (!ok) await leaveWorkDir(false);
  }
  // A lane that has passed so far keeps its directory until its coverage
  // is converted, which can still fail it.
  const undecided = ok;
  describeConflicts(conflicts);
  if (rerun !== undefined) describeReruns(rerun);
  // After the capabilities are closed, because a conversion is the lane's
  // own work and needs nothing a suite opened. A conversion that lost a
  // tracked file fails the lane: every line of that file reads as
  // uncovered downstream, so a gate scored from it would fail somebody
  // for a report that was never complete. A lane told to stop converts
  // nothing: the job ends it seconds after asking, and a conversion takes
  // minutes.
  const converted = stop.signal === undefined
    ? await convertCoverage(options)
    : { ok: true, reports: [] };
  if (!converted.ok) ok = false;
  // A signal can arrive while the conversion runs, and a lane told to stop
  // has failed whenever it was told.
  if (stop.signal !== undefined) ok = false;
  if (undecided) await leaveWorkDir(ok);
  const marked = await markMeasuredFailures(options, suites, failedUnits);
  if (compileCacheState !== undefined) {
    await writeCompileCacheState(options, compileCacheState);
  }
  // What the lane's work came to against what it was projected to come
  // to and the most it could come to inside the lane's bound, which is the
  // bound less the prologue the budget was derived with. Read last, so that
  // it holds everything the lane did after its prologue. The publisher
  // counts from these how many lanes ran past their bound, and how many of
  // those the packer had expected to. The packer charges nothing for
  // reruns, so their time is left out of the lane's work and recorded
  // apart.
  if (spool !== undefined) {
    spoolRecords(spool, [
      timingRecord(
        laneMeasurementName("spent"),
        (performance.now() - startedAt) / 1000 - (rerun?.seconds ?? 0),
        ok,
      ),
      ...(rerun === undefined
        ? []
        : [timingRecord(RERUN_MEASUREMENT_NAME, rerun.seconds, ok)]),
      timingRecord(
        laneMeasurementName("projected"),
        mine.projectedSeconds,
        ok,
      ),
      timingRecord(
        laneMeasurementName("bound"),
        laid.boundSeconds - LANE_PROLOGUE_SECONDS,
        ok,
      ),
    ]);
  }
  describeCoverage(coverage, converted.reports, marked);
  return ok;
}

/**
 * Says which coverage gates the plan chose, and what this lane measured for
 * them. A gate the change reached and the plan did not choose is named
 * here too, so that a set nothing measured is visible rather than absent.
 */
export function describeCoverage(
  gate: CoverageGateSelection,
  reports: readonly string[],
  marked: readonly string[] = [],
): void {
  if (
    gate.reached.length === 0 && gate.sets.length === 0 &&
    reports.length === 0 && marked.length === 0
  ) {
    return;
  }
  const lines = ["## Coverage", ""];
  const chosen = new Set(gate.sets.map(measuredSetName));
  if (chosen.size > 0) {
    lines.push("Measured sets whose gates the plan chose, run whole:", "");
    for (const name of chosen) lines.push(`- ${name}`);
  }
  const passedOver = gate.reached.map(measuredSetName)
    .filter((name) => !chosen.has(name));
  if (passedOver.length > 0) {
    if (chosen.size > 0) lines.push("");
    lines.push(
      "Measured sets the change reaches whose gates the plan did not " +
        "choose, which nothing measures:",
      "",
    );
    for (const name of passedOver) lines.push(`- ${name}`);
  }
  if (reports.length > 0) {
    // A report belonging to a set is named as the set, so one summary
    // does not spell one thing two ways. What is left is a directory a
    // suite wrote and no set is scored from, which only the full run's
    // merge reads.
    const named = new Map(
      [...gate.reached, ...gate.sets].map((
        ref,
      ) => [measuredSetDirectory(ref), measuredSetName(ref)]),
    );
    lines.push("", "Reports this lane wrote:", "");
    for (const report of reports) {
      lines.push(`- ${named.get(report) ?? report}`);
    }
  }
  if (marked.length > 0) {
    lines.push(
      "",
      "Measured through a failing test, so no baseline is published:",
      "",
    );
    for (const set of marked) lines.push(`- ${set}`);
  }
  say(lines);
}

/**
 * Runs the lane the way the job runs it, and answers with the status it
 * would exit with: two for a command line this cannot read, one for a
 * lane that failed, zero otherwise.
 */
export async function main(
  args: readonly string[],
  root: string,
  deps: LaneDeps,
): Promise<number> {
  const options = parseLaneArgs(args, root);
  if (options === undefined) {
    console.error(
      "usage: ci-lane.ts [--lane N] [--of M] [--full] [--scale <n>] " +
        "[--dry-run] [--described] [--lane-count [--label <name>]...] " +
        "[--base <ref>] [--at <iso>] [--coverage-dir <dir>]",
    );
    return 2;
  }
  if (options.laneCount) {
    // A pull request's labels decide whether it is the full run and how
    // much it spends on tests chosen by score. One this cannot read stops
    // the run here, before any lane starts, and says why.
    const requested = options.labels === undefined
      ? { ok: true as const, full: options.full, scale: options.scale ?? 1 }
      : requestedRun(options.labels);
    if (!requested.ok) {
      console.error(`::error::${requested.problem}`);
      return 1;
    }
    const run = await runLanes({
      ...options,
      full: requested.full,
      scale: requested.scale,
    }, deps);
    console.log(JSON.stringify(run));
    return 0;
  }
  return await runLane(options, deps) ? 0 : 1;
}

/**
 * What the lane the command line runs reads its manifest from, and what
 * stops it: the signals a job stops a step with. A lane that only plans
 * or counts leaves those signals to end it as they would any process.
 */
const store: LaneDeps = {
  manifest: fetchManifest,
  stop: () => {
    const stop = new LaneStop();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      Deno.addSignalListener(signal, () => stop.receive(signal));
    }
    return stop;
  },
};

// `Deno.exitCode` rather than `Deno.exit`, which would end the process
// before the unload handlers run — and one of those is what writes a
// test run's name map into its spool.
//
// The seed is settled before any invocation is built, so that every
// command this lane builds and every task it starts shuffles the same
// way.
if (import.meta.main) {
  pinShuffleSeed();
  Deno.exitCode = await main(Deno.args, Deno.cwd(), store);
}
