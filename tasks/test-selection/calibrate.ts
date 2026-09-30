/**
 * What a lane costs beyond the tests it runs, read from what lanes have
 * measured about themselves.
 *
 * A test's own cost is what the runner measured for it. A lane pays
 * more: it opens the capabilities its batches need, it starts processes
 * to run them, each of which may spend time before its first unit begins,
 * and it loads a module per file. None of that is in any test's duration,
 * and all of it is in the five minutes a lane has.
 *
 * The packer already charges each of those — `setupCost` the first time
 * a lane opens a capability, a suite's process `setup` each time a lane
 * starts one of its processes, its `overhead` for each pass a lane's
 * batch of the suite makes, its `unitOverhead` each time one of those
 * passes opens one of its units, and its `correction` against what the
 * batch's tests take. What it charges them from is this.
 *
 * A batch makes one pass for each time its most repeated unit runs. Each
 * pass invokes the suite's command afresh over the units still running,
 * so it starts the suite's processes again and runs every selected test
 * of each of those units again.
 *
 * The inputs are the lane's own measurements of itself, which travel to
 * the store as ordinary records. A lane writes one per capability it
 * opened and seven per batch: what the batch spent, what its tests took
 * between them, how many times its passes opened a unit, what the longest
 * unit of each pass took added together, how many passes it made, what the
 * processes it started spent before their units began, and how many such
 * processes it started. None of the batch's seven can be recovered from
 * the records the batch produced, because a reader cannot tell which of a
 * report's records came from which batch, and a unit whose tests all
 * recorded nothing leaves no trace of having been opened. A lane also
 * writes what the packer charged it for each batch, and three figures
 * about its work as a whole; nothing is fitted from those, and they are
 * read here only to be kept.
 *
 * Two of the charges are measured, and read off what lanes saw: how long
 * a capability took to open, and how long a process spent before its
 * units began, which its runner marks and the lane times. The other two
 * are fitted, because what they describe happens inside a process where
 * no lane can see it. How far a runner running its files side by side
 * shares their time out is the correction, and what loading one more
 * file costs is the per-unit charge. Both are read from what each batch
 * spent once its processes' setup is taken out. So is the intercept, what
 * a batch spent beyond everything else here, which a lane is charged once
 * for each pass.
 *
 * A suite whose processes mark nothing, such as the repository gates or
 * one type check over many paths, keeps what they spend before their
 * units in what its units cost. A process of a suite whose other
 * processes mark, but which leaves no mark itself, such as a `deno test`
 * with no permission to write to its spool, is charged the setup
 * measured from the rest.
 *
 * The fourth figure is what a suite running its units side by side is
 * bounded by. The pattern unit suite runs five files at a time, so a batch
 * of many files spends about a third of what they took between them, and
 * the correction fitted from such batches says so. A batch holding one
 * file that takes minutes spends at least those minutes, and twice them
 * where the file runs twice, whatever the correction makes of it. So a
 * batch's tests are charged whichever is more: the correction times what
 * they took, or what the longest unit of each pass took added together.
 *
 * What the batch's tests took, rather than what the packer expected them
 * to take. The two differ by however wrong the manifest's costs are, and
 * a unit nothing has measured is charged a stand-in that can be wrong by
 * a factor of ten. Fitting against the expectation would put that error
 * in the per-unit charge and the correction, where it is charged to every
 * lane for as long as the measurement is kept, long after the costs
 * behind it were measured. The error a suite's cost model should carry is
 * the machine's, which is what the tests' own time leaves.
 *
 * What that costs is worth being plain about, because it is charged to
 * every lane rather than to the occasional bad window. The packer reads
 * the fitted slope against a manifest cost, which is the ninetieth
 * percentile of a test's executions across the cost window and so is
 * above what the test usually takes. A slope fitted against what tests
 * usually take, read against a figure above that, over-charges by the
 * difference. So a lane is packed short of what it could hold, by
 * whatever margin the cost figures carry. That margin is one of three
 * things between what a lane is projected to spend and its bound; the
 * others are the charges below, each read high, and the safety margin
 * `LANE_SAFETY_SECONDS`. The correction and the per-unit charge are each
 * read from the middle of what batches did, and the intercept beside them
 * covers a batch that spent more than that on its units.
 *
 * The fixed charges err high: above what the typical lane pays. A cost
 * model that under-estimates puts a lane past the bound it is packed to
 * finish inside, where one that over-estimates leaves a lane finishing
 * early. A capability's setup, a process's setup, and a suite's intercept
 * are each read at the ninetieth percentile of what lanes have seen. That
 * is well above the typical observation, and it is not the slowest one:
 * up to one observation in ten exceeds its charge, by an amount nothing
 * here bounds. The safety margin `LANE_SAFETY_SECONDS` leaves between a
 * lane's budget and its bound absorbs such an excess up to its own size,
 * and a lane whose observations exceed their charges by more than that
 * between them runs past its bound. Each charge is paid by every lane
 * that starts the process, holds the suite or opens the capability, for
 * as long as the window keeps the observations it was read from. Read at
 * the slowest observation, a single slow runner would set what every lane
 * is charged, and every lane would pack short by the whole of that
 * runner's excess.
 *
 * What a run is charged errs high too, with one exception:
 * `pricedCalibration` charges a run with coverage on the fit without
 * coverage for a suite no lane has yet run with coverage on, and that is
 * short by whatever instrumenting the suite costs.
 *
 * A process whose runner marks nothing, and a batch stored by a lane that
 * did not measure its processes' setup, cannot say where that setup ends.
 * `fitSuite` says what a suite is charged from them.
 */

