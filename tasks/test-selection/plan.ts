/**
 * What a pull request runs, worked out from the manifest, the diff, and
 * nothing else.
 *
 * Every lane calls this over the same inputs and takes its own share of
 * the answer, so the five agree by construction and no job sits ahead of
 * them deciding. That only holds while this is a pure function: no clock,
 * no unseeded randomness, no dependence on anything but its arguments.
 * The exploration draw's seed comes from the manifest.
 */

import { testIdentityKey } from "@commonfabric/test-support/records";
import {
  FILL_DENSITY_SHARE,
  FILL_EXPLORATION_SHARE,
  FILL_VALUE_SHARE,
  FLAKE_EXCLUSION_RATE,
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BOUND_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES,
} from "./policy.ts";
import type {
  Manifest,
  ManifestEntry,
  ScoreInputs,
  UnschedulableEntry,
} from "./manifest.ts";
import { value } from "./score.ts";

/** Why one identity is in the run. */
export type SelectionReason =
  | "changed"
  | "unknown"
  | "coverage-gate"
  | "value"
  | "density"
  | "exploration"
  | "full";

/**
 * How much of the corpus a plan runs, which is the whole of the
 * difference between what a pull request runs and what `main` runs.
 *
 * `budgeted` spends a bounded amount on the tests worth the most, which
 * is the four passes below. `everything` runs the corpus it was given,
 * once each. Under `everything` every identity is required, so the
 * exclusions and the three discretionary passes have nothing to act on
 * and the rest of this file behaves the same way for both. Keeping the
 * difference to one value is what stops the two runs drifting into
 * packing the same tests differently.
 */
export type Policy = "budgeted" | "everything";

/** One identity the plan runs, and what put it there. */
export interface Selection {
  entry: ManifestEntry;
  reason: SelectionReason;

  /** How many times it runs. Every one of them must pass. */
  repeats: number;
}

/** What a lane was asked to do. */
export interface LaneAssignment {
  lane: number;
  selections: Selection[];

  /**
   * Seconds of work this lane is expected to take, setup included. It
   * stops at the lane budget, except for a lane holding a single identity
   * costing more than that, which runs up to the hard bound, and for a
   * mandatory set that fits in no lane, which `overBudgetSeconds` reports.
   */
  projectedSeconds: number;

  /** The capabilities its batches need, in a stable order. */
  capabilities: string[];
}

/** The whole plan, and what it declined to run. */
export interface Plan {
  lanes: LaneAssignment[];

  /**
   * Seconds each of these lanes was packed against, which the policy
   * decides. Carried here so that whatever reports a lane's projected
   * time reports it against the figure it was actually judged by, rather
   * than working the figure out a second time.
   */
  budgetSeconds: number;

  /**
   * Identities this plan declined to run, so a lane can say why. Empty
   * for a full run, which declines nothing.
   */
  withheld: Manifest["withheld"];

  /**
   * Identities this plan is running whose failures do not fail the run.
   *
   * A test too noisy to judge a change by is held back from a pull
   * request, and the default branch runs it anyway: what it knows about
   * that test is the whole of what says whether the exclusion should
   * reverse, and a run that stopped running it would never find out. But
   * a run that stopped for it would make the branch red for something no
   * change caused, so the failure is reported and the run stays green.
   *
   * Empty for a pull request, where such a test is held back rather than
   * run.
   */
  nonGating: Manifest["withheld"];

  /**
   * Seconds by which the mandatory pass alone put the longest lane past a
   * lane's budget, and zero where every lane held what it was given. The
   * longest lane is what a pull request waits on, which is why this is
   * that figure rather than the amount the five lanes' total was overrun
   * by.
   */
  overBudgetSeconds: number;

  /**
   * Discretionary identities no lane can hold. One costing more than a
   * lane's planned budget is given a lane to itself and allowed to run up
   * to the hard bound; one costing more than the hard bound would only
   * time its lane out, so it is reported instead, and the sixty-second
   * rule is where such a test gets split. A mandatory identity is never
   * here, however expensive: it is placed, and `overBudgetSeconds` is
   * what says how far past its budget that put a lane.
   */
  unschedulable: UnschedulableEntry[];

  /**
   * Suites a lane cannot fill around, and the fixed charge that says so.
   *
   * A lane pays a suite's overhead, its per-unit charge and its
   * capabilities' setup before it runs anything of that suite. Where
   * those alone pass what a lane holding two things may take, nothing
   * can share a lane with one of its identities, so the suite takes a
   * whole lane per identity it places and the lanes around it hold
   * everything else. Where they pass the hard bound as well, no lane can
   * hold it at all and every discretionary identity it has is in
   * `unschedulable`.
   *
   * Neither reading changes what the packer does; both are what makes it
   * answerable. A lane holding one test, and four lanes holding the rest
   * of the corpus, is otherwise a plan with no line in it saying why.
   */
  crowding: CrowdingSuite[];
}

