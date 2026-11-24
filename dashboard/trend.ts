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
// Samples on each side of a sample that `levelChanges` compares when it looks
// for the steps a series takes.
const STEP_WINDOW = 2 * MIN_SEGMENT;
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

// How far apart, in logs, the medians of two neighboring runs of `left` and
// `right` samples must sit for the boundary between them to be a change point.
const changePointFloor = (scale: number, left: number, right: number): number =>
  CHANGE_POINT_SIGMAS * scale * Math.sqrt(1 / left + 1 / right);

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
    const floor = changePointFloor(scale, split, length - split);
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
  const levels = levelMedians(logs, edges);
  const slope = medianSlope(logs);
  return Math.expm1(
    lineFitsCloser(logs, edges, levels, slope)
      ? slope * (logs.length - 1)
      : levels[levels.length - 1] - levels[0],
  );
}

// The median of each level, where `edges` holds the start of every level and
// then the length of the series.
const levelMedians = (logs: number[], edges: number[]): number[] =>
  edges.slice(0, -1).map((start, index) =>
    median(logs.slice(start, edges[index + 1]))
  );

// Whether the straight line of slope `slope` through `logs` sits closer to
// them in all than the flat levels `levels`, starting at `edges`, do, by
// `LINE_PREFERENCE_MARGIN`.
function lineFitsCloser(
  logs: number[],
  edges: number[],
  levels: number[],
  slope: number,
): boolean {
  let levelDeviation = 0;
  for (let edge = 0; edge < levels.length; edge++) {
    for (let i = edges[edge]; i < edges[edge + 1]; i++) {
      levelDeviation += Math.abs(logs[i] - levels[edge]);
    }
  }
  const intercept = median(logs.map((log, index) => log - slope * index));
  let lineDeviation = 0;
  for (let i = 0; i < logs.length; i++) {
    lineDeviation += Math.abs(logs[i] - (intercept + slope * i));
  }
  return lineDeviation < levelDeviation * (1 - LINE_PREFERENCE_MARGIN);
}

// The median slope between each sample and the sample half the series later.
// `levelChanges` reads it instead of `medianSlope` because it takes time in
// proportion to the length of the series rather than to its square, and
// `levelChanges` reads series far longer than the ones `trendPct` groups.
function halfSpanSlope(logs: number[]): number {
  const span = Math.floor(logs.length / 2);
  return median(
    logs.slice(span).map((log, index) => (log - logs[index]) / span),
  );
}

// Whether the samples of `[from, to)` and of `[otherFrom, otherTo)` sit far
// enough apart to be two levels, by the rule the change-point search applies.
function apart(
  logs: number[],
  scale: number,
  [from, to]: [number, number],
  [otherFrom, otherTo]: [number, number],
): boolean {
  const gap = Math.abs(
    median(logs.slice(otherFrom, otherTo)) - median(logs.slice(from, to)),
  );
  return gap > changePointFloor(scale, to - from, otherTo - otherFrom);
}

// For each count of leading values, how far those values sit in all from
// their own median. Of sorted values, that is the sum of each value in the
// upper half less its mirror in the lower half.
function prefixDeviations(values: number[]): number[] {
  const sorted: number[] = [];
  const deviations = [0];
  for (const value of values) {
    insertSorted(sorted, value);
    let deviation = 0;
    for (let low = 0, high = sorted.length - 1; low < high; low++, high--) {
      deviation += sorted[high] - sorted[low];
    }
    deviations.push(deviation);
  }
  return deviations;
}

// The split of `[from, to)` that leaves the samples on each side closest to
// their own side's median, keeping `MIN_SEGMENT` samples on each side.
function closestSplit(logs: number[], from: number, to: number): number {
  const segment = logs.slice(from, to);
  const leading = prefixDeviations(segment);
  const trailing = prefixDeviations(segment.toReversed());
  let best = MIN_SEGMENT;
  for (let split = best; split <= segment.length - MIN_SEGMENT; split++) {
    if (
      leading[split] + trailing[segment.length - split] <
        leading[best] + trailing[segment.length - best]
    ) best = split;
  }
  return from + best;
}

// The spread of the samples, as a standard deviation, where `edges` holds the
// start of every level and then the length of the series. It is the larger of
// two measures, each taken within levels. The first is the distance of each
// sample from the median of the other samples within `STEP_WINDOW` of it, at
// the 90th percentile, which fewer than a tenth of the samples lying far out
// do not move; unlike the median difference between neighbors, it takes in the whole
// spread of a series that moves between two levels at random, such as one
// measured on two kinds of host. The second is the median difference between
// samples `STEP_WINDOW` apart, which takes in some of the noise that stays high
// or low for several samples, and drift.
function localSpread(logs: number[], edges: number[]): number {
  const distances: number[] = [];
  const lagged: number[] = [];
  for (let level = 0; level < edges.length - 1; level++) {
    const [from, to] = [edges[level], edges[level + 1]];
    for (let i = from; i < to; i++) {
      const others = [
        ...logs.slice(Math.max(from, i - STEP_WINDOW), i),
        ...logs.slice(i + 1, Math.min(to, i + STEP_WINDOW + 1)),
      ];
      if (others.length) distances.push(Math.abs(logs[i] - median(others)));
      if (i + STEP_WINDOW < to) {
        lagged.push(Math.abs(logs[i + STEP_WINDOW] - logs[i]));
      }
    }
  }
  distances.sort((a, b) => a - b);
  return Math.max(
    (distances[Math.floor(0.9 * (distances.length - 1))] ?? 0) / 1.645,
    1.4826 * median(lagged) / Math.SQRT2,
  );
}