import type { TestRecord } from "@commonfabric/test-support/records";
import { maxOf, minOf } from "@commonfabric/utils/math";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Calibration, SuiteFit } from "./manifest.ts";
import {
  batchMeasurement,
  isLaneMeasurement,
  laneMeasurement,
  setupMeasurement,
} from "../lane-measurement.ts";
import {
  LANE_PROLOGUE_SECONDS,
  MIN_CORRECTION_SAMPLES,
  MIN_CORRECTION_SPAN_SECONDS,
} from "./policy.ts";
import { percentile90 } from "./score.ts";

/**
 * One thing a lane measured about itself, and the day it measured it:
 * one capability's setup, one batch, or the lane's work as a whole. A
 * batch carries what the packer charged for it, as `projected`, where
 * the lane recorded that.
 *
 * A batch carries each figure `BatchObservation` marks optional only
 * where whatever wrote it recorded that figure, and it may carry figures
 * this reader does not know. An absent figure says nothing:
 * `fitSuite()` prefers the batches that carry it.
 */
export type LaneObservation =
  | { day: string; capability: string; seconds: number }
  | ({ day: string; projected?: number } & BatchObservation)
  | ({ day: string } & LaneRun);

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
  if (one.suite === undefined) {
    return finite(one.spent) && finite(one.projected) && finite(one.bound);
  }
  return typeof one.suite === "string" && finite(one.ran) &&
    (one.projected === undefined || finite(one.projected)) &&
    finite(one.spent) && finite(one.units) &&
    (one.measured === undefined || typeof one.measured === "boolean") &&
    (one.longest === undefined || finite(one.longest)) &&
    (one.passes === undefined ||
      (typeof one.passes === "number" && Number.isInteger(one.passes) &&
        one.passes >= 1)) &&
    (one.setup === undefined || isProcessSetup(one.setup));
}

/** Whether a stored value is a batch's processes' setup. */
function isProcessSetup(value: unknown): boolean {
  if (!isObjectOrArray(value)) return false;
  const setup = value as Record<string, unknown>;
  return finite(setup.seconds) && finite(setup.processes);
}

/**
 * One batch, as a lane measured it. Each optional figure is absent where
 * the batch does not say it, and `CARRIES` names every one of them.
 */
export interface BatchObservation {
  /** The suite the batch ran. */
  suite: string;

  /** Whether coverage was on for the batch. */
  measured?: boolean;

  /**
   * Seconds the batch's own tests took, summed over every execution of
   * every unit it ran. The suite's overhead and correction are not in
   * it, because they are what is fitted from it.
   */
  ran: number;

  /** Seconds the batch took. */
  spent: number;

  /**
   * How many times the batch's passes opened a unit, a unit counting once
   * for each pass that ran it. A unit's own tests are in `ran`; what this
   * counts is the runner started and the modules loaded to reach them,
   * which no test's duration holds.
   */
  units: number;

