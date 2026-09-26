/**
 * Which measured sets a change reaches, and what each of them is called
 * on disk.
 *
 * A measured set is one suite's units over one workspace member's lines.
 * Everything about the coverage gate starts here: the lanes read this to
 * decide what to run whole and what to turn coverage on for, and the job
 * that joins the lanes reads the same function over the same diff rather
 * than trusting what a lane reported.
 */

import { duration } from "./duration.ts";
import {
  coverageMemberDirectory,
  type MeasuredSet,
  reachedByChange,
  type Suite,
  unavailableUnits,
} from "../test-topology/suite.ts";
import { memberScope } from "../test-topology/unit.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import {
  COST_WINDOW_DAYS,
  EXCLUDED_FROM_COVERAGE_GATE,
  exclusionKind,
  LANE_BUDGET_SECONDS,
  LANES,
  LOCAL_COVERAGE_MAX_SECONDS,
  LOCAL_COVERAGE_MAX_SETS,
} from "./policy.ts";

/** One measured set, and the suite that declared it. */
export interface MeasuredSetRef {
  suite: string;
  set: MeasuredSet;
}

/**
 * Every measured set the topology declares that this configuration can
 * run, in a stable order.
 *
 * A set every one of whose units the suite declares unavailable is left
 * out. Keeping it would mean scoring a set nothing was required to run,
 * so the count would be whatever some other lane happened to leave in
 * the directory.
 */
export function measuredSets(
  suites: readonly Suite[],
): MeasuredSetRef[] {
  const sets: MeasuredSetRef[] = [];
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    for (const set of suite.measured ?? []) {
      if (set.units.every((unit) => unavailable.has(unit))) continue;
      sets.push({ suite: suite.id, set });
    }
  }
  return sets.sort((a, b) =>
    a.suite.localeCompare(b.suite) || a.set.member.localeCompare(b.set.member)
  );
}

/** Where one measured set's coverage profiles and report live. */
export function measuredSetDirectory(ref: MeasuredSetRef): string {
  return `${ref.suite}/${coverageMemberDirectory(ref.set.member)}`;
}

/** How a measured set is named in a summary or a metric. */
export function measuredSetName(ref: MeasuredSetRef): string {
  return `${ref.suite}/${ref.set.member}`;
}

/** What the coverage gate decided about one change. */
export interface CoverageGateSelection {
  /** The sets the gate runs and scores. Empty where it does not run. */
  sets: MeasuredSetRef[];

  /**
   * Every set the change reached, whether or not the gate runs. The cap
   * below turns the gate off without changing what the change reached,
   * and a summary that could not say what it reached would leave nobody
   * able to tell a capped change from an untouched one.
   */
  reached: MeasuredSetRef[];

  /** Why the gate did not run, where it did not. */
  off?: string;
}

/**
 * Which measured sets a change reaches, and whether the gate runs.
 *
 * The gate is off entirely past the cap rather than off for some of the
 * sets: gating two of the four a change reached would mean quietly
 * ignoring the other two. A cliff is also predictable, so an author can
 * tell from the diff whether the gate applies without knowing what any
 * set's tests cost.
 */
export function coverageGateFor(
  suites: readonly Suite[],
  changed: ReadonlySet<string>,
): CoverageGateSelection {
  const reached = measuredSets(suites)
    .filter((ref) => reachedByChange(ref.set.reachedBy, changed));
  if (reached.length > LOCAL_COVERAGE_MAX_SETS) {
    return {
      sets: [],
      reached,
      off: `the change reaches ${reached.length} measured sets, more than ` +
        `the ${LOCAL_COVERAGE_MAX_SETS} a gated change may reach`,
    };
  }
  return { sets: reached, reached };
}

/**
 * The units one selection makes mandatory, as `suite\tunit` keys.
 *
 * A unit the suite declares unavailable is left out: it does not run, so
 * requiring it would place an identity no invocation would execute.
 */
export function measuredUnitKeys(
  suites: readonly Suite[],
  selection: CoverageGateSelection,
): Set<string> {
  const bySuite = new Map(suites.map((suite) => [suite.id, suite]));
  const keys = new Set<string>();
  for (const ref of selection.sets) {
    const suite = bySuite.get(ref.suite);
    if (suite === undefined) continue;
    const unavailable = unavailableUnits(suite);
    for (const unit of ref.set.units) {
      if (unavailable.has(unit)) continue;
      keys.add(`${ref.suite}\t${unit}`);
    }
  }
  return keys;
}

