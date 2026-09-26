/**
 * What a lane costs beyond the tests it runs, fitted from what lanes
 * have spent.
 *
 * A test's own cost is what the runner measured for it. A lane pays
 * more: it opens the capabilities its batches need, it starts a runner
 * per batch, and it loads a module per file. None of that is in any
 * test's duration, and all of it is in the five minutes a lane has.
 *
 * The packer already charges each of those — `setupCost` the first time
 * a lane opens a capability, a suite's `overhead` the first time a lane
 * holds that suite, its `unitOverhead` the first time a lane opens one of
 * its units, and its `correction` against every identity's own cost. What
 * it charges them from is this.
 *
 * The inputs are the lane's own measurements of itself, which travel to
 * the store as ordinary records. A lane writes one per capability it
 * opened and three per batch: what the batch spent, what its tests took
 * between them, and how many units it opened. The second and third are
 * what make a fit possible at all — neither can be recovered from the
 * records the batch produced, because a reader cannot tell which of a
 * report's records came from which batch, and a unit whose tests all
 * recorded nothing leaves no trace of having been opened.
 *
 * What the batch's tests took, rather than what the packer expected them
 * to take. The two differ by however wrong the manifest's costs are, and
 * a unit nothing has measured is charged a stand-in that can be wrong by
 * a factor of ten. Fitting against the expectation would put that error
 * in the intercept, where it is charged once per lane for as long as the
 * measurement is kept, long after the costs behind it were measured, and
 * a suite whose intercept passes the bound a lane is packed to finish
 * inside places no discretionary identity at all. The error a suite's
 * cost model should carry is the machine's, which is what the tests' own
 * time leaves.
 *
 * What that costs is worth being plain about, because it is charged to
 * every lane rather than to the occasional bad window. The packer reads
 * the fitted slope against a manifest cost, which is the largest of the
 * days' ninetieth percentiles and so is deliberately above what a test
 * usually takes. A slope fitted against what tests usually take, read
 * against a figure padded above that, over-charges by the padding. So a
 * lane is packed short of what it could hold, by whatever margin the
 * cost figures carry, and the headroom that keeps a lane inside its
 * bound is that padding rather than this intercept. Under-packing is the
 * direction every fit here errs in; it is the price of an intercept that
 * measures the machine rather than the manifest.
 *
 * Every fit here errs high. A cost model that under-estimates puts a lane
 * past the bound it is packed to finish inside, where one that
 * over-estimates leaves a lane finishing early. What a run is charged
 * errs high too, with one exception: `pricedCalibration` charges a run
 * with coverage on the fit without coverage for a suite no lane has yet
 * run with coverage on, and that is short by whatever instrumenting the
 * suite costs.
 *
 * One reading cannot manage it at both ends. A suite's fixed cost and
 * what one of its units costs are measured from batches of much the same
 * size, which cannot tell the two apart, so whichever way the split falls
 * the model is under a batch of some size. `fitSuite` says which end it
 * chooses and what bounds the error there.
 */

import type { TestRecord } from "@commonfabric/test-support/records";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Calibration, SuiteFit } from "./manifest.ts";
import {
  batchMeasurement,
  isLaneMeasurement,
  setupMeasurement,
} from "../lane-measurement.ts";
import {
  LANE_PROLOGUE_SECONDS,
  MIN_CORRECTION_SAMPLES,
  MIN_CORRECTION_SPAN_SECONDS,
} from "./policy.ts";

/**
 * One thing a lane measured about itself, and the day it measured it.
 *
 * A batch stored without `measured` is read as one run without
 * coverage. An aggregate may hold batches of either kind without the
 * flag, and that reading errs high: an instrumented batch among the
 * uninstrumented raises what they are charged, where the other reading
 * would put uninstrumented batches among the instrumented and lower what
 * a lane measuring the suite is charged. Such batches age out of the
 * window `COST_WINDOW_DAYS` names like any other.
 */
export type LaneObservation =
  | { day: string; capability: string; seconds: number }
  | {
    day: string;
    suite: string;
    measured?: boolean;
    ran: number;
    spent: number;
    units: number;
  };

