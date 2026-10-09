import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TestRecord } from "@commonfabric/test-support/records";
import { maxOf } from "@commonfabric/utils/math";
import {
  type BatchObservation,
  calibrate,
  fitSuite,
  isLaneObservation,
  laneObservations,
  laneObservationsOf,
  nonNegativeLeastSquares,
  observationsOf,
  pricedCalibration,
} from "./calibrate.ts";
import {
  batchMeasurementName,
  excusedMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
  laneMeasurementName,
} from "../lane-measurement.ts";
import {
  MIN_CORRECTION_SAMPLES,
  MIN_CORRECTION_SPAN_SECONDS,
} from "./policy.ts";

/** One figure a lane spooled, as the record format carries it. */
function figure(name: string, durationMs: number): TestRecord {
  return {
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: "pass",
    durationMs: Math.round(durationMs),
  };
}

/** One measurement of a span of time, as a lane spools it. */
function measured(name: string, seconds: number): TestRecord {
  return figure(name, seconds * 1000);
}

/** What a lane writes about one batch: the four figures, together. */
function batch(
  suite: string,
  ran: number,
  spent: number,
  units = 1,
  coverage = false,
  passes = 1,
): TestRecord[] {
  return [
    measured(batchMeasurementName(suite, coverage), spent),
    measured(batchMeasurementName(suite, coverage, "ran"), ran),
    figure(batchMeasurementName(suite, coverage, "units"), units),
    figure(batchMeasurementName(suite, coverage, "passes"), passes),
  ];
}

/** What a lane writes about its work as a whole: the three figures. */
function lane(spent: number, projected: number, bound: number): TestRecord[] {
  return [
    measured(laneMeasurementName("spent"), spent),
    measured(laneMeasurementName("projected"), projected),
    measured(laneMeasurementName("bound"), bound),
  ];
}

/**
 * One batch of the suite `s`, run without coverage in one pass unless the
 * figures say otherwise.
 */
function observed(
  figures:
    & Pick<BatchObservation, "ran" | "spent" | "units">
    & Partial<Pick<BatchObservation, "passes" | "measured">>,
): BatchObservation {
  return { suite: "s", measured: false, passes: 1, ...figures };
}

/**
 * Batches over every combination of a small and a large reading of each
 * of the three things a batch is charged for, far enough apart in the
 * seconds their tests took for a correction to be fitted.
 */
function spread(
  spent: (ran: number, units: number, passes: number) => number,
): BatchObservation[] {
  const observations: BatchObservation[] = [];
  for (
    const ran of [MIN_CORRECTION_SPAN_SECONDS, MIN_CORRECTION_SPAN_SECONDS * 3]
  ) {
    for (const units of [20, 60]) {
      for (const passes of [1, 2]) {
        observations.push(
          observed({ ran, units, passes, spent: spent(ran, units, passes) }),
        );
      }
    }
  }
  return observations;
}

/** What `fitted` charges a batch holding what `batch` held. */
function chargeFor(
  fitted: ReturnType<typeof fitSuite>,
  batch: BatchObservation,
): number {
  return fitted.overhead * batch.passes + fitted.correction * batch.ran +
    fitted.unitOverhead * batch.units;
}

/** The mean of some figures. */
function mean(figures: readonly number[]): number {
  return figures.reduce((sum, one) => sum + one, 0) / figures.length;
}