// The samples at which the median of the `STEP_WINDOW` samples from there on
// sits further from the median of the `STEP_WINDOW` samples before than the
// change-point floor, and by more than it does at any sample within
// `MIN_SEGMENT` of there, the earliest of equals.
function stepCandidates(logs: number[], scale: number): number[] {
  const excesses = new Map<number, number>();
  for (let i = MIN_SEGMENT; i <= logs.length - MIN_SEGMENT; i++) {
    const before = logs.slice(Math.max(0, i - STEP_WINDOW), i);
    const after = logs.slice(i, i + STEP_WINDOW);
    excesses.set(
      i,
      Math.abs(median(after) - median(before)) -
        changePointFloor(scale, before.length, after.length),
    );
  }
  return [...excesses].filter(([i, excess]) => {
    if (!(excess > 0)) return false;
    for (let j = i - MIN_SEGMENT; j <= i + MIN_SEGMENT; j++) {
      const other = excesses.get(j) ?? 0;
      if (other > excess || (other === excess && j < i)) return false;
    }
    return true;
  }).map(([i]) => i);
}

/** A boundary between two flat levels of a series. */
export interface LevelChange {
  /** The index of the first sample of the earlier level. */
  start: number;
  /** The index of the first sample of the later level. */
  index: number;
  /** The index just past the last sample of the later level. */
  end: number;
  /** The later level's median divided by the earlier level's. */
  ratio: number;
}

/**
 * The boundaries between the flat levels of `values`, oldest first. Every
 * value must be finite and above zero.
 *
 * Each sample at which the samples just after it sit apart from those just
 * before it is a candidate boundary, measured against `localSpread`. Each
 * boundary is then moved, among the samples of its two levels, to the split
 * that leaves them closest to their own level's median, which is the sample at
 * which the level changed. A boundary is dropped when its two levels do not
 * sit apart by the change-point search's rule. So are both boundaries of a
 * level shorter than `STEP_WINDOW` between two levels that do not sit apart
 * from each other, and the boundary after a first level shorter than
 * `STEP_WINDOW`, since each is a burst of outlying samples rather than a
 * step. The rest are moved again until every boundary left passes, and the
 * levels that leaves are searched for candidates in turn, for as long as a
 * search leaves more boundaries than it started with. The search then runs
 * again from those boundaries with the spread measured within each level, so
 * that a large step does not hide a smaller one. A series that a straight line
 * in logs, a steady change by the same share each sample, describes more
 * closely than the levels found has none. A step no larger than the spread
 * of a series that moves between two levels at random is part of that
 * spread, and a step inside a large drift can be read as part of the drift.
 */
export function levelChanges(values: number[]): LevelChange[] {
  if (values.some((value) => !(Number.isFinite(value) && value > 0))) {
    throw new RangeError("levelChanges reads only finite values above zero");
  }
  const logs = values.map((value) => Math.log(value));
  let edges = [0, logs.length];
  for (const pass of [1, 2]) {
    const scale = localSpread(logs, pass === 1 ? [0, logs.length] : edges);
    let before;
    do {
      before = edges.length;
      edges = [
        ...edges,
        ...edges.slice(0, -1).flatMap((from, level) =>
          stepCandidates(logs.slice(from, edges[level + 1]), scale)
            .map((index) => from + index)
        ),
      ].sort((a, b) => a - b);
      let dropped;
      do {
        for (let edge = 1; edge < edges.length - 1; edge++) {
          edges[edge] = closestSplit(logs, edges[edge - 1], edges[edge + 1]);
        }
        dropped = false;
        for (let edge = 1; edge < edges.length - 1;) {
          const [from, split, to] = edges.slice(edge - 1, edge + 2);
          const burst = edge + 2 < edges.length && to - split < STEP_WINDOW &&
            !apart(logs, scale, [from, split], [to, edges[edge + 2]]);
          if (
            !apart(logs, scale, [from, split], [split, to]) ||
            (from === 0 && split < STEP_WINDOW)
          ) {
            edges.splice(edge, 1);
            dropped = true;
          } else if (burst) {
            edges.splice(edge, 2);
            dropped = true;
          } else edge++;
        }
      } while (dropped);
    } while (edges.length > before);
  }
  const levels = levelMedians(logs, edges);
  if (
    edges.length === 2 ||
    lineFitsCloser(logs, edges, levels, halfSpanSlope(logs))
  ) return [];
  return edges.slice(1, -1).map((index, level) => ({
    start: edges[level],
    index,
    end: edges[level + 2],
    ratio: Math.exp(levels[level + 1] - levels[level]),
  }));
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