  /**
   * Seconds the unit that took longest in each pass took, added up over
   * the passes. The batch spent at least this on its tests, however many
   * units it ran side by side, since its passes follow one another.
   */
  longest?: number;

  /**
   * How many passes the batch made, each an invocation of the suite's
   * command of its own. A batch that repeated none of its units makes one
   * pass.
   */
  passes?: number;

  /**
   * What the processes the batch started spent before their units began,
   * where their runners mark when that is, summed over every run.
   */
  setup?: ProcessSetup;
}

/** What a batch's processes spent before their units began. */
export interface ProcessSetup {
  /** Seconds, over every process the batch started and every run. */
  seconds: number;

  /** How many such processes the batch started, over every run. */
  processes: number;
}

/** The figures a `BatchObservation` may lack. */
type OptionalFigure = {
  [K in keyof BatchObservation]-?: undefined extends BatchObservation[K] ? K
    : never;
}[keyof BatchObservation];

/**
 * Whether a batch carries each figure it may lack. The type requires an
 * entry for every optional figure of `BatchObservation`, so `fitSuite()`
 * prefers the batches carrying a figure added there as it does the rest.
 */
const CARRIES: {
  [K in OptionalFigure]: (observation: BatchObservation) => boolean;
} = {
  measured: (observation) => observation.measured !== undefined,
  longest: (observation) => observation.longest !== undefined,
  passes: (observation) => observation.passes !== undefined,
  setup: (observation) => observation.setup !== undefined,
};

/** Batches a suite is fitted from, narrowest first, ending with all of them. */
type Narrowed = [
  readonly BatchObservation[],
  ...(readonly BatchObservation[])[],
];

/** What one batch spent, against what the packer charged the lane for it. */
export interface BatchCharge {
  suite: string;
  spent: number;
  projected: number;
}

/** One lane's work as a whole, as the lane measured it. */
export interface LaneRun {
  /** Seconds from opening its first capability to the end of its work. */
  spent: number;

  /** Seconds the packer projected that work to take. */
  projected: number;

  /**
   * The most seconds that work could take with the lane's job still
   * inside the bound the lane was packed to finish inside.
   */
  bound: number;
}

/** Every lane measurement a set of records holds, sorted into its kind. */
export interface Observations {
  /** Seconds each capability's setup took, every time one was opened. */
  setup: Map<string, number[]>;

  /** Each batch a lane both charged for and ran. */
  batches: BatchObservation[];

  /**
   * Each of those batches whose lane recorded what it was charged. Nothing
   * is fitted from these; they say how far the fit a lane was packed by
   * was out.
   */
  charges: BatchCharge[];

  /** Each lane that recorded its work as a whole. */
  lanes: LaneRun[];
}

/** One batch, with what it was charged where its lane recorded that. */
interface ChargedBatch {
  batch: BatchObservation;
  projected?: number;
}

/**
 * Sorts batches with their charges into the fields of `Observations`
 * holding them.
 */
function sortCharged(
  charged: readonly ChargedBatch[],
): Pick<Observations, "batches" | "charges"> {
  return {
    batches: charged.map(({ batch }) => batch),
    charges: charged.flatMap(({ batch, projected }) =>
      projected === undefined
        ? []
        : [{ suite: batch.suite, spent: batch.spent, projected }]
    ),
  };
}

/**
 * What the aggregate has kept, in the shape the fit reads. The fold
 * pairs a batch's measurements as it reads them, so what is stored
 * is already paired and this only sorts it.
 */
export function laneObservations(
  kept: Iterable<LaneObservation>,
): Observations {
  const setup = new Map<string, number[]>();
  const charged: ChargedBatch[] = [];
  const lanes: LaneRun[] = [];
  for (const one of kept) {
    if ("capability" in one) {
      setup.set(one.capability, [
        ...setup.get(one.capability) ?? [],
        one.seconds,
      ]);
    } else if ("suite" in one) {
      const { day: _, projected, ...batch } = one;
      charged.push({
        batch,
        ...(projected === undefined ? {} : { projected }),
      });
    } else {
      lanes.push({
        spent: one.spent,
        projected: one.projected,
        bound: one.bound,
      });
    }
  }
  return { setup, ...sortCharged(charged), lanes };
}