/** The members one suite measures under a selection. */
export function measuredMembersOf(
  selection: CoverageGateSelection,
  suiteId: string,
): Set<string> {
  return new Set(
    selection.sets
      .filter((ref) => ref.suite === suiteId)
      .map((ref) => ref.set.member),
  );
}

/**
 * Whether a run measures any of a suite's members. The full run measures
 * every suite, because the baselines and the repository-wide trend both
 * come out of it; a pull request measures the suites of the sets its gate
 * scores, and no others.
 */
export function measuresSuite(
  selection: CoverageGateSelection,
  suiteId: string,
  full: boolean,
): boolean {
  return full || measuredMembersOf(selection, suiteId).size > 0;
}

/**
 * What running some entries costs a run with coverage on, read from what
 * their suites' batches have cost with coverage on, in the parts a lane
 * is charged them in.
 */
export interface MeasuredCost {
  /** Each suite's overhead, which every lane holding it pays once. */
  overhead: number;

  /**
   * Each entry's own cost through its suite's correction, once for every
   * time the entry runs, which is paid once however the entries are
   * spread.
   */
  spread: number;

  /**
   * Each unit's overhead, and how many of the entries are in it. Every
   * lane opening the unit pays its overhead, and all of one entry's runs
   * go in one lane, so a unit is opened in at most as many lanes as it
   * holds entries.
   */
  units: { overhead: number; entries: number }[];

  /**
   * The most any one entry charges the lane holding it, with its suite's
   * and its unit's overheads. All of one entry's runs go in one lane, so
   * no number of lanes holds an entry costing more than one lane does.
   */
  largest: number;
}

/**
 * What running `entries` costs a run with coverage on.
 *
 * Undefined where a suite among them has no such figure, which is every
 * suite until a lane has run one of its batches with coverage on. What
 * it costs without is no answer, being short by whatever instrumenting
 * it costs, and that is the whole of the question.
 */
export function measuredCost(
  calibration: Calibration,
  entries: readonly ManifestEntry[],
): MeasuredCost | undefined {
  const bySuite = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    bySuite.set(entry.suite, [...bySuite.get(entry.suite) ?? [], entry]);
  }
  const cost: MeasuredCost = { overhead: 0, spread: 0, units: [], largest: 0 };
  for (const [suite, held] of bySuite) {
    const fitted = calibration.suitesWithCoverage?.[suite];
    if (fitted === undefined) return undefined;
    const units = new Map<string, number>();
    for (const entry of held) {
      units.set(entry.unit, (units.get(entry.unit) ?? 0) + 1);
      const own = fitted.correction * entry.cost * entry.repeats;
      cost.spread += own;
      cost.largest = Math.max(
        cost.largest,
        fitted.overhead + fitted.unitOverhead + own,
      );
    }
    cost.overhead += fitted.overhead;
    for (const entries of units.values()) {
      cost.units.push({ overhead: fitted.unitOverhead, entries });
    }
  }
  return cost;
}

/**
 * The fewest of a run's lanes that hold `cost`, where each lane holding
 * any of it also pays `setup` for the capabilities it needs, and what
 * holding it in that many lanes charges; undefined where the run's lanes
 * cannot hold it.
 *
 * Spread over some number of lanes, it charges its spread once, its
 * suites' overheads and the setup in every one of them, and each unit's
 * overhead in as many of them as the unit can be split over. Those lanes
 * hold it where that fits inside their budgets together and its largest
 * entry, with the setup, fits inside one of them. A lane's prologue is
 * already outside its budget.
 */
function lanesHolding(
  cost: MeasuredCost,
  setup: number,
): { lanes: number; seconds: number } | undefined {
  if (cost.largest + setup > LANE_BUDGET_SECONDS) return undefined;
  for (let lanes = 1; lanes <= LANES; lanes++) {
    const seconds = cost.spread + lanes * (cost.overhead + setup) +
      cost.units.reduce(
        (sum, unit) => sum + unit.overhead * Math.min(lanes, unit.entries),
        0,
      );
    if (seconds <= lanes * LANE_BUDGET_SECONDS) return { lanes, seconds };
  }
  return undefined;
}

/** What setting up `capabilities` costs a lane, by `calibration`. */
function setupCost(
  calibration: Calibration,
  capabilities: Iterable<string>,
): number {
  let seconds = 0;
  for (const capability of new Set(capabilities)) {
    seconds += calibration.setupCost[capability] ?? 0;
  }
  return seconds;
}

