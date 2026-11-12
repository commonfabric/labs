/**
 * Combines the serving-loop counters of several hosts into the one set a
 * process reports (serving-loop.md §7), for a loop that runs as one host per
 * serving worker. A counter is summed. The fields that are not counters are
 * named in `RULES` below, each with how it combines, so a counter the stats
 * gain later is summed without a change here and a level or a peak gained
 * later needs its line.
 */

import { maxOf } from "@commonfabric/collections/math";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  DERIVED_COMMITS_BY_SPACE_MAX,
  emptyServingLoopStats,
  type ServingLoopStats,
  SETTLE_SERIES_MAX,
} from "./stats.ts";

/**
 * How a field that is not a counter combines across hosts, and what a host
 * that has closed leaves of it:
 *
 * - `level` is a count of what a host holds now. Hosts' levels add, and a
 *   closed host holds nothing.
 * - `level-max` is the largest of something a host holds now. The largest
 *   across hosts stands, and a closed host holds nothing.
 * - `peak` is the largest a level ever reached on one host. The largest
 *   across hosts stands, a closed host's included.
 */
type Rule = "level" | "level-max" | "peak";

/** The fields of {@link ServingLoopStats} that are not counters, by path. */
const RULES: Readonly<Record<string, Rule>> = {
  "activeSpaces": "level",
  "watermarkLag": "level-max",
  "demand.demandedRows": "level",
  "demand.demandedInstances": "level",
  "demand.demandedInstancesMax": "peak",
  "demand.demandedPairs": "level",
  "demand.demandedWriters": "level",
  "demand.demandedWritersMax": "peak",
  "events.coalescedPerWaveMax": "peak",
  "events.deliveryDeferralsActive": "level",
  "events.deliveryFailuresActive": "level",
  "events.maxAccumulatedDeliveryFailureMs": "level-max",
  "memo.inflight": "level",
  "parkedRuntimes.held": "level",
  "workers.serving": "level",
  "workers.spare": "level",
  "workers.parked": "level",
  "workers.heapUsed": "level",
};

/**
 * Helper for `mergedStats()`, which combines the values several hosts hold
 * at `path`: numbers by the path's rule, records key by key over the union of
 * their keys, and arrays end to end. With `closing` set, a level is zero.
 */
const mergedAt = (
  path: string,
  values: readonly unknown[],
  closing: boolean,
): unknown => {
  const [first] = values;
  if (typeof first === "number") {
    const numbers = values.filter((value) => typeof value === "number");
    const rule = RULES[path];
    if (closing && (rule === "level" || rule === "level-max")) return 0;
    return rule === "peak" || rule === "level-max"
      ? maxOf(numbers)
      : numbers.reduce((sum, value) => sum + value, 0);
  }
  if (Array.isArray(first)) {
    return values.flatMap((value) => Array.isArray(value) ? value : []);
  }
  const records = values.filter((value) => isPlainObject(value));
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key in merged) continue;
      merged[key] = mergedAt(
        path === "" ? key : `${path}.${key}`,
        records.flatMap((each) => key in each ? [each[key]] : []),
        closing,
      );
    }
  }
  return merged;
};

/** Helper for `mergedStats()`, which keeps a series within bounds. */
const bounded = <Row>(
  block: { series: Row[]; dropped: number },
): void => {
  const excess = block.series.length - SETTLE_SERIES_MAX;
  if (excess <= 0) return;
  block.dropped += excess;
  block.series.splice(0, excess);
};

/**
 * Helper for `mergeServingLoopStats()` and `closedHostServingLoopStats()`,
 * which combines `parts`, with every level at zero when `closing` is set.
 */
const mergedStats = (
  parts: readonly ServingLoopStats[],
  closing: boolean,
): ServingLoopStats => {
  // The walk rebuilds the shape every part has, so what it returns has that
  // shape too, which the compiler cannot see through a walk over `unknown`.
  const merged = mergedAt("", [
    emptyServingLoopStats(),
    ...parts,
  ], closing) as ServingLoopStats;
  merged.settle.series = merged.settle.series.map((row) => ({ ...row }));
  merged.settleAdvances.series = merged.settleAdvances.series.map((row) => ({
    ...row,
  }));
  bounded(merged.settle);
  bounded(merged.settleAdvances);
  merged.settleAdvances.lastDelta =
    parts.findLast((part) => part.settleAdvances.count > 0)?.settleAdvances
      .lastDelta ?? 0;
  const spaces = Object.keys(merged.derivedCommitsBySpace);
  for (
    const space of spaces.slice(
      0,
      Math.max(0, spaces.length - DERIVED_COMMITS_BY_SPACE_MAX),
    )
  ) {
    merged.derivedCommitsBySpaceDropped += merged.derivedCommitsBySpace[space];
    delete merged.derivedCommitsBySpace[space];
  }
  return merged;
};

/**
 * Returns the counters of the hosts whose counters `parts` holds, taken
 * together: the counters of no host for an empty list. Rows of a bounded
 * series keep the order of `parts`, and the rows a bound drops are the
 * earliest of them, counted where the series counts its own.
 * `settleAdvances.lastDelta` is that of the last part that advanced.
 *
 * The parts are left as they are, and the result shares nothing with them
 * that the counters' holders write to.
 */
export function mergeServingLoopStats(
  parts: readonly ServingLoopStats[],
): ServingLoopStats {
  return mergedStats(parts, false);
}

/**
 * Returns `stats` as a host that has closed leaves them: every counter and
 * peak as it stood, and every level at zero, since a closed host holds
 * nothing.
 */
export function closedHostServingLoopStats(
  stats: ServingLoopStats,
): ServingLoopStats {
  return mergedStats([stats], true);
}
