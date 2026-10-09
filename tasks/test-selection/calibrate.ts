/**
 * What a lane costs beyond the tests it runs, read from what lanes have
 * measured about themselves.
 *
 * A test's own cost is what the runner measured for it. A lane pays
 * more: it opens the capabilities its batches need, each pass of a batch
 * starts the suite's command afresh, and each unit a pass opens starts a
 * runner and loads a module. None of that is in any test's duration, and
 * all of it is in the five minutes a lane has. A runner running its units
 * side by side also spends less than its tests' durations add up to.
 *
 * The packer charges each of those: `setupCost` the first time a lane
 * opens a capability, and for each suite a lane holds, the suite's
 * `overhead` for each pass, its `unitOverhead` for each time a pass opens
 * a unit, and its `correction` times what the batch's tests take. What it
 * charges them from is this.
 *
 * The inputs are the lane's own measurements of itself, which travel to
 * the store as ordinary records. A lane writes one per capability it
 * opened and five per batch: what the batch spent, what its tests took
 * between them, how many times its passes opened a unit, how many passes
 * it made, and what the packer charged the lane for it. None of the
 * batch's figures can be recovered from the records the batch produced,
 * because a reader cannot tell which of a report's records came from
 * which batch. A lane also writes three figures about its work as a
 * whole. Nothing is fitted from what a batch or a lane was charged, or
 * from a lane's work as a whole; they are read here only to be kept.
 *
 * A capability's setup is charged at the ninetieth percentile of what its
 * openings took. A suite's three figures are fitted to what its batches
 * spent by least squares, so that a batch is charged what a batch of its
 * shape spends on average. A lane's charge is a sum over the batches it
 * holds, and a sum of averages is what that sum comes to on average; the
 * safety margin `LANE_SAFETY_SECONDS` is what absorbs a lane whose
 * batches together spend more than that.
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
 * the lane recorded that. A stored batch may carry figures this reader
 * does not know, which it passes over.
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
 * aggregate is read back through. Every figure the fit reads has to be a
 * finite number, since a single entry moves what every lane is charged
 * for the suite it names, and a batch lacking one is not an observation.
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
    typeof one.measured === "boolean" && isPassCount(one.passes);
}

/** Whether a figure is a number of passes: a whole number, one or more. */
function isPassCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** One batch, as a lane measured it. */
export interface BatchObservation {
  /** The suite the batch ran. */
  suite: string;

  /** Whether coverage was on for the batch. */
  measured: boolean;

  /**
   * Seconds the tests of the units the batch ran took, summed over every
   * execution of each. The suite's overhead and correction are not in it,
   * because they are what is fitted from it.
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
   * How many passes the batch made, each an invocation of the suite's
   * command of its own. A batch that repeated none of its units makes one
   * pass.
   */
  passes: number;
}

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
      const { suite, measured, ran, spent, units, passes, projected } = one;
      charged.push({
        batch: { suite, measured, ran, spent, units, passes },
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
 * A batch is read only where what it spent, what its tests took, how many
 * units it opened, and how many passes it made are all present. Some of
 * them without the rest say nothing a fit can use, and a lane stopped part
 * way through a batch leaves exactly that — a lane writes a batch's
 * measurements together, so a batch that never finished contributes none
 * of them. What it was charged is read where it is present.
 *
 * A lane's measurements of its work as a whole are read where all three
 * are present, which is where the lane finished every batch it held and
 * every one of them passed.
 *
 * They are keyed by the run, the suite, and whether coverage was on,
 * because five lanes of one run may each run the same suite and adding
 * two lanes' figures would describe a batch neither of them ran. Not by
 * the measurement's name, which is what tells the five apart and would
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
  const passes = new Map<string, number>();
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
      // The suite and the coverage marker, not the name: a batch's five
      // measurements are named differently, and that is what tells them
      // apart. The marker is in the key so that a batch run with
      // coverage on pairs with the time its own tests took rather than
      // with an uninstrumented batch's.
      const key = `${run}\t${batch.suite}\t${batch.measured}`;
      batchOf.set(key, { suite: batch.suite, measured: batch.measured });
      // A count is not a duration. The record format carries one number
      // and calls it a duration, and the name is what says which of the
      // five this is, so a count is read back as it was written.
      if (batch.kind === "units") units.set(key, record.durationMs);
      else if (batch.kind === "passes") {
        if (isPassCount(record.durationMs)) passes.set(key, record.durationMs);
      } else if (batch.kind === "ran") ran.set(key, seconds);
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
    const made = passes.get(key);
    if (tests === undefined || opened === undefined || made === undefined) {
      continue;
    }
    const charge = projected.get(key);
    charged.push({
      batch: {
        ...batchOf.get(key)!,
        ran: tests,
        spent: took,
        units: opened,
        passes: made,
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
 * The figures that minimize the squared difference between `targets` and
 * each row of `rows` weighted by them, among those with no figure below
 * zero. Every row has the same length, which is small, so this solves the
 * unconstrained problem over every subset of the figures, keeps the
 * solutions with no figure below zero, and returns the one leaving the
 * least squared difference. The least one with no figure below zero is
 * the unconstrained solution over the figures it leaves above zero, so it
 * is among them. Figures outside the subset are zero, and a subset the
 * rows cannot tell apart, such as two figures every row reads alike, is
 * passed over in favor of one of its parts. Of solutions that fit equally
 * well, the one found first is kept, so where the rows cannot tell two
 * figures apart, the earlier one carries what they share.
 */
export function nonNegativeLeastSquares(
  rows: readonly (readonly number[])[],
  targets: readonly number[],
): number[] {
  const width = rows[0]?.length ?? 0;
  let best = new Array<number>(width).fill(0);
  let least = squaredError(rows, targets, best);
  for (let subset = 1; subset < 1 << width; subset++) {
    const chosen = [...Array(width).keys()].filter((i) => subset & (1 << i));
    const solved = solveNormal(rows, targets, chosen);
    if (solved === undefined || solved.some((figure) => figure < 0)) continue;
    const figures = new Array<number>(width).fill(0);
    chosen.forEach((i, at) => figures[i] = solved[at]!);
    const error = squaredError(rows, targets, figures);
    if (error < least) {
      best = figures;
      least = error;
    }
  }
  return best;
}

/**
 * Helper for `nonNegativeLeastSquares()`, which solves the normal
 * equations over the figures `chosen` names, or returns `undefined` where
 * the rows do not determine them.
 */
function solveNormal(
  rows: readonly (readonly number[])[],
  targets: readonly number[],
  chosen: readonly number[],
): number[] | undefined {
  const n = chosen.length;
  const matrix = chosen.map((i) => [
    ...chosen.map((j) => rows.reduce((sum, row) => sum + row[i]! * row[j]!, 0)),
    rows.reduce((sum, row, at) => sum + row[i]! * targets[at]!, 0),
  ]);
  const scale = maxOf(matrix.map((row, i) => Math.abs(row[i]!)));
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (
        Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)
      ) {
        pivot = row;
      }
    }
    // A pivot this small against the largest diagonal entry is the rows
    // failing to tell the figures apart, whatever rounding left behind.
    if (!(Math.abs(matrix[pivot]![column]!) > 1e-9 * scale)) return undefined;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]! / matrix[column]![column]!;
      for (let at = column; at <= n; at++) {
        matrix[row]![at]! -= factor * matrix[column]![at]!;
      }
    }
  }
  return matrix.map((row, i) => row[n]! / row[i]!);
}

