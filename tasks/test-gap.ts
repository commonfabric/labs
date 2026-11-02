#!/usr/bin/env -S deno run -A

/**
 * Runs, on a workstation, the tests a change reaches that the pull
 * request's default continuous-integration selection leaves out.
 *
 *   deno task test-gap [--dry-run] [--base <ref>] [--seconds <n>]
 *
 * A pull request's lanes run the units the change edits and a budget of
 * tests chosen by score, so a test that imports a changed module can go
 * unrun until the default branch runs everything. This reads which test
 * files the change reaches through their imports, packs the pull request's
 * plan with the lanes' own code, and takes away every test that plan runs.
 * What is left is chosen nearest the change first, passing over each unit
 * that would take the run past `--seconds` of what the manifest says the
 * work costs. The run ends with a summary of what ran, what failed, and what was
 * left out.
 *
 * The change is everything the working tree differs from the merge base
 * by, committed or not, since that is what the pull request will carry.
 * The run writes nothing the lanes' cost model reads: its tests' records
 * go where a local `deno task test` sends them, and the lane's own
 * measurements of its batches are not written at all.
 */

import { existsSync } from "@std/fs";
import { join, resolve } from "@std/path";
import {
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { pinShuffleSeed } from "@commonfabric/test-support/shuffle";
import { maxOf } from "@commonfabric/collections/math";
import {
  cachedBinaries,
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  openCapabilities,
  type OpenedCapabilities,
  resolveCapabilities,
  takeGithubToken,
} from "./ci-capabilities.ts";
import {
  addLaneResults,
  batchesOf,
  describeCapabilityLogs,
  describeConflicts,
  gitOutput,
  judgeBatch,
  landedFiles,
  type LaneDeps,
  type LaneOptions,
  LaneStop,
  pathsOf,
  planOver,
  rerunCommands,
  resolveManifest,
  runBatch,
  spoolRecords,
  stopOnSignals,
} from "./ci-lane.ts";
import {
  finishRunRecording,
  type RunRecording,
  startRunRecording,
} from "./test-records.ts";
import { pricedForRun, type PricedManifest } from "./test-selection/census.ts";
import { duration } from "./test-selection/duration.ts";
import type { Manifest, ManifestEntry } from "./test-selection/manifest.ts";
import {
  excused,
  type Plan,
  type Selection,
  suiteCharge,
} from "./test-selection/plan.ts";
import { fetchManifest } from "./test-selection/store.ts";
import {
  type FailedCommand,
  passed,
  printSummary,
  type RunSummary,
  type TestResult,
  testTitle,
} from "./test-summary.ts";
import { loadTopology, type Suite } from "./test-topology.ts";
import { BUILDING_SUITE } from "./test-topology/binaries.ts";
import { changeReach, MODULE_EXTENSIONS } from "./typecheck.ts";

/**
 * Seconds of work, as the manifest prices it, that a run takes on where
 * `--seconds` names no other figure.
 */
export const GAP_SECONDS = 600;

/** How many left-out units a report names before counting the rest. */
const NAMED_LEFT_OUT = 10;

const USAGE = `usage: test-gap [--dry-run] [--base <ref>] [--seconds <n>]

Runs the tests the change in this working tree reaches through its imports
that a pull request's default CI selection would not run, nearest the change
first, passing over each test unit that would take the run past <n> seconds
of work as the test-selection manifest prices it (default ${GAP_SECONDS}).

  --dry-run      print what would run, and run nothing
  --base <ref>   what the change is measured against (default upstream/main
                 where that exists, and origin/main otherwise)
  --seconds <n>  the budget, in seconds of work as the manifest prices it
`;

/** What the command line asked for. */
export interface GapOptions {
  dryRun: boolean;
  base?: string;
  seconds: number;
}

/** Reads the command line, or returns undefined for a malformed one. */
export function parseGapArgs(args: readonly string[]): GapOptions | undefined {
  const options: GapOptions = { dryRun: false, seconds: GAP_SECONDS };
  const rest = [...args];
  for (let flag = rest.shift(); flag !== undefined; flag = rest.shift()) {
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) return undefined;
    if (flag === "--base") {
      options.base = value;
    } else if (flag === "--seconds") {
      const seconds = Number(value);
      if (value.trim() === "" || !Number.isFinite(seconds) || seconds <= 0) {
        return undefined;
      }
      options.seconds = seconds;
    } else {
      return undefined;
    }
  }
  return options;
}

