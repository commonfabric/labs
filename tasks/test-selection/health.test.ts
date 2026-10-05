import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  alarms,
  calibrationHealth,
  healthLines,
  suiteCharges,
} from "./health.ts";
import type { BatchCharge, LaneRun } from "./calibrate.ts";
import type { CalibrationHealth, SuiteHealth } from "./manifest.ts";
import type { HealthFigures } from "./health.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
import {
  HEALTH_DRIFT_FACTOR,
  HEALTH_MIN_BATCHES,
  HEALTH_MIN_LANES,
  LANE_BUDGET_SECONDS,
} from "./policy.ts";

/** A manifest holding one identity of each suite named, with their fits. */
function manifestOf(
  fits: Record<string, { overhead: number; unitOverhead: number }>,
  tooLong: Record<string, number> = {},
) {
  const suites = Object.keys(fits);
  return sampleManifest({
    entries: suites.map((suite) =>
      sampleEntry({ k: "unit", s: suite, n: "one" }, { suite })
    ),
    calibration: {
      setupCost: { fuse: 14 },
      suites: Object.fromEntries(
        suites.map((suite) => [suite, { ...fits[suite]!, correction: 1 }]),
      ),
      prologue: 40,
    },
    unschedulable: Object.entries(tooLong).flatMap(([suite, count]) =>
      Array.from({ length: count }, (_, i) => ({
        test: { k: "unit", s: suite, n: `slow ${i}` },
        suite,
        cost: 400,
      }))
    ),
  });
}

/** A batch of `suite` that spent `spent` against a charge of `projected`. */
function charged(
  suite: string,
  spent: number,
  projected: number,
): BatchCharge {
  return { suite, spent, projected };
}

/** Health with nothing in it to alarm about, which a case adjusts. */
function holding(
  suites: Record<string, SuiteHealth> = {},
  lanes: Partial<CalibrationHealth["lanes"]> = {},
): HealthFigures {
  return {
    suites,
    lanes: {
      observed: 0,
      pastBound: 0,
      projectedInside: 0,
      overran: 0,
      ...lanes,
    },
  };
}

/** One suite's figures, where only its charges matter to a case. */
function suite(fixed: number, tooLong = 0): SuiteHealth {
  return { fixed, tooLong, batches: 0 };
}

/**
 * The figures the publisher would have written into the manifest of
 * 2026-09-25 20:25, against the manifest of 16:30 before it, for every
 * suite that a lane paid over a minute to hold or that had a test too
 * long for any lane. That manifest is the one whose pattern unit charge
 * took about 180 tests out of every pull request.
 */
const BROKEN: HealthFigures = {
  suites: {
    "pattern-integration": suite(187.7),
    "pattern-integration-opposite": suite(246.4, 4),
    "pattern-unit": suite(351.3, 181),
    "runner-unit": suite(101.8),
    "workspace-unit": suite(205, 7),
  },
  lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
  previous: {
    generatedAt: "2026-09-25T16:30:32.893Z",
    suites: {
      "pattern-integration": { fixed: 102.6, tooLong: 0 },
      "pattern-integration-opposite": { fixed: 81.2, tooLong: 0 },
      "pattern-unit": { fixed: 185.5, tooLong: 0 },
      "runner-unit": { fixed: 70.2, tooLong: 0 },
      "workspace-unit": { fixed: 160.8, tooLong: 3 },
    },
  },
  tooLongBaseline: 3,
};

/** The same figures for the manifest of 16:30, against the one of 12:38. */
const ORDINARY_BEFORE: HealthFigures = {
  suites: {
    "pattern-integration": suite(102.6),
    "pattern-integration-opposite": suite(81.2),
    "pattern-unit": suite(185.5),
    "runner-unit": suite(70.2),
    "workspace-unit": suite(160.8, 3),
  },
  lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
  previous: {
    generatedAt: "2026-09-25T12:38:00.000Z",
    suites: {
      "pattern-integration": { fixed: 102.6, tooLong: 0 },
      "pattern-integration-opposite": { fixed: 81.2, tooLong: 0 },
      "pattern-unit": { fixed: 185.5, tooLong: 0 },
      "runner-unit": { fixed: 70.2, tooLong: 0 },
      "workspace-unit": { fixed: 160.8, tooLong: 2 },
    },
  },
  tooLongBaseline: 2,
};

/**
 * The same figures for the manifest of 2026-09-26 16:27, the first once
 * the model had recovered, against the one of 12:34 before it.
 */