/** Whether a stored figure is one the fit can use. */
function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a stored value is one observation, which is what a stored
 * aggregate is read back through. A figure that will not read as a
 * finite number reaches the fit as one all the same, and a single such
 * entry decides what every lane is charged for the suite it names.
 */
export function isLaneObservation(value: unknown): value is LaneObservation {
  if (!isObjectOrArray(value)) return false;
  const one = value as Record<string, unknown>;
  if (typeof one.day !== "string") return false;
  if (typeof one.capability === "string") return finite(one.seconds);
  return typeof one.suite === "string" && finite(one.ran) &&
    finite(one.spent) && finite(one.units) &&
    (one.measured === undefined || typeof one.measured === "boolean");
}

/** One batch, as a lane measured it. */
export interface BatchObservation {
  /** The suite the batch ran. */
  suite: string;

  /** Whether coverage was on for the batch. */
  measured: boolean;

  /**
   * Seconds the batch's own tests took, summed over every execution of
   * every unit it ran. The suite's overhead and correction are not in
   * it, because they are what is fitted from it.
   */
  ran: number;

  /** Seconds the batch took. */
  spent: number;

  /**
   * Units the batch was asked to run. A unit's own tests are in `ran`;
   * what this counts is the runner started and the modules loaded to
   * reach them, which no test's duration holds.
   */
  units: number;
}

/** Every lane measurement a set of records holds, sorted into its kind. */
export interface Observations {
  /** Seconds each capability's setup took, every time one was opened. */
  setup: Map<string, number[]>;

  /** Each batch a lane both charged for and ran. */
  batches: BatchObservation[];
}

/**
 * What the aggregate has kept, in the shape the fit reads. The fold
 * pairs a batch's three measurements as it reads them, so what is stored
 * is already paired and this only sorts it.
 */
export function laneObservations(
  kept: Iterable<LaneObservation>,
): Observations {
  const setup = new Map<string, number[]>();
  const batches: BatchObservation[] = [];
  for (const one of kept) {
    if ("capability" in one) {
      setup.set(one.capability, [
        ...setup.get(one.capability) ?? [],
        one.seconds,
      ]);
    } else {
      batches.push({
        suite: one.suite,
        measured: one.measured === true,
        ran: one.ran,
        spent: one.spent,
        units: one.units,
      });
    }
  }
  return { setup, batches };
}

/**
 * Reads a run's records for what the lanes in it measured about
 * themselves.
 *
 * A batch is read only where all three of its measurements are present.
 * Two of them without the third say nothing a fit can use, and a lane
 * stopped part way through a batch leaves exactly that — the
 * three are written together, so a batch that never finished contributes
 * none of them.
 *
 * They are keyed by the run, the suite, and whether coverage was on,
 * because five lanes of one run may each run the same suite and adding
 * two lanes' figures would describe a batch neither of them ran. Not by
 * the measurement's name, which is what tells the three apart and would
 * therefore keep them apart.
 */