/**
 * What a change is measured against where the command line names
 * nothing: `upstream/main` in a checkout of a fork, which is where a pull
 * request's base lives, and `origin/main` otherwise.
 */
export async function defaultBase(root: string): Promise<string> {
  const upstream = await new Deno.Command("git", {
    args: ["rev-parse", "--verify", "--quiet", "upstream/main"],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  return upstream.success ? "upstream/main" : "origin/main";
}

/**
 * The files the working tree differs from its merge base with `base` by,
 * whether committed or not, and the files that are new and not ignored.
 */
export async function localChanges(
  root: string,
  base: string,
): Promise<Set<string>> {
  const git = (args: readonly string[]) =>
    gitOutput(root, args, `cannot list the changes against ${base}`);
  return new Set([
    ...pathsOf(await git(["diff", "-z", "--name-only", "--merge-base", base])),
    ...pathsOf(await git(["ls-files", "-z", "--others", "--exclude-standard"])),
  ]);
}

/**
 * The files of the tree at `root` each unit of `suites` runs, as
 * `<suite>\t<unit>`: what the suite's `sourcesOf` declares for it, or the
 * file it is named for. A unit naming no file in the tree has none. A suite
 * of verdicts over other suites is no suite a run runs, and has no units
 * here.
 */
export function unitSources(
  root: string,
  suites: readonly Suite[],
): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const suite of suites) {
    if (suite.judges !== undefined) continue;
    for (const unit of suite.units) {
      const declared = suite.sourcesOf?.(unit) ?? [];
      sources.set(
        `${suite.id}\t${unit}`,
        (declared.length > 0 ? declared : [unit]).filter((file) =>
          existsSync(join(root, file), { isFile: true })
        ),
      );
    }
  }
  return sources;
}

/** The modules among `sources`, which are what the import graph starts from. */
export function sourceModules(
  sources: ReadonlyMap<string, readonly string[]>,
): string[] {
  const modules = new Set<string>();
  for (const files of sources.values()) {
    for (const file of files) {
      if (MODULE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
        modules.add(file);
      }
    }
  }
  return [...modules].sort();
}

/**
 * The units `reach`, what `changeReach()` made of the change to `changed`,
 * reaches, each as `<suite>\t<unit>` against the number of steps between it
 * and the change. `sources` is what `unitSources()` says each unit runs.
 *
 * A unit is as far from the change as the nearest of the files it runs, and
 * a unit the change touches, or one of whose files it touches, is at no
 * steps. A change reaching everything
 * reaches every unit that runs a file, at one step. A unit running no file,
 * such as a repository gate, is reached only by a change
 * touching it: mapping any other change onto it is its suite's own work,
 * and the lanes run whatever the suite maps.
 */
export function unitsReached(
  changed: ReadonlySet<string>,
  reach: ReadonlyMap<string, number> | "everything",
  sources: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const reached = new Map<string, number>();
  for (const [key, files] of sources) {
    const unit = key.slice(key.indexOf("\t") + 1);
    let distance: number | undefined;
    if (changed.has(unit) || files.some((file) => changed.has(file))) {
      distance = 0;
    } else if (reach === "everything") {
      distance = files.length === 0 ? undefined : 1;
    } else {
      for (const file of files) {
        const hops = reach.get(file);
        if (hops !== undefined) distance = Math.min(distance ?? hops, hops);
      }
    }
    if (distance !== undefined) reached.set(key, distance);
  }
  return reached;
}

/** One unit the change reaches, and the tests in it the pull request skips. */
export interface GapUnit {
  suite: string;
  unit: string;

  /** Steps between the unit and the change, as `changeReach()` counts them. */
  hops: number;

  /** The unit's tests that the pull request's plan does not run. */
  selections: Selection[];

  /** Whether the pull request's plan runs other tests of the unit. */
  partly: boolean;
}

/** What a change reaches that its pull request skips, and what of it runs. */
export interface Gap {
  /** How many units the change reaches. */
  reached: number;

  /** How many of those the pull request's plan runs every test of. */
  covered: number;