const ORDINARY_AFTER: HealthFigures = {
  suites: {
    "pattern-integration": suite(78.8),
    "pattern-integration-opposite": suite(63.3),
    "pattern-unit": suite(211.4, 1),
    "workspace-unit": suite(74, 1),
  },
  lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
  previous: {
    generatedAt: "2026-09-26T12:34:00.000Z",
    suites: {
      "pattern-integration": { fixed: 79.4, tooLong: 0 },
      "pattern-integration-opposite": { fixed: 62.5, tooLong: 0 },
      "pattern-unit": { fixed: 243.5, tooLong: 4 },
      "workspace-unit": { fixed: 73.9, tooLong: 1 },
    },
  },
  tooLongBaseline: 5,
};

describe("health", () => {
  describe("suiteCharges()", () => {
    it("returns each suite's fixed charge and its tests too long for any lane", () => {
      const manifest = manifestOf(
        {
          "workspace-unit": { overhead: 9, unitOverhead: 2 },
          "pattern-unit": { overhead: 350, unitOverhead: 1 },
        },
        { "pattern-unit": 3 },
      );
      const capabilities = new Map([["workspace-unit", ["fuse"]]]);
      expect(suiteCharges(manifest, { capabilities, processes: new Map() }))
        .toEqual({
          "workspace-unit": { fixed: 25, tooLong: 0 },
          "pattern-unit": { fixed: 351, tooLong: 3 },
        });
    });

    it("returns a suite whose every test is too long, charged what it costs", () => {
      // The identities too long for any lane are still in the manifest,
      // so the suite still has a charge to read.
      const manifest = manifestOf(
        { "pattern-unit": { overhead: 350, unitOverhead: 0 } },
        { "pattern-unit": 1 },
      );
      expect(
        suiteCharges(manifest, {
          capabilities: new Map(),
          processes: new Map(),
        })[
          "pattern-unit"
        ],
      )
        .toEqual({ fixed: 350, tooLong: 1 });
    });
  });

  describe("calibrationHealth()", () => {
    const manifest = manifestOf({
      "workspace-unit": { overhead: 9, unitOverhead: 2 },
    });

    it("returns what batches spent over what they were charged", () => {
      const health = calibrationHealth({
        manifest,
        previous: undefined,
        capabilities: new Map(),
        processes: new Map(),
        observations: {
          charges: [
            charged("workspace-unit", 10, 20),
            charged("workspace-unit", 20, 20),
            charged("workspace-unit", 30, 20),
            // Charged nothing: no ratio to give.
            charged("workspace-unit", 30, 0),
          ],
          lanes: [],
        },
      });
      expect(health.suites["workspace-unit"]).toEqual({
        fixed: 11,
        tooLong: 0,
        batches: 3,
        ratio: { median: 1, p90: 1.5 },
      });
    });

    it("returns a suite lanes charged that the manifest no longer holds", () => {
      const health = calibrationHealth({
        manifest,
        previous: undefined,
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [charged("gone-unit", 5, 4)], lanes: [] },
      });
      expect(health.suites["gone-unit"]).toEqual({
        fixed: 0,
        tooLong: 0,
        batches: 1,
        ratio: { median: 1.25, p90: 1.25 },
      });
    });

    it("counts the lanes that ran past their bound, and which were projected inside it", () => {
      const lanes: LaneRun[] = [
        { spent: 200, projected: 229, bound: 260 },
        { spent: 270, projected: 229, bound: 260 },
        // Projected past its bound, so running past it is no surprise.
        { spent: 400, projected: 380, bound: 260 },
      ];
      const health = calibrationHealth({
        manifest,
        previous: undefined,
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [], lanes },
      });
      expect(health.lanes).toEqual({
        observed: 3,
        pastBound: 2,
        projectedInside: 2,
        overran: 1,
      });
    });

    it("returns the previous manifest's charges where there is one", () => {
      const health = calibrationHealth({
        manifest,
        previous: {
          ...manifestOf(
            { "workspace-unit": { overhead: 4, unitOverhead: 1 } },
            { "workspace-unit": 2 },
          ),
          generatedAt: "2026-09-25T16:30:00.000Z",
        },
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [], lanes: [] },
      });
      expect(health.previous).toEqual({
        generatedAt: "2026-09-25T16:30:00.000Z",
        suites: { "workspace-unit": { fixed: 5, tooLong: 2 } },
      });
      // A manifest carrying no health of its own had nothing reported.
      expect(health.tooLongBaseline).toBe(2);
    });

    it("returns the charges the previous manifest recorded, where it recorded them", () => {
      // What the manifest before said is what the dashboard showed then,
      // whatever the topology now makes of it.
      const previous = manifestOf(
        { "workspace-unit": { overhead: 4, unitOverhead: 1 } },
        { "workspace-unit": 2 },
      );
      previous.health = {
        suites: { "workspace-unit": { fixed: 99, tooLong: 7, batches: 5 } },
        lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
        alarms: [],
      };
      const health = calibrationHealth({
        manifest,
        previous,
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [], lanes: [] },
      });
      expect(health.previous?.suites).toEqual({
        "workspace-unit": { fixed: 99, tooLong: 7 },
      });
    });

    describe("the count the tests too long for any lane are judged against", () => {
      /**
       * A previous manifest holding `count` tests too long for any lane,
       * having judged its own count against `baseline`.
       */
      const before = (count: number, baseline: number) => {
        const previous = manifestOf(
          { "pattern-unit": { overhead: 10, unitOverhead: 0 } },
          { "pattern-unit": count },
        );
        previous.health = {
          suites: {},
          lanes: { observed: 0, pastBound: 0, projectedInside: 0, overran: 0 },
          tooLongBaseline: baseline,
          alarms: [],
        };
        return previous;
      };

      /** The baseline a manifest following `previous` is judged against. */
      const judgedAfter = (previous: ReturnType<typeof before>) =>
        calibrationHealth({
          manifest,
          previous,
          capabilities: new Map(),
          processes: new Map(),
          observations: { charges: [], lanes: [] },
        }).tooLongBaseline;

      it("is the previous manifest's count while that count had not grown", () => {
        expect(judgedAfter(before(4, 3))).toBe(4);
      });

      it("stays at the count before a jump while the count stays up", () => {
        // 192 against 3 was reported, so the manifest after it is judged
        // against 3 as well, and goes on reporting while 190 are still out.
        expect(judgedAfter(before(192, 3))).toBe(3);
      });

      it("returns to the previous manifest's count once the count falls back", () => {
        expect(judgedAfter(before(5, 3))).toBe(5);
      });
    });

    it("returns what it found broken beside its figures", () => {
      const health = calibrationHealth({
        manifest: manifestOf({
          "pattern-unit": { overhead: 400, unitOverhead: 0 },
        }),
        previous: undefined,
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [], lanes: [] },
      });
      expect(health.alarms).toEqual([
        "pattern-unit: a lane pays 6m40s before it runs any of it, past " +
        "the 3m50s a lane may fill",
      ]);
    });

    it("returns no previous charges where there is no previous manifest", () => {
      const health = calibrationHealth({
        manifest,
        previous: undefined,
        capabilities: new Map(),
        processes: new Map(),
        observations: { charges: [], lanes: [] },
      });
      expect(Object.hasOwn(health, "previous")).toBe(false);
    });
  });

  describe("alarms()", () => {
    it("returns nothing for the manifests either side of 2026-09-25's break", () => {
      expect(alarms(ORDINARY_BEFORE)).toEqual([]);
      expect(alarms(ORDINARY_AFTER)).toEqual([]);
    });

    it("names what broke in the manifest of 2026-09-25 20:25", () => {
      expect(alarms(BROKEN)).toEqual([
        "192 tests are too long for any lane, up from 3: pattern-unit 181, " +
        "workspace-unit 7, pattern-integration-opposite 4",
        "pattern-integration-opposite: a lane pays 4m6s before it runs any " +
        "of it, past the 3m50s a lane may fill; it was 1m21s in the " +
        "manifest before",
        "pattern-unit: a lane pays 5m51s before it runs any of it, past the " +
        "3m50s a lane may fill; it was 3m6s in the manifest before",
      ]);
    });

    describe("the tests too long for any lane", () => {
      /** Health whose one suite has `now` such tests, against `before`. */
      const grown = (before: number, now: number): HealthFigures => ({
        ...holding({ "pattern-unit": suite(10, now) }),
        tooLongBaseline: before,
      });

      it("returns an alarm for a count past twice what it was and twenty more", () => {
        expect(alarms(grown(3, 24))).toHaveLength(1);
      });

      it("returns nothing for a count that grew by twenty or fewer", () => {
        // The manifests of 2026-09-10 went from 8 to 20.
        expect(alarms(grown(8, 20))).toEqual([]);
        expect(alarms(grown(0, 20))).toEqual([]);
      });

      it("returns nothing for a count that did not double", () => {
        expect(alarms(grown(100, 200))).toEqual([]);
      });

      it("returns nothing where there is no previous manifest to compare with", () => {
        expect(alarms(holding({ "pattern-unit": suite(10, 22_000) })))
          .toEqual([]);
      });
    });

    describe("a suite's fixed charge", () => {
      it("returns an alarm for a charge past a lane's budget", () => {
        expect(
          alarms(holding({ "pattern-unit": suite(LANE_BUDGET_SECONDS + 1) })),
        ).toEqual([
          "pattern-unit: a lane pays 3m51s before it runs any of it, past " +
          "the 3m50s a lane may fill",
        ]);
      });

      it("returns nothing for a charge at the budget", () => {
        expect(alarms(holding({ "pattern-unit": suite(LANE_BUDGET_SECONDS) })))
          .toEqual([]);
      });
    });

    describe("the lanes that ran past their bound", () => {
      it("returns an alarm where more than the share allowed ran past it", () => {
        expect(
          alarms(holding({}, { projectedInside: 20, overran: 4 })),
        ).toEqual([
          "4 of the 20 lanes projected to finish inside their bound over " +
          "the last 7 days ran past it, which is 20% against the 15% allowed",
        ]);
      });

      it("returns nothing at the share allowed", () => {
        expect(alarms(holding({}, { projectedInside: 20, overran: 3 })))
          .toEqual([]);
      });

      it("returns nothing over too few lanes to judge", () => {
        expect(
          alarms(
            holding({}, {
              projectedInside: HEALTH_MIN_LANES - 1,
              overran: HEALTH_MIN_LANES - 1,
            }),
          ),
        ).toEqual([]);
      });
    });

    describe("a suite's drift", () => {
      /** Health whose one suite's batches came to `p90`. */
      const drifting = (p90: number, batches = HEALTH_MIN_BATCHES) =>
        holding({
          "pattern-unit": {
            fixed: 10,
            tooLong: 0,
            batches,
            ratio: { median: p90, p90 },
          },
        });

      it("returns an alarm for batches spending more than twice their charge", () => {
        expect(alarms(drifting(2.4))).toEqual([
          "pattern-unit: the ninetieth percentile of what its 10 batches " +
          "spent over what they were charged is 2.40, more than 2",
        ]);
      });

      it("returns an alarm for batches spending under half their charge", () => {
        expect(alarms(drifting(0.3))).toEqual([
          "pattern-unit: the ninetieth percentile of what its 10 batches " +
          "spent over what they were charged is 0.30, less than 0.5",
        ]);
      });

      it("returns nothing at the factor allowed either way", () => {
        expect(alarms(drifting(HEALTH_DRIFT_FACTOR))).toEqual([]);
        expect(alarms(drifting(1 / HEALTH_DRIFT_FACTOR))).toEqual([]);
      });

      it("returns nothing over too few batches to judge", () => {
        expect(alarms(drifting(9, HEALTH_MIN_BATCHES - 1))).toEqual([]);
      });
    });
  });

  describe("healthLines()", () => {
    /** Figures with what `alarms()` finds broken in them. */
    const judged = (figures: HealthFigures): CalibrationHealth => ({
      ...figures,
      alarms: alarms(figures),
    });

    it("says the model holds where nothing alarms", () => {
      const lines = healthLines(judged(ORDINARY_BEFORE));
      expect(lines).toContain(
        "workspace-unit: a lane pays 2m41s to hold it; 3 too long for any " +
          "lane (was 2)",
      );
      expect(lines).toContain("no lane over the last 7 days recorded its work");
      expect(lines.at(-1)).toBe("the cost model holds");
    });

    it("says what broke where something alarms", () => {
      const lines = healthLines(judged(BROKEN));
      expect(lines).toContain(
        "pattern-unit: a lane pays 5m51s to hold it (was 3m6s); 181 too " +
          "long for any lane (was 0)",
      );
      expect(
        lines.filter((line) => line.startsWith("the cost model is broken: ")),
      )
        .toHaveLength(3);
      expect(lines).not.toContain("the cost model holds");
    });

    it("says what the lanes and the batches came to", () => {
      const lines = healthLines(judged(
        holding({
          "runner-unit": {
            fixed: 6,
            tooLong: 0,
            batches: 12,
            ratio: { median: 0.8, p90: 1.1 },
          },
        }, { observed: 40, pastBound: 3, projectedInside: 38, overran: 2 }),
      ));
      expect(lines).toEqual([
        "runner-unit: a lane pays 6s to hold it; 12 batches spent 0.80 of " +
        "what they were charged at the median and 1.10 at the ninetieth " +
        "percentile",
        "3 of 40 lanes over the last 7 days ran past their bound, 2 of them " +
        "among the 38 projected to finish inside it",
        "the cost model holds",
      ]);
    });
  });
});