/** A suite whose fixed charge alone is past what a lane can fill around. */
export interface CrowdingSuite {
  suite: string;

  /** Overhead, per-unit charge and capability setup, without any test. */
  fixed: number;

  /** Discretionary identities of the suite, which is what this costs. */
  identities: number;

  /**
   * How many of those no lane can hold. All of them where no lane can
   * hold the suite at all, and fewer where the charge leaves room for
   * the cheaper of its tests and not the dearer.
   */
  heldNowhere: number;
}

/** Whether no lane can hold any identity of the suite. */
export function unholdable(suite: CrowdingSuite): boolean {
  return suite.heldNowhere === suite.identities;
}

/** What the packer needs beyond the manifest. */
export interface PlanInput {
  manifest: Manifest;

  /**
   * Identities this change makes mandatory, against the reason. The lane
   * runner fills this from the diff and from the topology's enumeration.
   */
  mandatory: Map<string, SelectionReason>;

  /** Which capabilities each suite needs. */
  capabilities: ReadonlyMap<string, readonly string[]>;

  /** How much of the manifest to run. Defaults to `budgeted`. */
  policy?: Policy;

  /** How many lanes to fill, at least one. Defaults to the dial. */
  lanes?: number;

  /**
   * Seconds each lane may fill. Defaults to the dial the policy belongs
   * to, so that the full run cannot be packed against a pull request's
   * budget by leaving one field out.
   */
  budgetSeconds?: number;

  /** The hard bound on a lane's work step. Defaults to the policy's dial. */
  boundSeconds?: number;

  /**
   * The units whose runner runs every identity in them whatever it is asked,
   * each written as `<suite>\t<unit>`. `wholeUnits()` builds this set from the
   * topology.
   */
  wholeUnits: ReadonlySet<string>;
}

/**
 * A deterministic pseudo-random sequence from a string seed. The
 * exploration draw needs tie-breaking that every lane agrees on and that
 * changes between manifests, which is exactly what a seeded generator is
 * and exactly what `Math.random` is not.
 */
