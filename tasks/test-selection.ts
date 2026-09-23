#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * Everything a person types about test selection goes through here, and
 * these modes are also how the system is checked by hand.
 *
 *   deno task test-selection dials
 *   deno task test-selection coverage
 *   deno task test-selection explain <identity>
 *   deno task test-selection plan --dry-run [--lane N]
 *   deno task test-selection plan --verify
 *
 * `explain` is the one this will be asked most often, because "why did my
 * test not run?" is the question a selected run provokes and the one it
 * would otherwise answer badly.
 */

import { join } from "@std/path";
import {
  loadAliasResolver,
  repositoryRoot,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import {
  DIALS,
  dialValue,
  EXCLUDED_FROM_COVERAGE_GATE,
  LANE_BUDGET_SECONDS,
  LANES,
} from "./test-selection/policy.ts";
import { fetchManifest } from "./test-selection/store.ts";
import {
  capabilitiesBySuite,
  loadTopology,
  wholeUnits,
} from "./test-topology.ts";
import { type Suite, unavailableUnits } from "./test-topology/suite.ts";
import { census } from "./test-selection/census.ts";
import {
  measuredSetName,
  type MeasuredSetRef,
  measuredSets,
} from "./test-selection/coverage.ts";
import type { Manifest } from "./test-selection/manifest.ts";
import { crowdingLine, plan, unholdableSuites } from "./test-selection/plan.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";

const USAGE = `usage: test-selection <mode>

  dials                       every dial, its value, and why you would move it
  coverage                    every workspace member and its coverage gate
  explain <identity>          one test's score, and whether it is selected
  plan --dry-run [--lane N]   what would run, and what it would cost
  plan --verify               what the topology and the store disagree about

An identity is its canonical key, either three parts or four when the
test ran in a non-default configuration:

  ["unit","memory","space > writes a fact"]
  ["integration","patterns","counter.test.ts","server-execution"]
`;

/**
 * The lane a `--lane` argument names: a number, nothing when the flag is
 * absent, and "invalid" for a flag that names no lane.
 */
export function laneArgument(
  args: readonly string[],
): number | undefined | "invalid" {
  const at = args.indexOf("--lane");
  if (at < 0) return undefined;
  const lane = Number(args[at + 1]);
  if (!Number.isInteger(lane) || lane < 1 || lane > LANES) return "invalid";
  return lane;
}

/**
 * What the program says before stopping, and the code it stops with.
 * Raised rather than exited so the whole dispatch runs in a test.
 */
export class Stop extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "Stop";
    this.code = code;
  }
}

/** Stops with the usage code, which is what a mistyped command line gets. */
function fail(message: string): never {
  throw new Stop(message, 2);
}

/** Pads a column so a printed table lines up. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Every dial, as the lines `dials` prints. */
export function dialLines(): string[] {
  const lines: string[] = [];
  const width = Math.max(...DIALS.map((dial) => dial.name.length));
  for (const dial of DIALS) {
    lines.push(
      `${pad(dial.name, width)}  ${dialValue(dial)} ${dial.unit} ` +
        `(${dial.setBy})`,
    );
    lines.push(`${" ".repeat(width)}  ${dial.why}`);
    lines.push("");
  }
  lines.push(
    "setupCost, suiteOverhead and correction are measured too, and are " +
      "published\nin each manifest rather than kept here.",
  );
  return lines;
}

/**
 * Each measured set and its baseline, then every workspace member that
 * carries no set and the reason it does not.
 *
 * The two halves answer the two questions somebody brings here: what am I
 * being compared against, and why is my package not gated.
 */