  /** The units that run, in the order they run. */
  chosen: GapUnit[];

  /** The units that would have taken the run past its budget. */
  over: GapUnit[];

  /**
   * The units a run on this workstation does not run, each with why: its
   * suite needs a capability that shares the checkout with its owner's own
   * work, or one whose provision the machine lacks.
   */
  apart: { unit: GapUnit; reason: string }[];

  /** Seconds the chosen units are projected to take, setup included. */
  projectedSeconds: number;

  budgetSeconds: number;
}

/**
 * `registry` as a run on a workstation opens it: a capability that prepares
 * a continuous-integration runner opens nothing and exports nothing, and the
 * rest are as they are.
 */
export function workstationRegistry(
  registry: ReadonlyMap<CapabilityId, Capability>,
): Map<CapabilityId, Capability> {
  return new Map(
    [...registry].map(([id, capability]) => [
      id,
      capability.preparesRunner === true
        ? {
          ...capability,
          open: () =>
            Promise.resolve({ env: {}, close: () => Promise.resolve() }),
        }
        : capability,
    ]),
  );
}

/**
 * What this machine lacks, by capability, of what the capabilities in
 * `registry` that prepare a continuous-integration runner would provide,
 * as each one's `missing` says. Nothing is changed by asking.
 */
export async function machineLacks(
  registry: ReadonlyMap<CapabilityId, Capability>,
  root: string,
): Promise<Map<CapabilityId, string>> {
  const lacking = new Map<CapabilityId, string>();
  for (const [id, capability] of registry) {
    const reason = await capability.missing?.({ root });
    if (reason !== undefined) lacking.set(id, reason);
  }
  return lacking;
}

/**
 * What opening each capability a run on a workstation opens is projected to
 * take, by the manifest's cost model: what a lane is charged for opening
 * it, and, for one that builds a binary, what the test building that binary
 * takes, since such a run builds it afresh where a lane mostly restores it.
 */
export function setupCosts(manifest: Manifest): Map<CapabilityId, number> {
  const costs = new Map<CapabilityId, number>();
  for (const [id, capability] of CAPABILITIES) {
    costs.set(
      id,
      capability.preparesRunner === true
        ? 0
        : manifest.calibration.setupCost[id] ?? 0,
    );
  }
  for (const entry of manifest.entries) {
    for (const [id, capability] of CAPABILITIES) {
      if (capability.builds === undefined) continue;
      if (
        entry.suite === BUILDING_SUITE[capability.builds] &&
        entry.unit === cachedBinaries()[capability.builds].build
      ) {
        costs.set(id, (costs.get(id) ?? 0) + entry.cost);
      }
    }
  }
  return costs;
}

/**
 * What opening the capabilities a run on a workstation opens for suites
 * needing `needs` is projected to take, at `costs`.
 */
function setupSeconds(
  costs: ReadonlyMap<CapabilityId, number>,
  needs: Iterable<CapabilityId>,
): number {
  let seconds = 0;
  for (const id of resolveCapabilities(needs)) seconds += costs.get(id) ?? 0;
  return seconds;
}

/**
 * Which tests of the units `reached` holds the pull request's plan `ci`
 * leaves out, and which of those run within `budgetSeconds`.
 *
 * The units run nearest the change first, and among units equally near,
 * the one holding the test with the highest score first. A unit that would
 * take the run past the budget is left out and the next is tried, so a
 * cheap unit further out still runs where an expensive one nearer did not
 * fit. A unit this workstation cannot run is set apart with the reason
 * before anything is charged. Each test runs once.
 */