/**
 * Reads a run's records for what the lanes in it measured about
 * themselves.
 *
 * A batch is read only where what it spent, what its tests took, and how
 * many units it opened are all present. Two of them without the third say
 * nothing a fit can use, and a lane stopped part way through a batch
 * leaves exactly that — a lane writes a batch's measurements together, so
 * a batch that never finished contributes none of them. What its longest
 * units took, how many passes it made, and what it was charged, are read
 * where they are present, and so is its processes' setup, where both of its
 * figures are.
 *
 * A lane's measurements of its work as a whole are read where all three
 * are present, which is where the lane finished every batch it held and
 * every one of them passed.
 *
 * They are keyed by the run, the suite, and whether coverage was on,
 * because five lanes of one run may each run the same suite and adding
 * two lanes' figures would describe a batch neither of them ran. Not by
 * the measurement's name, which is what tells the eight apart and would
 * therefore keep them apart.
 */
export function observationsOf(
  runs: Iterable<{ run: string; records: Iterable<TestRecord> }>,
): Observations {
  const { setup, charged, lanes } = measuredIn(runs);
  return { setup, ...sortCharged(charged), lanes };
}

/**
 * Helper for `observationsOf()` and `laneObservationsOf()`, which returns
 * what `observationsOf()` describes with each batch beside its charge.
 */
function measuredIn(
  runs: Iterable<{ run: string; records: Iterable<TestRecord> }>,
): { setup: Map<string, number[]>; charged: ChargedBatch[]; lanes: LaneRun[] } {
  const setup = new Map<string, number[]>();
  const ran = new Map<string, number>();
  const spent = new Map<string, number>();
  const units = new Map<string, number>();
  const longest = new Map<string, number>();
  const passes = new Map<string, number>();
  const start = new Map<string, number>();
  const processes = new Map<string, number>();
  const projected = new Map<string, number>();
  const batchOf = new Map<string, { suite: string; measured: boolean }>();
  const lanes: LaneRun[] = [];
  for (const { run, records } of runs) {
    const lane: Partial<LaneRun> = {};
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
      const whole = laneMeasurement(record.test.n);
      if (whole !== undefined) {
        lane[whole] = seconds;
        continue;
      }
      const batch = batchMeasurement(record.test.n);
      if (batch === undefined) continue;
      // The suite and the coverage marker, not the name: a batch's eight
      // measurements are named differently, and that is what tells them
      // apart. The marker is in the key so that a batch run with
      // coverage on pairs with the time its own tests took rather than
      // with an uninstrumented batch's.
      const key = `${run}\t${batch.suite}\t${batch.measured}`;
      batchOf.set(key, { suite: batch.suite, measured: batch.measured });
      // A count is not a duration. The record format carries one number
      // and calls it a duration, and the name is what says which of the
      // eight this is, so a count is read back as it was written.
      if (batch.kind === "units") units.set(key, record.durationMs);
      else if (batch.kind === "processes") {
        processes.set(key, record.durationMs);
      } else if (batch.kind === "passes") {
        // A batch makes a whole number of passes, at least one, and the fit
        // divides by the count.
        if (Number.isInteger(record.durationMs) && record.durationMs >= 1) {
          passes.set(key, record.durationMs);
        }
      } else if (batch.kind === "ran") ran.set(key, seconds);
      else if (batch.kind === "longest") longest.set(key, seconds);
      else if (batch.kind === "start") start.set(key, seconds);
      else if (batch.kind === "projected") projected.set(key, seconds);
      else spent.set(key, seconds);
    }
    const { spent: took, projected: expected, bound } = lane;
    if (took !== undefined && expected !== undefined && bound !== undefined) {
      lanes.push({ spent: took, projected: expected, bound });
    }
  }
  const charged: ChargedBatch[] = [];
  for (const [key, took] of spent) {
    const tests = ran.get(key);
    const opened = units.get(key);
    if (tests === undefined || opened === undefined) continue;
    const bound = longest.get(key);
    const made = passes.get(key);
    const charge = projected.get(key);
    charged.push({
      batch: {
        ...batchOf.get(key)!,
        ran: tests,
        spent: took,
        units: opened,
        ...(bound === undefined ? {} : { longest: bound }),
        ...(made === undefined ? {} : { passes: made }),
        ...setupOf(start.get(key), processes.get(key)),
      },
      ...(charge === undefined ? {} : { projected: charge }),
    });
  }
  return { setup, charged, lanes };
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
  const seen = measuredIn([{ run, records }]);
  return [
    ...[...seen.setup].flatMap(([capability, samples]) =>
      samples.map((seconds) => ({ day, capability, seconds }))
    ),
    ...seen.charged.map(({ batch, projected }) => ({
      day,
      ...batch,
      ...(projected === undefined ? {} : { projected }),
    })),
    ...seen.lanes.map((lane) => ({ day, ...lane })),
  ];
}