export function coverageLines(
  manifest: Manifest | undefined,
  sets: readonly MeasuredSetRef[],
  members: readonly string[],
): string[] {
  const names = sets.map(measuredSetName);
  const ungated = members.filter((member) =>
    !sets.some((ref) => ref.set.member === member)
  );
  const width = Math.max(
    1,
    ...names.map((name) => name.length),
    ...ungated.map((member) => member.length),
  );
  const baselines = new Map(
    (manifest?.coverageBaselines ?? []).map((
      base,
    ) => [`${base.suite}/${base.member}`, base]),
  );
  const lines = sets.map((ref, index) => {
    const name = names[index]!;
    const baseline = baselines.get(name);
    const against = baseline === undefined
      ? "no baseline yet"
      : `${baseline.uncoveredLines} uncovered lines at ${baseline.commit}`;
    const units = ref.set.units.length;
    return `${pad(name, width)}  ${units} ${units === 1 ? "unit" : "units"}, ` +
      `against ${against}`;
  });
  for (const member of ungated) {
    const excluded = EXCLUDED_FROM_COVERAGE_GATE.get(member);
    lines.push(
      `${pad(member, width)}  no measured set: ` +
        `${excluded ?? "it has no Deno-only tests"}`,
    );
  }
  return lines;
}

/** The workspace members the coverage gate has an opinion about. */
export async function gatedMembers(): Promise<string[]> {
  const root = repositoryRoot() ?? Deno.cwd();
  return (await readWorkspaceMembers(join(root, "deno.jsonc")))
    .map((member) => member.replace(/^\.\//, ""))
    .filter((member) => member.startsWith("packages/"))
    .sort();
}

/** The identity a command-line argument names. */
export function parseIdentityArgument(text: string): TestIdentity | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length < 3 || parts.length > 4) {
    return undefined;
  }
  const [k, s, n, v] = parts;
  // Empty parts are not an identity. The manifest validator refuses them,
  // so accepting one here would report a test as unknown and mandatory
  // when what was really wrong was the argument.
  const named = (part: unknown): part is string =>
    typeof part === "string" && part.length > 0;
  if (!named(k) || !named(s) || !named(n)) return undefined;
  if (v !== undefined && !named(v)) return undefined;
  const test: TestIdentity = { k, s, n };
  if (typeof v === "string") test.v = v;
  return test;
}

/** What the packing decided about one identity. */
export interface PlanVerdict {
  selected: boolean;

  /** How many times it would run, which a pass may have trimmed. */
  repeats?: number;

  /** Set when no lane can hold it, whatever the budget. */
  unschedulable?: boolean;

  /**
   * What a lane running nothing else would pay for it: its corrected own
   * time plus every overhead and setup that lane would open. This is the
   * figure the hard bound is compared against, so it is the one to report
   * when the answer is that no lane can hold it.
   */
  loneSeconds?: number;
}

/** What `explain` says about one identity, as lines. */
export function explainLines(
  manifest: Manifest,
  test: TestIdentity,
  verdict: PlanVerdict = { selected: false },
): string[] {
  const key = testIdentityKey(test);
  const entry = manifest.entries.find(
    (candidate) => testIdentityKey(candidate.test) === key,
  );
  if (entry === undefined) {
    return [
      `${key}`,
      "  The manifest has no entry for it, and what that means depends on",
      "  the tree. An available unit no manifest knows is mandatory, so a",
      "  test just added, one just renamed, and one whose records never",
      "  say which unit it is in all run until a run on `main` records",
      "  them. Nothing runs a test the tree no longer holds, and nothing",
      "  runs one whose unit a configuration declares unavailable.",
    ];
  }
  const lines = [
    `${key}`,
    `  suite ${entry.suite}, in ${entry.unit}`,
    `  score ${entry.score.toFixed(3)}, costing ${entry.cost.toFixed(3)}s`,
    `  ${entry.inputs.catches.toFixed(1)} weighted catches, across ` +
    `${entry.inputs.sources} sources`,
    entry.inputs.lastCatch === undefined
      ? "  it has never caught anything"
      : `  the most recent catch was on ${entry.inputs.lastCatch}`,
    `  churn ${entry.inputs.churn.toFixed(4)}, flake rate ` +
    `${entry.flakeRate.toFixed(4)}`,
  ];
  // Each of the lines below is a fact of its own rather than one arm of a
  // choice, because the facts do not partition: a withheld identity a
  // change reaches runs, and every identity that runs has a number of
  // runs it is given.
  const held = manifest.withheld.find(
    (candidate) => testIdentityKey(candidate.test) === key,
  );
  if (held !== undefined) {
    // What is said about a held-back identity stops at what holds it
    // back, because a change that reaches one runs it: saying it runs on
    // the default branch and not here would contradict the selection
    // line below on every identity a change edits.
    lines.push(
      "  withheld: it is too flaky to judge a change by, so a pull " +
        "request runs it only where the change reaches it",
    );
  }
  if (verdict.unschedulable) {
    const seconds = verdict.loneSeconds ?? entry.cost;
    lines.push(
      `  no lane can hold it: ${seconds.toFixed(1)}s is past the bound a ` +
        "lane runs under, so it is reported rather than scheduled. Splitting " +
        "it is the fix.",
    );
  }
  // The repeat count the packing settled on, which is what will run: a
  // filling pass trims repeats to fit rather than dropping the test, so
  // the manifest's own number is what it asked for and not what it got.
  const repeats = verdict.selected ? verdict.repeats ?? entry.repeats : 0;
  if (repeats > 1) {
    lines.push(`  run ${repeats} times, and every one must pass`);
  }
  // The question this mode exists to answer. Everything above is a fact
  // about the entry; whether a lane reaches it is a fact about the
  // packing, and only the packing knows it.
  if (verdict.selected) {
    lines.push("  the current manifest selects it");
  } else if (!verdict.unschedulable && held === undefined) {
    lines.push(
      "  the current manifest does not reach it: the budget runs out " +
        "first, on tests worth more per second",
    );
  }
  return lines;
}

