/**
 * What a pull request runs, worked out from the manifest, the diff, and
 * nothing else.
 *
 * Every lane calls this over the same inputs and takes its own share of
 * the answer, so the lanes agree by construction, and the job ahead of
 * them decides only how many there are. That only holds while this is a
 * pure function: no clock, no unseeded randomness, no dependence on
 * anything but its arguments.
 * The exploration draw's seed comes from the manifest.
 */

import {
  enclosingNames,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import { maxOf } from "@commonfabric/utils/math";
import {
  DISCRETIONARY_SECONDS,
  FILL_DENSITY_SHARE,
  FILL_EXPLORATION_SHARE,
  FILL_VALUE_SHARE,
  FLAKE_EXCLUSION_RATE,
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BOUND_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES_MAX,
  NAMED_UNSCHEDULABLE,
} from "./policy.ts";
import type {
  Manifest,
  ManifestEntry,
  ScoreInputs,
  SuiteFit,
  UnschedulableEntry,
} from "./manifest.ts";
import { value } from "./score.ts";
import { duration } from "./duration.ts";

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
   * costing more than that, which may run up to the bound a lane is
   * packed to finish inside, and for a mandatory set that fits in no
   * lane, which `overBudgetSeconds` reports.
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
   * Seconds a lane of this plan is packed to finish inside, which the
   * policy decides, carried for the reason `budgetSeconds` is.
   */
  boundSeconds: number;

  /**
   * Identities this plan declined to run, so a lane can say why. Empty
   * for a full run, which declines nothing.
   */
  withheld: Manifest["withheld"];

  /**
   * Identities this plan declined to run because their unit runs whole
   * and holds a test the manifest withholds, which running the unit would
   * run. Empty for a full run.
   */
  heldWithUnit: TestIdentity[];

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
   * A pull request holds such a test back rather than running it, unless a
   * gate it chose runs the test's unit: a gate measures what it judges
   * whole, and the test's failure then fails that pull request for nothing
   * its author can act on, so it is here.
   */
  nonGating: Manifest["withheld"];

  /**
   * Seconds of room the value, density and exploration passes want: the
   * run's discretionary target, or what one lane holding every identity
   * they could choose would be charged where that is less. Zero for a full
   * run, which leaves nothing to choose.
   */
  discretionaryTargetSeconds: number;

  /**
   * Seconds those passes were given to fill between them: the run's
   * discretionary target, or what the mandatory pass left of the lanes'
   * budgets where that was less.
   */
  discretionarySeconds: number;

  /**
   * Seconds by which the mandatory pass alone put the longest lane past a
   * lane's budget, and zero where every lane held what it was given. The
   * longest lane is what a pull request waits on, which is why this is
   * that figure rather than the amount the lanes' total was overrun by.
   */
  overBudgetSeconds: number;

  /**
   * Mandatory identities that went past a lane's budget for want of a
   * lane: no lane could hold them, and none was empty to run them alone.
   * Zero means every mandatory identity either fit inside a lane's
   * budget or ran alone, so more lanes would bring no more of them under
   * it, apart from runs a repeated identity gave up.
   */
  overflowed: number;

  /**
   * Discretionary identities no lane can hold. One costing more than a
   * lane's planned budget is given a lane to itself and allowed to run up
   * to the bound a lane is packed to finish inside; one costing more than
   * that bound fits in no lane, so it is reported instead, and the
   * sixty-second rule is where such a test gets split. A mandatory
   * identity is never here, however expensive: it is placed, and
   * `overBudgetSeconds` is what says how far past its budget that put a
   * lane.
   */
  unschedulable: UnschedulableEntry[];

  /**
   * Suites a lane cannot fill around, and the fixed charge that says so.
   *
   * A lane pays a suite's overhead, its per-unit charge and its capabilities'
   * setup before it runs anything of that suite. Where those alone pass what a
   * lane holding two things may take, nothing can share a lane with one of its
   * identities, so the suite takes a whole lane per identity it places and the
   * lanes around it hold everything else. Where they pass the bound a lane is
   * packed to finish inside as well, no lane can hold it at all and every
   * discretionary identity it has is in `unschedulable`.
   *
   * Neither reading changes what the packer does; both are what makes it
   * answerable. A lane holding one test, and four lanes holding the rest
   * of the corpus, is otherwise a plan with no line in it saying why.
   */
  crowding: CrowdingSuite[];

  /**
   * The gates this plan chose, each under the reason it was chosen for. A
   * gate is a verdict reached outside the lanes over what they ran, so it
   * is in no lane; what choosing it put in the lanes is there under
   * `coverage-gate`. Under the full policy every gate is here.
   */
  gates: Selection[];
}

/**
 * A gate a plan may choose: a verdict reached over every identity of the
 * units it judges, once the lanes have run them.
 *
 * Choosing one runs all of those identities, wherever they fit, so a gate
 * costs a plan what they add to its lanes, and is chosen only where the
 * whole of that fits. A gate is scored like any test, by its own record.
 */
export interface GateChoice {
  /** The gate's own identity, with its score. */
  entry: ManifestEntry;

  /** The suite whose units it judges. */
  judges: string;

  /** The key of every identity in the units it judges. */
  members: readonly string[];

  /**
   * Whether the change reaches it. A budgeted plan chooses among the gates
   * the change reaches and no others; the full policy runs every gate.
   */
  reached: boolean;
}

/** A suite whose fixed charge alone is past what a lane can fill around. */
export interface CrowdingSuite {
  suite: string;

  /**
   * Overhead, per-unit charge and capability setup, without any test.
   */
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

  /**
   * How many lanes to fill, at least one. Defaults to the fewest
   * `laneCount` finds hold the run.
   */
  lanes?: number;

  /**
   * Seconds the value, density and exploration passes may fill between
   * them, or fewer where the lanes have less room left. Defaults to
   * `DISCRETIONARY_SECONDS`. Under `everything` it is zero whatever this
   * says, since that leaves nothing to choose.
   */
  discretionarySeconds?: number;

  /**
   * Seconds each lane may fill. Defaults to the dial the policy belongs
   * to, so that the full run cannot be packed against a pull request's
   * budget by leaving one field out.
   */
  budgetSeconds?: number;

  /**
   * The bound a lane is packed to finish inside. Defaults to the policy's
   * dial.
   */
  boundSeconds?: number;

  /**
   * The units whose runner runs every identity in them whatever it is asked,
   * each written as `<suite>\t<unit>`. `wholeUnits()` builds this set from the
   * topology.
   */
  wholeUnits: ReadonlySet<string>;

  /**
   * Every gate the topology declares. A gate is never placed in a lane, so
   * an entry of the corpus that is one of these is not packed as one.
   * Defaults to none.
   */
  gates?: readonly GateChoice[];
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

  /** What this lane's selections of each suite take, by suite. */
  tests: Map<string, SuiteTests>;

  /**
   * The invocation units this lane has opened, against what its
   * selections in each take, by suite and then by path. Two suites
   * name the same path where they run the same file two ways — the two
   * postures of a pattern integration test, a package built for two
   * targets — and each of those is a runner started and a module loaded of
   * its own.
   */
  unitTime: Map<string, Map<string, UnitRun>>;

  /**
   * The names of the tests whose own costs each unit's `UnitRun` here holds,
   * keyed as `unitTime` is.
   */
  held: Map<string, Map<string, Set<string>>>;

  /** The tests around each identity, in the corpus this lane is packed from. */
  around: Around;

  /** Seconds of work placed here so far. */
  load: number;
}