export function observationsOf(
  runs: Iterable<{ run: string; records: Iterable<TestRecord> }>,
): Observations {
  const setup = new Map<string, number[]>();
  const ran = new Map<string, number>();
  const spent = new Map<string, number>();
  const units = new Map<string, number>();
  const batchOf = new Map<string, { suite: string; measured: boolean }>();
  for (const { run, records } of runs) {
    for (const record of records) {
      if (!isLaneMeasurement(record.test)) continue;
      // Only a passing measurement says what the work costs. A batch
      // that went red stopped at the first invocation that failed, and
      // a capability that failed to open stopped part way through
      // opening; either reads as the work being cheap. The fold draws
      // the same line for a test's own duration and for the same reason.
      if (record.outcome !== "pass") continue;
      const seconds = record.durationMs / 1000;
      const capability = setupMeasurement(record.test.n);
      if (capability !== undefined) {
        setup.set(capability, [...setup.get(capability) ?? [], seconds]);
        continue;
      }
      const batch = batchMeasurement(record.test.n);
      if (batch === undefined) continue;
      // The suite and the coverage marker, not the name: a batch's three
      // measurements are named differently, and that is what tells them
      // apart. The marker is in the key so that a batch run with
      // coverage on pairs with the time its own tests took rather than
      // with an uninstrumented batch's.
      const key = `${run}\t${batch.suite}\t${batch.measured}`;
      batchOf.set(key, { suite: batch.suite, measured: batch.measured });
      // A count is not a duration. The record format carries one number
      // and calls it a duration, and the name is what says which of the
      // three this is, so the count is read back as it was written.
      if (batch.kind === "units") units.set(key, record.durationMs);
      else (batch.kind === "ran" ? ran : spent).set(key, seconds);
    }
  }
  const batches: BatchObservation[] = [];
  for (const [key, took] of spent) {
    const tests = ran.get(key);
    const opened = units.get(key);
    if (tests === undefined || opened === undefined) continue;
    batches.push({
      ...batchOf.get(key)!,
      ran: tests,
      spent: took,
      units: opened,
    });
  }
  return { setup, batches };
}

/**
 * What one group of records says, in the shape an aggregate stores. The
 * day travels with each observation so that a stored one can be aged the
 * way every other window is.
 */
export function laneObservationsOf(
  run: string,
  records: Iterable<TestRecord>,
  day: string,
): LaneObservation[] {
  const seen = observationsOf([{ run, records }]);
  return [
    ...[...seen.setup].flatMap(([capability, samples]) =>
      samples.map((seconds) => ({ day, capability, seconds }))
    ),
    ...seen.batches.map((batch) => ({
      day,
      suite: batch.suite,
      measured: batch.measured,
      ran: batch.ran,
      spent: batch.spent,
      units: batch.units,
    })),
  ];
}

/** The widest gap between two observations' readings of `of`. */
function span(
  observations: readonly BatchObservation[],
  of: (observation: BatchObservation) => number,
): number {
  const read = observations.map(of);
  return Math.max(...read) - Math.min(...read);
}

/**
 * The least-squares slope of `y` on `x` through the observations. The
 * caller has established that the observations disagree about `x`, so
 * they cannot all sit on one vertical line and the divisor is positive.
 */
function slopeOf(
  observations: readonly BatchObservation[],
  x: (observation: BatchObservation) => number,
  y: (observation: BatchObservation) => number,
): number {
  const n = observations.length;
  const meanX = observations.reduce((t, o) => t + x(o), 0) / n;
  const meanY = observations.reduce((t, o) => t + y(o), 0) / n;
  let top = 0;
  let bottom = 0;
  for (const o of observations) {
    top += (x(o) - meanX) * (y(o) - meanY);
    bottom += (x(o) - meanX) ** 2;
  }
  return top / bottom;
}

/**
 * What one second of a batch's own test time costs it.
 *
 * The slope is read far outside the range it was fitted over: a suite
 * whose every batch anybody has seen held six seconds of tests may be
 * charged thousands the first time a lane packs it whole. Inside a narrow
 * range the fixed cost dominates and the slope is noise, so it is fitted
 * only where the suite's batches have disagreed enough about that reading
 * for a slope to mean anything, and otherwise stays at one. That is the
 * reading which needs no evidence: a second of test time costs a second.
 *
 * It is not believed where it comes out at or below zero. A correction
 * below one is ordinary — a batch runs its files in parallel, so the wall
 * time of one is routinely a fraction of the sum of its tests' own
 * durations, and the pattern unit suite takes about a third — but at or
 * below zero it says a batch grows no dearer, or grows cheaper, the more
 * of the suite it holds, which would let a lane pack the suite without
 * limit against a flat charge. A manifest carrying a correction of zero
 * is refused whole, so publishing one would leave every lane with no
 * manifest at all.
 *
 * Nothing bounds it above. The intercept absorbs whatever a bound would
 * have moved, and the intercept is charged once for holding the suite
 * where this is charged in proportion, so bounding it makes a suite
 * dearer to reach rather than cheaper.
 *
 * It is not believed either where the line it belongs to passes below
 * the origin. A suite is charged a fixed cost of nothing or more, so
 * such a line is not one the model can carry, and a slope steep enough
 * to need it has taken what the batch spent on something else: within a
 * suite more units usually means more seconds of tests, so what it has
 * taken is what the units cost, and every batch then reads as having
 * spent nothing on them.
 */
