/**
 * Decides whether a series of measurements is trending, and turns that into
 * the status and the label a tile shows. A series is read two ways at once:
 * as a run of flat levels separated by change points, which is what a
 * regression that lands in one commit looks like, and as a single straight
 * line, which is what a gradual drift looks like. Whichever describes the
 * series more closely supplies the change that gets reported. Working in logs
 * throughout makes the answer a ratio, so a series of milliseconds and a
 * series of megabytes are judged on the same scale.
 */

import { median } from "./lib.ts";
import type { Status } from "./types.ts";

const DAY_MS = 86_400_000;
const MIN_TREND_DAYS = 7;
const UP_PCT = 0.05;
const RAPID_PCT = 0.20;
// Samples the level fit reads, after grouping. Bounds the change-point search,
// which is quadratic in the sample count.
const LEVEL_SAMPLE_CAP = 64;
// Samples either side of a change point, so each level rests on three or more.
const MIN_SEGMENT = 3;
// How far apart two neighboring levels must sit, in standard errors of their
// difference, for the boundary between them to count as a change point.
const CHANGE_POINT_SIGMAS = 4;
// How much smaller the straight line's total deviation must be for it to
// describe the series instead of the levels.
const LINE_PREFERENCE_MARGIN = 0.1;

export function distinctTrendDays(times: number[], values: number[]): number {
  const days = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) days.add(Math.floor(times[i] / DAY_MS));
  }
  return days.size;
}

// Groups the samples into at most `LEVEL_SAMPLE_CAP` equal-sized runs and takes
// each run's median. Grouping by count rather than by clock keeps every group
// carrying the same weight however unevenly the samples arrive.
function groupedSamples(values: number[]): number[] {
  if (values.length <= LEVEL_SAMPLE_CAP) return values;
  const grouped: number[] = [];
  for (let group = 0; group < LEVEL_SAMPLE_CAP; group++) {
    const from = Math.round(group * values.length / LEVEL_SAMPLE_CAP);
    const to = Math.round((group + 1) * values.length / LEVEL_SAMPLE_CAP);
    if (to > from) grouped.push(median(values.slice(from, to)));
  }
  return grouped;
}

// The typical size of a sample-to-sample move, read from the differences
// between neighbors. A level change contributes one difference however large
// it is, so the median of them describes the noise around the levels.
function noiseScale(logs: number[]): number {
  const steps: number[] = [];
  for (let i = 1; i < logs.length; i++) {
    steps.push(Math.abs(logs[i] - logs[i - 1]));
  }
  return 1.4826 * median(steps) / Math.SQRT2;
}

function insertSorted(sorted: number[], value: number): void {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  sorted.splice(low, 0, value);
}

function medianOfSorted(sorted: number[]): number {
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Splits `[from, to)` at the boundary whose two sides sit furthest apart, then
// splits each side the same way, collecting the boundaries into `into`. A
// boundary counts only when the gap between the two medians clears
// `CHANGE_POINT_SIGMAS` standard errors, so noise alone does not produce one.
function collectChangePoints(
  logs: number[],
  scale: number,
  from: number,
  to: number,
  into: number[],
): void {
  const length = to - from;
  if (length < 2 * MIN_SEGMENT) return;
  const leftMedians: number[] = new Array(length + 1).fill(0);
  const left: number[] = [];
  for (let taken = 0; taken < length; taken++) {
    insertSorted(left, logs[from + taken]);
    leftMedians[taken + 1] = medianOfSorted(left);
  }
  const rightMedians: number[] = new Array(length + 1).fill(0);
  const right: number[] = [];
  for (let taken = length - 1; taken >= 0; taken--) {
    insertSorted(right, logs[from + taken]);
    rightMedians[taken] = medianOfSorted(right);
  }
  let bestSplit = -1;
  let bestGap = 0;
  for (let split = MIN_SEGMENT; split <= length - MIN_SEGMENT; split++) {
    const gap = Math.abs(rightMedians[split] - leftMedians[split]);
    const floor = CHANGE_POINT_SIGMAS * scale *
      Math.sqrt(1 / split + 1 / (length - split));
    if (gap > floor && gap > bestGap) {
      bestGap = gap;
      bestSplit = from + split;
    }
  }
  if (bestSplit < 0) return;
  into.push(bestSplit);
  collectChangePoints(logs, scale, from, bestSplit, into);
  collectChangePoints(logs, scale, bestSplit, to, into);
}

// The median of every pairwise slope between samples, by position in the
// series.
function medianSlope(logs: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < logs.length; i++) {
    for (let j = i + 1; j < logs.length; j++) {
      slopes.push((logs[j] - logs[i]) / (j - i));
    }
  }
  return slopes.length ? median(slopes) : 0;
}