/**
 * A batch's processes' setup, as the fields of an observation holding it,
 * from its two figures, or nothing where either is missing.
 */
function setupOf(
  seconds: number | undefined,
  processes: number | undefined,
): { setup?: ProcessSetup } {
  return seconds === undefined || processes === undefined
    ? {}
    : { setup: { seconds, processes } };
}

/** The widest gap between two observations' readings of `of`. */
function span(
  observations: readonly BatchObservation[],
  of: (observation: BatchObservation) => number,
): number {
  const read = observations.map(of);
  return maxOf(read) - minOf(read);
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
 * range what a batch spends apart from its tests dominates and the slope
 * is noise, so it is fitted only where the suite's batches have disagreed
 * enough about that reading for a slope to mean anything, and otherwise
 * is not fitted at all.
 * `fitSuite()` then charges one, which is the reading that needs no
 * evidence: a second of test time costs a second.
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
 * Nothing bounds it above. A slope fitted too high only over-charges.
 *
 * It is not believed either where the line it belongs to passes below
 * the origin. A batch spends nothing or more beyond its tests, so such a
 * line is not one the model can carry, and a slope steep enough to need
 * it has taken what the batch spent on something else: within a suite
 * more units usually means more seconds of tests, so what it has taken
 * is what the units cost, and every batch then reads as having spent
 * nothing on them.
 *
 * A batch whose floor, the longest unit of each pass added together,
 * outlasted what the slope makes of the rest spent what those units took,
 * not what the slope says, and fitting the slope through it pulls the
 * slope toward them, or past zero. So the slope is fitted again over the
 * batches a first fit over all of them does not charge their floor, where
 * those are enough to believe a slope from. Where the first fit is not
 * believed, the batches it is fitted again over are those whose floor
 * took less than half of what the batch spent, which is to say those that
 * spent most of what they spent on units side by side.
 */
function correctionOf(
  observations: readonly BatchObservation[],
): number | undefined {
  const fitted = slopeThrough(observations);
  const shared = observations.filter((o) =>
    fitted === undefined
      ? 2 * floorOf(o) < o.spent
      : fitted * o.ran >= floorOf(o)
  );
  return slopeThrough(shared) ?? fitted;
}

/**
 * Helper for `correctionOf()`, which fits the slope through
 * `observations`, or returns `undefined` where it is not to be believed.
 */
function slopeThrough(
  observations: readonly BatchObservation[],
): number | undefined {
  if (observations.length < MIN_CORRECTION_SAMPLES) return undefined;
  if (span(observations, (o) => o.ran) < MIN_CORRECTION_SPAN_SECONDS) {
    return undefined;
  }
  const fitted = slopeOf(observations, (o) => o.ran, (o) => o.spent);
  if (fitted <= 0) return undefined;
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
  return fixed >= -1e-9 * meanSpent ? fitted : undefined;
}

/**
 * What a batch's own tests are charged: the correction times what they
 * took, or what the longest unit of each pass took added together where
 * that is more. The second is the batch's floor, because a pass does not
 * finish before its longest unit has and the passes follow one another;
 * it binds for a suite running its units side by side, whose correction
 * is well below one.
 */
function testsCost(observation: BatchObservation, correction: number): number {
  return Math.max(correction * observation.ran, floorOf(observation));
}

/**
 * The least a batch spent on its tests: what the longest unit of each of
 * its passes took, added together, or nothing where the lane did not say.
 */
function floorOf(observation: BatchObservation): number {
  return observation.longest ?? 0;
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
 * own tests, over the units that spending opened, a unit counting once for
 * each pass that opened it. The middle reading is
 * the one taken. The largest charges every unit whatever one small batch
 * spent beyond its tests, which for a process marking nothing includes
 * the whole of its setup. The smallest lands under the figure the same
 * suites have been measured at directly, because a batch's wall time
 * moves by several seconds for reasons that have nothing to do with what
 * the batch held, and because a correction fitted from the tests alone
 * takes some of what a unit costs with it.
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
      Math.max(0, observation.spent - testsCost(observation, correction)) /
      observation.units
    )
    .sort((a, b) => a - b);
  if (rates.length === 0) return 0;
  // The higher of the two middle readings where the count is even, which
  // is the direction every figure here errs in.
  return rates[Math.floor(rates.length / 2)]!;
}