export function seededOrder(seed: string, count: number): number[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

/** A lane as it fills up. */
interface Filling {
  lane: number;
  selections: Selection[];
  capabilities: Set<string>;

  /** The suites whose overheads this lane has paid. */
  suites: Set<string>;

  /**
   * The invocation units whose overheads this lane has paid, each named
   * by its suite as well as its path. Two suites name the same path where
   * they run the same file two ways — the two postures of a pattern
   * integration test, a package built for two targets — and each of those
   * is a runner started and a module loaded of its own.
   */
  units: Set<string>;

  /** Seconds of work placed here so far. */
  load: number;
}

/** What one identity costs a lane that is running nothing else. */
function loneCost(
  manifest: Manifest,
  input: PlanInput,
  entry: ManifestEntry,
  repeats = 1,
): number {
  return marginalCost(
    manifest,
    input,
    {
      lane: 0,
      selections: [],
      capabilities: new Set(),
      suites: new Set(),
      units: new Set(),
      load: 0,
    },
    entry,
    repeats,
  );
}

function capabilityCost(manifest: Manifest, capability: string): number {
  return manifest.calibration.setupCost[capability] ?? 0;
}

/**
 * What a lane pays to hold one identity of a suite, before that
 * identity's own time. It is one identity's lone cost with the time
 * taken out, read through the same function the packer charges by, so
 * that a term added there is in this the moment it is added there.
 */
function fixedCost(
  manifest: Manifest,
  input: PlanInput,
  entry: ManifestEntry,
): number {
  return loneCost(manifest, input, { ...entry, cost: 0 });
}

/** How a lane names one unit of one suite among the units it has opened. */
function openedUnit(entry: ManifestEntry): string {
  return `${entry.suite}\t${entry.unit}`;
}

/**
 * What must run, keyed as the packer places it. A test that must run makes its
 * whole unit run. When two tests of one unit must run for different reasons,
 * the unit is placed under the first reason. The plan still reports each test
 * under its own reason.
 */
function mandatoryPlaced(
  mandatory: ReadonlyMap<string, SelectionReason>,
  placedAs: (key: string) => string,
): Map<string, SelectionReason> {
  const placed = new Map<string, SelectionReason>();
  for (const [key, reason] of mandatory) {
    const at = placedAs(key);
    if (!placed.has(at)) placed.set(at, reason);
  }
  return placed;
}

/** The corpus with each whole unit merged, and the maps that expand it. */
export interface Folding {
  entries: ManifestEntry[];

  /** For each entry standing for a whole unit, the entries it stands for. */
  members: Map<string, ManifestEntry[]>;

  /** For each identity inside a whole unit, the entry standing for it. */
  standsFor: Map<string, string>;
}

/**
 * The corpus, with each unit its runner runs whole merged into one entry.
 *
 * A lane that picks any test in such a unit runs every test in it. The packer
 * therefore places the unit as one choice. The plan it writes lists the unit's
 * tests again, so the manifest, the records, and the plan all name tests rather
 * than units.
 *
 * The merged entry combines its tests as follows:
 *
 * - Cost is the sum, because running the unit runs every test in it.
 * - Catches are the sum, because the unit catches whenever any of its tests
 *   does. Two tests catching one commit count twice, which favors running
 *   the unit.
 * - Sources and churn are the largest, because an entry records how many
 *   distinct sources saw a catch, not which ones.
 * - Flake rate and repeat count are the largest, because a test disagreeing
 *   with itself makes the whole invocation disagree.
 * - The last run is the oldest of the tests' last runs, and absent when any
 *   test has never run.
 * - Score is computed from the combined inputs as of the day the manifest
 *   was written, which is the date of every other score in it.
 *
 * A unit holding one identity keeps that identity's entry. A test the manifest
 * lists twice counts once.
 */
export function foldWholeUnits(
  manifest: Manifest,
  wholeUnits: ReadonlySet<string>,
): Folding {
  const entries: ManifestEntry[] = [];
  const grouped = new Map<string, ManifestEntry[]>();
  const keys = new Set<string>();
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    keys.add(key);
    const unit = openedUnit(entry);
    if (!wholeUnits.has(unit)) {
      entries.push(entry);
      continue;
    }
    const group = grouped.get(unit) ?? [];
    if (group.some((member) => testIdentityKey(member.test) === key)) continue;
    grouped.set(unit, [...group, entry]);
  }
  const members = new Map<string, ManifestEntry[]>();
  const standsFor = new Map<string, string>();
  const today = manifest.generatedAt.slice(0, "YYYY-MM-DD".length);
  for (const group of grouped.values()) {
    const first = group[0]!;
    if (group.length === 1) {
      entries.push(first);
      continue;
    }
    const latest = (days: (string | undefined)[]) =>
      days.filter((day): day is string => day !== undefined).sort().at(-1);
    const caught = latest(group.map((entry) => entry.inputs.lastCatch));
    const inputs: ScoreInputs = {
      catches: group.reduce((total, entry) => total + entry.inputs.catches, 0),
      sources: Math.max(...group.map((entry) => entry.inputs.sources)),
      churn: Math.max(...group.map((entry) => entry.inputs.churn)),
      ...(caught === undefined ? {} : { lastCatch: caught }),
    };
    // The unit last ran when its stalest test did, and never where one of
    // its tests never has. The exploration pass draws the longest-unrun
    // entries first, and a unit is as unrun as its least-run test.
    const days = group.map((entry) => entry.lastRun);
    const ran = days.includes(undefined)
      ? undefined
      : days.filter((day): day is string => day !== undefined).sort()[0];
    // Named for the suite and the unit. No record carries such a name, because
    // records are named for tests. The name has to be unique in the corpus,
    // because two entries sharing a key would leave one of them unplaced.
    const entry: ManifestEntry = {
      test: { ...first.test, n: `whole ${first.suite} ${first.unit}` },
      suite: first.suite,
      unit: first.unit,
      cost: group.reduce((total, member) => total + member.cost, 0),
      score: value(inputs, today),
      inputs,
      flakeRate: Math.max(...group.map((member) => member.flakeRate)),
      repeats: Math.max(...group.map((member) => member.repeats)),
      ...(ran === undefined ? {} : { lastRun: ran }),
    };
    const key = testIdentityKey(entry.test);
    if (keys.has(key)) {
      throw new Error(
        `the merged entry for ${first.suite} ${first.unit} has the key ` +
          `${key}, which another entry in the corpus already has; one of ` +
          `the two would never be placed`,
      );
    }
    keys.add(key);
    entries.push(entry);
    members.set(key, group);
    for (const member of group) {
      standsFor.set(testIdentityKey(member.test), key);
    }
  }
  return { entries, members, standsFor };
}

/**
 * The part of a lane's load one identity's own cost decides: that cost
 * times its suite's correction times the times it runs. What a lane pays
 * around it — its suite's overhead, its unit's, and its capabilities'
 * setup — is charged once per lane rather than per identity, so none of
 * that is here.
 *
 * Exported because a reader asking how much of a lane's projected time a
 * given set of identities accounts for has to read it the way the packer
 * charged it, and a second reading of the same quantity would answer a
 * share of one total in the units of another.
 */
export function ownLoad(
  manifest: Manifest,
  entry: ManifestEntry,
  repeats: number,
): number {
  return entry.cost *
    (manifest.calibration.suites[entry.suite]?.correction ?? 1) * repeats;
}

/**
 * What adding this identity to this lane would cost: its own time times
 * its suite's correction, plus its suite's overhead where the lane is not
 * holding that suite already and its suite's per-unit overhead where the
 * lane has not opened that unit already, plus any capability setup this
 * lane has not opened yet.
 */
