import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  LogCounts,
  LoggerBreakdown,
  TimingStats,
} from "@commonfabric/logger";
import {
  mergeServingLoopDiagnostics,
  mergeTimingStats,
} from "../../src/executor/diagnostics-merge.ts";
import type { ServingLoopDiagnostics } from "../../src/executor/serving-port-protocol.ts";

/** The statistics a store reports of `samples`, measured in that order. */
const timingOf = (samples: readonly number[]): TimingStats => {
  const sorted = [...samples].sort((a, b) => a - b);
  const totalTime = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    count: samples.length,
    min: sorted[0],
    max: sorted.at(-1)!,
    totalTime,
    average: totalTime / samples.length,
    countSinceBaseline: 0,
    totalTimeSinceBaseline: 0,
    averageSinceBaseline: 0,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    lastTime: samples.at(-1)!,
    lastTimestamp: samples.length,
    slowest: sorted.slice(-2).reverse().map((elapsed) => ({
      elapsed,
      at: elapsed,
      epochMs: elapsed,
    })),
    cdf: sorted.map((x, index) => ({ x, y: (index + 1) / sorted.length })),
    cdfSinceBaseline: null,
  };
};

/** What a realm logged: `counts` under one logger, `timing` under one key. */
const diagnosticsOf = (
  counts: number,
  timing?: TimingStats,
): ServingLoopDiagnostics => {
  // A breakdown's `total` sits beside its entries under one index signature,
  // so no literal has its type; each level is spread together, as the logger
  // builds its own.
  const byKey: Record<string, LogCounts> = {
    wave: { debug: 0, info: counts, warn: 0, error: 0, total: counts },
  };
  const byLogger: Record<string, LoggerBreakdown> = {
    executor: { ...byKey, total: counts } as LoggerBreakdown,
  };
  return {
    loggerCounts: {
      ...byLogger,
      total: counts,
    } as ServingLoopDiagnostics["loggerCounts"],
    timingStats: timing === undefined ? {} : { executor: { settle: timing } },
  };
};

describe("diagnostics-merge", () => {
  describe("mergeTimingStats()", () => {
    it("returns the one part it is given", () => {
      const only = timingOf([1, 2, 3]);
      expect(mergeTimingStats([only])).toBe(only);
    });

    it("adds counts and totals, and takes the extremes", () => {
      const merged = mergeTimingStats([
        timingOf([1, 2, 3]),
        timingOf([10, 20]),
      ]);
      expect(merged.count).toBe(5);
      expect(merged.totalTime).toBe(36);
      expect(merged.average).toBe(36 / 5);
      expect(merged.min).toBe(1);
      expect(merged.max).toBe(20);
    });

    it("returns the distribution of every sample for parts that hold all of theirs", () => {
      const merged = mergeTimingStats([
        timingOf([1, 2, 3, 4]),
        timingOf([10, 20, 30, 40]),
      ]);
      expect(merged.cdf.map((point) => point.x)).toEqual([
        1,
        2,
        3,
        4,
        10,
        20,
        30,
        40,
      ]);
      expect(merged.cdf.at(-1)?.y).toBe(1);
      expect(merged.cdf[3].y).toBeCloseTo(0.5);
      expect(merged.p50).toBe(4);
      expect(merged.p95).toBe(40);
    });

    it("weighs each part's distribution by the measurements it summarizes", () => {
      // Three of four measurements took 1, so the median is 1, where the two
      // parts' medians average to 50.5.
      const merged = mergeTimingStats([
        { ...timingOf([1]), count: 3, totalTime: 3 },
        timingOf([100]),
      ]);
      expect(merged.cdf).toEqual([{ x: 1, y: 0.75 }, { x: 100, y: 1 }]);
      expect(merged.p50).toBe(1);
      expect(merged.p95).toBe(100);
    });

    it("keeps no more points than one realm's distribution has, the largest sample among them", () => {
      const samples = (offset: number) =>
        Array.from({ length: 1000 }, (_, index) => offset + index * 2);
      const merged = mergeTimingStats([
        timingOf(samples(0)),
        timingOf(samples(1)),
      ]);
      expect(merged.cdf).toHaveLength(1000);
      expect(merged.cdf.at(-1)).toEqual({ x: 1999, y: 1 });
      expect(merged.p50).toBe(999);
    });

    it("keeps the slowest measurements of any part, longest first", () => {
      const merged = mergeTimingStats([
        timingOf([1, 50, 3]),
        timingOf([40, 60]),
      ]);
      expect(merged.slowest.map((entry) => entry.elapsed)).toEqual([60, 50]);
    });

    it("takes the most recent measurement from the last part", () => {
      const merged = mergeTimingStats([timingOf([1, 2]), timingOf([7, 9])]);
      expect(merged.lastTime).toBe(9);
    });

    it("returns no distribution since a baseline when no part has one", () => {
      expect(
        mergeTimingStats([timingOf([1]), timingOf([2])]).cdfSinceBaseline,
      ).toBeNull();
    });

    it("mixes the distributions since a baseline of the parts that have one", () => {
      const since = {
        ...timingOf([5]),
        countSinceBaseline: 1,
        totalTimeSinceBaseline: 5,
        cdfSinceBaseline: [{ x: 5, y: 1 }],
      };
      const merged = mergeTimingStats([since, timingOf([2])]);
      expect(merged.cdfSinceBaseline).toEqual([{ x: 5, y: 1 }]);
      expect(merged.countSinceBaseline).toBe(1);
      expect(merged.averageSinceBaseline).toBe(5);
    });

    it("returns an empty distribution since a baseline no part has measured past", () => {
      const quiet = { ...timingOf([3]), cdfSinceBaseline: [] };
      const merged = mergeTimingStats([quiet, quiet]);
      expect(merged.cdfSinceBaseline).toEqual([]);
      expect(merged.averageSinceBaseline).toBe(0);
      expect(merged.cdf).toEqual([{ x: 3, y: 1 }]);
    });
  });

  describe("mergeServingLoopDiagnostics()", () => {
    it("returns what a realm that logged nothing reports for an empty list", () => {
      expect(mergeServingLoopDiagnostics([])).toEqual({
        loggerCounts: { total: 0 },
        timingStats: {},
      });
    });

    it("returns the one part it is given", () => {
      const only = diagnosticsOf(2, timingOf([1]));
      expect(mergeServingLoopDiagnostics([only])).toBe(only);
    });

    it("adds log counts at every level of the breakdown", () => {
      const merged = mergeServingLoopDiagnostics([
        diagnosticsOf(2),
        diagnosticsOf(3),
      ]);
      expect(merged.loggerCounts).toEqual({
        total: 5,
        executor: {
          total: 5,
          wave: { debug: 0, info: 5, warn: 0, error: 0, total: 5 },
        },
      });
    });

    it("merges a timing key several realms measured, and keeps one a single realm did", () => {
      const alone = timingOf([4]);
      const merged = mergeServingLoopDiagnostics([
        diagnosticsOf(0, timingOf([1, 2])),
        {
          ...diagnosticsOf(0, timingOf([3])),
          timingStats: {
            executor: { settle: timingOf([3]), commit: alone },
          },
        },
      ]);
      expect(merged.timingStats.executor.settle.count).toBe(3);
      expect(merged.timingStats.executor.commit).toBe(alone);
    });
  });
});