/**
 * What a suite costs a lane beyond its tests, fitted twice.
 *
 * The first fit reads each batch as a whole: an intercept charged once
 * per lane holding the suite, and a correction and a per-unit charge in
 * proportion to what the lane holds. What the suite's processes spend
 * before their units begin is spread through those three, however many
 * processes a lane starts. It is what a packer charges that does not know
 * the second fit, so it reads what that packer's lanes spent: a batch that
 * does not say what its processes spent on setup is as good a reading of
 * it as one that does, and the first fit prefers neither.
 *
 * The second fit, `process`, is made where some batch measured its
 * processes' setup and started a process that marks when its units begin,
 * and only from batches that measured it. Its `setup` is the ninetieth
 * percentile, over those batches, of what each batch's processes spent on
 * average before their units began, and a lane is charged it for each
 * process it starts. A batch's average is read rather than each process's
 * own figure, because what a lane pays is the sum over the processes it
 * starts, and over the twenty-odd a lane of the workspace unit suite
 * starts, the ninetieth percentile of the average comes near the
 * ninetieth percentile of what they come to together. It is below that
 * for a lane starting one process, and the process fit's intercept is
 * what covers the difference. The rest of the second fit is made the way
 * the first is, over what each batch spent once that setup is taken out,
 * since what the correction and the per-unit charge describe happens
 * inside a process where no lane can see it: how a runner shares out its
 * files' time between them, and what loading one more file costs.
 */
export function fitSuite(all: readonly BatchObservation[]): SuiteFit {
  const measured = all.flatMap(({ setup, ...o }) =>
    setup === undefined ? [] : [{ ...o, setup }]
  );
  const perProcess = measured
    .flatMap(({ setup }) =>
      setup.processes === 0 ? [] : [setup.seconds / setup.processes]
    )
    .sort((a, b) => a - b);
  // The first fit reads no setup, so it prefers no batch for carrying one.
  const whole = Object.entries(CARRIES).flatMap(([figure, carries]) =>
    figure === "setup" ? [] : [carries]
  );
  return {
    ...fitOver(all, whole),
    ...(perProcess.length === 0 ? {} : {
      process: {
        setup: percentile90(perProcess),
        ...fitOver(
          measured.map((o) => ({ ...o, spent: o.spent - o.setup.seconds })),
          Object.values(CARRIES),
        ),
      },
    }),
  };
}