function correctionOf(observations: readonly BatchObservation[]): number {
  if (observations.length < MIN_CORRECTION_SAMPLES) return 1;
  if (span(observations, (o) => o.ran) < MIN_CORRECTION_SPAN_SECONDS) return 1;
  const fitted = slopeOf(observations, (o) => o.ran, (o) => o.spent);
  if (fitted <= 0) return 1;
  const n = observations.length;
  const meanRan = observations.reduce((most, o) => most + o.ran, 0) / n;
  const meanSpent = observations.reduce((most, o) => most + o.spent, 0) / n;
  // A suite whose batches spend exactly in proportion to their tests sits
  // on the line this refuses either side of, and the fixed cost it is
  // judged by is the difference of two figures that are equal there, so
  // an exact comparison would settle it on what the arithmetic left
  // behind. A suite this refuses is out by seconds: the one that prompted
  // the guard fits a fixed cost of minus twenty-two.
  const fixed = meanSpent - fitted * meanRan;
  return fixed >= -1e-9 * meanSpent ? fitted : 1;
}

/**
 * What one unit costs a batch: a rate read off each batch, rather than a
 * slope fitted across batches of different sizes.
 *
 * A slope needs the suite's batches to have disagreed about how many units
 * they held, and whether they do is a property of the run rather than of
 * the suite. The packer puts an identity in the cheapest lane that can
 * still hold it and breaks a tie by which lane is emptier, so a suite
 * gathers in the lanes already holding it and is shared out among them;
 * where every lane fills to one budget the counts come out close. Across
 * a full run of twenty-two lanes the widest gap between two batches of
 * one suite is around twenty units against batches of eighty. A
 * least-squares slope over a gap that narrow comes out negative for five
 * of the eight suites with enough batches to fit one, and inside its own
 * standard error for two more; the eighth is the suite whose per-unit
 * cost has been measured directly, and the slope reads it at twice that
 * figure. Across five lanes packing a selection the same suite has held
 * five units in one batch and six hundred in another, which is a gap
 * worth fitting over. So a threshold on that gap settles what a suite is
 * charged from the shape of the run it was measured in, and where it is
 * not met the suite is charged nothing a unit, which is the direction
 * that runs a lane past its bound.
 *
 * What a batch does say on its own is a rate: what it spent beyond its
 * own tests, over the units that spending opened. Whatever the batch paid
 * for itself is in that rate, which is what carries a reading above what
 * a unit costs rather than below it. The middle reading is the one taken.
 * The largest charges every unit a small batch's whole fixed cost. The
 * smallest lands under the figure the same suites have been measured at
 * directly, because a batch's wall time moves by several seconds for
 * reasons that have nothing to do with what the batch held, and because
 * a correction fitted from the tests alone takes some of what a unit
 * costs with it.
 *
 * A batch whose spending is under what its own tests are charged has
 * nothing left to attribute to its units, which is where a suite running
 * its files in parallel lands. That is not evidence a unit gives time
 * back, so it reads as costing nothing.
 */
function unitCostOf(
  observations: readonly BatchObservation[],
  correction: number,
): number {
  const rates = observations
    .filter((observation) => observation.units > 0)
    .map((observation) =>
      Math.max(0, observation.spent - correction * observation.ran) /
      observation.units
    )
    .sort((a, b) => a - b);
  if (rates.length === 0) return 0;
  // The higher of the two middle readings where the count is even, which
  // is the direction every figure here errs in.
  return rates[Math.floor(rates.length / 2)]!;
}