/** How far `rows` weighted by `figures` miss `targets`, squared and summed. */
function squaredError(
  rows: readonly (readonly number[])[],
  targets: readonly number[],
  figures: readonly number[],
): number {
  return rows.reduce((sum, row, at) => {
    const fitted = row.reduce((total, x, i) => total + x * figures[i]!, 0);
    return sum + (targets[at]! - fitted) ** 2;
  }, 0);
}

/**
 * What a suite costs a lane, fitted to what its batches spent: `overhead`
 * for each pass, `unitOverhead` for each time a pass opened a unit, and
 * `correction` for each second its tests took.
 *
 * The correction is read far outside the range it was fitted over: a suite
 * whose every batch anybody has seen held six seconds of tests may be
 * charged thousands the first time a lane packs it whole. Inside a narrow
 * range what a batch spends apart from its tests dominates and the slope
 * is noise, so it is fitted only where at least `MIN_CORRECTION_SAMPLES`
 * batches disagree by `MIN_CORRECTION_SPAN_SECONDS` about what their tests
 * took. A fit that comes out at zero says a batch grows no dearer the more
 * of the suite it holds, which would let a lane pack the suite without
 * limit, and a manifest carrying a correction of zero is refused whole.
 * Either way the correction is one, which is the reading that needs no
 * evidence, and the other two are fitted to what the batches spent beyond
 * their tests.
 *
 * Batches that open one unit for each pass cannot say whether what they
 * spent beyond their tests was the pass's or the unit's, and the unit
 * carries it then: that errs high for a lane packing more units than
 * those batches held, where the pass would err low.
 */
export function fitSuite(batches: readonly BatchObservation[]): SuiteFit {
  const spent = batches.map((o) => o.spent);
  if (
    batches.length >= MIN_CORRECTION_SAMPLES &&
    maxOf(batches.map((o) => o.ran)) - minOf(batches.map((o) => o.ran)) >=
      MIN_CORRECTION_SPAN_SECONDS
  ) {
    const [unitOverhead, overhead, correction] = nonNegativeLeastSquares(
      batches.map((o) => [o.units, o.passes, o.ran]),
      spent,
    );
    if (correction! > 0) {
      return {
        overhead: overhead!,
        correction: correction!,
        unitOverhead: unitOverhead!,
      };
    }
  }
  const [unitOverhead, overhead] = nonNegativeLeastSquares(
    batches.map((o) => [o.units, o.passes]),
    batches.map((o) => o.spent - o.ran),
  );
  return {
    overhead: overhead ?? 0,
    correction: 1,
    unitOverhead: unitOverhead ?? 0,
  };
}

/** What a lane pays beyond its tests, read from what lanes have measured. */
export function calibrate(
  observations: Pick<Observations, "setup" | "batches">,
): Calibration {
  const setupCost: Record<string, number> = {};
  // The ninetieth percentile of the openings lanes have seen rather than
  // the slowest: the slowest opening in the window is one runner's, and
  // it would otherwise be charged to every lane that opens the capability.
  // Over nine or fewer openings it is the slowest of them.
  for (const [capability, seconds] of observations.setup) {
    const sorted = [...seconds].sort((a, b) => a - b);
    setupCost[capability] = percentile90(sorted);
  }
  // Instrumenting a run costs it time, and how much is a property of the
  // suite, so a suite's batches run with coverage on are fitted apart
  // from the ones run without.
  const fitted = (measured: boolean) =>
    Object.fromEntries(
      [
        ...Map.groupBy(
          observations.batches.filter((o) => o.measured === measured),
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
