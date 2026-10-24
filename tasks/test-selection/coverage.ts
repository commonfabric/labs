/**
 * Which measured sets a plan chose to run whole, and what measuring them
 * costs.
 *
 * A measured set is one suite's units over one workspace member's lines,
 * and its coverage gate is a test the plan chooses by score. The lanes
 * read what this makes of a plan to decide what to turn coverage on for,
 * and the job that joins the lanes packs the same plan and reads the same
 * answer from it rather than trusting what a lane reported.
 */

import { duration } from "./duration.ts";
import { type Suite, unavailableUnits } from "../test-topology/suite.ts";
import {
  COVERAGE_GATE_SUITE,
  measuredSetName,
  type MeasuredSetRef,
  measuredSets,
} from "../test-topology/coverage-gates.ts";
import { memberScope } from "../test-topology/unit.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import {
  aroundIn,
  chargedTests,
  type GateChoice,
  type Selection,
  testsOf,
} from "./plan.ts";
import {
  COST_WINDOW_DAYS,
  EXCLUDED_FROM_COVERAGE_GATE,
  exclusionKind,
  LANE_BUDGET_SECONDS,
  LANES_MAX,
  LOCAL_COVERAGE_MAX_SECONDS,
} from "./policy.ts";

/** What the coverage gates a change could choose came to in one plan. */
export interface CoverageGateSelection {
  /**
   * The sets whose gates the plan chose, which the lanes run whole and
   * measure, and whose verdicts are reached.
   */
  sets: MeasuredSetRef[];

  /**
   * Every set the change reached, whether or not the plan chose its gate.
   * A gate the change reached and the plan did not choose forces nothing,
   * and a summary that could not name it would leave nobody able to tell
   * a gate passed over from a set the change never touched.
   */
  reached: MeasuredSetRef[];
}

/**
 * The measured sets of the gates in `gates`, and of those among them that
 * `chosen` names, by the coverage-gate unit each gate is.
 */
export function coverageGateSelection(
  suites: readonly Suite[],
  gates: readonly GateChoice[],
  chosen: readonly Pick<Selection, "entry">[],
): CoverageGateSelection {
  const byName = new Map(
    measuredSets(suites).map((ref) => [measuredSetName(ref), ref]),
  );
  /** The sets, in their own order, whose gates `picked` names. */
  const setsOf = (picked: readonly ManifestEntry[]) => {
    const names = new Set(
      picked
        .filter((entry) => entry.suite === COVERAGE_GATE_SUITE)
        .map((entry) => entry.unit),
    );
    return [...byName].filter(([name]) => names.has(name)).map(([, ref]) =>
      ref
    );
  };
  return {
    sets: setsOf(chosen.map((selection) => selection.entry)),
    reached: setsOf(
      gates.filter((gate) => gate.reached).map((gate) => gate.entry),
    ),
  };
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
 * come out of it; a pull request measures the suites of the sets whose
 * gates its plan chose, and no others.
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
  /** Each suite's overhead, which every lane holding it pays at least once. */
  overhead: number;

  /**
   * What the entries take, which is paid once however they are spread:
   * for each suite, what `chargedTests()` makes of them all in one lane,
   * and the overheads of the passes and unit openings past the first that
   * its most repeated entries add, since all of one entry's runs go in one
   * lane. Spreading a suite over lanes charges each lane at least its own
   * share of the loads, and the longest unit of each pass is in one of
   * those lanes, so the lanes between them are charged no less, except
   * where lanes split a unit whose entries ask for different numbers of
   * runs. Each part of such a unit runs only as often as its own entries
   * ask, so this errs high there.
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
   * The most any one entry charges a lane holding nothing else, its
   * suite's and its unit's overheads included. All of one
   * entry's runs go in one lane, so no number of lanes holds an entry
   * costing more than one lane does.
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
  const cost: MeasuredCost = {
    overhead: 0,
    spread: 0,
    units: [],
    largest: 0,
  };
  for (const [suite, held] of bySuite) {
    const fitted = calibration.suitesWithCoverage?.[suite];
    if (fitted === undefined) return undefined;
    const around = aroundIn(held);
    /** What `entries` take, and their overheads past one lane's first. */
    const beyond = (entries: readonly ManifestEntry[]) => {
      const tests = testsOf(
        entries.map((entry) => ({ entry, repeats: entry.repeats })),
        around,
        fitted,
      );
      const units = new Set(entries.map((entry) => entry.unit)).size;
      return chargedTests(fitted.correction, tests) +
        fitted.overhead * (tests.longest.length - 1) +
        fitted.unitOverhead * (tests.opened - units);
    };
    for (const entry of held) {
      cost.largest = Math.max(
        cost.largest,
        fitted.overhead + fitted.unitOverhead + beyond([entry]),
      );
    }
    cost.spread += beyond(held);
    cost.overhead += fitted.overhead;
    for (const entries of Map.groupBy(held, (entry) => entry.unit).values()) {
      cost.units.push({
        overhead: fitted.unitOverhead,
        entries: entries.length,
      });
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
  for (let lanes = 1; lanes <= LANES_MAX; lanes++) {
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
      ? `more with coverage on than the ${LANES_MAX} lanes of ` +
        `${duration(LANE_BUDGET_SECONDS)} a pull request may take hold`
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
        `across ${held.lanes} lane(s), inside the ${LANES_MAX} lanes of ` +
        `${duration(LANE_BUDGET_SECONDS)} a pull request may take, so its ` +
        `line can come off.`,
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