/**
 * What the share of a batch that is not its tests comes to, as an
 * intercept and two figures charged in proportion to what the batch
 * holds.
 *
 * The intercept is raised until no observation is under-predicted,
 * whatever the other two came to. A least-squares line sits in the middle
 * of its observations by construction, which for this quantity means half
 * the lanes running past the budget they were packed against.
 *
 * The per-unit cost is read at a rate carrying a share of the suite's own
 * fixed cost, and the intercept is what that rate leaves. So a batch far
 * smaller than any this has seen is charged less than the whole of that
 * fixed cost, and what that can be wrong by is bounded by the fixed cost
 * itself. Charging nothing per unit is wrong by the per-unit cost times
 * however many units a lane packs, and nothing bounds that: neither term
 * left would grow with the units, so a lane packing a thousand of a
 * suite's cheapest units would be charged what a lane packing three is.
 */
export function fitSuite(
  observations: readonly BatchObservation[],
): { overhead: number; correction: number; unitOverhead: number } {
  const correction = correctionOf(observations);
  const unitOverhead = unitCostOf(observations, correction);
  const overhead = observations.reduce(
    (most, o) =>
      Math.max(most, o.spent - correction * o.ran - unitOverhead * o.units),
    0,
  );
  return { overhead, correction, unitOverhead };
}

/** What a lane pays beyond its tests, fitted from what lanes have spent. */
export function calibrate(observations: Observations): Calibration {
  const setupCost: Record<string, number> = {};
  // The worst opening anybody has seen, which is the same reading the
  // intercept takes and errs the same way.
  for (const [capability, seconds] of observations.setup) {
    setupCost[capability] = Math.max(...seconds);
  }
  // Instrumenting a run costs it time, and how much is a property of the
  // suite, so a suite's batches run with coverage on are fitted apart
  // from the ones run without.
  const without = new Map<string, BatchObservation[]>();
  const withCoverage = new Map<string, BatchObservation[]>();
  for (const batch of observations.batches) {
    const into = batch.measured ? withCoverage : without;
    into.set(batch.suite, [...into.get(batch.suite) ?? [], batch]);
  }
  const fitted = (bySuite: ReadonlyMap<string, BatchObservation[]>) =>
    Object.fromEntries(
      [...bySuite].map(([suite, batches]) => [suite, fitSuite(batches)]),
    );
  return {
    setupCost,
    suites: fitted(without),
    suitesWithCoverage: fitted(withCoverage),
    prologue: LANE_PROLOGUE_SECONDS,
  };
}

/** What a run charges its suites, and which of those charges it measured. */
export interface Pricing {
  /**
   * The calibration the run charges by. Each suite's entry in `suites` is
   * what the run charges it, whichever way the run runs its batches, so
   * it carries no coverage fits of its own.
   */
  calibration: Calibration;

  /**
   * The suites whose charge was fitted from batches run the way this run
   * runs them. Every other suite is charged what its batches cost when
   * run the other way, or nothing where no lane has run it at all.
   */
  fitted: ReadonlySet<string>;
}

/**
 * The calibration a run charges by, given each suite it runs and whether
 * it runs that suite's batches with coverage on.
 *
 * A suite is charged what its batches have cost when run the way this
 * run runs them. Where no lane has run it that way, it is charged what
 * they cost run the other way: with coverage on that errs high, and
 * without it is short by whatever instrumenting costs, but either is
 * nearer than charging nothing.
 */
export function pricedCalibration(
  calibration: Calibration,
  measuring: ReadonlyMap<string, boolean>,
): Pricing {
  const suites: Record<string, SuiteFit> = { ...calibration.suites };
  const fitted = new Set<string>();
  const covered = calibration.suitesWithCoverage ?? {};
  for (const [suite, measured] of measuring) {
    const [same, other] = measured
      ? [covered[suite], calibration.suites[suite]]
      : [calibration.suites[suite], covered[suite]];
    const charge = same ?? other;
    if (same !== undefined) fitted.add(suite);
    if (charge !== undefined) suites[suite] = charge;
  }
  return {
    calibration: {
      setupCost: calibration.setupCost,
      suites,
      prologue: calibration.prologue,
    },
    fitted,
  };
}