export function gapOf(input: {
  manifest: Manifest;
  suites: readonly Suite[];
  ci: Pick<Plan, "lanes">;
  reached: ReadonlyMap<string, number>;
  budgetSeconds: number;

  /** What this machine lacks, by capability, as `machineLacks()` says. */
  lacking?: ReadonlyMap<CapabilityId, string>;
}): Gap {
  // A unit its suite runs whole runs every test it holds once the plan
  // selects any of them.
  const whole = new Map(
    input.suites.map((suite) => [suite.id, new Set(suite.whole)]),
  );
  const running = new Set<string>();
  const runWhole = new Set<string>();
  for (const lane of input.ci.lanes) {
    for (const { entry } of lane.selections) {
      running.add(testIdentityKey(entry.test));
      if (whole.get(entry.suite)?.has(entry.unit)) {
        runWhole.add(`${entry.suite}\t${entry.unit}`);
      }
    }
  }
  const inUnit = new Map<
    string,
    { suite: string; unit: string; hops: number; entries: ManifestEntry[] }
  >();
  for (const entry of input.manifest.entries) {
    const key = `${entry.suite}\t${entry.unit}`;
    const hops = input.reached.get(key);
    if (hops === undefined) continue;
    const held = inUnit.get(key);
    if (held !== undefined) held.entries.push(entry);
    else {
      inUnit.set(key, {
        suite: entry.suite,
        unit: entry.unit,
        hops,
        entries: [entry],
      });
    }
  }
  let covered = 0;
  const units: { unit: GapUnit; entries: ManifestEntry[]; best: number }[] = [];
  for (const [key, { suite, unit, hops, entries }] of inUnit) {
    const left = runWhole.has(key)
      ? []
      : entries.filter((entry) => !running.has(testIdentityKey(entry.test)));
    if (left.length === 0) {
      covered += 1;
      continue;
    }
    units.push({
      unit: {
        suite,
        unit,
        hops,
        selections: left.map((entry) => ({
          entry,
          reason: "changed",
          repeats: 1,
        })),
        partly: left.length < entries.length,
      },
      entries,
      best: maxOf(left.map((entry) => entry.score)),
    });
  }
  units.sort((a, b) =>
    a.unit.hops - b.unit.hops || b.best - a.best ||
    (a.unit.suite < b.unit.suite ? -1 : a.unit.suite > b.unit.suite ? 1 : 0) ||
    (a.unit.unit < b.unit.unit ? -1 : a.unit.unit > b.unit.unit ? 1 : 0)
  );
  // What each suite's share is charged is worked out again only for the
  // suite a unit adds to. The tests around a selection are read from the
  // entries of its unit, so each suite is priced over the entries of the
  // units it holds.
  const suites = new Map(input.suites.map((suite) => [suite.id, suite]));
  const costs = setupCosts(input.manifest);
  const held = new Map<
    string,
    { selections: Selection[]; entries: ManifestEntry[]; seconds: number }
  >();
  let tests = 0;
  let needs = new Set<CapabilityId>();
  const chosen: GapUnit[] = [];
  const over: GapUnit[] = [];
  const apart: Gap["apart"] = [];
  let projected = 0;
  for (const { unit, entries } of units) {
    const reasons = resolveCapabilities(suites.get(unit.suite)?.needs ?? [])
      .flatMap((id) =>
        CAPABILITIES.get(id)?.sharesCheckout === true
          ? ["its servers share the checkout with its owner's own"]
          : input.lacking?.get(id) ?? []
      );
    if (reasons.length > 0) {
      apart.push({ unit, reason: reasons.join("; ") });
      continue;
    }
    const was = held.get(unit.suite) ??
      { selections: [], entries: [], seconds: 0 };
    const share = {
      selections: [...was.selections, ...unit.selections],
      entries: [...was.entries, ...entries],
      seconds: 0,
    };
    share.seconds = suiteCharge(
      { ...input.manifest, entries: share.entries },
      unit.suite,
      share.selections,
    );
    const opening = new Set(needs);
    for (const need of suites.get(unit.suite)?.needs ?? []) opening.add(need);
    const trying = tests - was.seconds + share.seconds +
      setupSeconds(costs, opening);
    if (trying > input.budgetSeconds) {
      over.push(unit);
      continue;
    }
    held.set(unit.suite, share);
    tests += share.seconds - was.seconds;
    needs = opening;
    projected = trying;
    chosen.push(unit);
  }
  return {
    reached: input.reached.size,
    covered,
    chosen,
    over,
    apart,
    projectedSeconds: projected,
    budgetSeconds: input.budgetSeconds,
  };
}

/** How near the change a unit is, in words. */
function nearness(hops: number): string {
  if (hops === 0) return "touched by the change";
  return `${hops} ${hops === 1 ? "step" : "steps"} from the change`;
}