/**
 * The tests the corpus holds that enclose an identity in its unit, outermost
 * first: the `describe` blocks around a leaf, and the test around a step.
 *
 * A runner running an identity runs every test around it as well, so its
 * `beforeAll` and `afterAll` hooks run on every run of the unit, whichever
 * lane the corpus's entry for that `describe` went to. A test's own cost is
 * the time it spent outside the cases directly inside it, so the costs of a
 * chain of them do not overlap, and none of them overlaps the cost of a test
 * inside it.
 */
export type Around = (entry: ManifestEntry) => readonly ManifestEntry[];

/** An `Around` giving no identity any test around it. */
const NOTHING_AROUND: Around = () => [];

/**
 * The tests around each identity, read from `corpus`. Each identity's list is
 * worked out once and kept, since the packer asks for it every time it weighs
 * the identity against a lane.
 */
export function aroundIn(corpus: readonly ManifestEntry[]): Around {
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of corpus) {
    byKey.set(`${openedUnit(entry)}\t${testIdentityKey(entry.test)}`, entry);
  }
  const known = new Map<ManifestEntry, readonly ManifestEntry[]>();
  return (entry) => {
    const already = known.get(entry);
    if (already !== undefined) return already;
    const found = enclosingNames(entry.test.n).flatMap((n) => {
      const outer = byKey.get(
        `${openedUnit(entry)}\t${testIdentityKey({ ...entry.test, n })}`,
      );
      return outer === undefined ? [] : [outer];
    });
    known.set(entry, found);
    return found;
  };
}

/**
 * What a unit's selections in a lane take: a unit's runner runs it as many
 * times as the most any selection in it asks for, and every selection in
 * it each time, along with every test around one of them and the unit's
 * hooks.
 */
interface UnitRun {
  /**
   * The own costs of the selections and the tests around them, each test
   * counted once, and what the unit's hooks take, added together.
   */
  once: number;

  /** How many times the unit runs. */
  runs: number;
}

/**
 * Seconds `entry` adds to one run of its unit, where that run already runs
 * the tests named in `held` and the tests around `entry` are `around`: its own
 * cost and that of each test around it, less any the unit already runs. So
 * `entry` itself adds nothing where an identity inside it put it there.
 */
function addedBy(
  held: ReadonlySet<string> | undefined,
  entry: ManifestEntry,
  around: readonly ManifestEntry[],
): number {
  let added = held?.has(entry.test.n) ? 0 : entry.cost;
  for (const test of around) {
    if (!held?.has(test.test.n)) added += test.cost;
  }
  return added;
}

/**
 * What a lane's selections of one suite take, as the lane runs them.
 *
 * A lane runs a suite's share in passes, one for each time its most
 * repeated unit runs. Each pass invokes the suite's command afresh over
 * every unit that runs at least that many times, and runs every selection
 * in each of those units. So a pass pays the suite's overhead, each unit
 * it opens pays the unit's overhead, and the passes follow one another.
 */
export interface SuiteTests {
  /**
   * The own costs of the selections and the tests around them, and what
   * their units' hooks take, once for each time their unit runs.
   */
  ran: number;

  /**
   * What the unit taking longest in each pass takes, its hooks included,
   * first pass first. A
   * unit runs in as many of the first passes as it runs times, so no pass
   * takes longer than the one before it.
   */
  longest: readonly number[];

  /** How many times the passes open a unit between them. */
  opened: number;
}

/** What a lane holding nothing of a suite is charged for its tests. */
const NO_TESTS: SuiteTests = { ran: 0, longest: [], opened: 0 };

/**
 * The least the passes can take between them, whatever their units run
 * side by side: what the longest unit of each pass takes, added together.
 */
function floorOf(tests: SuiteTests): number {
  return tests.longest.reduce((sum, seconds) => sum + seconds, 0);
}

/**
 * What one identity costs a lane that is running nothing else, the tests
 * `around` it gives it included.
 */
function loneCost(
  manifest: Manifest,
  input: PlanInput,
  around: Around,
  entry: ManifestEntry,
  repeats = 1,
): number {
  return marginalCost(
    manifest,
    input,
    emptyLane(0, around),
    entry,
    repeats,
  );
}

/** A lane holding nothing yet, packed from a corpus `around` describes. */
function emptyLane(lane: number, around: Around): Filling {
  return {
    lane,
    selections: [],
    capabilities: new Set(),
    suites: new Set(),
    tests: new Map(),
    unitTime: new Map(),
    held: new Map(),
    around,
    load: 0,
  };
}

/**
 * What a lane is charged for a suite beyond its tests. A suite with no fit
 * is charged a correction of one, and nothing per pass or per unit.
 */
export function chargesOf(fitted: SuiteFit | undefined): SuiteFit {
  return fitted ?? { overhead: 0, correction: 1, unitOverhead: 0 };
}

/**
 * What the hooks of `unit` take each time it runs, by the suite's fit. A
 * unit the fit names no hooks for takes nothing for them.
 */
export function hooksOf(
  fitted: Pick<SuiteFit, "unitHooks">,
  unit: string,
): number {
  const hooks = fitted.unitHooks ?? {};
  return Object.hasOwn(hooks, unit) ? hooks[unit] ?? 0 : 0;
}

function capabilityCost(manifest: Manifest, capability: string): number {
  return manifest.calibration.setupCost[capability] ?? 0;
}

/**
 * What a lane pays to hold one identity of a suite, before that
 * identity's own time and that of the tests around it. It is one
 * identity's lone cost with the time taken out, read through the same
 * function the packer charges by, so that a term added there is in this
 * the moment it is added there. What the hooks of the identity's unit take
 * is time of the same kind, and is taken out with it, so the charge is the
 * suite's rather than the unit's.
 */
function fixedCost(
  manifest: Manifest,
  input: PlanInput,
  entry: ManifestEntry,
): number {
  const fitted = chargesOf(manifest.calibration.suites[entry.suite]);
  const idle = { entry: { ...entry, cost: 0 }, repeats: 1 };
  return loneCost(manifest, input, NOTHING_AROUND, idle.entry) -
    chargedTests(fitted.correction, testsOf([idle], NOTHING_AROUND, fitted));
}

