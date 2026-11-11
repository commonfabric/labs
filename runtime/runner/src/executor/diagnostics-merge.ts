/**
 * Combines what several serving-loop realms logged into what one realm
 * running all of their work would have logged, for a loop that runs as one
 * host per serving worker. Counts add. A timing key's distribution is the
 * mixture of the parts' distributions, each weighted by how many measurements
 * it summarizes, so a percentile of the result is a percentile of every
 * measurement the parts sampled from.
 */

import { maxOf, minOf } from "@commonfabric/collections/math";
import { isPlainObject } from "@commonfabric/js-values/types";
import type {
  CDFPoint,
  getLoggerCountsBreakdown,
  TimingStats,
  TimingStatsBreakdown,
} from "@commonfabric/logger";
import type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

type LoggerCounts = ReturnType<typeof getLoggerCountsBreakdown>;

/**
 * Helper for `mergeServingLoopDiagnostics()`, which adds the numbers the
 * count breakdowns in `values` hold at one position, level by level.
 */
const summed = (values: readonly unknown[]): unknown => {
  const [first] = values;
  if (typeof first === "number") {
    return values.filter((value) => typeof value === "number")
      .reduce((sum, value) => sum + value, 0);
  }
  if (!isPlainObject(first)) return first;
  const records = values.filter((value) => isPlainObject(value));
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key in merged) continue;
      merged[key] = summed(
        records.flatMap((each) => key in each ? [each[key]] : []),
      );
    }
  }
  return merged;
};

/**
 * How many points a merged distribution keeps: as many as one realm's
 * reservoir of samples gives one of its own, so that merging what was merged
 * before, as each closed worker's diagnostics are, stays the size of one.
 */
const MERGED_CDF_POINTS_MAX = 1000;

/**
 * Helper for `mergeTimingStats()`, which returns the distribution function
 * of the mixture of `parts`, each a distribution function over its own
 * samples and the weight it carries, at no more than
 * `MERGED_CDF_POINTS_MAX` points.
 */
const mixtureOf = (
  parts: readonly { cdf: readonly CDFPoint[]; weight: number }[],
): CDFPoint[] => {
  const weighted = parts.filter((part) =>
    part.weight > 0 && part.cdf.length > 0
  );
  if (weighted.length === 0) return [];
  const total = weighted.reduce((sum, part) => sum + part.weight, 0);
  const steps = weighted.flatMap((part, index) =>
    part.cdf.map((point) => ({ ...point, index }))
  ).sort((a, b) => a.x - b.x);
  // Each part's distribution is a step function, so the mixture at `x` is
  // the weighted sum of the last step each part has taken by then. The sum
  // is taken afresh at each point, in the order `total` was, so that it
  // comes to exactly one once every part has taken its last step.
  const reached = weighted.map(() => 0);
  const mixture: CDFPoint[] = [];
  for (const [position, step] of steps.entries()) {
    reached[step.index] = step.y;
    if (steps[position + 1]?.x === step.x) continue;
    mixture.push({
      x: step.x,
      y: reached.reduce(
        (sum, y, index) => sum + y * weighted[index].weight,
        0,
      ) / total,
    });
  }
  if (mixture.length <= MERGED_CDF_POINTS_MAX) return mixture;
  // The last point is kept, since it is the largest sample of any part.
  return Array.from(
    { length: MERGED_CDF_POINTS_MAX },
    (_, index) =>
      mixture[
        Math.ceil((index + 1) * mixture.length / MERGED_CDF_POINTS_MAX) - 1
      ],
  );
};

/** Helper for `mergeTimingStats()`: the smallest sample `cdf` puts `p` at. */
const quantileOf = (cdf: readonly CDFPoint[], p: number): number =>
  (cdf.find((point) => point.y >= p) ?? cdf.at(-1))?.x ?? 0;

/**
 * Returns the statistics of the measurements `parts` summarize, taken
 * together; `parts` holds at least one. The most recent measurement is that
 * of the last part, since the parts' clocks are their realms' own and do not
 * compare.
 */
export function mergeTimingStats(parts: readonly TimingStats[]): TimingStats {
  if (parts.length === 1) return parts[0];
  const last = parts.at(-1)!;
  const count = parts.reduce((sum, part) => sum + part.count, 0);
  const totalTime = parts.reduce((sum, part) => sum + part.totalTime, 0);
  const countSinceBaseline = parts.reduce(
    (sum, part) => sum + part.countSinceBaseline,
    0,
  );
  const totalTimeSinceBaseline = parts.reduce(
    (sum, part) => sum + part.totalTimeSinceBaseline,
    0,
  );
  const cdf = mixtureOf(
    parts.map((part) => ({ cdf: part.cdf, weight: part.count })),
  );
  const sinceBaseline = parts.flatMap((part) =>
    part.cdfSinceBaseline === null
      ? []
      : [{ cdf: part.cdfSinceBaseline, weight: part.countSinceBaseline }]
  );
  return {
    count,
    min: minOf(parts.map((part) => part.min)),
    max: maxOf(parts.map((part) => part.max)),
    totalTime,
    average: count > 0 ? totalTime / count : 0,
    countSinceBaseline,
    totalTimeSinceBaseline,
    averageSinceBaseline: countSinceBaseline > 0
      ? totalTimeSinceBaseline / countSinceBaseline
      : 0,
    p50: quantileOf(cdf, 0.5),
    p95: quantileOf(cdf, 0.95),
    lastTime: last.lastTime,
    lastTimestamp: last.lastTimestamp,
    slowest: parts.flatMap((part) => part.slowest)
      .sort((a, b) => b.elapsed - a.elapsed)
      .slice(0, maxOf(parts.map((part) => part.slowest.length))),
    cdf,
    cdfSinceBaseline: sinceBaseline.length === 0
      ? null
      : mixtureOf(sinceBaseline),
  };
}

/**
 * Returns what the realms whose diagnostics `parts` holds logged, taken
 * together, and what a realm that has logged nothing reports for an empty
 * list.
 */
export function mergeServingLoopDiagnostics(
  parts: readonly ServingLoopDiagnostics[],
): ServingLoopDiagnostics {
  if (parts.length === 1) return parts[0];
  const byKey = new Map<string, Map<string, TimingStats[]>>();
  for (const { timingStats } of parts) {
    for (const [logger, keys] of Object.entries(timingStats)) {
      let merged = byKey.get(logger);
      if (merged === undefined) {
        merged = new Map();
        byKey.set(logger, merged);
      }
      for (const [key, stats] of Object.entries(keys)) {
        const held = merged.get(key);
        if (held === undefined) merged.set(key, [stats]);
        else held.push(stats);
      }
    }
  }
  const timingStats: TimingStatsBreakdown = {};
  for (const [logger, keys] of byKey) {
    timingStats[logger] = Object.fromEntries(
      [...keys].map(([key, stats]) => [key, mergeTimingStats(stats)]),
    );
  }
  return {
    // The sum has the shape every part has, which the compiler cannot see
    // through a walk over `unknown`.
    loggerCounts: summed([
      { total: 0 },
      ...parts.map((part) => part.loggerCounts),
    ]) as LoggerCounts,
    timingStats,
  };
}