describe("calibrate", () => {
  describe("reading a run's own measurements", () => {
    it("takes each capability's setup, every time one was opened", () => {
      const seen = observationsOf([
        {
          run: "a",
          records: [
            measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 14.8),
            measured(`${LANE_MEASUREMENT_PREFIX}setup toolshed`, 2.8),
          ],
        },
        {
          run: "b",
          records: [measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 2.1)],
        },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.setup.get("toolshed")).toEqual([2.8]);
    });

    it("joins what a batch cost, what it took, what it opened, and how many passes it made", () => {
      // The pass count is a count, like the units: read the way a
      // duration is, three passes would arrive as 0.003.
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92, 17, false, 3) },
      ]);
      expect(seen.batches).toEqual([
        {
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
          passes: 3,
        },
      ]);
    });

    it("takes nothing from a batch whose pass count is not a whole number of one or more", () => {
      // The pass count is what the per-pass charge is fitted against, so
      // a batch without a usable one says nothing the fit can read.
      for (const count of [0, -1, 1.5]) {
        const [spent, ran, units, passes] = batch("pattern-unit", 900, 1400, 5);
        const seen = observationsOf([{
          run: "a",
          records: [spent!, ran!, units!, { ...passes!, durationMs: count }],
        }]);
        expect(seen.batches).toEqual([]);
      }
      const seen = observationsOf([{
        run: "a",
        records: batch("pattern-unit", 900, 1400, 5, false, 1),
      }]);
      expect(seen.batches.map((one) => one.passes)).toEqual([1]);
    });

    it("takes what the packer charged for a batch beside the batch, where the lane wrote that", () => {
      const seen = observationsOf([
        {
          run: "a",
          records: [
            ...batch("workspace-unit", 40, 92, 17),
            measured(
              batchMeasurementName("workspace-unit", false, "projected"),
              88,
            ),
            ...batch("runner-unit", 5, 9, 2),
          ],
        },
      ]);
      expect(seen.charges).toEqual([
        { suite: "workspace-unit", spent: 92, projected: 88 },
      ]);
      // The charge is no figure the fit reads, so the batch carries none.
      expect(seen.batches).toEqual([
        {
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
          passes: 1,
        },
        {
          suite: "runner-unit",
          measured: false,
          ran: 5,
          spent: 9,
          units: 2,
          passes: 1,
        },
      ]);
    });

    it("takes a lane's work, projection and bound, one lane per run", () => {
      const seen = observationsOf([
        { run: "a", records: lane(250, 225, 260) },
        { run: "b", records: lane(280, 229, 260) },
      ]);
      expect(seen.lanes).toEqual([
        { spent: 250, projected: 225, bound: 260 },
        { spent: 280, projected: 229, bound: 260 },
      ]);
      // A lane's own figures are not a batch, and fit nothing.
      expect(seen.batches).toEqual([]);
    });

    it("takes nothing from a lane missing one of its three figures", () => {
      const seen = observationsOf([
        { run: "a", records: lane(250, 225, 260).slice(0, 2) },
      ]);
      expect(seen.lanes).toEqual([]);
    });

    it("takes nothing from a lane that went red", () => {
      const seen = observationsOf([{
        run: "a",
        records: lane(250, 225, 260).map((record) => ({
          ...record,
          outcome: "fail" as const,
        })),
      }]);
      expect(seen.lanes).toEqual([]);
    });

    it("reads a unit count as a count rather than as a span of time", () => {
      // The record format carries one number and calls it a duration, so
      // a count read the way a duration is would arrive a thousand times
      // too small.
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92, 250) },
      ]);
      expect(seen.batches[0]!.units).toBe(250);
    });

    it("takes nothing from a batch missing one of the four", () => {
      // A lane writes all four together, so three alone are records that
      // arrived without the fourth rather than a batch to fit from.
      const whole = batch("workspace-unit", 40, 92, 17);
      for (let left = 0; left < whole.length; left++) {
        const records = whole.filter((_, at) => at !== left);
        expect(observationsOf([{ run: "a", records }]).batches).toEqual([]);
      }
      expect(observationsOf([{ run: "a", records: whole }]).batches.length)
        .toBe(1);
    });

    it("keeps two lanes of one run apart", () => {
      // Five lanes of a run may each hold the same suite, and adding two
      // lanes' figures would describe a batch neither of them ran.
      const seen = observationsOf([
        { run: "run-1-lane-1", records: batch("runner-unit", 10, 30, 4) },
        { run: "run-1-lane-2", records: batch("runner-unit", 20, 50, 9) },
      ]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        {
          suite: "runner-unit",
          measured: false,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 1,
        },
        {
          suite: "runner-unit",
          measured: false,
          ran: 20,
          spent: 50,
          units: 9,
          passes: 1,
        },
      ]);
    });

    it("joins a batch run with coverage to its own figures, and says it was", () => {
      // Its tests took the same time as the uninstrumented batch's, so
      // a join that ignored the marker could read either batch's spent
      // figure against either's.
      const seen = observationsOf([{
        run: "a",
        records: [
          ...batch("workspace-unit", 40, 92, 17),
          ...batch("workspace-unit", 40, 150, 17, true, 2),
        ],
      }]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        {
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
          passes: 1,
        },
        {
          suite: "workspace-unit",
          measured: true,
          ran: 40,
          spent: 150,
          units: 17,
          passes: 2,
        },
      ]);
    });

    it("takes nothing from a batch that went red", () => {
      // A batch that failed stopped at the first invocation that did,
      // and what it spent says the suite is cheap rather than saying
      // what running it costs.
      const failed = batch("workspace-unit", 460, 3, 12)
        .map((record) => ({ ...record, outcome: "fail" as const }));
      expect(observationsOf([{ run: "a", records: failed }]).batches)
        .toEqual([]);
    });

    it("takes nothing from a capability that failed to open", () => {
      const seen = observationsOf([{
        run: "a",
        records: [{
          ...measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 0.4),
          outcome: "fail",
        }],
      }]);
      expect(seen.setup.size).toBe(0);
    });

    it("passes over a lane measurement of something else entirely", () => {
      // Everything a lane writes about itself carries the same prefix, so
      // a kind of measurement this does not read arrives here rather than
      // anywhere else. Skipping it is what lets a lane record something
      // new without the fit reading it as a batch.
      const seen = observationsOf([{
        run: "a",
        records: [measured(`${LANE_MEASUREMENT_PREFIX}prologue`, 41.2)],
      }]);
      expect(seen.setup.size).toBe(0);
      expect(seen.batches).toEqual([]);
    });

    it("reads a batch beside a figure about it of a kind this reader does not know", () => {
      // The unknown figure names the same batch, and read as what the
      // batch spent it would replace the figure that is.
      const seen = observationsOf([{
        run: "a",
        records: [
          ...batch("pattern-unit", 900, 700, 3),
          measured(`${LANE_MEASUREMENT_PREFIX}longest batch pattern-unit`, 680),
        ],
      }]);
      expect(seen.batches).toEqual([{
        suite: "pattern-unit",
        measured: false,
        ran: 900,
        spent: 700,
        units: 3,
        passes: 1,
      }]);
    });

    it("passes over a lane's record of a failure it excused", () => {
      // That record names a test rather than a batch, and carries no
      // figure, so read as a batch it would be fitted as a batch that
      // cost nothing.
      const seen = observationsOf([{
        run: "a",
        records: [
          figure(excusedMeasurementName('["unit","bakery","glaze > sets"]'), 0),
          ...batch("workspace-unit", 20, 30, 2),
        ],
      }]);
      expect(seen.setup.size).toBe(0);
      expect(seen.batches).toEqual([{
        suite: "workspace-unit",
        measured: false,
        ran: 20,
        spent: 30,
        units: 2,
        passes: 1,
      }]);
    });

    it("passes over a record that is not a lane measuring itself", () => {
      const seen = observationsOf([{
        run: "a",
        records: [{
          line: "record",
          test: { k: "unit", s: "memory", n: "space > writes a fact" },
          outcome: "pass",
          durationMs: 40,
        }],
      }]);
      expect(seen.setup.size).toBe(0);
      expect(seen.batches).toEqual([]);
    });
  });

  describe("what one group says, as an aggregate stores it", () => {
    it("carries how many passes a batch made", () => {
      const kept = laneObservationsOf(
        "object-1",
        batch("pattern-unit", 900, 1400, 5, false, 2),
        "2026-09-12",
      );
      expect(kept).toEqual([{
        day: "2026-09-12",
        suite: "pattern-unit",
        measured: false,
        ran: 900,
        spent: 1400,
        units: 5,
        passes: 2,
      }]);
    });

    it("carries what a batch was charged and what its lane came to", () => {
      const kept = laneObservationsOf(
        "object-1",
        [
          ...batch("runner-unit", 10, 30, 4),
          measured(batchMeasurementName("runner-unit", false, "projected"), 24),
          ...lane(31, 26, 260),
        ],
        "2026-09-12",
      );
      expect(kept).toEqual([
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: false,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 1,
          projected: 24,
        },
        { day: "2026-09-12", spent: 31, projected: 26, bound: 260 },
      ]);
    });

    it("carries the day, so a stored observation can be aged", () => {
      const kept = laneObservationsOf(
        "object-1",
        [
          ...batch("runner-unit", 10, 30, 4),
          ...batch("runner-unit", 10, 45, 4, true),
          measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 14.8),
        ],
        "2026-09-12",
      );
      expect(kept).toEqual([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: false,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 1,
        },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 45,
          units: 4,
          passes: 1,
        },
      ]);
    });
  });

  describe("nonNegativeLeastSquares()", () => {
    it("returns the figures that reproduce rows a set of non-negative figures fits exactly", () => {
      const rows = [[1, 2, 3], [1, 5, 1], [2, 1, 4], [1, 1, 1], [3, 0, 2]];
      const truth = [2, 0.5, 3];
      const targets = rows.map((row) =>
        row.reduce((sum, x, i) => sum + x * truth[i]!, 0)
      );
      const solved = nonNegativeLeastSquares(rows, targets);
      expect(solved.length).toBe(3);
      solved.forEach((one, i) => expect(one).toBeCloseTo(truth[i]!, 9));
    });

    it("returns zero for a figure whose unconstrained fit is below zero, and refits the rest without it", () => {
      // Unconstrained, these rows fit a line of 10 less 2 for each step.
      // With the slope held at zero, the best intercept is their mean.
      const solved = nonNegativeLeastSquares(
        [[1, 0], [1, 1], [1, 2], [1, 3]],
        [10, 8, 6, 4],
      );
      expect(solved[0]).toBeCloseTo(7, 9);
      expect(solved[1]).toBe(0);
    });

    it("returns figures whose fitted values match where two of its columns are identical", () => {
      // Any pair of figures adding up to 2 fits these rows exactly, so
      // the rows cannot say how to divide it.
      const rows = [[1, 1], [2, 2], [3, 3]];
      const solved = nonNegativeLeastSquares(rows, [2, 4, 6]);
      expect(solved.length).toBe(2);
      for (const one of solved) {
        expect(Number.isFinite(one)).toBe(true);
        expect(one).toBeGreaterThanOrEqual(0);
      }
      rows.forEach((row, at) =>
        expect(row[0]! * solved[0]! + row[1]! * solved[1]!)
          .toBeCloseTo([2, 4, 6][at]!, 9)
      );
    });

    it("gives what two columns it cannot tell apart share to the earlier of them", () => {
      expect(nonNegativeLeastSquares([[1, 1], [2, 2], [3, 3]], [2, 4, 6]))
        .toEqual([2, 0]);
      const [first, second, third] = nonNegativeLeastSquares(
        [[1, 1, 0], [2, 2, 1]],
        [2, 5],
      );
      expect(first).toBeCloseTo(2, 9);
      expect(second).toBe(0);
      expect(third).toBeCloseTo(1, 9);
    });

    it("returns zero for every figure where nothing is above zero to fit", () => {
      expect(nonNegativeLeastSquares([[1, 2], [3, 4]], [0, 0])).toEqual([0, 0]);
      expect(nonNegativeLeastSquares([[1], [2]], [-1, -2])).toEqual([0]);
      expect(nonNegativeLeastSquares([[0, 0], [0, 0]], [5, 3]))
        .toEqual([0, 0]);
      expect(nonNegativeLeastSquares([[1], [2]], [1, 2])).toEqual([1]);
    });

    it("returns no figures for no rows", () => {
      expect(nonNegativeLeastSquares([], [])).toEqual([]);
    });
  });

  describe("fitting one suite", () => {
    /**
     * Batches spending 4 seconds a pass, half a second a unit, and three
     * tenths of what their tests took, whose figures disagree enough for
     * all three to be told apart. Their tests' time rises by
     * `MIN_CORRECTION_SPAN_SECONDS` from each to the next.
     */
    const exact = [1, 2, 1, 3, 2, 1].map((passes, i) => {
      const units = [10, 40, 25, 5, 30, 15][i]!;
      const ran = MIN_CORRECTION_SPAN_SECONDS * (1 + i);
      return observed({
        passes,
        units,
        ran,
        spent: 4 * passes + 0.5 * units + 0.3 * ran,
      });
    });

    it("recovers what a suite charges a pass, a unit, and a second of its tests", () => {
      const fitted = fitSuite(exact);
      expect(fitted.overhead).toBeCloseTo(4, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
      expect(fitted.correction).toBeCloseTo(0.3, 6);
    });

    it("fits a correction from as few batches as `MIN_CORRECTION_SAMPLES`, and charges one from fewer", () => {
      const enough = fitSuite(exact.slice(0, MIN_CORRECTION_SAMPLES));
      expect(enough.correction).toBeCloseTo(0.3, 6);
      expect(enough.overhead).toBeCloseTo(4, 6);
      expect(enough.unitOverhead).toBeCloseTo(0.5, 6);
      expect(fitSuite(exact.slice(0, MIN_CORRECTION_SAMPLES - 1)).correction)
        .toBe(1);
    });

    it("fits a correction where the batches' tests span `MIN_CORRECTION_SPAN_SECONDS`, and charges one where they span less", () => {
      // A slope is read far outside the range it was fitted over, and
      // inside a narrow range what a batch spends apart from its tests
      // dominates, so the slope there is noise.
      const across = (span: number) =>
        [10, 30, 20].map((units, i) => {
          const ran = 100 + span * i / 2;
          return observed({ units, ran, spent: 10 + 0.2 * units + ran / 3 });
        });
      const wide = fitSuite(across(MIN_CORRECTION_SPAN_SECONDS));
      expect(wide.correction).toBeCloseTo(1 / 3, 6);
      expect(wide.overhead).toBeCloseTo(10, 6);
      expect(wide.unitOverhead).toBeCloseTo(0.2, 6);
      expect(fitSuite(across(MIN_CORRECTION_SPAN_SECONDS - 1)).correction)
        .toBe(1);
    });

    it("fits what a pass and a unit cost to what batches spent beyond their tests, where it charges a correction of one", () => {
      // Two batches are too few to fit a correction from. Beyond their
      // tests, each spent 3 seconds a pass and half a second a unit.
      const fitted = fitSuite([
        observed({ passes: 1, units: 10, ran: 7, spent: 7 + 3 + 0.5 * 10 }),
        observed({ passes: 2, units: 4, ran: 30, spent: 30 + 6 + 0.5 * 4 }),
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.overhead).toBeCloseTo(3, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
    });

    it("charges a correction of one where batches spend no more the more their tests take", () => {
      // A correction of zero says a batch grows no dearer the more of
      // the suite it holds, which would let a lane pack the suite without
      // limit, and a manifest carrying one is refused whole. The batches
      // are many enough and far enough apart for a correction to be
      // fitted, so it is the fit coming out at zero that refuses it.
      const flat = Array.from(
        { length: MIN_CORRECTION_SAMPLES + 1 },
        (_, i) =>
          observed({
            units: 1,
            ran: 40 + MIN_CORRECTION_SPAN_SECONDS * i,
            spent: 200,
          }),
      );
      const fitted = fitSuite(flat);
      expect(fitted.correction).toBe(1);
      expect(fitted.overhead + fitted.unitOverhead).toBeCloseTo(
        mean(flat.map((one) => one.spent - one.ran)),
        6,
      );
      const rising = fitSuite(
        flat.map((one) => ({ ...one, spent: 200 + 0.01 * one.ran })),
      );
      expect(rising.correction).toBeCloseTo(0.01, 6);
    });

    it("refuses a slope saying a batch gets cheaper with more tests", () => {
      // Such a slope would let a lane pack the suite without limit
      // against a flat charge. A correction of zero is worse still: a
      // manifest carrying one is refused whole, so a single suite whose
      // batches trend downward would leave every lane with no manifest.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) =>
          observed({
            units: 1,
            ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
            spent: 500 - 0.5 * MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          })),
      );
      expect(fitted.correction).toBe(1);
    });

    it("charges once for each pass a batch made", () => {
      // The batches held the same units and the same tests, and differ
      // only in how many times the suite's command was started.
      const fitted = fitSuite(
        [1, 2, 3].map((passes) =>
          observed({ passes, units: 10, ran: 30, spent: 30 + 15 * passes + 5 })
        ),
      );
      expect(fitted.correction).toBe(1);
      expect(fitted.overhead).toBeCloseTo(15, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
    });

    it("charges nothing a pass where a line through the batches would need a fixed cost below nothing, and fits the correction without it", () => {
      const seen = Array.from(
        { length: MIN_CORRECTION_SAMPLES + 2 },
        (_, i) => {
          const ran = MIN_CORRECTION_SPAN_SECONDS * (2 + i);
          return observed({ units: 0, ran, spent: 2 * ran - 50 });
        },
      );
      const fitted = fitSuite(seen);
      expect(fitted.overhead).toBe(0);
      expect(fitted.unitOverhead).toBe(0);
      // The slope through the origin that fits them best.
      expect(fitted.correction).toBeCloseTo(
        seen.reduce((sum, one) => sum + one.ran * one.spent, 0) /
          seen.reduce((sum, one) => sum + one.ran ** 2, 0),
        6,
      );
      expect(fitted.correction).toBeLessThan(2);
    });

    it("charges a batch what a batch of its shape spends on average", () => {
      // The batches' wall time moves by a few seconds for reasons that
      // have nothing to do with what they held. Each pass is charged its
      // own figure, so the charges are out by nothing on average, and a
      // batch that spent more than most is charged less than it spent.
      const noise = [3, -4, 1, 6, -2, -3, 4, -1, 2, -5];
      const seen = noise.map((jitter, i) => {
        const units = 10 + 7 * ((i * 3) % 5);
        const ran = MIN_CORRECTION_SPAN_SECONDS * (1 + i);
        return observed({
          units,
          ran,
          spent: 20 + 0.4 * units + 0.5 * ran + jitter,
        });
      });
      const fitted = fitSuite(seen);
      expect(fitted.overhead).toBeGreaterThan(0);
      expect(mean(seen.map((one) => chargeFor(fitted, one) - one.spent)))
        .toBeCloseTo(0, 6);
      expect(maxOf(seen.map((one) => one.spent - chargeFor(fitted, one))))
        .toBeGreaterThan(1);
    });

    it("charges one observation's whole cost to the units it opened", () => {
      // With one batch there is nothing to say about how much of what it
      // spent was the pass and how much was the units inside it.
      // Charging the units errs high for a lane packing more of them
      // than that batch held, which is the direction that runs a lane
      // past its bound, and errs low for a lane packing fewer: a lane
      // holding one unit of this suite is charged 13 against the 52 the
      // batch spent beyond its tests.
      expect(fitSuite([observed({ ran: 40, spent: 92, units: 4 })]))
        .toEqual({ overhead: 0, correction: 1, unitOverhead: 13 });
    });

    it("charges a unit rather than a pass where every batch opens one unit in one pass", () => {
      // Such batches cannot say whether what they spent beyond their
      // tests was the pass's or the unit's.
      expect(fitSuite([observed({ ran: 10, spent: 25, units: 1 })]))
        .toEqual({ overhead: 0, correction: 1, unitOverhead: 15 });
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => {
          const ran = MIN_CORRECTION_SPAN_SECONDS * (1 + i);
          return observed({ units: 1, ran, spent: 7 + ran / 2 });
        }),
      );
      expect(fitted.correction).toBeCloseTo(0.5, 6);
      expect(fitted.unitOverhead).toBeCloseTo(7, 6);
      expect(fitted.overhead).toBe(0);
    });

    it("finds the slope enough disagreeing observations carry", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) =>
          observed({
            units: 1,
            ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
            spent: 2 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          })),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("fits no correction from too few observations", () => {
      // Two points fit a line exactly, so a line through two of them says
      // whatever they say and nothing about their noise. They are charged
      // far enough apart to clear the span guard, so the count is the
      // only thing that can refuse a correction here.
      const fitted = fitSuite([
        observed({ units: 20, ran: MIN_CORRECTION_SPAN_SECONDS, spent: 80 }),
        observed({
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * 3,
          spent: 100,
        }),
      ]);
      expect(fitted.correction).toBe(1);
    });

    it("charges a steep suite on its correction rather than its intercept", () => {
      // Nothing bounds the correction from above. The intercept is what a
      // lane pays to run one test of the suite, so a bound that moved
      // cost there would make the suite dearer to reach, not cheaper.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) =>
          observed({
            units: 20,
            ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
            spent: 50 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          })),
      );
      expect(fitted.correction).toBeCloseTo(50, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("believes no slope from a suite nothing has charged much for", () => {
      // A slope is read far outside the range it was fitted over: a
      // suite charged six seconds in every batch anybody has seen may be
      // charged thousands the first time a lane packs it whole. Inside a
      // narrow range the fixed cost dominates and the slope is noise,
      // which is how a lane comes to believe six thousand seconds of
      // tests are free.
      const fitted = fitSuite(
        Array.from(
          { length: MIN_CORRECTION_SAMPLES + 3 },
          (_, i) => observed({ units: 1, ran: 2 + 0.5 * i, spent: 41 }),
        ),
      );
      expect(fitted.correction).toBe(1);
    });

    it("believes no slope from batches charged within a second of each other", () => {
      // A range is narrow wherever it sits. Batches charged 229, 230 and
      // 230 seconds say as little about a slope as batches charged two,
      // three and four, and the slope a line through them carries would
      // be read against a batch charged thousands.
      const most = MIN_CORRECTION_SPAN_SECONDS * 10;
      const fitted = fitSuite(
        Array.from(
          { length: MIN_CORRECTION_SAMPLES + 1 },
          (_, i) => observed({ units: 1, ran: most + i, spent: 200 + i / 10 }),
        ),
      );
      expect(fitted.correction).toBe(1);
    });

    it("fits a suite whose batch runs faster than the sum of its tests", () => {
      // A batch runs its files in parallel, so its wall time is
      // routinely a fraction of the sum of its tests' own durations —
      // the pattern unit suite takes about a third. Holding the slope at
      // one would push that difference into the intercept, which is
      // charged whatever the batch holds.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) =>
          observed({
            units: 20,
            ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
            spent: MIN_CORRECTION_SPAN_SECONDS * (2 + i) / 3,
          })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.unitOverhead).toBe(0);
      expect(fitted.overhead).toBe(0);
    });

    it("charges nothing per unit for a batch that outran its own tests", () => {
      // A batch whose wall time is under what its tests took, against a
      // correction of one, is not evidence that a unit gives time back.
      const fitted = fitSuite([
        observed({ units: 20, ran: 30, spent: 10 }),
        observed({ units: 20, ran: 30, spent: 12 }),
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBe(0);
      expect(fitted.overhead).toBe(0);
    });

    it("fits every suite figures a manifest will carry", () => {
      // `parseCalibration` refuses a correction at or below zero and a
      // per-unit cost below zero, and it refuses the whole manifest with
      // either, so what this returns has to survive being published.
      for (const perSecond of [-3, -0.5, 0, 0.25, 4, 50]) {
        for (const perUnit of [-2, 0, 0.5, 9]) {
          for (const perPass of [-100, 0, 20]) {
            const fitted = fitSuite(
              spread((ran, units, passes) =>
                500 + perSecond * ran + perUnit * units + perPass * passes
              ),
            );
            expect(fitted.correction).toBeGreaterThan(0);
            expect(fitted.unitOverhead).toBeGreaterThanOrEqual(0);
            expect(fitted.overhead).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it("charges nothing for a suite nothing has measured", () => {
      expect(fitSuite([])).toEqual({
        overhead: 0,
        correction: 1,
        unitOverhead: 0,
      });
    });
  });

  describe("calibrate()", () => {
    it("names every capability and every suite it was given", () => {
      const workspace = {
        ...observed({ ran: 40, spent: 92, units: 3 }),
        suite: "workspace-unit",
      };
      const fitted = calibrate({
        setup: new Map([["fuse", [14.8, 2.1]], ["browser", [0]]]),
        batches: [
          workspace,
          {
            ...observed({ ran: 10, spent: 20, units: 2 }),
            suite: "runner-unit",
          },
        ],
      });
      expect(Object.keys(fitted.setupCost).sort()).toEqual(["browser", "fuse"]);
      expect(Object.keys(fitted.suites).sort()).toEqual([
        "runner-unit",
        "workspace-unit",
      ]);
      expect(chargeFor(fitted.suites["workspace-unit"]!, workspace))
        .toBeCloseTo(92, 6);
      expect(fitted.suites["workspace-unit"]!.unitOverhead).toBeCloseTo(
        52 / 3,
        6,
      );
    });

    it("charges a capability its slowest opening while there are nine or fewer", () => {
      for (let count = 1; count <= 9; count++) {
        const openings = [
          ...Array.from({ length: count - 1 }, (_, i) => 10 + i),
          90,
        ];
        const fitted = calibrate({
          setup: new Map([["fuse", openings]]),
          batches: [],
        });
        expect(fitted.setupCost["fuse"]).toBe(90);
      }
    });

    it("charges nine openings in ten what they took, and not what one slow opening did", () => {
      // A capability's setup is charged to every lane that opens it, so
      // one runner's slow opening would otherwise set what every lane
      // pays. The slow one comes first, since the charge must not depend
      // on the order the openings were read in.
      for (const count of [10, 11, 20, 30, 100]) {
        const typical = Array.from({ length: count - 1 }, (_, i) => 10 + i);
        const openings = [400, ...typical];
        const charged = calibrate({
          setup: new Map([["fuse", openings]]),
          batches: [],
        }).setupCost["fuse"]!;
        expect(charged).toBeLessThanOrEqual(maxOf(typical));
        const held = openings.filter((seconds) => seconds <= charged);
        expect(held.length).toBeGreaterThanOrEqual(0.9 * count);
        expect(charged).toBeGreaterThan(
          typical[Math.floor(typical.length / 2)]!,
        );
      }
    });

    it("fits a suite's batches run with coverage on apart from the rest", () => {
      // The two batches' tests took the same time, and the one with
      // coverage on spent 58 seconds more. Fitted together, both would
      // be charged what the two cost on average.
      const without = observed({ ran: 40, spent: 92, units: 4 });
      const withCoverage = observed({
        ran: 40,
        spent: 150,
        units: 4,
        measured: true,
      });
      const fitted = calibrate({
        setup: new Map(),
        batches: [without, withCoverage],
      });
      expect(fitted.suites).toEqual({
        s: { overhead: 0, correction: 1, unitOverhead: 13 },
      });
      expect(fitted.suitesWithCoverage).toEqual({
        s: { overhead: 0, correction: 1, unitOverhead: 27.5 },
      });
    });

    it("fits a suite run only with coverage on under that alone", () => {
      const fitted = calibrate({
        setup: new Map(),
        batches: [observed({ ran: 40, spent: 150, units: 4, measured: true })],
      });
      expect(fitted.suites).toEqual({});
      expect(Object.keys(fitted.suitesWithCoverage ?? {})).toEqual(["s"]);
    });

    it("carries no coverage figure for a suite run only without", () => {
      const fitted = calibrate({
        setup: new Map(),
        batches: [observed({ ran: 40, spent: 92, units: 4 })],
      });
      expect(Object.keys(fitted.suites)).toEqual(["s"]);
      expect(fitted.suitesWithCoverage).toEqual({});
    });
  });

  describe("pricedCalibration()", () => {
    const WITHOUT = { overhead: 1, correction: 1, unitOverhead: 0 };
    const WITH = { overhead: 9, correction: 2, unitOverhead: 1 };
    const calibration = {
      setupCost: { fuse: 14.8 },
      suites: { both: WITHOUT, plain: WITHOUT },
      suitesWithCoverage: { both: WITH, covered: WITH },
      prologue: 40,
    };

    it("charges a suite run with coverage on what it costs so, as measured", () => {
      const priced = pricedCalibration(calibration, new Map([["both", true]]));
      expect(priced.calibration.suites["both"]).toEqual(WITH);
      expect([...priced.fitted]).toEqual(["both"]);
    });

    it("charges a suite run without coverage what it costs so, as measured", () => {
      const priced = pricedCalibration(
        calibration,
        new Map([["both", false]]),
      );
      expect(priced.calibration.suites["both"]).toEqual(WITHOUT);
      expect([...priced.fitted]).toEqual(["both"]);
    });

    it("charges what a suite costs run the other way where it has not been run this way", () => {
      const priced = pricedCalibration(
        calibration,
        new Map([["plain", true], ["covered", false]]),
      );
      expect(priced.calibration.suites["plain"]).toEqual(WITHOUT);
      expect(priced.calibration.suites["covered"]).toEqual(WITH);
      expect([...priced.fitted]).toEqual([]);
    });

    it("charges nothing for a suite no lane has run either way", () => {
      const priced = pricedCalibration(
        calibration,
        new Map([["unknown", true]]),
      );
      expect(Object.hasOwn(priced.calibration.suites, "unknown")).toBe(false);
      expect([...priced.fitted]).toEqual([]);
    });

    it("returns every other figure as it was, and leaves its input alone", () => {
      const priced = pricedCalibration(calibration, new Map([["both", true]]));
      expect(priced.calibration.setupCost).toEqual({ fuse: 14.8 });
      expect(priced.calibration.prologue).toBe(40);
      expect(priced.calibration.suitesWithCoverage).toBeUndefined();
      expect(calibration.suites.both).toEqual(WITHOUT);
    });
  });

  describe("isLaneObservation()", () => {
    /** A stored batch carrying every figure the fit reads. */
    const stored = {
      day: "d",
      suite: "s",
      measured: false,
      ran: 10,
      spent: 30,
      units: 4,
      passes: 1,
    };

    it("returns `true` for every kind of observation", () => {
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: 14.8 }))
        .toBe(true);
      expect(
        isLaneObservation({ day: "d", spent: 31, projected: 26, bound: 260 }),
      ).toBe(true);
      expect(isLaneObservation(stored)).toBe(true);
      expect(isLaneObservation({ ...stored, measured: true, passes: 3 }))
        .toBe(true);
    });

    it("returns `false` for a batch missing a figure the fit reads", () => {
      // A batch stored without whether coverage was on cannot be fitted
      // with either kind of run, and one stored without its pass count
      // cannot be charged per pass.
      for (const key of ["measured", "passes", "ran", "spent", "units"]) {
        const missing: Record<string, unknown> = { ...stored };
        delete missing[key];
        expect(isLaneObservation(missing)).toBe(false);
      }
    });

    it("returns `false` for a coverage flag that is not a boolean", () => {
      expect(isLaneObservation({ ...stored, measured: "yes" })).toBe(false);
    });

    it("returns `false` for a figure that is not a finite number", () => {
      // A stored `Infinity` or `NaN` arrives as `null`, and one entry
      // read forward as a number that is not one decides what every lane
      // is charged for the suite it names.
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: null }))
        .toBe(false);
      expect(isLaneObservation({ ...stored, spent: "30" })).toBe(false);
      expect(isLaneObservation({ ...stored, ran: Infinity })).toBe(false);
    });

    it("returns `true` for a batch carrying a figure this reader does not know", () => {
      expect(isLaneObservation({ ...stored, longest: 3 })).toBe(true);
      expect(isLaneObservation({ ...stored, invocations: 3 })).toBe(true);
      expect(isLaneObservation({ ...stored, longest: null })).toBe(true);
    });

    it("returns `false` for a pass count that is not a whole number of one or more", () => {
      for (const figure of [null, "2", Infinity, 0, -1, 1.5]) {
        expect(isLaneObservation({ ...stored, passes: figure })).toBe(false);
      }
    });

    it("returns `false` for a charge that is not a finite number", () => {
      expect(isLaneObservation({ ...stored, projected: 24 })).toBe(true);
      for (const figure of [null, "24", Infinity]) {
        expect(isLaneObservation({ ...stored, projected: figure })).toBe(false);
        expect(
          isLaneObservation({
            day: "d",
            spent: 31,
            projected: figure,
            bound: 1,
          }),
        ).toBe(false);
      }
    });

    it("returns `false` for anything that is not one", () => {
      expect(isLaneObservation({ capability: "fuse", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", spent: 31, projected: 26 }))
        .toBe(false);
      expect(isLaneObservation({ day: "d", suite: "s", ran: 10 }))
        .toBe(false);
      expect(
        isLaneObservation({ day: "d", suite: "s", ran: 10, spent: 30 }),
      ).toBe(false);
      expect(isLaneObservation("fuse took a while")).toBe(false);
      expect(isLaneObservation(null)).toBe(false);
    });
  });

  describe("what the aggregate kept", () => {
    it("sorts stored observations back into their kinds", () => {
      const seen = laneObservations([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 2,
        },
        { day: "2026-09-13", capability: "fuse", seconds: 2.1 },
        { day: "2026-09-13", spent: 31, projected: 26, bound: 260 },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.batches).toEqual([
        {
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 2,
        },
      ]);
      expect(seen.lanes).toEqual([{ spent: 31, projected: 26, bound: 260 }]);
    });

    it("reads what a stored batch was charged beside the batch", () => {
      const seen = laneObservations([{
        day: "2026-09-12",
        suite: "runner-unit",
        measured: false,
        ran: 10,
        spent: 30,
        units: 4,
        passes: 1,
        projected: 24,
      }]);
      expect(seen.charges).toEqual([
        { suite: "runner-unit", spent: 30, projected: 24 },
      ]);
      expect(seen.batches).toEqual([
        {
          suite: "runner-unit",
          measured: false,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 1,
        },
      ]);
    });

    it("drops a figure a stored batch carries that this reader does not know", () => {
      const kept = [{
        day: "2026-09-12",
        suite: "pattern-unit",
        measured: true,
        ran: 900,
        spent: 700,
        units: 3,
        passes: 1,
        longest: 680,
        setup: { seconds: 120, processes: 1 },
      }];
      expect(kept.every(isLaneObservation)).toBe(true);
      expect(laneObservations(kept).batches).toEqual([{
        suite: "pattern-unit",
        measured: true,
        ran: 900,
        spent: 700,
        units: 3,
        passes: 1,
      }]);
    });
  });
});