/** A one-line summary of what a lane would do. */
function laneLine(
  lane: { lane: number; selections: unknown[]; projectedSeconds: number },
): string {
  return `  lane ${lane.lane}: ${lane.selections.length} tests, ` +
    `${lane.projectedSeconds.toFixed(1)}s of ${LANE_BUDGET_SECONDS}s`;
}

/**
 * The packing, over a manifest and no diff, as a lane would compute it.
 *
 * It reads the tree against the manifest first, exactly as a lane does.
 * Without that this would answer for a corpus a lane never sees: the
 * units the manifest still names and the tree has dropped would be in
 * the answer, and the units the tree has gained would not. The
 * capabilities a suite opens are most of what a lane's budget goes on,
 * which is the other reason the topology is what makes this the answer a
 * lane would give.
 */
function planFor(manifest: Manifest, suites: readonly Suite[]) {
  const seen = census(suites, manifest, new Set());
  return {
    seen: seen.manifest,
    result: plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(suites),
      wholeUnits: wholeUnits(suites),
    }),
  };
}

/** What `plan --dry-run` prints, as lines. */
export function planLines(
  manifest: Manifest,
  suites: readonly Suite[],
  laneNumber: number | undefined,
): string[] {
  const lines: string[] = [];
  const { seen, result } = planFor(manifest, suites);
  const lanes = laneNumber === undefined
    ? result.lanes
    : result.lanes.filter((lane) => lane.lane === laneNumber);
  lines.push(
    `manifest of ${manifest.generatedAt}, from ${manifest.runs} runs at ` +
      `${manifest.commit}`,
  );
  // The corpus the lanes below were packed from, which is what this tree
  // holds rather than what the manifest was published over. Counting the
  // manifest's own entries here would head a plan with a total the plan
  // does not add up to.
  lines.push(
    `${seen.entries.length} identities in this tree, ` +
      `${seen.withheld.length} withheld`,
  );
  for (const lane of lanes) {
    lines.push(laneLine(lane));
    if (lane.capabilities.length > 0) {
      lines.push(`    needs ${lane.capabilities.join(", ")}`);
    }
    const byReason = new Map<string, number>();
    for (const selection of lane.selections) {
      byReason.set(
        selection.reason,
        (byReason.get(selection.reason) ?? 0) + 1,
      );
    }
    for (const [reason, count] of [...byReason].sort()) {
      lines.push(`    ${count} by ${reason}`);
    }
  }
  if (result.overBudgetSeconds > 0) {
    lines.push(
      `the mandatory set alone puts a lane ` +
        `${result.overBudgetSeconds.toFixed(1)}s past its budget`,
    );
  }
  // A suite whose fixed charge alone is past a lane comes first, and its
  // identities are not listed under it. Every one of them is past the
  // bound by that charge and by nothing about itself, so a list of them
  // is one line per test saying what one line per suite already said.
  const unholdable = unholdableSuites(result.crowding);
  for (const suite of result.crowding) lines.push(crowdingLine(suite));
  for (const entry of result.unschedulable) {
    if (unholdable.has(entry.suite)) continue;
    lines.push(
      `unschedulable: ${testIdentityKey(entry.test)} costs ` +
        `${entry.cost.toFixed(1)}s, past a lane's whole budget`,
    );
  }
  lines.push(`${LANES} lanes, ${LANE_BUDGET_SECONDS}s of work each`);
  return lines;
}