/** One line naming a unit, how near the change it is, and what it holds. */
function unitLine(unit: GapUnit): string {
  const tests = unit.selections.length;
  return `  ${unit.unit} (${unit.suite}; ${nearness(unit.hops)}; ` +
    `${tests} ${tests === 1 ? "test" : "tests"}` +
    `${unit.partly ? " the pull request skips" : ""})`;
}

/**
 * The lines naming the units left out, the first few of each kind by name:
 * those the budget left out, and those a workstation runs none of.
 */
function leftOutLines(gap: Gap): string[] {
  const named = (units: readonly GapUnit[]) => {
    const rest = units.length - NAMED_LEFT_OUT;
    return [
      ...units.slice(0, NAMED_LEFT_OUT).map(unitLine),
      ...(rest > 0 ? [`  and ${rest} more`] : []),
    ];
  };
  return [
    ...(gap.over.length === 0 ? [] : [
      `test-gap: left out ${gap.over.length} test unit(s) the change ` +
      `reaches, which would take the run past its ` +
      `${duration(gap.budgetSeconds)} budget; --seconds raises it:`,
      ...named(gap.over),
    ]),
    ...(gap.apart.length === 0 ? [] : [
      `test-gap: left out ${gap.apart.length} test unit(s) the change ` +
      `reaches that this machine does not run:`,
      ...gap.apart.slice(0, NAMED_LEFT_OUT).map(({ unit, reason }) =>
        `${unitLine(unit)}: ${reason}`
      ),
      ...(gap.apart.length > NAMED_LEFT_OUT
        ? [`  and ${gap.apart.length - NAMED_LEFT_OUT} more`]
        : []),
    ]),
  ];
}

/** What a run would do, as the lines a dry run prints and a run begins with. */
export function describeGap(gap: Gap, changed: number, base: string): string[] {
  const lines = [
    `test-gap: the change touches ${changed} file(s) against ${base}, and ` +
    `reaches ${gap.reached} test unit(s). The pull ` +
    `request's default CI selection runs every test of ${gap.covered} of ` +
    `them, and leaves out tests of ${
      gap.chosen.length + gap.over.length + gap.apart.length
    }.`,
  ];
  const running = gap.chosen.length === 0 ? ["test-gap: nothing to run."] : [
    `test-gap: running ${gap.chosen.length} test unit(s), projected at ` +
    `${duration(gap.projectedSeconds)} of the ` +
    `${duration(gap.budgetSeconds)} budget, chosen nearest the change first:`,
    ...gap.chosen.map(unitLine),
  ];
  return [...lines, ...running, ...leftOutLines(gap)];
}

/** A worktree `snapshotTree()` made, and how to take it away again. */
export interface Snapshot {
  /** The worktree's directory, absolute. */
  tree: string;

  /** Removes the worktree, the repository's record of it, and its directory. */
  remove(): Promise<void>;
}

/**
 * Makes a detached worktree of the repository at `root`, in a new
 * temporary directory under `under`, or under the system's where that is
 * not given, holding its working tree as it stands: every file git tracks
 * or would track, as it is now, committed or not, and nothing it ignores.
 * The snapshot is a commit on no branch, recorded through an index of its
 * own that starts as a copy of the repository's, so the repository's index,
 * branches and working tree are left as they were. Every git command runs
 * with this process's environment less whatever names another repository,
 * index or work tree, and with the repository's hooks and file-system
 * monitor turned off, since those are for its owner's checkouts. A snapshot
 * that fails leaves nothing behind.
 */