/**
 * Helper for `fitSuite()`, which fits one of its two fits: what the share
 * of a batch that is not its tests, or its processes' setup where that is
 * taken out, comes to, as an intercept and two figures charged in
 * proportion to what the batch holds.
 *
 * What a batch's tests took is read through `testsCost()`, so a batch
 * whose floor outlasted what the correction makes of the rest leaves the
 * intercept only what it spent beyond the longest unit of each pass. The packer
 * charges a lane's share of a suite the same way.
 *
 * The intercept is charged once for each pass a batch makes, since each
 * pass starts the suite's command afresh. It is the ninetieth percentile
 * of what each batch spent beyond what the other two charge it, over the
 * passes it made, whatever those came to, so at least nine batches in
 * ten are charged what they spent or more. A
 * least-squares line sits in the middle of its observations by
 * construction, which for this quantity means half the lanes running past
 * the budget they were packed against. An intercept that no batch exceeds
 * is set by the single slowest batch in the window, whatever made that
 * batch slow, and every lane holding the suite pays it.
 *
 * The percentile is the observation at that rank rather than a value
 * between two of them, so over nine or fewer batches it is the largest,
 * and over ten to nineteen it is the second largest. A suite lanes have
 * rarely run is charged what its slowest batch cost, which errs high
 * where there are too few batches to tell a slow one from the suite.
 *
 * The per-unit cost is read at a rate carrying a share of whatever fixed
 * cost is left in what is fitted, and the intercept is what that rate
 * leaves. So a batch far
 * smaller than any this has seen is charged less than the whole of that
 * fixed cost, and what that can be wrong by is bounded by the fixed cost
 * itself. Charging nothing per unit is wrong by the per-unit cost times
 * however many units a lane packs, and nothing bounds that: neither term
 * left would grow with the units, so a lane packing a thousand of a
 * suite's cheapest units would be charged what a lane packing three is.
 *
 * A batch that lacks a figure the fit reads is read at a guess. One that
 * does not say whether coverage was on is read as run the way the fit is
 * for, one that does not say what its longest units took is charged no
 * floor, and one that does not say how many passes it made is read as one
 * pass, though where it repeated a unit its later passes' startup is then
 * left in its remainder. At the ninetieth percentile a few batches read
 * wrongly set the intercept for as long as the window keeps them, where
 * the batches beside them that do say would not. So each of `narrowing`,
 * the tests `CARRIES` holds for the figures the fit reads, in turn narrows
 * the batches to those that carry its figure, wherever there are
 * `MIN_CORRECTION_SAMPLES` of those or more, and the intercept and the
 * per-unit rate are read from the batches left.
 *
 * The correction is read from the narrowest of those sets of batches that
 * fits one. A slope needs batches that disagree about how long their tests
 * took, and the batches that carry a figure can be too alike to fit one,
 * where charging one would under-charge a suite whose tests cost more
 * than their own time. A least-squares slope moves with a misread batch in
 * proportion to that batch's share of the fit, where a ninetieth
 * percentile is set outright by the few batches at its top.
 */
function fitOver(
  all: readonly BatchObservation[],
  narrowing: readonly ((observation: BatchObservation) => boolean)[],
): { overhead: number; correction: number; unitOverhead: number } {
  const narrowed = narrowing.reduce<Narrowed>((sets, carries) => {
    const carrying = sets[0].filter(carries);
    return carrying.length < MIN_CORRECTION_SAMPLES
      ? sets
      : [carrying, ...sets];
  }, [all]);
  const [observations] = narrowed;
  const fits = narrowed.map(correctionOf);
  const correction = fits.find((fit) => fit !== undefined) ?? 1;
  const unitOverhead = unitCostOf(observations, correction);
  const remainders = observations
    .map((o) =>
      (o.spent - testsCost(o, correction) - unitOverhead * o.units) /
      (o.passes ?? 1)
    )
    .sort((a, b) => a - b);
  const overhead = Math.max(0, percentile90(remainders));
  return { overhead, correction, unitOverhead };
}

/** What a lane pays beyond its tests, read from what lanes have measured. */
export function calibrate(
  observations: Pick<Observations, "setup" | "batches">,
): Calibration {
  const setupCost: Record<string, number> = {};
  // The ninetieth percentile of the openings lanes have seen, which is the
  // reading a process's setup takes, for the same reason: the slowest
  // opening in the window is one runner's, and it would otherwise be
  // charged to every lane that opens the capability. Over nine or fewer
  // openings it is the slowest of them.
  for (const [capability, seconds] of observations.setup) {
    const sorted = [...seconds].sort((a, b) => a - b);
    setupCost[capability] = percentile90(sorted);
  }
  // Instrumenting a run costs it time, and how much is a property of the
  // suite, so a suite's batches run with coverage on are fitted apart
  // from the ones run without. A batch that does not say which it was
  // could be either, so it is offered to both fits, and `fitSuite()` reads
  // it only where the batches that do say are too few.
  const fitted = (measured: boolean) =>
    Object.fromEntries(
      [
        ...Map.groupBy(
          observations.batches.filter((o) =>
            o.measured === undefined || o.measured === measured
          ),
          (o) => o.suite,
        ),
      ].map(([suite, batches]) => [suite, fitSuite(batches)]),
    );
  return {
    setupCost,
    suites: fitted(false),
    suitesWithCoverage: fitted(true),
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