/** How a lane names one unit of one suite among the units it has opened. */
function openedUnit(entry: Pick<ManifestEntry, "suite" | "unit">): string {
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
 * - New real test failures are the sum, because the unit has one whenever
 *   any of its tests does. Two tests with a new real test failure at one
 *   commit count twice, which favors running the unit.
 * - Sources and churn are the largest, because an entry records how many
 *   distinct sources saw a new real test failure, not which ones.
 * - Flake rate and repeat count are the largest, because a test disagreeing
 *   with itself makes the whole invocation disagree.
 * - The last run is the oldest of the tests' last runs, and absent when any
 *   test has never run.
 * - Score is computed from the combined inputs as of the day the manifest
 *   was written, which is the date of every other score in it.
 *
 * A unit holding one identity keeps that identity's entry. Each identity is
 * taken to be listed once, as `plan()` refuses a corpus listing one twice.
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
    const group = grouped.get(unit);
    if (group === undefined) grouped.set(unit, [entry]);
    else group.push(entry);
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
      sources: maxOf(group.map((entry) => entry.inputs.sources)),
      churn: maxOf(group.map((entry) => entry.inputs.churn)),
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
      flakeRate: maxOf(group.map((member) => member.flakeRate)),
      repeats: maxOf(group.map((member) => member.repeats)),
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
 * What `selections` of one suite take, all of them in one lane, where the
 * tests around each are what `around` gives. A test around a selection is
 * counted once in its unit however many selections it encloses, and not at
 * all where it is a selection itself.
 *
 * Each unit is summed from the tests it runs cheapest first and the units
 * are added up smallest first, so that the figures are the same numbers
 * however the selections were listed, since floating-point addition
 * rounds differently in a different order.
 */
export function testsOf(
  selections: readonly Pick<Selection, "entry" | "repeats">[],
  around: Around,
  fitted: Pick<SuiteFit, "unitHooks"> = {},
): SuiteTests {
  const units = new Map<string, {
    costs: number[];
    names: Set<string>;
    around: Map<string, number>;
    runs: number;
  }>();
  for (const { entry, repeats } of selections) {
    const key = openedUnit(entry);
    const unit = units.get(key) ?? {
      costs: [hooksOf(fitted, entry.unit)],
      names: new Set<string>(),
      around: new Map<string, number>(),
      runs: 1,
    };
    units.set(key, unit);
    unit.costs.push(entry.cost);
    unit.names.add(entry.test.n);
    for (const test of around(entry)) unit.around.set(test.test.n, test.cost);
    unit.runs = Math.max(unit.runs, repeats);
  }
  const runs: UnitRun[] = [...units.values()].map((unit) => ({
    once: [
      ...unit.costs,
      ...[...unit.around].flatMap(([name, cost]) =>
        unit.names.has(name) ? [] : [cost]
      ),
    ].toSorted((a, b) => a - b)
      .reduce((sum, seconds) => sum + seconds, 0),
    runs: unit.runs,
  }));
  const longest: number[] = [];
  for (const unit of runs) {
    for (let pass = 0; pass < unit.runs; pass++) {
      longest[pass] = Math.max(longest[pass] ?? 0, unit.once);
    }
  }
  return {
    ran: runs.map((unit) => unit.once * unit.runs)
      .toSorted((a, b) => a - b)
      .reduce((sum, seconds) => sum + seconds, 0),
    longest,
    opened: runs.reduce((sum, unit) => sum + unit.runs, 0),
  };
}

/**
 * What a lane is charged for the time its selections of one suite take:
 * what they take between them through the suite's correction, or the
 * least the passes can take, where that is more. The calibration reads
 * what a batch's tests took the same way, so the two agree about what a
 * batch of the suite costs.
 */
export function chargedTests(correction: number, tests: SuiteTests): number {
  return Math.max(correction * tests.ran, floorOf(tests));
}

/**
 * The tests around `selections`, read from the entries `manifest` holds in
 * their units.
 */
export function aroundOf(
  manifest: Manifest,
  selections: readonly Pick<Selection, "entry">[],
): Around {
  const units = new Set(selections.map(({ entry }) => openedUnit(entry)));
  return aroundIn(
    manifest.entries.filter((entry) => units.has(openedUnit(entry))),
  );
}

/**
 * What the packer charges a lane for the time its selections of `suite`
 * take, the tests `manifest` holds around them included, by the suite's
 * correction in `manifest`. Every selection is to be one of that suite's.
 */
export function suiteLoad(
  manifest: Manifest,
  suite: string,
  selections: readonly Pick<Selection, "entry" | "repeats">[],
): number {
  const other = selections.find(({ entry }) => entry.suite !== suite);
  if (other !== undefined) {
    throw new Error(
      `${suite} was charged for a selection of ${other.entry.suite}`,
    );
  }
  const fitted = chargesOf(manifest.calibration.suites[suite]);
  return chargedTests(
    fitted.correction,
    testsOf(selections, aroundOf(manifest, selections), fitted),
  );
}

/**
 * What a lane is charged for holding `selections`, all of `suite`: the suite's
 * overhead for each pass, its per-unit charge for each time a pass opens a
 * unit, and what `suiteLoad()` makes of their tests. A lane's projection is
 * this added up over the suites it holds, and the setup of each capability it
 * opens, so it is what the lane's batch of the suite was projected to spend.
 */
export function suiteCharge(
  manifest: Manifest,
  suite: string,
  selections: readonly Pick<Selection, "entry" | "repeats">[],
): number {
  const fitted = chargesOf(manifest.calibration.suites[suite]);
  const tests = testsOf(selections, aroundOf(manifest, selections), fitted);
  return fitted.overhead * tests.longest.length +
    fitted.unitOverhead * tests.opened +
    chargedTests(fitted.correction, tests);
}

/**
 * What `lane`'s selections of the suite of `entry` take once it holds
 * `entry` as well, and what its unit then takes. `ran` and `floor` are
 * what the two figures the lane is charged the larger of grow by, worked
 * out from what changed rather than as the difference of two sums, so that
 * where the loads set the charge the identity adds exactly what `addedBy()`
 * says it adds to its unit, for each time its unit runs.
 */
function withSelection(
  lane: Filling,
  entry: ManifestEntry,
  repeats: number,
  fitted: SuiteFit,
): {
  held: SuiteTests;
  tests: SuiteTests;
  unit: UnitRun;
  ran: number;
  floor: number;
} {
  const held = lane.tests.get(entry.suite) ?? NO_TESTS;
  const was = lane.unitTime.get(entry.suite)?.get(entry.unit);
  const added = addedBy(
    lane.held.get(entry.suite)?.get(entry.unit),
    entry,
    lane.around(entry),
  ) + (was === undefined ? hooksOf(fitted, entry.unit) : 0);
  const unit = {
    once: (was?.once ?? 0) + added,
    runs: Math.max(was?.runs ?? 1, repeats),
  };
  const before = was ?? { once: 0, runs: 0 };
  const longest = [...held.longest];
  let floor = 0;
  for (let pass = 0; pass < unit.runs; pass++) {
    const other = longest[pass] ?? 0;
    floor += Math.max(0, unit.once - other);
    longest[pass] = Math.max(other, unit.once);
  }
  const ran = added * unit.runs + before.once * (unit.runs - before.runs);
  return {
    held,
    tests: {
      ran: held.ran + ran,
      longest,
      opened: held.opened + unit.runs - before.runs,
    },
    unit,
    ran,
    floor,
  };
}

/**
 * What adding this identity to this lane would cost: what it raises the
 * lane's charge for its suite's tests by, plus its suite's overhead for
 * each pass it adds to the lane's batch of the suite and its suite's
 * per-unit overhead for each time it adds its unit to a pass, plus any
 * capability setup this lane has not opened yet.
 */
function marginalCost(
  manifest: Manifest,
  input: PlanInput,
  lane: Filling,
  entry: ManifestEntry,
  repeats: number,
): number {
  const fitted = chargesOf(manifest.calibration.suites[entry.suite]);
  const correction = fitted.correction;
  const { held, tests, ran, floor } = withSelection(
    lane,
    entry,
    repeats,
    fitted,
  );
  // Each term is taken past the old charge before the larger is chosen,
  // so that where the loads are the charge, what is added is exactly the
  // identity's own share of them, however large the lane's loads have
  // grown.
  const was = chargedTests(correction, held);
  let cost = Math.max(
    correction * held.ran - was + correction * ran,
    floorOf(held) - was + floor,
  );
  cost += fitted.overhead * (tests.longest.length - held.longest.length);
  cost += fitted.unitOverhead * (tests.opened - held.opened);
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
 * may go up to the bound a lane is packed to finish inside, which is
 * where an identity costing more than a whole lane's budget runs: it
 * cannot be split, so a lane to itself is the only place it goes. A
 * repeat can be split — dropping one run of it is what `take` does — so a
 * lane repeating an identity stops at the budget like any other.
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

/**
 * What placing one identity opened in its lane: whether the lane was not
 * yet holding its suite, whether another test of its unit may now cost the
 * lane less, and which of the capabilities its suite needs the lane had
 * not set up. What the lane
 * charges for anything sharing one of those can fall.
 */
interface Opened {
  lane: Filling;
  suite: boolean;

  /**
   * Whether the lane had not yet opened the unit, or now runs it more
   * times than it did. Adding to a unit that runs no more often than it
   * did lowers what nothing else in that unit costs, apart from a test
   * inside one of the tests `held` names, since what the lane charges for
   * a suite's tests only grows faster the more one unit holds. Running the
   * unit more often can: the reruns can raise the loads past the floor,
   * and a test of the unit that was charged against the floor is then
   * charged its share of the loads, which can be less.
   */
  unit: boolean;

  /**
   * The tests a run of the unit runs now and did not before: the identity,
   * unless an identity inside it put it there, and each test around it the
   * unit was not running. A test inside one of these adds less to a run of
   * the unit than it did, since that one's cost is in the unit already.
   */
  held: readonly ManifestEntry[];
  capabilities: string[];

  /**
   * Which tests of its suite may now cost this lane less: every one of
   * them; or those adding more than `outside` to a run of their unit,
   * together with those in a unit open in this lane adding more than
   * `within()` of that unit's `UnitRun` here; or none, where this is
   * `undefined`. `outside` covers a unit not open here, which takes
   * nothing and runs once. Neither covers the unit the placement went in,
   * whose tests `unit` and `held` say may cost less where they can. What a
   * test adds to a run of its unit is its own cost and that of each test
   * around it the unit is not running, so it is never more than those
   * costs added together.
   *
   * A lane holding a suite's tests is charged the larger of their loads
   * `cL` and their floor `P`; call that `C`. One run of a test adding `k`
   * to a unit taking `t` a run and running `r` times adds `ckr` to the
   * loads, and to the floor what the unit's `t + k` takes past the longest
   * unit of each of its passes, which is no more than `r(t + k - m)` where
   * `m` is the longest unit of its last pass. Its cost against the charge
   * is whichever of `cL + ckr - C` and `P` plus that addition `- C` is
   * larger. A placement that leaves `C` as it was lowers neither, and one
   * that raises it lowers each by no more than it raises `C`. Where the
   * loads set `C` after, the first is exactly `ckr`, so a test's cost
   * falls only where the second was more than that before, which needs
   * `k > (C - P + r(m - t)) / (r(1 - c))`, and never so where `c` is one
   * or more, since then the loads are never less than the floor. Where
   * the floor sets it after, a test's cost falls only where it was
   * positive before, which needs `k > (C - cL) / (cr)` or
   * `k > (C - P) / r + m - t`.
   */
  cheaper:
    | "all"
    | { outside: number; within: (unit: UnitRun) => number }
    | undefined;
}

function place(
  input: PlanInput,
  spot: Spot,
  entry: ManifestEntry,
  reason: SelectionReason,
  repeats: number,
): Opened {
  const lane = spot.lane;
  const was = lane.unitTime.get(entry.suite)?.get(entry.unit);
  const { held, tests, unit } = withSelection(
    lane,
    entry,
    repeats,
    chargesOf(input.manifest.calibration.suites[entry.suite]),
  );
  const suite = !lane.suites.has(entry.suite);
  const names = lane.held.get(entry.suite)?.get(entry.unit) ??
    new Set<string>();
  lane.held.set(
    entry.suite,
    (lane.held.get(entry.suite) ?? new Map()).set(entry.unit, names),
  );
  const newlyHeld: ManifestEntry[] = [];
  for (const test of [...lane.around(entry), entry]) {
    if (names.has(test.test.n)) continue;
    names.add(test.test.n);
    newlyHeld.push(test);
  }
  const opened: Opened = {
    lane,
    suite,
    unit: was === undefined || unit.runs > was.runs,
    held: newlyHeld,
    capabilities: (input.capabilities.get(entry.suite) ?? []).filter(
      (capability) => !lane.capabilities.has(capability),
    ),
    cheaper: suite ? "all" : cheaperIn(
      chargesOf(input.manifest.calibration.suites[entry.suite]).correction,
      held,
      tests,
    ),
  };
  lane.selections.push({ entry, reason, repeats });
  lane.tests.set(entry.suite, tests);
  lane.unitTime.set(
    entry.suite,
    (lane.unitTime.get(entry.suite) ?? new Map()).set(entry.unit, unit),
  );
  lane.load += spot.cost;
  lane.suites.add(entry.suite);
  for (const capability of opened.capabilities) {
    lane.capabilities.add(capability);
  }
  return opened;
}

/**
 * Helper for `place()`, which says what `Opened.cheaper` says for a suite
 * of correction `correction` whose tests in a lane took `held` and now
 * take `tests`.
 */
function cheaperIn(
  correction: number,
  held: SuiteTests,
  tests: SuiteTests,
): Opened["cheaper"] {
  const was = chargedTests(correction, held);
  if (chargedTests(correction, tests) <= was) return undefined;
  const pastLoads = was - correction * held.ran;
  const pastFloor = was - floorOf(held);
  /** The longest unit of the last pass a unit running `runs` times is in. */
  const last = (runs: number) => held.longest[runs - 1] ?? 0;
  let past: (once: number, runs: number) => number;
  if (correction * tests.ran >= floorOf(tests)) {
    if (correction >= 1) return undefined;
    past = (once, runs) =>
      (pastFloor + runs * (last(runs) - once)) / (runs * (1 - correction));
  } else {
    past = (once, runs) =>
      Math.min(
        pastLoads / (correction * runs),
        pastFloor / runs + last(runs) - once,
      );
  }
  return {
    outside: past(0, 1),
    within: (unit) => past(unit.once, unit.runs),
  };
}

/**
 * Helper for `plan()`, which lists the identities of `entries` in the order
 * of their keys. What every pass reads after that, the units run whole
 * included, is then in an order that depends on which identities there
 * are and not on where the manifest listed them, so where two tie, their
 * position does not decide.
 *
 * Throws where `entries` lists one identity twice, which a manifest may
 * not do: two rows can disagree about what the identity costs or scores,
 * and nothing here can say which of them is right.
 */
function inKeyOrder(
  entries: readonly ManifestEntry[],
): ManifestEntry[] {
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const key = testIdentityKey(entry.test);
    if (byKey.has(key)) {
      throw new Error(
        `${key} is listed more than once in the corpus this was given, ` +
          `so nothing here knows which of its rows to plan by`,
      );
    }
    byKey.set(key, entry);
  }
  return [...byKey]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, entry]) => entry);
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
 * What the last three passes may spend is a share of the run's
 * discretionary target, taken over the whole run rather than per lane, so
 * an expensive test can have a lane to itself while the others carry the
 * tail. What keeps any one lane from
 * running long is separate from the shares: those three passes put no
 * work in a lane past that lane's budget, and the lane that carries an
 * identity costing more than a whole lane's budget carries that identity
 * and nothing else. Together they make every lane finish near the budget,
 * which is the number the pull request waits on. The mandatory pass is
 * bounded by neither, and reports how far past a lane it went.
 *
 * A gate the change reaches is a candidate of the last three passes like
 * any test, taken by its own score. Choosing one places every identity it
 * runs, across as many lanes as that takes, inside the same budgets and
 * the same share, so a gate costs what running what it judges costs. The
 * mandatory pass never places a gate, and under the budgeted policy a gate
 * the change does not reach is never chosen.
 */