// Overall change as the fractional difference between the start and the end of
// a robust fit (+0.2 means the fit ends 20% higher than it starts).
//
// Two fits describe the series and the closer one wins. The first is a set
// of flat levels meeting at change points, which is the shape a series takes
// when something lands and shifts it. The second is a straight line through the
// median pairwise slope, which is the shape a series takes when it drifts. Each
// reports the difference between its own value at the last sample and at the
// first, so a shift reads at its true size wherever in the window it sits.
//
// Sub-zero values are not timings and take no part. Fewer than
// `MIN_TREND_DAYS` distinct days reads flat, which also means the fits below
// always have that many samples to read: a distinct day needs a sample above
// zero to count, and grouping only ever thins a longer series. `times` must be
// ascending.
export function trendPct(times: number[], values: number[]): number {
  if (distinctTrendDays(times, values) < MIN_TREND_DAYS) return 0;
  const logs = groupedSamples(values.filter((value) => value > 0))
    .map((value) => Math.log(value));
  // A scale of zero means most neighbors agree exactly. The search then treats
  // any daylight between two levels as real, and still asks for `MIN_SEGMENT`
  // samples either side of the boundary, so a single stray sample is not one.
  const scale = noiseScale(logs);
  const changePoints: number[] = [];
  collectChangePoints(logs, scale, 0, logs.length, changePoints);
  // The search reports each boundary as it splits, which is widest-gap first.
  changePoints.sort((a, b) => a - b);
  const edges = [0, ...changePoints, logs.length];
  const levels = edges.slice(0, -1).map((start, index) =>
    median(logs.slice(start, edges[index + 1]))
  );
  let levelDeviation = 0;
  for (let edge = 0; edge < levels.length; edge++) {
    for (let i = edges[edge]; i < edges[edge + 1]; i++) {
      levelDeviation += Math.abs(logs[i] - levels[edge]);
    }
  }
  const slope = medianSlope(logs);
  const intercept = median(logs.map((log, index) => log - slope * index));
  let lineDeviation = 0;
  for (let i = 0; i < logs.length; i++) {
    lineDeviation += Math.abs(logs[i] - (intercept + slope * i));
  }
  const byLine = lineDeviation < levelDeviation * (1 - LINE_PREFERENCE_MARGIN);
  return Math.expm1(
    byLine ? slope * (logs.length - 1) : levels[levels.length - 1] - levels[0],
  );
}

export function trendStatus(pct: number): Status {
  return pct <= UP_PCT ? "good" : pct <= RAPID_PCT ? "warn" : "bad";
}

// A percent for modest moves; a fold multiplier once it passes four times in
// either direction.
export function trendPctLabel(pct: number): string {
  const ratio = pct + 1;
  const fold = (value: number) =>
    value >= 10 ? value.toFixed(0) : value.toFixed(1);
  if (ratio >= 4) return `▲${fold(ratio)}×`;
  if (ratio > 0 && 1 / ratio >= 4) return `▼${fold(1 / ratio)}×`;
  const percent = Math.round(pct * 100);
  return percent > 0 ? `▲${percent}%` : percent < 0 ? `▼${-percent}%` : "flat";
}