export async function snapshotTree(
  root: string,
  under?: string,
): Promise<Snapshot> {
  const directory = await Deno.makeTempDir({
    prefix: "test-gap-build-",
    ...(under === undefined ? {} : { dir: under }),
  });
  const tree = join(directory, "tree");
  const ambient = Deno.env.toObject();
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) {
    delete ambient[name];
  }
  const git = (
    args: readonly string[],
    failure: string,
    env: Record<string, string> = {},
  ) =>
    gitOutput(
      root,
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      failure,
      { ...ambient, ...env },
    );
  try {
    const making = "cannot snapshot the working tree";
    // The copy keeps the original's modification time, by which git tells
    // a file edited in the second the index was written from one that was
    // not, so such a file is read again rather than taken as unchanged.
    const index = join(directory, "index");
    const original = resolve(
      root,
      (await git(["rev-parse", "--git-path", "index"], making)).trim(),
    );
    await Deno.copyFile(original, index);
    const { atime, mtime } = await Deno.stat(original);
    if (atime === null || mtime === null) {
      throw new Error(`cannot read when ${original} was written`);
    }
    await Deno.utime(index, atime, mtime);
    await git(["add", "--all"], making, { GIT_INDEX_FILE: index });
    const written = (await git(["write-tree"], making, {
      GIT_INDEX_FILE: index,
    })).trim();
    const commit = (await git(
      ["commit-tree", written, "-p", "HEAD", "-m", "test-gap snapshot"],
      making,
      {
        GIT_AUTHOR_NAME: "test-gap",
        GIT_AUTHOR_EMAIL: "test-gap@localhost",
        GIT_COMMITTER_NAME: "test-gap",
        GIT_COMMITTER_EMAIL: "test-gap@localhost",
      },
    )).trim();
    await git(["worktree", "add", "--detach", tree, commit], making);
  } catch (error) {
    await Deno.remove(directory, { recursive: true }).catch((cleanup) =>
      console.log(`test-gap: could not remove ${directory}: ${cleanup}`)
    );
    throw error;
  }
  return {
    tree,
    async remove() {
      const failures: unknown[] = [];
      await git(
        ["worktree", "remove", "--force", tree],
        "cannot remove " +
          "the snapshot, whose record `git worktree prune` drops",
      ).catch(
        (error) => failures.push(error),
      );
      await Deno.remove(directory, { recursive: true }).catch((error) =>
        failures.push(error)
      );
      if (failures.length > 0) {
        throw new Error(`cannot remove ${directory}: ${failures.join("; ")}`);
      }
    },
  };
}

/** What running a gap came to. */
export interface GapRun {
  ok: boolean;

  /**
   * What the run's summary block says, as a lane's says it: every test the
   * run reported, with each failure the run fails for, each command that
   * failed with no failing test to say why, and anything else that kept the
   * run from passing.
   */
  summary: RunSummary;

  /** The failures a flake rate excused, which do not fail the run. */
  excused: TestRecord[];

  /** What the run could not clean up after itself, and why. */
  leftovers: string[];

  /** The run's directory, kept because the run did not pass. */
  kept?: string;
}

/** What a gap's run needs besides the gap. */
export interface GapContext {
  root: string;
  base: string;
  suites: readonly Suite[];

  /** The manifest the gap's selections were read from, priced. */
  manifest: PricedManifest;

  /** Where the tests' records go, or nothing where they go nowhere. */
  spool: string | undefined;

  stop: LaneStop;

  /** The GitHub token, for the suites that declare they ask the API. */
  githubToken?: string;

  /** Every capability, by name. Defaults to `CAPABILITIES`. */
  registry?: ReadonlyMap<CapabilityId, Capability>;
}

/**
 * Runs the units `gap` chose, the way a lane runs its batches, and judges
 * each batch as a pull request's lane judges it, with `judgeBatch()`. A test
 * the manifest holds back as too flaky to judge a change by is excused as a
 * lane excuses it, so where it is the only failure, the run passes and lists
 * it apart.
 *
 * The capabilities that prepare a continuous-integration runner are left to
 * the workstation. A binary a capability builds is built afresh in a
 * snapshot of the working tree, made by `snapshotTree()` and removed when
 * the run ends: one left in the lanes' cache may have been built from other
 * sources, and a build rewrites files of the tree it runs in while it runs.
 * The run's directory, which holds the servers' logs and the runners'
 * reports, is removed where the run passed and kept otherwise, whatever
 * stopped it.
 */
