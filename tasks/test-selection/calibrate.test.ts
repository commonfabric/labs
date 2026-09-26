import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TestRecord } from "@commonfabric/test-support/records";
import {
  type BatchObservation,
  calibrate,
  fitSuite,
  isLaneObservation,
  laneObservations,
  laneObservationsOf,
  observationsOf,
  pricedCalibration,
} from "./calibrate.ts";
import {
  batchMeasurementName,
  excusedMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
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

/** What a lane writes about one batch: the three figures, together. */
function batch(
  suite: string,
  ran: number,
  spent: number,
  units = 1,
  coverage = false,
): TestRecord[] {
  return [
    measured(batchMeasurementName(suite, coverage), spent),
    measured(batchMeasurementName(suite, coverage, "ran"), ran),
    figure(batchMeasurementName(suite, coverage, "units"), units),
  ];
}

/**
 * Observations over every combination of a small and a large reading of
 * each of the two things a batch is charged for, far enough apart in the
 * seconds its tests took for a correction to be fitted.
 */
function spread(
  spent: (ran: number, units: number) => number,
): BatchObservation[] {
  const observations: BatchObservation[] = [];
  for (
    const ran of [
      MIN_CORRECTION_SPAN_SECONDS,
      MIN_CORRECTION_SPAN_SECONDS * 3,
    ]
  ) {
    for (const units of [20, 60]) {
      observations.push({
        suite: "s",
        measured: false,
        ran,
        units,
        spent: spent(ran, units),
      });
    }
  }
  return observations;
}

/**
 * A suite's batches as they arrive when every lane fills to one budget:
 * all one size, disagreeing only in the seconds their tests took, each
 * paying `rate` for every unit it opened and nothing for itself.
 */
function oneSize(rate: number): BatchObservation[] {
  return Array.from({ length: MIN_CORRECTION_SAMPLES + 5 }, (_, i) => ({
    suite: "s",
    measured: false,
    units: 80,
    ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
    spent: MIN_CORRECTION_SPAN_SECONDS * (1 + i) + rate * 80,
  }));
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

    it("joins what a batch cost, what it took, and what it opened", () => {
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92, 17) },
      ]);
      expect(seen.batches).toEqual([
        {
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
        },
      ]);
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

    it("takes nothing from a batch missing one of the three", () => {
      // A lane writes all three together, so two alone are records that
      // arrived without the third rather than a batch to fit from.
      for (let left = 0; left < 3; left++) {
        const records = batch("workspace-unit", 40, 92, 17)
          .filter((_, at) => at !== left);
        expect(observationsOf([{ run: "a", records }]).batches).toEqual([]);
      }
    });

    it("keeps two lanes of one run apart", () => {
      // Five lanes of a run may each hold the same suite, and adding two
      // lanes' figures would describe a batch neither of them ran.
      const seen = observationsOf([
        { run: "run-1-lane-1", records: batch("runner-unit", 10, 30, 4) },
        { run: "run-1-lane-2", records: batch("runner-unit", 20, 50, 9) },
      ]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        { suite: "runner-unit", measured: false, ran: 10, spent: 30, units: 4 },
        { suite: "runner-unit", measured: false, ran: 20, spent: 50, units: 9 },
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
          ...batch("workspace-unit", 40, 150, 17, true),
        ],
      }]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        {
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
        },
        {
          suite: "workspace-unit",
          measured: true,
          ran: 40,
          spent: 150,
          units: 17,
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
        },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 45,
          units: 4,
        },
      ]);
    });
  });

  describe("fitting one suite", () => {
    it("charges one observation's whole cost to the units it opened", () => {
      // With one batch there is nothing to say about how much of what it
      // spent was the batch and how much was the units inside it.
      // Charging the units errs high for a lane packing more of them
      // than that batch held, which is the direction that runs a lane
      // past its bound, and errs low for a lane packing fewer: a lane holding one
      // unit of this suite is charged 13 against the 52 the batch spent.
      expect(
        fitSuite([{
          suite: "s",
          measured: false,
          ran: 40,
          spent: 92,
          units: 4,
        }]),
      )
        .toEqual({ overhead: 0, correction: 1, unitOverhead: 13 });
    });

    it("tells what the tests cost from what the units cost, where a suite pays nothing to open a batch", () => {
      // The whole point of measuring the unit count: a suite that opens a
      // runner and loads a module per unit pays for that whatever its
      // tests take, and nothing in a test's own duration holds it. Where
      // a batch also pays something for itself the two cannot be
      // recovered separately, which the reading below covers.
      const fitted = fitSuite(spread((ran, units) => 2 * ran + 0.5 * units));
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("reads what a unit costs from batches that all held the same count", () => {
      // The shape a suite's batches arrive in when every lane fills to
      // one budget: they disagree about how many units they held by a few
      // out of eighty, and a slope over a gap that narrow is describing
      // the runner. The rate each batch paid is not.
      const fitted = fitSuite(oneSize(0.5));
      expect(fitted.correction).toBeCloseTo(1, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("charges a lane packing more units than any batch held for them", () => {
      // A lane packs by cost, so a suite's cheapest units can reach one
      // in numbers no batch anybody has measured ever held. Charging a
      // unit nothing leaves that lane paying a batch's fixed cost and
      // nothing more, and the lane runs past its bound. Ten times the
      // largest batch measured, which is the sort of reach a suite of a
      // thousand units divided over lanes gives.
      const fitted = fitSuite(oneSize(0.5));
      expect(fitted.overhead + fitted.unitOverhead * 800)
        .toBeGreaterThanOrEqual(0.5 * 800);
    });

    it("spreads what a batch paid for itself over the units it opened", () => {
      // Batches of one size cannot tell a cost paid once from a cost
      // paid per unit, so the rate carries a share of whatever the batch
      // paid for itself and the intercept carries what the rate leaves.
      // The rate is therefore above what a unit costs, which is the
      // direction everything here errs in.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: MIN_CORRECTION_SPAN_SECONDS * (1 + i) + 10 + 0.5 * 20,
        })),
      );
      expect(fitted.unitOverhead).toBeCloseTo(1, 6);
      expect(fitted.unitOverhead).toBeGreaterThan(0.5);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("reads the middle of the rates its batches paid", () => {
      // A batch's wall time moves by several seconds for reasons that
      // have nothing to do with what it held, so the largest rate a
      // suite has shown is describing the runner. The intercept is what
      // covers the batch the middle rate under-charges.
      const fitted = fitSuite(
        [0.5, 20, 0.4, 0.7, 0.6].map((rate) => ({
          suite: "s",
          measured: false,
          units: 10,
          ran: 30,
          spent: 30 + rate * 10,
        })),
      );
      expect(fitted.unitOverhead).toBeCloseTo(0.6, 6);
      expect(fitted.overhead).toBeCloseTo(194, 6);
    });

    it("takes the higher rate where two of them are in the middle", () => {
      const fitted = fitSuite(
        [0.4, 0.5, 0.6, 0.7].map((rate) => ({
          suite: "s",
          measured: false,
          units: 10,
          ran: 30,
          spent: 30 + rate * 10,
        })),
      );
      expect(fitted.unitOverhead).toBeCloseTo(0.6, 6);
    });

    it("reads no rate from a batch that opened no unit", () => {
      // Such a batch says nothing about what opening one costs, and the
      // rate it would be read at is a division by nothing. The intercept
      // covers it the way it covers every other observation.
      const fitted = fitSuite([
        { suite: "s", measured: false, units: 0, ran: 10, spent: 30 },
        { suite: "s", measured: false, units: 10, ran: 10, spent: 30 },
      ]);
      expect(fitted.unitOverhead).toBeCloseTo(2, 6);
      expect(fitted.overhead).toBeCloseTo(20, 6);
    });

    it("finds the slope enough disagreeing observations carry", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          measured: false,
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
        {
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS,
          spent: 80,
        },
        {
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * 3,
          spent: 100,
        },
      ]);
      expect(fitted.correction).toBe(1);
    });

    it("charges a steep suite on its correction rather than its intercept", () => {
      // Nothing bounds the correction from above. The intercept is what a
      // lane pays to run one test of the suite, so a bound that moved
      // cost there would make the suite dearer to reach, not cheaper.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 50 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(50, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("never predicts a batch costing less than one was seen to", () => {
      // A least-squares line sits in the middle of its observations,
      // which for this quantity is half the lanes running past the
      // budget they were packed against.
      const seen: BatchObservation[] = [
        ...spread((ran, units) => 10 + 2 * ran + 0.5 * units),
        {
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS,
          spent: 900,
        },
      ];
      const fitted = fitSuite(seen);
      for (const one of seen) {
        expect(
          fitted.overhead + fitted.correction * one.ran +
            fitted.unitOverhead * one.units,
        ).toBeGreaterThanOrEqual(one.spent - 1e-9);
      }
    });

    it("charges a batch past the sizes it was fitted over what those sizes say a unit costs", () => {
      // Holding every observation from below says nothing about a batch
      // larger than all of them, which is the one the intercept cannot
      // reach and the one that runs a lane past its bound. What the
      // figures have to cover there is the rate the batches themselves
      // paid.
      const seen = oneSize(0.5);
      const fitted = fitSuite(seen);
      const held = Math.max(...seen.map((one) => one.units));
      for (const units of [held * 2, held * 10, held * 100]) {
        expect(fitted.overhead + fitted.unitOverhead * units)
          .toBeGreaterThanOrEqual(0.5 * units - 1e-9);
      }
    });

    it("believes no slope from a suite nothing has charged much for", () => {
      // A slope is read far outside the range it was fitted over: a
      // suite charged six seconds in every batch anybody has seen may be
      // charged thousands the first time a lane packs it whole. Inside a
      // narrow range the fixed cost dominates and the slope is noise,
      // which is how a lane comes to believe six thousand seconds of
      // tests are free.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES + 3 }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 1,
          ran: 2 + 0.5 * i,
          spent: 41,
        })),
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
        Array.from({ length: MIN_CORRECTION_SAMPLES + 1 }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 1,
          ran: most + i,
          spent: 200 + i / 10,
        })),
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
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: MIN_CORRECTION_SPAN_SECONDS * (2 + i) / 3,
        })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.unitOverhead).toBe(0);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("charges nothing per unit for a batch that outran its own tests", () => {
      // A batch whose wall time is under what its tests took, against a
      // correction of one, is not evidence that a unit gives time back.
      const fitted = fitSuite([
        { suite: "s", measured: false, units: 20, ran: 30, spent: 10 },
        { suite: "s", measured: false, units: 20, ran: 30, spent: 12 },
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBe(0);
      expect(fitted.overhead).toBe(0);
    });

    it("keeps a correction whose batches spend exactly in proportion to their tests", () => {
      // The line the guard above refuses either side of. A suite sitting
      // on it is one the model can carry, with nothing fixed and nothing
      // per unit, so what decides it must not be the arithmetic.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES + 2 }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 20,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: MIN_CORRECTION_SPAN_SECONDS * (2 + i) / 3,
        })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0, 6);
    });

    it("refuses a correction whose line needs a fixed cost below nothing", () => {
      // The shape a suite arrives in where its batches cost more than
      // their tests and cost more of it the more they hold: the slope on
      // the tests alone comes out steep enough to explain every batch on
      // its own, and what it has taken is what the units cost. Read that
      // way the suite is charged nothing a unit, which is the reading
      // this whole term exists to replace.
      const seen = Array.from({ length: MIN_CORRECTION_SAMPLES + 2 }, (
        _,
        i,
      ) => ({
        suite: "s",
        measured: false,
        units: 10 * (1 + i) ** 2,
        ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        spent: MIN_CORRECTION_SPAN_SECONDS * (1 + i) + 7 * 10 * (1 + i) ** 2,
      }));
      const fitted = fitSuite(seen);
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBeCloseTo(7, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("refuses a slope saying a batch gets cheaper with more tests", () => {
      // Such a slope would let a lane pack the suite without limit
      // against a flat charge. A correction of zero is worse still: a
      // manifest carrying one is refused whole, so a single suite whose
      // batches trend downward would leave every lane with no manifest.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          measured: false,
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: 500 - 0.5 * MIN_CORRECTION_SPAN_SECONDS * (2 + i),
        })),
      );
      expect(fitted.correction).toBe(1);
    });

    it("fits every suite figures a manifest will carry", () => {
      // `parseCalibration` refuses a correction at or below zero and a
      // per-unit cost below zero, and it refuses the whole manifest with
      // either, so what this returns has to survive being published.
      for (const perSecond of [-3, -0.5, 0, 0.25, 4, 50]) {
        for (const perUnit of [-2, 0, 0.5, 9]) {
          const fitted = fitSuite(
            spread((ran, units) => 500 + perSecond * ran + perUnit * units),
          );
          expect(fitted.correction).toBeGreaterThan(0);
          expect(fitted.unitOverhead).toBeGreaterThanOrEqual(0);
          expect(fitted.overhead).toBeGreaterThanOrEqual(0);
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
      const fitted = calibrate({
        setup: new Map([["fuse", [14.8, 2.1]], ["browser", [0]]]),
        batches: [
          {
            suite: "workspace-unit",
            measured: false,
            ran: 40,
            spent: 92,
            units: 3,
          },
          {
            suite: "runner-unit",
            measured: false,
            ran: 10,
            spent: 20,
            units: 2,
          },
        ],
      });
      expect(Object.keys(fitted.setupCost).sort()).toEqual(["browser", "fuse"]);
      expect(Object.keys(fitted.suites).sort()).toEqual([
        "runner-unit",
        "workspace-unit",
      ]);
      expect(fitted.suites["workspace-unit"].unitOverhead).toBeCloseTo(
        52 / 3,
        6,
      );
    });

    it("fits a suite's batches run with coverage on apart from the rest", () => {
      // The two batches' tests took the same time, and the one with
      // coverage on spent 58 seconds more. Fitted together, both would
      // be charged what the dearer one cost.
      const fitted = calibrate({
        setup: new Map(),
        batches: [
          { suite: "s", measured: false, ran: 40, spent: 92, units: 4 },
          { suite: "s", measured: true, ran: 40, spent: 150, units: 4 },
        ],
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
        batches: [
          { suite: "s", measured: true, ran: 40, spent: 150, units: 4 },
        ],
      });
      expect(fitted.suites).toEqual({});
      expect(Object.keys(fitted.suitesWithCoverage ?? {})).toEqual(["s"]);
    });

    it("carries no coverage figure for a suite run only without", () => {
      const fitted = calibrate({
        setup: new Map(),
        batches: [
          { suite: "s", measured: false, ran: 40, spent: 92, units: 4 },
        ],
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
    it("returns `true` for either kind of observation", () => {
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: 14.8 }))
        .toBe(true);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          measured: true,
          ran: 10,
          spent: 30,
          units: 4,
        }),
      ).toBe(true);
    });

    it("returns `true` for a batch stored without saying whether coverage was on", () => {
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          ran: 10,
          spent: 30,
          units: 4,
        }),
      ).toBe(true);
    });

    it("returns `false` for a coverage flag that is not a boolean", () => {
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          measured: "yes",
          ran: 10,
          spent: 30,
          units: 4,
        }),
      ).toBe(false);
    });

    it("returns `false` for a figure that is not a finite number", () => {
      // A stored `Infinity` or `NaN` arrives as `null`, and one entry
      // read forward as a number that is not one decides what every lane
      // is charged for the suite it names.
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: null }))
        .toBe(false);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          measured: false,
          ran: 10,
          spent: "30",
          units: 4,
        }),
      ).toBe(false);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          measured: false,
          ran: Infinity,
          spent: 3,
          units: 4,
        }),
      ).toBe(false);
    });

    it("returns `false` for anything that is not one", () => {
      expect(isLaneObservation({ capability: "fuse", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", seconds: 1 })).toBe(false);
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
    it("sorts stored observations back into the two kinds", () => {
      const seen = laneObservations([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 30,
          units: 4,
        },
        { day: "2026-09-13", capability: "fuse", seconds: 2.1 },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.batches).toEqual([
        { suite: "runner-unit", measured: true, ran: 10, spent: 30, units: 4 },
      ]);
    });

    it("reads a batch stored without the coverage flag as run without coverage", () => {
      const seen = laneObservations([
        {
          day: "2026-09-12",
          suite: "runner-unit",
          ran: 10,
          spent: 30,
          units: 4,
        },
      ]);
      expect(seen.batches).toEqual([
        { suite: "runner-unit", measured: false, ran: 10, spent: 30, units: 4 },
      ]);
    });
  });
});