function marginalCost(
  manifest: Manifest,
  input: PlanInput,
  lane: Filling,
  entry: ManifestEntry,
  repeats: number,
): number {
  const fitted = manifest.calibration.suites[entry.suite];
  let cost = ownLoad(manifest, entry, repeats);
  if (!lane.suites.has(entry.suite)) cost += fitted?.overhead ?? 0;
  if (!lane.units.has(openedUnit(entry))) cost += fitted?.unitOverhead ?? 0;
  for (const capability of input.capabilities.get(entry.suite) ?? []) {
    if (!lane.capabilities.has(capability)) {
      cost += capabilityCost(manifest, capability);
    }
  }
  return cost;
}

/** A lane an identity could go in, and what it would cost there. */
interface Spot {
  lane: Filling;
  cost: number;
}

/**
 * What a lane may hold. A lane running one identity once and nothing else
 * may go up to the hard bound, which is where an identity costing more
 * than a whole lane's budget runs: it cannot be split, so a lane to
 * itself is the only place it goes. A repeat can be split — dropping one
 * run of it is what `fill` does — so a lane repeating an identity stops
 * at the budget like any other.
 */
function capacity(
  lane: Filling,
  repeats: number,
  laneBudget: number,
  bound: number,
): number {
  return lane.selections.length === 0 && repeats === 1 ? bound : laneBudget;
}

/**
 * Where this identity could go.
 *
 * `fitting` is the cheapest lane that can still hold it inside that
 * lane's own capacity, which is what makes tests needing the same
 * environment group together rather than being a special case in the
 * packer. Lanes of equal cost are separated by load, so the emptier one
 * wins.
 *
 * `shortest` is the lane the identity would leave shortest, whether or
 * not that lane can hold it. Only the mandatory pass uses it, and only
 * when nothing fits: that pass may put a lane past its budget, and
 * putting the overrun where the finishing time rises least is what keeps
 * the longest lane down.
 */
function spotsFor(
  input: PlanInput,
  lanes: readonly Filling[],
  entry: ManifestEntry,
  repeats: number,
  laneBudget: number,
  bound: number,
): { fitting?: Spot; shortest?: Spot } {
  let fitting: Spot | undefined;
  let shortest: Spot | undefined;
  for (const lane of lanes) {
    const cost = marginalCost(input.manifest, input, lane, entry, repeats);
    if (
      shortest === undefined ||
      lane.load + cost < shortest.lane.load + shortest.cost
    ) {
      shortest = { lane, cost };
    }
    if (lane.load + cost > capacity(lane, repeats, laneBudget, bound)) {
      continue;
    }
    if (
      fitting === undefined || cost < fitting.cost ||
      (cost === fitting.cost && lane.load < fitting.lane.load)
    ) {
      fitting = { lane, cost };
    }
  }
  return { fitting, shortest };
}

function place(
  input: PlanInput,
  spot: Spot,
  entry: ManifestEntry,
  reason: SelectionReason,
  repeats: number,
): void {
  const lane = spot.lane;
  lane.selections.push({ entry, reason, repeats });
  lane.load += spot.cost;
  lane.suites.add(entry.suite);
  lane.units.add(openedUnit(entry));
  for (const capability of input.capabilities.get(entry.suite) ?? []) {
    lane.capabilities.add(capability);
  }
}

/**
 * Works out what runs, and where.
 *
 * Four passes in order. Mandatory first, which can in principle put a
 * lane past its budget and says how far past rather than silently
 * dropping work.
 * Then value, ignoring cost, which is what gets the expensive genuinely
 * broken integration test into the run. Then density, which sweeps up the
 * cheap tail the value floor puts at the top of the value-per-second
 * ordering. Then exploration, so the unselected corpus keeps producing
 * data.
 *
 * What the last three passes may spend is a share of the whole run's
 * budget rather than of each lane's, so an expensive test can have a lane
 * to itself while the others carry the tail. What keeps any one lane from
 * running long is separate from the shares: those three passes put no
 * work in a lane past that lane's budget, and the lane that carries an
 * identity costing more than a whole lane's budget carries that identity
 * and nothing else. Together they make every lane finish near the budget,
 * which is the number the pull request waits on. The mandatory pass is
 * bounded by neither, and reports how far past a lane it went.
 */