/**
 * What a publisher says about what measured sets cost with coverage on:
 * each set past `LOCAL_COVERAGE_MAX_SECONDS`, and each member on the
 * exclusion list for its size whose tests would now fit the run's
 * budget. Neither is acted on. Both are decisions about the repository,
 * so they are put in front of a person rather than taken by a threshold.
 *
 * What a set has to fit is the whole run rather than one lane, since its
 * units are packed across lanes like any other mandatory work and the
 * totals meet again afterwards. A set spread over several lanes pays its
 * suites' overheads and its capabilities' setup in each of them, and
 * each unit's overhead in each lane holding part of that unit. A set and
 * a member alike are charged that over the fewest lanes holding them,
 * with each unit split over as many of those lanes as its entries allow.
 * The units a set's suite declares unavailable are not run, so they are
 * not charged.
 *
 * Both read what the lanes have measured batches with coverage on to
 * cost, and until the lanes have run a suite that way nothing here can
 * say what its tests cost, so this says as much rather than judging
 * from a figure that is short by an unknown amount. A set or member with
 * no recorded test is passed over, since nothing is known of its cost
 * either way.
 */
export function measuredCostLines(
  manifest: Manifest,
  suites: readonly Suite[],
): string[] {
  const lines: string[] = [];
  const unfitted = new Set<string>();
  let unjudged = 0;
  const judged = (
    entries: readonly ManifestEntry[],
  ): MeasuredCost | undefined => {
    if (entries.length === 0) return undefined;
    const cost = measuredCost(manifest.calibration, entries);
    if (cost !== undefined) return cost;
    unjudged += 1;
    for (const { suite } of entries) {
      if (manifest.calibration.suitesWithCoverage?.[suite] === undefined) {
        unfitted.add(suite);
      }
    }
    return undefined;
  };
  const needs = new Map(suites.map((suite) => [suite.id, suite.needs]));
  const unavailable = new Map(
    suites.map((suite) => [suite.id, unavailableUnits(suite)]),
  );
  for (const ref of measuredSets(suites)) {
    const units = new Set(
      ref.set.units.filter((unit) => !unavailable.get(ref.suite)?.has(unit)),
    );
    const cost = judged(
      manifest.entries.filter((entry) =>
        entry.suite === ref.suite && units.has(entry.unit)
      ),
    );
    if (cost === undefined) continue;
    const held = lanesHolding(
      cost,
      setupCost(manifest.calibration, needs.get(ref.suite) ?? []),
    );
    if (held !== undefined && held.seconds <= LOCAL_COVERAGE_MAX_SECONDS) {
      continue;
    }
    const costs = held === undefined
      ? `more with coverage on than the run's ${LANES} lanes of ` +
        `${duration(LANE_BUDGET_SECONDS)} hold`
      : `${duration(held.seconds)} with coverage on`;
    lines.push(
      `${measuredSetName(ref)} costs ${costs}, past ` +
        `LOCAL_COVERAGE_MAX_SECONDS of ${
          duration(LOCAL_COVERAGE_MAX_SECONDS)
        }. ` +
        `Its member's tests could be split, the run could carry the cost, ` +
        `or the member could go on EXCLUDED_FROM_COVERAGE_GATE.`,
    );
  }
  for (const member of EXCLUDED_FROM_COVERAGE_GATE.keys()) {
    if (exclusionKind(member) !== "size") continue;
    // A member's Deno-only tests are the ones its unit suite records
    // under its own scope, and those are what its set would hold.
    const scope = memberScope(member);
    const entries = manifest.entries.filter((entry) =>
      entry.test.k === "unit" && entry.test.s === scope
    );
    const cost = judged(entries);
    if (cost === undefined) continue;
    const held = lanesHolding(
      cost,
      setupCost(
        manifest.calibration,
        entries.flatMap((entry) => needs.get(entry.suite) ?? []),
      ),
    );
    if (held === undefined) continue;
    lines.push(
      `${member} is on EXCLUDED_FROM_COVERAGE_GATE for its size, and its ` +
        `tests now cost ${duration(held.seconds)} with coverage on ` +
        `across ${held.lanes} lane(s), inside the run's ${LANES} lanes of ` +
        `${duration(LANE_BUDGET_SECONDS)}, so its line can come off.`,
    );
  }
  if (unjudged > 0) {
    lines.push(
      `What ${unjudged} measured set(s) or exclusion-list entries cost ` +
        `with coverage on cannot be said yet: no lane has run ` +
        `${[...unfitted].sort().join(", ")} with coverage on in the last ` +
        `${COST_WINDOW_DAYS} day(s).`,
    );
  }
  return lines;
}