export async function runGap(gap: Gap, context: GapContext): Promise<GapRun> {
  const startedAt = performance.now();
  const selections = gap.chosen.flatMap((unit) => unit.selections);
  const flaky = new Set(
    excused(context.manifest).map((held) => testIdentityKey(held.test)),
  );
  const registry = workstationRegistry(context.registry ?? CAPABILITIES);
  const workDir = await Deno.makeTempDir({ prefix: "test-gap-" });
  const batches = batchesOf(context.suites, context.manifest, selections);
  const needs = new Set<CapabilityId>();
  for (const batch of batches) {
    for (const need of batch.suite.needs) needs.add(need);
  }
  const lane: LaneOptions = {
    lane: 1,
    full: false,
    dryRun: false,
    laneCount: false,
    root: context.root,
    base: context.base,
  };
  const tests = new Map<string, TestResult>();
  const commands: FailedCommand[] = [];
  const notes: string[] = [];
  const run: GapRun = {
    ok: false,
    summary: { tests: [], commands, notes, seconds: 0 },
    excused: [],
    leftovers: [],
  };
  const opening = resolveCapabilities(needs, registry);
  const building = opening.some((id) => registry.get(id)?.builds !== undefined);
  let snapshot: Snapshot | undefined;
  let opened: OpenedCapabilities | undefined;
  const conflicts: TestRecord[] = [];
  let finished = false;
  try {
    if (building) snapshot = await snapshotTree(context.root);
    opened = await openCapabilities(opening, {
      root: context.root,
      dryRun: false,
      workDir,
      ...(snapshot === undefined ? {} : { buildFrom: snapshot.tree }),
      ...(context.githubToken === undefined
        ? {}
        : { githubToken: context.githubToken }),
      report: console.log,
    }, registry);
    let ok = true;
    for (const batch of batches) {
      if (context.stop.signal !== undefined) break;
      const result = await runBatch(
        batch,
        lane,
        workDir,
        undefined,
        opened.envFor(batch.suite.needs),
        undefined,
        context.stop,
      );
      if (context.spool !== undefined) {
        spoolRecords(context.spool, result.records);
      }
      for (const conflict of result.conflicts) conflicts.push(conflict);
      const { passed: held, accounting, excusing } = judgeBatch(
        batch,
        selections,
        result,
        flaky,
      );
      if (!held) ok = false;
      const failing = new Set([
        ...accounting.gating,
        ...(excusing ? [] : accounting.excused),
      ]);
      addLaneResults(tests, result.records, result.failures, failing);
      for (const record of result.records) {
        if (
          record.outcome === "fail" &&
          !failing.has(testIdentityKey(record.test))
        ) {
          run.excused.push(record);
        }
      }
      for (const { name } of accounting.silent) {
        commands.push({
          label: `${batch.suite.id} ${name}`,
          reason: "ran no test",
        });
      }
      if (result.unexplained > 0) {
        commands.push({
          label: batch.suite.id,
          reason: `${result.unexplained} command(s) failed having recorded ` +
            "no failing test",
        });
      }
    }
    if (context.stop.signal !== undefined) {
      ok = false;
      notes.push(
        `Stopped by ${context.stop.signal} before running everything.`,
      );
    }
    describeConflicts(conflicts);
    run.ok = ok;
    finished = true;
  } finally {
    // Every step runs whatever the one before it did, and one that fails is
    // recorded rather than thrown, so it can neither take another step with
    // it nor stand in for what ended the run.
    const tidy = async (what: string, step: () => Promise<void>) => {
      try {
        await step();
        return true;
      } catch (error) {
        run.leftovers.push(`could not ${what}: ${error}`);
        return false;
      }
    };
    const logs = opened?.logs ?? [];
    if (!run.ok) {
      await tidy("print the servers' logs", () => describeCapabilityLogs(logs));
    }
    await tidy("close what the run opened", async () => {
      await opened?.close();
    });
    await tidy("remove the snapshot", async () => {
      await snapshot?.remove();
    });
    const removed = run.ok &&
      await tidy(
        `remove ${workDir}`,
        () => Deno.remove(workDir, { recursive: true }),
      );
    if (!removed) {
      run.kept = workDir;
      console.log(
        `test-gap: kept ${workDir}, which holds the run's logs and ` +
          `the servers' stores`,
      );
    }
    // A run that threw returns nothing to print these after its summary.
    if (!finished) {
      for (const leftover of run.leftovers) {
        console.log(`test-gap: ${leftover}`);
      }
    }
  }
  await rerunCommands(context.root)(tests.values());
  run.summary = {
    tests: [...tests.values()],
    commands,
    notes,
    logs: "the output above" +
      (run.kept === undefined ? "" : `, and ${run.kept}`),
    seconds: (performance.now() - startedAt) / 1000,
  };
  if (!run.ok && passed(run.summary)) {
    notes.push("The run failed for a reason the output above gives.");
  }
  return run;
}