export function plan(input: PlanInput): Plan {
  const folding = foldWholeUnits(input.manifest, input.wholeUnits);
  const manifest: Manifest = { ...input.manifest, entries: folding.entries };
  /** The key under which the packer places an identity. */
  const placedAs = (key: string): string => folding.standsFor.get(key) ?? key;
  const laneCount = input.lanes ?? LANES;
  // Every pass below reaches for a lane to put work in, so there has to
  // be one.
  if (laneCount < 1) {
    throw new RangeError(
      `a plan needs a lane to fill, and was asked for ${laneCount}`,
    );
  }
  const everything = input.policy === "everything";
  const laneBudget = input.budgetSeconds ??
    (everything ? FULL_LANE_BUDGET_SECONDS : LANE_BUDGET_SECONDS);
  const budget = laneBudget * laneCount;
  const lanes: Filling[] = Array.from({ length: laneCount }, (_, i) => ({
    lane: i + 1,
    selections: [],
    capabilities: new Set<string>(),
    suites: new Set<string>(),
    units: new Set<string>(),
    load: 0,
  }));

  const bound = input.boundSeconds ??
    (everything ? FULL_LANE_BOUND_SECONDS : LANE_BOUND_SECONDS);
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    byKey.set(testIdentityKey(entry.test), entry);
  }

  // What runs whatever anything else says. A full run is the case where
  // that is the whole corpus, which is why it needs no pass of its own:
  // the mandatory pass below places every identity, and the three
  // discretionary passes then find nothing left to take.
  const requiredOf: ReadonlyMap<string, SelectionReason> = everything
    ? new Map(
      manifest.entries.map((
        entry,
      ) => [testIdentityKey(entry.test), "full" as SelectionReason]),
    )
    : mandatoryPlaced(input.mandatory, placedAs);

  // What must not run, unless the change edits the test itself or its
  // suite maps the change onto its unit, in which case it is very likely
  // a fix and must be allowed to prove itself.
  const excluded = new Set<string>();
  // A test that is held back holds back its whole unit, because running the
  // unit runs that test.
  for (const held of manifest.withheld) {
    const key = placedAs(testIdentityKey(held.test));
    if (!requiredOf.has(key)) excluded.add(key);
  }
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    if (entry.flakeRate > FLAKE_EXCLUSION_RATE && !requiredOf.has(key)) {
      excluded.add(key);
    }
  }

  // An identity whose own measured time is past the hard bound shares a
  // lane with nothing, so a discretionary one is reported rather than
  // placed in a lane that would then be killed at its bound. A mandatory
  // one is placed anyway: the change is not tested without it, and a lane
  // running long says so, where dropping it leaves the run reporting a
  // pass over a test that never ran. Its suite's correction is applied
  // first, because that is what the time will actually be.
  const unschedulable: UnschedulableEntry[] = [];
  // Per suite, the identities its own charge is the whole of what stops,
  // and how many of those no lane can hold. One held back for a reason of
  // its own is in neither, because it is not running whatever the charge
  // comes to.
  const discretionary = new Map<
    string,
    { all: number; unheld: number; one: ManifestEntry }
  >();
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    if (requiredOf.has(key)) continue;
    const counted = !excluded.has(key);
    // A whole unit counts as the number of identities it holds.
    const held = folding.members.get(key)?.length ?? 1;
    if (counted) {
      const seen = discretionary.get(entry.suite) ??
        { all: 0, unheld: 0, one: entry };
      seen.all += held;
      discretionary.set(entry.suite, seen);
    }
    // What an empty lane would pay for it: its own corrected time plus
    // every overhead and setup that lane would open. Charging only the
    // test's own time would schedule an identity whose suite, unit, and
    // capabilities together put the lane past the bound it is killed at.
    const cost = loneCost(manifest, input, entry);
    if (cost <= bound) continue;
    // That whole figure is what is reported, so whoever reads it is told
    // the number the bound was compared against.
    // A whole unit is reported as each of its tests, at the cost of the whole
    // unit, because the unit is what no lane can hold.
    for (const member of folding.members.get(key) ?? [entry]) {
      unschedulable.push({ test: member.test, suite: entry.suite, cost });
    }
    excluded.add(key);
    if (counted) discretionary.get(entry.suite)!.unheld += held;
  }

  // Read once per suite rather than once per identity, because it is the
  // same figure for every identity the suite has: a suite whose fixed
  // charge passes the budget is one that thousands of identical lines
  // would otherwise report, each naming a test that is not the problem.
  const crowding: CrowdingSuite[] = [];
  for (const [suite, counted] of discretionary) {
    const fixed = fixedCost(manifest, input, counted.one);
    if (fixed <= laneBudget) continue;
    // What no lane can hold is read from what the pass above decided
    // rather than from the charge against the bound: a charge inside the
    // bound still holds nothing where the cheapest test the suite has
    // takes it past, and comparing the charge alone would say a suite
    // ran a test to a lane while the list beside it named that test as
    // one nothing ran.
    crowding.push({
      suite,
      fixed,
      identities: counted.all,
      heldNowhere: counted.unheld,
    });
  }
  crowding.sort((a, b) => b.fixed - a.fixed);

  const taken = new Set<string>();
  const remaining = (): ManifestEntry[] =>
    manifest.entries.filter((entry) => {
      const key = testIdentityKey(entry.test);
      return !taken.has(key) && !excluded.has(key);
    });

  const required: {
    key: string;
    reason: SelectionReason;
    entry: ManifestEntry;
    runs: number;
    cost: number;
  }[] = [];
  for (const [key, reason] of requiredOf) {
    // An identity the manifest does not carry cannot be placed, because
    // nothing here knows which suite would run it. Whoever enumerated the
    // working tree carries a stand-in entry for every unit it holds, so
    // reaching this without one means the caller named something
    // mandatory and handed over a corpus that does not contain it.
    //
    // Skipping it instead would drop a test that must run and say
    // nothing, and a run reporting a pass over a test that never ran is
    // the one failure of this design that would leave no trace. Every
    // identity being placed once it is required is then what makes the
    // full run complete, so that needs no separate check afterwards.
    const entry = byKey.get(key);
    if (entry === undefined) {
      throw new Error(
        `${key} must run, and the corpus this was given does not carry ` +
          `it, so nothing here knows what would run it`,
      );
    }
    required.push({
      key,
      reason,
      entry,
      // How many times an item runs is what its share asks for, and
      // nothing else decides it. A repeat catches a test disagreeing
      // with itself, which is worth the same whether the item was
      // chosen, edited, pulled in by the coverage gate, or required
      // because the run is the whole corpus.
      runs: entry.repeats,
      // What an empty lane would pay for every one of those runs. The
      // setup and overheads a lane opens are paid once however many
      // times the item runs, so multiplying one run's whole figure
      // would charge them again per repeat and order the pass by a cost
      // no lane pays.
      cost: loneCost(manifest, input, entry, entry.repeats),
    });
  }

  // Longest-processing-time scheduling, which wants the largest piece of
  // work placed first: an expensive identity offered a set of lanes that
  // are already full has nowhere to go but past one lane's budget, where
  // the same identity offered empty lanes fits inside one. Every
  // mandatory identity runs whatever the order, so ordering this pass
  // decides only where the work lands. The key breaks ties, so two
  // identities costing the same are ordered the same way in every lane.
  required.sort((a, b) =>
    b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );

  for (const { key, reason, entry, runs } of required) {
    // An identity that would be repeated but fits nowhere runs fewer
    // times first, down to once, the way the discretionary passes do.
    // All of one identity's runs go in one lane, so a lane cannot be
    // added to make room for them.
    let taking: { spot: Spot; runs: number } | undefined;
    for (let count = runs; count >= 1 && taking === undefined; count--) {
      const spot = spotsFor(input, lanes, entry, count, laneBudget, bound)
        .fitting;
      if (spot !== undefined) taking = { spot, runs: count };
    }
    // This pass is the one allowed to put a lane past its budget: where
    // one run of it fits in no lane, it goes in the lane it leaves
    // shortest. Every lane is a candidate for such work, and there is at
    // least one lane, so there is always a shortest.
    const chosen = taking ?? {
      spot: spotsFor(input, lanes, entry, 1, laneBudget, bound).shortest!,
      runs: 1,
    };
    taken.add(key);
    place(input, chosen.spot, entry, reason, chosen.runs);
  }
  const mandatoryLoad = laneLoad(lanes);
  // A mandatory set larger than the whole run's budget leaves some lane
  // past its own share of it, so measuring the longest lane reports that
  // case as well as the case the total misses: work that fits the run
  // between them but that no one lane can hold its part of.
  const overBudget = lanes.reduce(
    (most, lane) => Math.max(most, lane.load - laneBudget),
    0,
  );

  // The three shares are of what the mandatory pass left, so a change
  // that forced a great deal of work in does not then get a full budget
  // of discretionary tests on top of it.
  const left = Math.max(0, budget - mandatoryLoad);
  const withRepeats = (entry: ManifestEntry): number => entry.repeats;

  // Value first: descending score, ignoring cost.
  fill(
    input,
    lanes,
    taken,
    remaining().sort((a, b) => b.score - a.score),
    "value",
    mandatoryLoad + left * FILL_VALUE_SHARE,
    laneBudget,
    bound,
    withRepeats,
  );

  // Density: descending value per second, which the value floor points at
  // the cheap tail.
  fill(
    input,
    lanes,
    taken,
    remaining().sort((a, b) =>
      b.score / Math.max(b.cost, 1e-6) - a.score / Math.max(a.cost, 1e-6)
    ),
    "density",
    mandatoryLoad + left * (FILL_VALUE_SHARE + FILL_DENSITY_SHARE),
    laneBudget,
    bound,
    withRepeats,
  );

  // Exploration: a draw over what the value ordering did not pick, so
  // the whole corpus is swept over time rather than sampled with
  // replacement forever.
  //
  // Longest-unrun first, with the seeded shuffle breaking ties. Sweeping
  // is what the ordering buys: a test the draw reaches goes to the back
  // of the queue until everything else has had a turn, where a shuffle
  // alone would keep drawing from the whole corpus and leave part of it
  // unvisited for as long as chance allowed. It also covers whatever the
  // value model is currently blind to, without anything having to know
  // what that is.
  const pool = remaining();
  const order = seededOrder(manifest.seed, pool.length);
  const drawn = order.map((i) => pool[i]!);
  // An identity nothing has run inside the aggregate's reach carries no
  // day at all, and it is the one most worth drawing, so it sorts ahead
  // of every day there is.
  drawn.sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  fill(
    input,
    lanes,
    taken,
    drawn,
    "exploration",
    mandatoryLoad +
      left * (FILL_VALUE_SHARE + FILL_DENSITY_SHARE + FILL_EXPLORATION_SHARE),
    laneBudget,
    bound,
    withRepeats,
  );

  return {
    lanes: lanes.map((lane) => ({
      lane: lane.lane,
      selections: lane.selections.flatMap((selection) => {
        const members = folding.members.get(
          testIdentityKey(selection.entry.test),
        );
        if (members === undefined) return [selection];
        // On a full run, every test keeps the full run's reason. Otherwise a
        // test the change made mandatory keeps its own reason, and the unit's
        // other tests take the unit's reason.
        return members.map((entry) => ({
          ...selection,
          entry,
          reason: everything
            ? selection.reason
            : input.mandatory.get(testIdentityKey(entry.test)) ??
              selection.reason,
        }));
      }),
      projectedSeconds: lane.load,
      capabilities: [...lane.capabilities].sort(),
    })),
    budgetSeconds: laneBudget,
    // A full run withholds nothing: every identity is required, so the
    // reasons the manifest gives for holding one back never applied.
    // Reporting the manifest's list here would have a run that ran a
    // test say in its own summary that no lane chose it. What it ran
    // anyway and will not fail for is the other list, which is narrower:
    // every reason the manifest gives holds a test back, and only a
    // flake rate excuses one.
    withheld: everything ? [] : manifest.withheld,
    nonGating: everything ? excused(manifest) : [],
    overBudgetSeconds: overBudget,
    unschedulable,
    crowding,
  };
}