/**
 * What the lanes would do with one test. Runs the same packing a lane
 * runs, so the answer is the one the lanes would give rather than a guess
 * from the manifest entry alone.
 */
export function verdictFor(
  manifest: Manifest,
  suites: readonly Suite[],
  test: TestIdentity,
): PlanVerdict & { corpus: Manifest } {
  const { seen, result } = planFor(manifest, suites);
  const key = testIdentityKey(test);
  const taken = result.lanes.flatMap((lane) => lane.selections).find((
    selection,
  ) => testIdentityKey(selection.entry.test) === key);
  // The corpus travels with the verdict so that whatever explains this
  // identity explains it against the same set the verdict came from. A
  // reader given the published manifest instead would be told there is
  // no record of a unit this tree has just added, while the verdict
  // beside it says a lane runs the stand-in for it.
  const verdict: PlanVerdict & { corpus: Manifest } = {
    selected: taken !== undefined,
    corpus: seen,
  };
  if (taken !== undefined) verdict.repeats = taken.repeats;
  const refused = result.unschedulable.find((entry) =>
    testIdentityKey(entry.test) === key
  );
  if (refused !== undefined) {
    verdict.unschedulable = true;
    verdict.loneSeconds = refused.cost;
  }
  return verdict;
}

/** What comparing the manifest against the working tree found. */
export interface Verification {
  lines: string[];

  /** Whether anything it found should stop a build. */
  fails: boolean;
}

/**
 * Whether the newest manifest accounts for the tree in front of it.
 *
 * Two directions, and they are not the same claim. A unit the topology
 * enumerates that the manifest holds nothing for is one every lane
 * treats as unknown and therefore mandatory, so a manifest missing many
 * of them is a run that selects nothing and tests everything. That is
 * what this fails on, and it is the check to run before anything depends
 * on selection working.
 *
 * A manifest entry naming a suite or unit the tree no longer holds is
 * work no lane can be asked to do, and the packer drops it silently. It
 * is reported rather than failed on, the way the drift guard reports its
 * own reverse direction: a manifest is hours old by construction, so a
 * unit deleted since it was published is expected to linger in it.
 */
export function verifyLines(
  manifest: Manifest,
  suites: readonly Suite[],
): Verification {
  const held = new Set(
    manifest.entries.map((entry) => `${entry.suite}\t${entry.unit}`),
  );
  const enumerated = new Set<string>();
  const missing: string[] = [];
  for (const suite of suites) {
    // A unit this configuration declares unavailable does not run, so a
    // manifest holding nothing for it is the manifest being right.
    const unavailable = unavailableUnits(suite);
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      enumerated.add(`${suite.id}\t${unit}`);
      if (!held.has(`${suite.id}\t${unit}`)) {
        missing.push(`${suite.id}: ${unit}`);
      }
    }
  }
  const stale = [...held].filter((key) => !enumerated.has(key)).sort();
  const lines = [
    `manifest of ${manifest.generatedAt}, from ${manifest.runs} runs at ` +
    `${manifest.commit}`,
    `${enumerated.size} units enumerated, ${manifest.entries.length} ` +
    `identities in the manifest`,
  ];
  for (const unit of missing.sort()) {
    lines.push(`  no identity for ${unit}, so every lane runs it as unknown`);
  }
  for (const key of stale) {
    const [suite, unit] = key.split("\t") as [string, string];
    lines.push(
      `  reported: ${suite} no longer enumerates ${unit}, so nothing runs it`,
    );
  }
  if (missing.length === 0) {
    lines.push("  the manifest accounts for every unit the topology holds");
  }
  return { lines, fails: missing.length > 0 };
}