export function plan(input: PlanInput): Plan {
  return packed(input, true);
}

/**
 * Helper for `plan` and `laneCount`, which packs the run, and places
 * nothing past the mandatory pass unless `choosing`. Whether a count of
 * lanes holds a run is settled by the end of that pass, and the passes
 * after it, gates among them, are most of the work.
 */
function packed(input: PlanInput, choosing: boolean): Plan {
  const gateKeys = new Set(
    (input.gates ?? []).map((gate) => testIdentityKey(gate.entry.test)),
  );
  // A gate is a verdict reached outside the lanes, so the corpus the lanes
  // are packed from is everything else.
  const folding = foldWholeUnits(
    {
      ...input.manifest,
      entries: inKeyOrder(
        input.manifest.entries.filter((entry) =>
          !gateKeys.has(testIdentityKey(entry.test))
        ),
      ),
    },
    input.wholeUnits,
  );
  const manifest: Manifest = { ...input.manifest, entries: folding.entries };
  /** The key under which the packer places an identity. */
  const placedAs = (key: string): string => folding.standsFor.get(key) ?? key;
  const count = input.lanes ?? laneCount(input).lanes;
  // Every pass below reaches for a lane to put work in, so there has to
  // be one.
  if (count < 1) {
    throw new RangeError(
      `a plan needs a lane to fill, and was asked for ${count}`,
    );
  }
  const everything = input.policy === "everything";
  const laneBudget = input.budgetSeconds ??
    (everything ? FULL_LANE_BUDGET_SECONDS : LANE_BUDGET_SECONDS);
  const budget = laneBudget * count;
  // Read from the corpus as folded, where a whole unit's entry already costs
  // every test of the unit, the tests around the others included.
  const around = aroundIn(manifest.entries);
  const lanes: Filling[] = Array.from(
    { length: count },
    (_, i) => emptyLane(i + 1, around),
  );

  const bound = input.boundSeconds ??
    (everything ? FULL_LANE_BOUND_SECONDS : LANE_BOUND_SECONDS);
  const byKey = new Map(
    manifest.entries.map((entry) => [testIdentityKey(entry.test), entry]),
  );

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
  const withheldKeys = new Set(
    manifest.withheld.map((held) => testIdentityKey(held.test)),
  );
  const heldWithUnit: TestIdentity[] = [];
  for (const held of manifest.withheld) {
    const key = placedAs(testIdentityKey(held.test));
    if (requiredOf.has(key) || excluded.has(key)) continue;
    excluded.add(key);
    for (const member of folding.members.get(key) ?? []) {
      if (!withheldKeys.has(testIdentityKey(member.test))) {
        heldWithUnit.push(member.test);
      }
    }
  }
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    if (entry.flakeRate > FLAKE_EXCLUSION_RATE && !requiredOf.has(key)) {
      excluded.add(key);
    }
  }

  // An identity whose own measured time is past the bound a lane is
  // packed to finish inside fits in no lane, so a discretionary one is
  // reported rather than placed in a lane it would take past that bound.
  // A mandatory one is placed anyway: the change is not tested without it,
  // and a lane running long says so, where dropping it leaves the run
  // reporting a pass over a test that never ran. It is charged what a
  // lane holding nothing else is charged for it, which is its time through
  // its suite's correction or its own time, whichever is more, because
  // that is what the time will actually be.
  const unschedulable: UnschedulableEntry[] = [];
  // Every identity the discretionary passes could choose, by suite.
  const choosable = new Map<string, Selection[]>();
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
    // What an empty lane would pay for it: what its own time and that of
    // the tests around it come to in a lane holding nothing else, plus
    // every overhead and setup that lane would open. Charging only the
    // test's own time would schedule an identity whose suite, unit, the
    // tests around it, and capabilities together put the lane past the
    // bound it is packed to finish inside.
    const cost = loneCost(manifest, input, around, entry);
    if (cost <= bound) {
      if (counted) {
        const suite = choosable.get(entry.suite) ?? [];
        suite.push({ entry, reason: "value", repeats: entry.repeats });
        choosable.set(entry.suite, suite);
      }
      continue;
    }
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
  // What the value, density and exploration passes may choose from.
  const remaining = (): ManifestEntry[] =>
    !choosing ? [] : manifest.entries.filter((entry) => {
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
      // What an empty lane would pay for every one of those runs. Each
      // run is a pass of its own, paying its suite's overhead and its
      // unit's again, while the capabilities' setup is paid once however
      // many times the item runs, so multiplying one run's whole figure
      // would charge the setup again per repeat and order the pass by a
      // cost no lane pays.
      cost: loneCost(manifest, input, around, entry, entry.repeats),
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

  let overflowed = 0;
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
    if (
      taking === undefined &&
      lanes.every((lane) => lane.selections.length > 0)
    ) {
      overflowed += 1;
    }
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

  // The gates the discretionary passes may choose, against what choosing
  // each runs, costliest first for the reason the mandatory pass places
  // its work that way. A gate held back, or one the change does not reach,
  // is not among them. The full policy chooses every gate and needs none
  // of this, since every identity a gate could run is already placed.
  const open = new Map<string, OpenGate>();
  for (const gate of everything || !choosing ? [] : input.gates ?? []) {
    const key = testIdentityKey(gate.entry.test);
    if (!gate.reached || withheldKeys.has(key)) continue;
    if (gate.entry.flakeRate > FLAKE_EXCLUSION_RATE) continue;
    const runs = [...new Set(gate.members.map(placedAs))].map((member) => {
      const entry = byKey.get(member);
      // The same reasoning as a mandatory identity's: a gate whose runs the
      // corpus does not carry would be chosen without running them.
      if (entry === undefined) {
        throw new Error(
          `the gate ${key} runs ${member}, and the corpus this was given ` +
            `does not carry it, so nothing here knows what would run it`,
        );
      }
      return {
        key: member,
        entry,
        cost: loneCost(manifest, input, around, entry, entry.repeats),
      };
    });
    runs.sort((a, b) =>
      b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    );
    open.set(key, { entry: gate.entry, runs: runs.map((run) => run.entry) });
  }
  const chosen: Selection[] = everything
    ? inKeyOrder((input.gates ?? []).map((gate) => gate.entry)).map((
      entry,
    ) => ({ entry, reason: "full" as SelectionReason, repeats: 1 }))
    : [];
  /** The gates no pass has chosen yet, in the order of their keys. */
  const openGates = (): ManifestEntry[] =>
    inKeyOrder(
      [...open].filter(([key]) => !taken.has(key)).map(([, gate]) =>
        gate.entry
      ),
    );

  // The three shares are of the discretionary target, or of what the
  // mandatory pass left where that is less: lanes too few to hold both
  // give the passes what room there is.
  const target = discretionaryTarget(input);
  const left = Math.min(target, Math.max(0, budget - mandatoryLoad));
  /** A discretionary pass stopping at `share` of what the mandatory left. */
  const pass = (reason: SelectionReason, share: number): Pass => ({
    input,
    lanes,
    taken,
    around,
    reason,
    ceiling: mandatoryLoad + left * share,
    laneBudget,
    bound,
    gates: open,
    chosen,
  });

  // Value first: descending score, ignoring cost.
  fill(
    pass("value", FILL_VALUE_SHARE),
    [...remaining(), ...openGates()].sort((a, b) => b.score - a.score),
  );

  // Density: descending value per second of what each identity would cost
  // the lane it went in, which the value floor points at the cheap tail.
  fillDensest(
    pass("density", FILL_VALUE_SHARE + FILL_DENSITY_SHARE),
    remaining(),
    openGates(),
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
  const pool = [...remaining(), ...openGates()];
  const order = seededOrder(manifest.seed, pool.length);
  const drawn = order.map((i) => pool[i]!);
  // An identity nothing has run inside the aggregate's reach carries no
  // day at all, and it is the one most worth drawing, so it sorts ahead
  // of every day there is.
  drawn.sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  fill(
    pass(
      "exploration",
      FILL_VALUE_SHARE + FILL_DENSITY_SHARE + FILL_EXPLORATION_SHARE,
    ),
    drawn,
  );

  const laid = lanes.map((lane) => ({
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
  }));
  // A chosen gate runs every unit of what it judges, a unit held back with
  // a withheld test among them, so what a lane runs is not held back.
  const running = new Set(
    laid.flatMap((lane) =>
      lane.selections.map((selection) => testIdentityKey(selection.entry.test))
    ),
  );
  const judged = new Set(
    laid.flatMap((lane) =>
      lane.selections
        .filter((selection) => selection.reason === "coverage-gate")
        .map((selection) => testIdentityKey(selection.entry.test))
    ),
  );
  return {
    lanes: laid,
    budgetSeconds: laneBudget,
    boundSeconds: bound,
    // A full run withholds nothing: every identity is required, so the
    // reasons the manifest gives for holding one back never applied.
    // Reporting the manifest's list here would have a run that ran a
    // test say in its own summary that no lane chose it. What it ran
    // anyway and will not fail for is the other list, which is narrower:
    // every reason the manifest gives holds a test back, and only a
    // flake rate excuses one.
    withheld: everything ? [] : manifest.withheld,
    heldWithUnit: heldWithUnit.filter((test) =>
      !running.has(testIdentityKey(test))
    ),
    nonGating: excused(manifest).filter((held) =>
      everything || judged.has(testIdentityKey(held.test))
    ),
    // A target past what there is to choose from needs no more room than
    // that.
    discretionaryTargetSeconds: Math.min(
      target,
      oneLaneHolding(manifest, input, choosable),
    ),
    discretionarySeconds: left,
    overBudgetSeconds: overBudget,
    overflowed,
    unschedulable,
    crowding,
    gates: chosen,
  };
}

/**
 * The reasons the three discretionary passes place an identity for, a gate
 * they chose among them.
 */
const DISCRETIONARY: ReadonlySet<SelectionReason> = new Set([
  "value",
  "density",
  "exploration",
  "coverage-gate",
]);

/**
 * Whether a budgeted plan placed nothing beyond its mandatory identities,
 * which is what a plan does once the mandatory work leaves no room in any
 * lane for anything else. A gate chosen over identities the mandatory pass
 * had placed already placed nothing, so it is not counted.
 */
export function placedOnlyMandatory(laid: Pick<Plan, "lanes">): boolean {
  return !laid.lanes.some((lane) =>
    lane.selections.some((selection) => DISCRETIONARY.has(selection.reason))
  );
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
  return `${suite.suite} costs ${duration(suite.fixed)} before it runs ` +
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
 * What a lane pays before it runs anything of each suite the manifest
 * holds an identity of: the charge `crowding` compares against a lane's
 * budget, for every suite rather than only the ones past it.
 */
export function fixedCharges(
  given: Pick<PlanInput, "manifest" | "capabilities">,
): Record<string, number> {
  const input: PlanInput = {
    ...given,
    mandatory: new Map(),
    wholeUnits: new Set(),
  };
  const charges: Record<string, number> = {};
  for (const entry of input.manifest.entries) {
    charges[entry.suite] ??= fixedCost(input.manifest, input, entry);
  }
  return charges;
}

/** How many lanes a run takes, and whether it wanted more. */
export interface LaneCount {
  lanes: number;

  /** Whether the run needs more than even the most lanes it may take. */
  capped: boolean;
}

/**
 * Seconds a plan's value, density and exploration passes are to fill
 * between them, before the lanes' room is considered.
 */
function discretionaryTarget(input: PlanInput): number {
  return input.policy === "everything"
    ? 0
    : input.discretionarySeconds ?? DISCRETIONARY_SECONDS;
}

/**
 * How many lanes a run takes: the fewest at which a bisection finds that
 * the plan holds the run, or `most` where even that many lanes do not. A
 * plan holds the run where nothing mandatory overflows, so that each
 * mandatory identity either fits a lane's budget or runs alone in a lane
 * of its own, and where the room the mandatory pass leaves is at least
 * the discretionary target, `Plan.discretionaryTargetSeconds`. Under
 * `everything` the target is zero, and the count is the fewest lanes at
 * which nothing overflows.
 *
 * The job matrix has to be known before any lane starts, and the number
 * of lanes depends on how much work there is. So one job answers this,
 * and an integer is the whole of what it hands the lanes. The lanes then
 * call `plan` over the same inputs and take their own share of it, so
 * there is no second packing anywhere that could disagree with the first.
 *
 * Each count is judged by its own plan alone, which needs no other count
 * to compare against, so no count past `most` is ever packed. The count
 * is found by bisection, which takes a lane added to leave nothing
 * overflowing that did not before, and to leave no less room. Where that
 * fails, the answer can be more lanes than the run needs, but never
 * fewer: every count the bisection settles on below `most` is one it saw
 * hold the run.
 */
export function laneCount(
  input: Omit<PlanInput, "lanes">,
  most: number = LANES_MAX,
): LaneCount {
  const holds = (lanes: number) => {
    const laid = packed({ ...input, lanes }, false);
    return laid.overflowed === 0 &&
      laid.discretionarySeconds >= laid.discretionaryTargetSeconds;
  };
  // A lane per identity leaves an empty lane for each one as it is
  // placed, so nothing overflows there, and every identity could run in
  // a lane of its own, so more lanes could hold nothing more.
  let low = 1;
  let high = Math.max(1, Math.min(most, input.manifest.entries.length));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (holds(middle)) high = middle;
    else low = middle + 1;
  }
  // The bisection never packs the count it started from, which is the
  // cap when the cap is below a lane per identity.
  return { lanes: high, capped: high === most && !holds(high) };
}

/**
 * What one lane holding every one of `selections`, grouped by suite, would
 * be charged: each suite and each unit opened once, and each capability set
 * up once. Spread over several lanes the same work costs more, since each
 * lane opens what it holds again.
 */
function oneLaneHolding(
  manifest: Manifest,
  input: PlanInput,
  selections: ReadonlyMap<string, readonly Selection[]>,
): number {
  let seconds = 0;
  const capabilities = new Set<string>();
  for (const [suite, held] of selections) {
    seconds += suiteCharge(manifest, suite, held);
    for (const capability of input.capabilities.get(suite) ?? []) {
      capabilities.add(capability);
    }
  }
  for (const capability of capabilities) {
    seconds += capabilityCost(manifest, capability);
  }
  return seconds;
}

function laneLoad(lanes: readonly Filling[]): number {
  return lanes.reduce((total, lane) => total + lane.load, 0);
}

/** What one discretionary pass fills, and how far it may go. */
interface Pass {
  input: PlanInput;
  lanes: Filling[];

  /** Every identity any pass has placed, which no pass places again. */
  taken: Set<string>;

  /** The tests around each identity, as every lane reads them. */
  around: Around;
  reason: SelectionReason;

  /** The load of the whole run at which this pass stops. */
  ceiling: number;
  laneBudget: number;
  bound: number;

  /** The gates the passes may choose, by key. */
  gates: ReadonlyMap<string, OpenGate>;

  /** Every gate any pass has chosen, which every pass adds to. */
  chosen: Selection[];
}

/** A gate a discretionary pass may choose, and what choosing it runs. */
interface OpenGate {
  entry: ManifestEntry;

  /** The identities it runs, as the packer places them, costliest first. */
  runs: readonly ManifestEntry[];
}

/** What choosing a gate would leave the lanes as, and what it adds. */
interface GateTrial {
  lanes: Filling[];
  cost: number;
}

/** A lane that can be filled without changing `lane`. */
function copyOf(lane: Filling): Filling {
  return {
    ...lane,
    selections: [...lane.selections],
    capabilities: new Set(lane.capabilities),
    suites: new Set(lane.suites),
    tests: new Map(lane.tests),
    unitTime: new Map(
      [...lane.unitTime].map(([suite, units]) => [suite, new Map(units)]),
    ),
    held: new Map(
      [...lane.held].map(([suite, units]) => [
        suite,
        new Map([...units].map(([unit, names]) => [unit, new Set(names)])),
      ]),
    ),
  };
}

/**
 * What choosing `gate` would do to the lanes: every identity it runs that
 * no pass has placed, placed the costliest first, each in the cheapest lane
 * that holds it inside its budget, giving up repeats down to one run the
 * way `take` does. Undefined where one of them fits in no lane, or where
 * the whole takes the run past the pass's ceiling, since a gate reaches its
 * verdict over every identity of what it judges or reaches none.
 *
 * Worked out on copies of the lanes, so that weighing a gate leaves them as
 * they were.
 */
function gateTrial(pass: Pass, gate: OpenGate): GateTrial | undefined {
  const lanes = pass.lanes.map(copyOf);
  const before = laneLoad(lanes);
  for (const entry of gate.runs) {
    if (pass.taken.has(testIdentityKey(entry.test))) continue;
    let placed = false;
    for (let repeats = entry.repeats; repeats >= 1 && !placed; repeats--) {
      const spot = spotsFor(
        pass.input,
        lanes,
        entry,
        repeats,
        pass.laneBudget,
        pass.bound,
      ).fitting;
      if (spot === undefined) continue;
      if (laneLoad(lanes) + spot.cost > pass.ceiling) continue;
      place(pass.input, spot, entry, "coverage-gate", repeats);
      placed = true;
    }
    if (!placed) return undefined;
  }
  return { lanes, cost: laneLoad(lanes) - before };
}

/** Chooses `gate` for `pass`, leaving the lanes as `trial` found them. */
function choose(pass: Pass, gate: OpenGate, trial: GateTrial): void {
  pass.lanes.forEach((lane, at) => Object.assign(lane, trial.lanes[at]));
  for (const entry of gate.runs) pass.taken.add(testIdentityKey(entry.test));
  pass.taken.add(testIdentityKey(gate.entry.test));
  pass.chosen.push({ entry: gate.entry, reason: pass.reason, repeats: 1 });
}

/**
 * Takes candidates in the order given, up to this pass's share of the
 * whole run's budget and no further. The share is of the whole rather
 * than of each lane, so an expensive test can have a lane to itself while
 * the others carry the tail; what stops any one lane running long is the
 * lane's own capacity, which `spotsFor` applies. A gate among them is
 * chosen where everything it runs fits.
 */
function fill(pass: Pass, candidates: readonly ManifestEntry[]): void {
  for (const entry of candidates) {
    const key = testIdentityKey(entry.test);
    if (pass.taken.has(key)) continue;
    const gate = pass.gates.get(key);
    if (gate !== undefined) {
      const trial = gateTrial(pass, gate);
      if (trial !== undefined) choose(pass, gate, trial);
      continue;
    }
    const once = oneRun(pass, entry);
    if (once !== undefined) take(pass, entry, once);
  }
}

/**
 * The cheapest lane that can hold one run of this identity, where
 * holding it there keeps the run inside the pass's ceiling.
 */
function oneRun(pass: Pass, entry: ManifestEntry): Spot | undefined {
  const spot = spotsFor(
    pass.input,
    pass.lanes,
    entry,
    1,
    pass.laneBudget,
    pass.bound,
  ).fitting;
  return spot === undefined ||
      laneLoad(pass.lanes) + spot.cost > pass.ceiling
    ? undefined
    : spot;
}

/**
 * Places an identity one run of which fits at `once`, and says what that
 * opened in its lane. An identity that would be repeated but no longer
 * fits runs fewer times, down to once: one observation beats none.
 */
function take(pass: Pass, entry: ManifestEntry, once: Spot): Opened {
  pass.taken.add(testIdentityKey(entry.test));
  const spent = laneLoad(pass.lanes);
  for (let repeats = entry.repeats; repeats > 1; repeats--) {
    const spot = spotsFor(
      pass.input,
      pass.lanes,
      entry,
      repeats,
      pass.laneBudget,
      pass.bound,
    ).fitting;
    if (spot !== undefined && spent + spot.cost <= pass.ceiling) {
      return place(pass.input, spot, entry, pass.reason, repeats);
    }
  }
  return place(pass.input, once, entry, pass.reason, 1);
}

/** Value per second of an identity whose one run costs `cost`. */
function density(entry: ManifestEntry, cost: number): number {
  return entry.score / Math.max(cost, 1e-6);
}

/**
 * Takes candidates in descending value per second of what one run of each
 * would cost the lane it went in, with the identity key breaking a tie,
 * and places each the way `fill` does.
 *
 * What an identity costs a lane falls once that lane has opened its unit, its
 * suite, or a capability its suite needs, since a lane already running them
 * charges one run of a test nothing more for any of them. So choosing one test
 * of a file moves the file's other tests up the ordering, and choosing the
 * first test of a suite moves the rest of the suite. It falls too where a
 * placement raises what the lane charges for the suite, which is the larger of
 * the suite's loads and the time the longest unit of each pass takes, and the
 * test is one that `Opened.cheaper` names, where a placement makes its unit
 * run more times than it did, and where a placement makes its unit run a test
 * around it, whose cost the unit then already holds. Nothing else raises a
 * candidate's density: lanes and the run only fill up, which can only move it
 * to a lane charging more or leave it nowhere to go.
 *
 * So each candidate waits in a queue at the density it was last offered
 * at, which is never below its density now. A placement offers again,
 * at the higher figure, every candidate whose cost in that lane it
 * lowered. The candidate at the head of the queue is worked out afresh.
 * Where its density has not changed, it is the densest there is, and it
 * is taken. Where its density has fallen, it is offered again at what it
 * is now. Where it fits nowhere, it waits for a placement to lower its
 * cost.
 *
 * Each candidate is offered once to start with, again for each lane that
 * opens its unit, its suite, or one of its capabilities,
 * again for each placement that runs its unit more times or runs in it a
 * test some candidate of the unit is inside, again for each placement that
 * lowers what it costs against its suite's charge, and again for each lane
 * that fills too far to hold it. A placement is
 * weighed against its own lane alone, since no other lane changed. A suite
 * whose correction is one or more lowers nothing against the charge.
 * Otherwise a placement raising the suite's charge in a lane can lower the
 * cost there of many of its candidates at once, and those are offered
 * again. On the published
 * manifest that adds about half to planning. Where one unit of such a
 * suite holds tens of thousands of candidates and sets what its lanes are
 * charged, each placement in it lowers what most of the rest cost, and
 * planning takes a hundred times as long.
 *
 * A gate is a candidate too, at its score over what choosing it adds to the
 * lanes, which `gateTrial()` works out by placing every identity it runs.
 * That is a packing of a whole set of tests, so a gate is weighed when it
 * is first offered, when it reaches the head of the queue, and after a gate
 * is chosen, rather than after every placement. A placement that lowers
 * what a gate adds leaves it waiting at the density it was weighed at.
 */
function fillDensest(
  pass: Pass,
  candidates: readonly ManifestEntry[],
  gates: readonly ManifestEntry[],
): void {
  const { input, taken, around } = pass;
  /**
   * The most each candidate can add to a run of its unit: its own cost and
   * that of every test around it.
   */
  const reach = new Map(
    candidates.map((entry) => [
      entry,
      around(entry).reduce((total, test) => total + test.cost, entry.cost),
    ]),
  );
  const costliestFirstBy = (by: (entry: ManifestEntry) => string) =>
    new Map(
      [...groupBy(candidates, by)].map((
        [key, entries],
      ) => [key, entries.toSorted((a, b) => reach.get(b)! - reach.get(a)!)]),
    );
  const bySuite = costliestFirstBy((entry) => entry.suite);
  const byUnit = costliestFirstBy(openedUnit);
  /** The tests some candidate is inside. */
  const enclosing = new Set(candidates.flatMap(around));
  /** The suites among the candidates needing each capability. */
  const needing = new Map<string, string[]>();
  for (const suite of bySuite.keys()) {
    for (const capability of input.capabilities.get(suite) ?? []) {
      needing.set(capability, [...needing.get(capability) ?? [], suite]);
    }
  }

  const queue = new Offers();
  /** The density each waiting candidate was last offered at. */
  const offered = new Map<string, number>();
  const offer = (entry: ManifestEntry, key: string, at: number) => {
    offered.set(key, at);
    queue.push({ density: at, key, entry });
  };

  /** What one run of `entry` adds to the lanes as they stand, if it fits. */
  const weigh = (entry: ManifestEntry, key: string): number | undefined => {
    const gate = pass.gates.get(key);
    return gate === undefined
      ? oneRun(pass, entry)?.cost
      : gateTrial(pass, gate)?.cost;
  };
  /** Offers again each candidate whose density has risen. */
  const offerRisen = (entries: readonly ManifestEntry[]) => {
    for (const entry of entries) {
      const key = testIdentityKey(entry.test);
      if (taken.has(key)) continue;
      const cost = weigh(entry, key);
      if (
        cost !== undefined &&
        density(entry, cost) > (offered.get(key) ?? -Infinity)
      ) {
        offer(entry, key, density(entry, cost));
      }
    }
  };
  offerRisen([...candidates, ...gates]);

  for (let head = queue.pop(); head !== undefined; head = queue.pop()) {
    const { entry, key } = head;
    if (taken.has(key)) continue;
    const gate = pass.gates.get(key);
    if (gate !== undefined) {
      const trial = gateTrial(pass, gate);
      if (trial === undefined) {
        offered.delete(key);
      } else if (density(entry, trial.cost) !== head.density) {
        offer(entry, key, density(entry, trial.cost));
      } else {
        choose(pass, gate, trial);
        // A gate places work in any lane, so any candidate may now cost
        // less, and every one is weighed again.
        offerRisen([...candidates, ...gates]);
      }
      continue;
    }
    const once = oneRun(pass, entry);
    if (once === undefined) {
      offered.delete(key);
      continue;
    }
    if (density(entry, once.cost) !== head.density) {
      offer(entry, key, density(entry, once.cost));
      continue;
    }
    const opened = take(pass, entry, once);
    const unitCheaper = opened.unit ||
      opened.held.some((test) => enclosing.has(test));
    const lowered = [
      ...cheaperOf(opened, entry, bySuite, byUnit, reach),
      ...(unitCheaper ? byUnit.get(openedUnit(entry)) ?? [] : []),
      ...opened.capabilities.flatMap((capability) =>
        (needing.get(capability) ?? []).flatMap((suite) =>
          bySuite.get(suite) ?? []
        )
      ),
    ];
    // Only the lane the placement went in has changed, so a candidate's
    // best lane is either the one it was offered for, at no more than
    // its offered density, or this one.
    const load = laneLoad(pass.lanes);
    for (const other of lowered) {
      const otherKey = testIdentityKey(other.test);
      if (taken.has(otherKey)) continue;
      const was = offered.get(otherKey) ?? -Infinity;
      if (was >= density(other, 0)) continue;
      const cost = marginalCost(input.manifest, input, opened.lane, other, 1);
      if (
        opened.lane.load + cost <=
          capacity(opened.lane, 1, pass.laneBudget, pass.bound) &&
        load + cost <= pass.ceiling && density(other, cost) > was
      ) {
        offer(other, otherKey, density(other, cost));
      }
    }
  }
}

/**
 * Helper for `fillDensest()`, which lists the candidates of the suite of
 * `entry` that `opened`, the placement of `entry`, says may now cost its
 * lane less. Both maps hold their entries in descending `reach`, the most
 * each can add to a run of its unit.
 */
function cheaperOf(
  opened: Opened,
  entry: ManifestEntry,
  bySuite: ReadonlyMap<string, readonly ManifestEntry[]>,
  byUnit: ReadonlyMap<string, readonly ManifestEntry[]>,
  reach: ReadonlyMap<ManifestEntry, number>,
): readonly ManifestEntry[] {
  const { cheaper } = opened;
  const suite = entry.suite;
  if (cheaper === undefined) return [];
  if (cheaper === "all") return bySuite.get(suite) ?? [];
  const found = [
    ...reachingPast(bySuite.get(suite) ?? [], reach, cheaper.outside),
  ];
  for (const [unit, run] of opened.lane.unitTime.get(suite) ?? []) {
    if (unit === entry.unit) continue;
    const inUnit = reachingPast(
      byUnit.get(openedUnit({ suite, unit })) ?? [],
      reach,
      cheaper.within(run),
    );
    for (const candidate of inUnit) found.push(candidate);
  }
  return found;
}

/**
 * Helper for `fillDensest()`, which takes the leading entries of a list
 * sorted in descending `reach`, as far as the ones whose reach is more than
 * `above`.
 */
function reachingPast(
  entries: readonly ManifestEntry[],
  reach: ReadonlyMap<ManifestEntry, number>,
  above: number,
): readonly ManifestEntry[] {
  const end = entries.findIndex((entry) => reach.get(entry)! <= above);
  return end === -1 ? entries : entries.slice(0, end);
}

function groupBy(
  entries: readonly ManifestEntry[],
  by: (entry: ManifestEntry) => string,
): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const group = groups.get(by(entry));
    if (group === undefined) groups.set(by(entry), [entry]);
    else group.push(entry);
  }
  return groups;
}

/** A candidate of the density pass, and the density it was offered at. */
interface Offer {
  density: number;
  key: string;
  entry: ManifestEntry;
}

/** Whether `a` leaves the density pass's queue ahead of `b`. */
function ahead(a: Offer, b: Offer): boolean {
  return a.density > b.density || (a.density === b.density && a.key < b.key);
}

/** The density pass's queue: a binary heap, densest first. */
class Offers {
  #heap: Offer[] = [];

  push(offer: Offer): void {
    const heap = this.#heap;
    let at = heap.push(offer) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!ahead(heap[at]!, heap[parent]!)) return;
      [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
      at = parent;
    }
  }

  pop(): Offer | undefined {
    const heap = this.#heap;
    const head = heap[0];
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return head;
    heap[0] = last;
    let at = 0;
    for (;;) {
      let first = at;
      for (const child of [2 * at + 1, 2 * at + 2]) {
        if (child < heap.length && ahead(heap[child]!, heap[first]!)) {
          first = child;
        }
      }
      if (first === at) return head;
      [heap[at], heap[first]] = [heap[first]!, heap[at]!];
      at = first;
    }
  }
}