/**
 * The identities a flake rate excuses: too noisy to judge a change by. A
 * pull request holds these back; the default branch runs them and does
 * not fail for them.
 *
 * Narrower than what a pull request holds back, which is every withheld
 * entry whatever its reason. The reason is read here rather than the
 * membership, so a reason added later is held back like any other and
 * does not become non-gating without anybody deciding that it should.
 */
function excused(manifest: Manifest): Manifest["withheld"] {
  return manifest.withheld.filter((held) => held.reason === "flaky");
}

/** How many of the costliest identities no lane can hold a report names. */
export const NAMED_UNSCHEDULABLE = 10;

/**
 * The costliest identities no lane can hold, and the rest of them. A
 * cost model pricing a whole suite above a lane puts every test in that
 * suite on this list, which has run to tens of thousands, so a report
 * names a few and says how many it left out. The manifest carries the
 * whole list either way, whatever a report does with it.
 */
export function costliestUnschedulable(
  entries: readonly UnschedulableEntry[],
): {
  named: readonly UnschedulableEntry[];
  rest: readonly UnschedulableEntry[];
} {
  const costliest = [...entries].sort((left, right) => right.cost - left.cost);
  return {
    named: costliest.slice(0, NAMED_UNSCHEDULABLE),
    rest: costliest.slice(NAMED_UNSCHEDULABLE),
  };
}