/** The manifest the newest publisher run wrote, or nothing with a reason. */
async function newestManifest(): Promise<Manifest | undefined> {
  const found = await fetchManifest({ at: new Date().toISOString() });
  if (found.manifest === undefined) {
    console.error(`no manifest: ${found.absent}`);
    return undefined;
  }
  return found.manifest;
}

/** What the dispatch reads that is not in its arguments. */
export interface Sources {
  /** The newest published manifest, or nothing when there is none. */
  manifest(): Promise<Manifest | undefined>;

  /** The workspace members the coverage gate has an opinion about. */
  members(): Promise<string[]>;

  /**
   * The alias file, which joins a renamed test to its own history. Named
   * by what the dispatch asks of it rather than by the class the live one
   * happens to be.
   */
  aliases(): Promise<{
    resolve(test: TestIdentity, day: string): TestIdentity;
  }>;

  /** The suites, read from the working tree. */
  topology(): Promise<readonly Suite[]>;
}

const LIVE: Sources = {
  manifest: newestManifest,
  members: gatedMembers,
  aliases: loadAliasResolver,
  topology: loadTopology,
};

/**
 * Runs one command line and returns the code to stop with. Every line it
 * means a person to read goes to the console; every reason to stop is a
 * `Stop`, so nothing here ends the process.
 */
export async function dispatch(
  args: readonly string[],
  sources: Sources = LIVE,
): Promise<number> {
  const mode = args[0];
  if (mode === undefined || mode === "--help" || mode === "-h") {
    console.log(USAGE);
    return 0;
  }
  switch (mode) {
    case "dials":
      for (const line of dialLines()) console.log(line);
      return 0;
    case "coverage": {
      // The one mode that reads a manifest and carries on without one:
      // which sets exist is a fact about the tree, and only the baseline
      // each is measured against comes from a manifest.
      const manifest = await sources.manifest();
      const sets = measuredSets(await sources.topology());
      for (
        const line of coverageLines(manifest, sets, await sources.members())
      ) {
        console.log(line);
      }
      return 0;
    }
    case "explain": {
      const argument = args[1];
      if (argument === undefined) fail(USAGE);
      const test = parseIdentityArgument(argument);
      if (test === undefined) {
        fail(`not an identity key: ${argument}\n\n${USAGE}`);
      }
      const manifest = await sources.manifest();
      if (manifest === undefined) return 1;
      // Resolving through the alias file is what joins the two halves of
      // a renamed test's history under today's name.
      const resolver = await sources.aliases();
      const resolved = resolver.resolve(
        test,
        manifest.generatedAt.slice(0, 10),
      );
      const suites = await sources.topology();
      const verdict = verdictFor(manifest, suites, resolved);
      for (const line of explainLines(verdict.corpus, resolved, verdict)) {
        console.log(line);
      }
      return 0;
    }
    case "plan": {
      // Before the manifest, because a lane number this cannot read is a
      // mistake to report rather than a reason to reach for the store.
      const laneNumber = laneArgument(args);
      // Silently filtering every lane would exit zero having printed
      // nothing, which reads as "this lane runs no tests".
      if (laneNumber === "invalid") {
        fail(`--lane takes a whole number from 1 to ${LANES}`);
      }
      const manifest = await sources.manifest();
      if (manifest === undefined) return 1;
      const suites = await sources.topology();
      if (args.includes("--verify")) {
        const verification = verifyLines(manifest, suites);
        for (const line of verification.lines) console.log(line);
        return verification.fails ? 1 : 0;
      }
      for (const line of planLines(manifest, suites, laneNumber)) {
        console.log(line);
      }
      return 0;
    }
    default:
      fail(`unknown mode ${mode}\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await dispatch(Deno.args));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(error.message);
    Deno.exit(error.code);
  }
}