/**
 * What a run prints after its summary block: what it could not clean up,
 * the failures a flake rate excused, and the units the run left out.
 */
export function afterSummaryLines(gap: Gap, run: GapRun): string[] {
  return [
    ...(run.leftovers.length === 0 ? [] : [
      "",
      "Left behind:",
      ...run.leftovers.map((leftover) => `  ${leftover}`),
    ]),
    ...(run.excused.length === 0 ? [] : [
      "",
      "Failed, and held back from pull requests as too flaky to judge a " +
      "change by, so not failing this run:",
      ...run.excused.map((record) => `  ${testTitle(record)}`),
    ]),
    ...(gap.over.length + gap.apart.length === 0 ? [] : [""]),
    ...leftOutLines(gap),
  ];
}

/** What the command reads besides the working tree. */
export interface GapDeps extends Pick<LaneDeps, "manifest" | "topology"> {
  /** Where the run's test records go, and how they are sent once it ends. */
  recording: () => Promise<RunRecording>;

  /** What tells the run to stop part way through. */
  stop: () => LaneStop;

  /**
   * The GitHub token, taken out of the process's environment before
   * anything is planned or run, as a lane takes it.
   */
  githubToken?: string;

  /** Every capability, by name. Defaults to `CAPABILITIES`. */
  registry?: ReadonlyMap<CapabilityId, Capability>;
}

/**
 * Runs the command, and returns the status it exits with: two for a
 * command line this cannot read, one for a run that failed, and zero
 * otherwise, a dry run included. What stops it from planning, such as a
 * manifest store it cannot read, is thrown.
 */
export async function main(
  args: readonly string[],
  root: string,
  deps: GapDeps,
): Promise<number> {
  const options = parseGapArgs(args);
  if (options === undefined) {
    console.error(USAGE);
    return 2;
  }
  const base = options.base ?? await defaultBase(root);
  const changed = await localChanges(root, base);
  const suites = await (deps.topology ?? loadTopology)(root);
  const fetched = await resolveManifest({ root }, deps);
  if (fetched.unreachable) {
    throw new Error(
      `test-gap: the manifest store could not be read (${fetched.absent}), ` +
        "so what the pull request's lanes would run is unknown",
    );
  }
  const landed = await landedFiles(root, base, fetched.manifest?.commit);
  const { read, laid } = planOver({
    suites,
    manifest: fetched.manifest,
    changed,
    landed,
    full: false,
  });
  // A pull request prices the suites of the coverage gates it chose as run
  // with coverage on. This run measures nothing, so it prices none so.
  const manifest = pricedForRun(read, suites, () => false).manifest;
  const sources = unitSources(root, suites);
  const reach = await changeReach(root, () => sourceModules(sources));
  const gap = gapOf({
    manifest,
    suites,
    ci: laid,
    reached: unitsReached(changed, reach(changed), sources),
    budgetSeconds: options.seconds,
    lacking: await machineLacks(deps.registry ?? CAPABILITIES, root),
  });
  for (const line of describeGap(gap, changed.size, base)) console.log(line);
  if (options.dryRun || gap.chosen.length === 0) return 0;
  const recording = await deps.recording();
  let run: GapRun;
  try {
    run = await runGap(gap, {
      root,
      base,
      suites,
      manifest,
      spool: recording.mode === "own"
        ? recording.spool.dir
        : recording.mode === "join"
        ? recording.dir
        : undefined,
      stop: deps.stop(),
      ...(deps.githubToken === undefined
        ? {}
        : { githubToken: deps.githubToken }),
      ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    });
  } finally {
    await finishRunRecording(recording);
  }
  printSummary(run.summary);
  for (const line of afterSummaryLines(gap, run)) console.log(line);
  return run.ok ? 0 : 1;
}

if (import.meta.main) {
  // Settled before any invocation is built, so every runner this starts
  // shuffles the same way, and the notice says how to repeat the order.
  pinShuffleSeed();
  const githubToken = takeGithubToken();
  Deno.exitCode = await main(Deno.args, Deno.cwd(), {
    ...(githubToken === undefined ? {} : { githubToken }),
    manifest: fetchManifest,
    recording: () => startRunRecording(),
    stop: stopOnSignals,
  });
}