/**
 * What a crowded suite costs a plan, in one sentence. Written here rather
 * than at each place that prints it, so that the job summary and the
 * command-line report say the same thing about the same suite.
 */
export function crowdingLine(suite: CrowdingSuite): string {
  // The count is of what the sentence is about: every discretionary
  // identity where none of them ran, and the ones a lane can still hold
  // where the rest are past the bound by their own time as well.
  return `${suite.suite} costs ${suite.fixed.toFixed(1)}s before it runs ` +
    `anything, so ` +
    (unholdable(suite)
      ? `no lane holds it and none of its ${suite.identities} tests ran`
      : `each of the ${suite.identities - suite.heldNowhere} tests it can ` +
        `still run takes a lane to itself`);
}

/** The suites a report says nothing can run any of. */
export function unholdableSuites(
  crowding: readonly CrowdingSuite[],
): ReadonlySet<string> {
  return new Set(
    crowding.filter(unholdable).map((suite) => suite.suite),
  );
}

/**
 * How many lanes the full run needs.
 *
 * A pull request has a fixed number of lanes, so each one works out its
 * own share and no job sits ahead of them. `main` cannot: the number
 * depends on how much work there is, and the job matrix has to be known
 * before anything starts. So one job answers this, and an integer is the
 * whole of what it answers. The lanes then call `plan` over the same
 * manifest and take their own share of it, exactly as the pull-request
 * lanes do, so there is no second packing anywhere that could disagree
 * with the first.
 *
 * The search starts at what the work divided by a lane's budget comes to
 * and moves in both directions: down while dropping a lane costs under a
 * second, then up while adding one buys at least that. Both directions
 * are needed because that starting figure is an estimate rather than a
 * bound — it charges every execution the packer was asked for, and the
 * packer gives up runs to fit — so it can land either side of the
 * answer, and a search that only climbed would keep whatever it
 * overshot by.
 *
 * What it measures is the total by
 * which the lanes are over budget rather than the worst single lane: a
 * test costing more than a whole lane holds its own lane over budget at
 * every count, so the worst lane stops moving while every other lane is
 * still crowded, and a search reading the worst lane would stop there
 * and leave the rest of the run packed twice as tight as it asked for.
 * The total keeps falling while lanes are still worth adding and stops
 * falling once only the unsplittable part is left, which is where the
 * search stops. It terminates on that total, which cannot fall below
 * zero, and on one lane per identity being the finest packing there is.
 */
export function fullLaneCount(
  input: Omit<PlanInput, "policy" | "lanes" | "mandatory">,
): number {
  const manifest = input.manifest;
  const budget = input.budgetSeconds ?? FULL_LANE_BUDGET_SECONDS;
  // The tests' own corrected time, with no lane overhead in it, charged
  // once per execution: an identity the packer repeats costs the lane
  // that holds it once per repeat, and counting one would put the search
  // below a packing that cannot fit.
  const work = manifest.entries.reduce(
    (total, entry) =>
      total + entry.cost * entry.repeats *
        (manifest.calibration.suites[entry.suite]?.correction ?? 1),
    0,
  );
  const most = Math.max(1, manifest.entries.length);
  let count = Math.min(most, Math.max(1, Math.ceil(work / budget)));
  const packed = (lanes: number) =>
    plan({
      ...input,
      // Under `everything` every identity is required, so there is
      // nothing a caller could add to this that would change the answer.
      mandatory: new Map(),
      policy: "everything",
      budgetSeconds: budget,
      lanes,
    });
  /** Seconds by which the lanes are over budget, added up over all of them. */
  const overrun = (result: Plan): number =>
    result.lanes.reduce(
      (total, lane) => total + Math.max(0, lane.projectedSeconds - budget),
      0,
    );
  let best = overrun(packed(count));
  // Fewer lanes first, while dropping one costs under a second. The
  // figure above charges every execution the packer was asked for and
  // the packer gives up runs to fit, so it can land past the fewest
  // lanes that carry the run, and the climb below never comes back down.
  // Leaving it there costs the default branch a job per commit for each
  // lane the estimate overshot by.
  //
  // Measured against the overrun rather than against zero, because an
  // identity costing more than a lane holds overruns at every count, so
  // a run holding one would never shrink at all. What a lane has to buy
  // to be worth keeping is the same second the climb below makes it buy.
  while (count > 1) {
    const fewer = overrun(packed(count - 1));
    if (fewer >= best + 1) break;
    count -= 1;
    best = fewer;
  }
  while (best > 0 && count < most) {
    const next = overrun(packed(count + 1));
    // A lane has to buy at least a second to be worth adding. Stopping
    // only on no improvement at all would let a run of ever smaller ones
    // carry the search as far as there are identities, and a lane's
    // budget is counted in seconds, so anything under one is noise.
    if (next > best - 1) break;
    count += 1;
    best = next;
  }
  return count;
}

function laneLoad(lanes: readonly Filling[]): number {
  return lanes.reduce((total, lane) => total + lane.load, 0);
}

/**
 * Takes candidates in the order given, up to this pass's share of the
 * whole run's budget and no further. The share is of the whole rather
 * than of each lane, so an expensive test can have a lane to itself while
 * the others carry the tail; what stops any one lane running long is the
 * lane's own capacity, which `spotsFor` applies.
 */
function fill(
  input: PlanInput,
  lanes: Filling[],
  taken: Set<string>,
  candidates: readonly ManifestEntry[],
  reason: SelectionReason,
  ceiling: number,
  laneBudget: number,
  bound: number,
  repeatsOf: (entry: ManifestEntry) => number,
): void {
  for (const entry of candidates) {
    const key = testIdentityKey(entry.test);
    if (taken.has(key)) continue;
    const spent = laneLoad(lanes);
    // An identity that would be repeated but no longer fits runs fewer
    // times, down to once: one observation beats none.
    for (let repeats = repeatsOf(entry); repeats >= 1; repeats--) {
      const spot = spotsFor(input, lanes, entry, repeats, laneBudget, bound)
        .fitting;
      if (spot === undefined || spent + spot.cost > ceiling) continue;
      taken.add(key);
      place(input, spot, entry, reason, repeats);
      break;
    }
  }
}
