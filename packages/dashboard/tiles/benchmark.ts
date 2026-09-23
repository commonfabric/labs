/**
 * Trends one scale-invariant index of benchmark performance per processor on
 * main. Each index changes by the geometric mean of the selected benchmark
 * changes between consecutive runs on that processor. The all benchmarks tile
 * selects every product benchmark. The key benchmarks tile selects
 * `topic board/journey` and `topic board scale/100`. Each selected benchmark
 * carries the same weight regardless of size. `deno bench` samples each benchmark
 * to a fixed time budget, so a performance change moves the per-operation times
 * without materially changing the run's wall-clock time.
 *
 * Each processor has its own colored line, and the headline shows the largest
 * established trend among processors measured in the last twelve hours.
 * Orange means at least one of those processors trends up. Green means every
 * eligible established processor stays flat or falls. Red means the most recent
 * run failed, or finished successfully without readable benchmark data.
 * A tile in the failed state reads `failed (was <trend>)` in its headline when
 * cached measurements are available, including measurements older than twelve
 * hours. Without measurements it reads `failed`. It drops its benchmark count
 * and window span and names the failure in their place: how long ago the
 * benchmarks last worked, and how many runs have failed since.
 * A run under way puts a "running" badge in the header.
 *
 * A benchmark added or removed is absent from one side of an adjacent
 * comparison, so it does not move the index. A processor change starts another
 * line instead of connecting unlike machines. A processor model is not a
 * machine, though: the runner group hands a run whatever share of a shared host
 * the other tenants leave it, and hosts under one model have measured a fifth
 * apart on work that touches no repository code. So each step also divides out
 * the machine, read from the calibration benchmarks the same run carries, and a
 * run that landed on a busy host reads as the busy host it was. The index takes
 * one run per BENCH_TREND_BUCKET_MS, matching the benchmarks.yml cadence, so a
 * re-run or a manual dispatch does not put two samples of one moment into the
 * fit. Each line's recent window contains the runs in the last
 * BENCH_TREND_MAX_AGE_DAYS or the newest BENCH_TREND_MIN_RUNS, whichever is
 * larger, and the full line spans about 45 days.
 *
 * A red run is read like any other: `deno bench` exits non-zero when one
 * benchmark throws, having written a complete report of the rest, so a run's
 * color says nothing about whether it measured anything. What decides that is
 * the artifact, which has to parse, name a processor, and carry benchmarks the
 * tile trends. The failed state reads the workflow-run list and the latest
 * run's cached result, so it is unaffected by which runs the trend samples, and
 * it works when artifacts cannot be read. Without usable data, the dashboard
 * keeps the last completed color and values while a fetch runs, and reads
 * "benchmark data unavailable" after an empty fetch. A failed fetch keeps the
 * last-known processor lines gray and names the reason.
 *
 * Every collection pages the run list, once a minute, which is the cadence the
 * run state needs. The artifact history behind the tile moves with the runs
 * instead: a collection whose sampled runs match the last refresh downloads
 * nothing.
 *
 * The /bench drill-down keeps the deeper picture, and closes with a link that
 * hands a rerun to GitHub: this token reads, so GitHub is where a run starts.
 * The benchmarks.yml job runs `deno bench --json` and uploads the output as a
 * `bench-results` artifact with 90-day retention, and there is no committed
 * history. The drill-down lists recent main runs and keeps one artifact per
 * shortest-view time bucket. It unzips each artifact in the process and reads
 * every benchmark's timings and processor identity. Results for a run attempt
 * are immutable and persisted, so later collections fetch only new runs and
 * attempts. The drill-down overlays one colored line per processor for each
 * benchmark. The CI duration and Gantt views also live behind /bench, and this
 * tile's collection keeps their history warm.
 */

import type { Ctx, Route, Status, Tile, TileView } from "../types.ts";
import {
  isCalibrationKey,
  isKeyBenchmark,
  parseBenchmarkReport,
} from "../bench-report.ts";
import {
  BenchmarkHistoryStore,
  type BenchmarkRefreshResult,
  type BenchmarkStats,
  type CachedBenchmarkRun,
} from "../benchmark-history-cache.ts";
import {
  CI_HISTORY_DAYS,
  CI_HISTORY_MIN_DAYS,
  CI_HISTORY_POINT_TARGET,
  ciHistoryBucketMs,
  ciHistoryDays,
  ciHistorySource,
  type CiHistorySourceKey,
  ciJobHistoryCheckResponse,
  ciJobHistoryProgressResponse,
  ciJobHistoryResponse,
} from "../ci-job-history.ts";
import {
  concDot,
  durationTag,
  escapeHtml,
  friendlyError,
  type GitHubDownload,
  github,
  githubDownload,
  humanSpan,
  jsonFromZip,
  multiSparkline,
  type GitHubJson,
  performanceGithub,
  performanceGithubDownload,
  runArtifactId,
} from "../lib.ts";
import {
  BENCH_HEADLINE_MAX_AGE_HOURS,
  BENCH_TREND_BUCKET_MS,
  BENCH_TREND_MAX_AGE_DAYS,
  BENCH_TREND_MIN_RUNS,
  REPO,
} from "../config.ts";
import {
  PERFORMANCE_CHECK_MS,
  PERFORMANCE_HISTORY_SCALE_MIN_VALUES,
  PERFORMANCE_HISTORY_SCALE_TRIM,
  PERFORMANCE_VIEW_STYLES,
  performanceViewHref,
  performanceViewNav,
} from "../performance-views.ts";
import {
  distinctTrendDays,
  trendPct,
  trendPctLabel,
  trendStatus,
} from "../trend.ts";
import { ciGanttPage } from "./ci-duration.ts";
import {
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  dashboardThemeToggle,
  themedChartSeries,
} from "../theme.ts";

export { trendPct, trendStatus } from "../trend.ts";

export function benchmarkTrend(
  times: number[],
  values: number[],
): { pct: number; status: Status; label: string } {
  if (distinctTrendDays(times, values) < 7) {
    return { pct: 0, status: "unknown", label: "new" };
  }
  const pct = trendPct(times, values);
  return { pct, status: trendStatus(pct), label: trendPctLabel(pct) };
}

const WORKFLOW = "benchmarks.yml";
const ARTIFACT = "bench-results";
const SPARK_DAYS = CI_HISTORY_DAYS;
const COLLECTION_BUCKET_MS = ciHistoryBucketMs(CI_HISTORY_MIN_DAYS);
const BENCHMARK_REFRESH_MS = 30 * 60_000;
const BENCHMARK_FETCH_CONCURRENCY = 8;

interface BenchmarkGitHub extends GitHubJson {
  download(path: string, token: string): Promise<GitHubDownload>;
}

const ordinaryBenchmarkGitHub: BenchmarkGitHub = {
  json: github,
  download: githubDownload,
};
const performanceBenchmarkGitHub: BenchmarkGitHub = {
  json: performanceGithub,
  download: performanceGithubDownload,
};

// deno bench reports these seven timings per benchmark (all nanoseconds).
type Stats = BenchmarkStats;
// Shown as a ladder from the fastest sample to the slowest. Each label names
// the timing it plots: six percentiles and the mean.
const STATS: { label: string; field: keyof Stats }[] = [
  { label: "p0", field: "min" },
  { label: "mean", field: "avg" },
  { label: "p75", field: "p75" },
  { label: "p99", field: "p99" },
  { label: "p99.5", field: "p995" },
  { label: "p99.9", field: "p999" },
  { label: "p100", field: "max" },
];
const DEFAULT_LABEL = "p99";

interface Run {
  id: number;
  run_attempt?: number;
  status?: string;
  created_at: string;
  conclusion: string | null;
}

const benchmarkStore = new BenchmarkHistoryStore();
// Assembled by collect() for the /bench drill-down: each benchmark key with its
// processor-specific timings over the covered days (oldest -> newest).
interface BenchmarkCpuSeries {
  cpu: string;
  points: {
    runId: number;
    runAttempt: number;
    at: number;
    stats: Stats;
  }[];
}

interface BenchmarkSeries {
  key: string;
  cpus: BenchmarkCpuSeries[];
}

let snapshot: BenchmarkSeries[] = [];
// The last benchmarks.yml run list a collection paged, which the drill-down reads
// to name the run its rerun hand-off points at. A collection replaces it only on
// a fetch that worked, so the hand-off keeps naming the failed run while a later
// fetch is in flight or has failed. The tile itself reads the list its own
// collection fetched, never this one.
let latestBenchmarkRuns: Run[] | undefined;

export type BenchmarkFetchPhase =
  | "discovering"
  | "fetching"
  | "saving"
  | "complete"
  | "error";

export interface BenchmarkFetchProgress {
  id: string;
  phase: BenchmarkFetchPhase;
  totalRuns: number;
  cachedRuns: number;
  requestsMade: number;
  responsesReceived: number;
  successfulResponses: number;
  failedResponses: number;
  completedRuns: number;
  queuedRuns: number;
  outstandingRequests: number;
  needsReload: boolean;
  updatedAt: number;
  error?: string;
}

interface BenchmarkProgressRecord {
  state: BenchmarkFetchProgress;
  listeners: Set<(progress: BenchmarkFetchProgress) => void>;
  baselines: Set<string>;
}

interface BenchmarkRefresh {
  progress: BenchmarkFetchProgress | null;
  result: Promise<BenchmarkCollectionOutcome>;
}

type BenchmarkRefreshScope = "bench" | "dashboard";

const activeBenchmarkRefreshes = new Map<BenchmarkRefreshScope, {
  progress: BenchmarkProgressRecord;
  result: Promise<BenchmarkCollectionOutcome>;
}>();
let benchmarkCollectionTail: Promise<void> = Promise.resolve();
let benchmarkProgressSequence = 0;
let benchmarkRefreshedAt = 0;
let benchmarkRefreshFailedAt = 0;
let benchmarkRefreshError = "";
const benchmarkProgressById = new Map<string, BenchmarkProgressRecord>();

function benchmarkVersion(value: BenchmarkSeries[]): string {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function benchmarkSnapshotVersion(): string {
  return benchmarkVersion(snapshot);
}

function newBenchmarkProgress(baseline?: string): BenchmarkProgressRecord {
  for (const [id, record] of benchmarkProgressById) {
    if (record.state.phase === "complete" || record.state.phase === "error") {
      benchmarkProgressById.delete(id);
    }
  }
  const now = Date.now();
  const record: BenchmarkProgressRecord = {
    state: {
      id: `runtime-${now.toString(36)}-${++benchmarkProgressSequence}`,
      phase: "discovering",
      totalRuns: 0,
      cachedRuns: 0,
      requestsMade: 0,
      responsesReceived: 0,
      successfulResponses: 0,
      failedResponses: 0,
      completedRuns: 0,
      queuedRuns: 0,
      outstandingRequests: 0,
      needsReload: false,
      updatedAt: now,
    },
    listeners: new Set(),
    baselines: new Set(baseline === undefined ? [] : [baseline]),
  };
  benchmarkProgressById.set(record.state.id, record);
  return record;
}

function updateBenchmarkProgress(
  record: BenchmarkProgressRecord,
  update: Partial<BenchmarkFetchProgress>,
): void {
  Object.assign(record.state, update);
  record.state.completedRuns = Math.min(
    record.state.totalRuns,
    record.state.cachedRuns + record.state.responsesReceived,
  );
  record.state.queuedRuns = Math.max(
    0,
    record.state.totalRuns - record.state.cachedRuns -
      record.state.requestsMade,
  );
  record.state.outstandingRequests = Math.max(
    0,
    record.state.requestsMade - record.state.responsesReceived,
  );
  record.state.updatedAt = Date.now();
  const value = { ...record.state };
  for (const listener of record.listeners) {
    try {
      listener(value);
    } catch {
      record.listeners.delete(listener);
    }
  }
}

function benchmarkProgress(id: string): BenchmarkFetchProgress | null {
  const record = benchmarkProgressById.get(id);
  return record ? { ...record.state } : null;
}

export function subscribeBenchmarkProgress(
  id: string,
  listener: (progress: BenchmarkFetchProgress) => void,
): (() => void) | null {
  const record = benchmarkProgressById.get(id);
  if (!record) return null;
  record.listeners.add(listener);
  try {
    listener({ ...record.state });
  } catch {
    record.listeners.delete(listener);
    return null;
  }
  return () => record.listeners.delete(listener);
}

// How many of a run's product benchmarks match the selection. Zero means the
// run measured nothing the tile trends, whatever else its artifact holds.
const productMetricCount = (
  run: { metrics: Map<string, Stats> },
  select: (key: string) => boolean = () => true,
): number => {
  let count = 0;
  for (const key of run.metrics.keys()) {
    if (!isCalibrationKey(key) && select(key)) count++;
  }
  return count;
};

const UNKNOWN_CPU = "Unknown CPU";

// Wall-clock span of a series (first to last point), in milliseconds.
const spanMs = (points: { at: number }[]): number =>
  points.length < 2 ? 0 : points[points.length - 1].at - points[0].at;

// Nanoseconds to a short human string.
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return "—";
  if (ns < 1e3) return `${Math.round(ns)}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(ns < 1e4 ? 1 : 0)}µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 1e7 ? 1 : 0)}ms`;
  return `${(ns / 1e9).toFixed(2)}s`;
}

async function fetchZip(
  artifactId: number,
  token: string,
  github: BenchmarkGitHub,
): Promise<Uint8Array<ArrayBuffer>> {
  // GitHub 302s to a pre-signed blob URL; fetch follows it and drops the
  // Authorization header on the cross-origin hop, which the signed URL expects.
  const res = await github.download(
    `repos/${REPO}/actions/artifacts/${artifactId}/zip`,
    token,
  );
  if (!res.ok) throw new Error(`artifact ${artifactId}: HTTP ${res.status}`);
  return res.body;
}

// The benchmarks.yml runs on main, newest first, paging back until past the
// window (or the 12-page ceiling). The workflow runs to a four-hourly schedule
// and on manual dispatch. Both kinds of run land on main, and the list is
// filtered by branch alone, so it holds either.
async function pageBenchmarkRuns(
  github: BenchmarkGitHub,
  token: string,
  cutoff: number,
): Promise<Run[]> {
  const runs: Run[] = [];
  for (let page = 1; page <= 12; page++) {
    const response = await github.json<{ workflow_runs?: Run[] }>(
      `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=100&page=${page}`,
      token,
    );
    const batch = response.workflow_runs ?? [];
    if (!batch.length) break;
    runs.push(...batch);
    if (
      batch.length < 100 ||
      Date.parse(batch[batch.length - 1].created_at) < cutoff
    ) break;
  }
  return runs;
}

// Populate and persist one run. A response that establishes there is no usable
// artifact is cached as an empty map. A failed read remains unknown.
async function loadRun(
  run: Run,
  token: string,
  github: BenchmarkGitHub,
): Promise<{ cached: boolean; error?: unknown }> {
  let cpu = UNKNOWN_CPU;
  let metrics = new Map<string, Stats>();
  let zip: Uint8Array<ArrayBuffer> | undefined;
  try {
    const artifactId = await runArtifactId({
      github,
      runId: run.id,
      name: ARTIFACT,
      token,
    });
    if (artifactId !== undefined) {
      zip = await fetchZip(artifactId, token, github);
    }
  } catch (error) {
    // The read failed, so whether this run has usable results is still unknown.
    // Caching the empty map here would answer that question with "no" and never ask
    // again: the run is only ever fetched once, so a single blip would drop the run
    // from the trend for the life of the process. Record nothing and retry on the
    // next refresh.
    return { cached: false, error };
  }
  if (zip !== undefined) {
    try {
      const json = await jsonFromZip(zip);
      const report = json === null ? undefined : parseBenchmarkReport(json);
      if (report?.cpu !== undefined) {
        cpu = report.cpu;
        metrics = report.metrics;
      }
    } catch {
      // Reading bytes already in hand is deterministic, and a run attempt's
      // artifact never changes, so an artifact that will not parse now will not
      // parse later either. That is the same answer as a run with no artifact
      // at all, and it is recorded the same way: an empty map, which reads as
      // no benchmark data. Reporting it instead would gray the whole tile on
      // one bad artifact and hold back the refresh marker for as long as that
      // artifact stayed in the window.
    }
  }
  benchmarkStore.set({
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    at: Date.parse(run.created_at),
    cpu,
    metrics,
  });
  await benchmarkStore.save();
  return { cached: true };
}

function currentBenchmarkRun(run: Run): CachedBenchmarkRun | undefined {
  const cached = benchmarkStore.get(run.id);
  return cached && cached.runAttempt >= (run.run_attempt ?? 1)
    ? cached
    : undefined;
}

function currentRunMetrics(run: Run): Map<string, Stats> | undefined {
  const cached = currentBenchmarkRun(run);
  return cached?.cpu === undefined ? undefined : cached.metrics;
}

function assembleBenchmarkSeries(
  runs: CachedBenchmarkRun[],
): BenchmarkSeries[] {
  const byKey = new Map<
    string,
    Map<
      string,
      {
        runId: number;
        runAttempt: number;
        at: number;
        stats: Stats;
      }[]
    >
  >();
  for (const run of [...runs].sort((a, b) => a.at - b.at)) {
    if (run.cpu === undefined) continue;
    for (const [key, stats] of run.metrics) {
      if (isCalibrationKey(key)) continue;
      let byCpu = byKey.get(key);
      if (!byCpu) {
        byCpu = new Map();
        byKey.set(key, byCpu);
      }
      let points = byCpu.get(run.cpu);
      if (!points) {
        points = [];
        byCpu.set(run.cpu, points);
      }
      points.push({
        runId: run.runId,
        runAttempt: run.runAttempt,
        at: run.at,
        stats,
      });
    }
  }
  return [...byKey]
    .map(([key, byCpu]) => ({
      key,
      cpus: [...byCpu]
        .map(([cpu, points]) => ({ cpu, points }))
        .filter((series) => series.points.length > 0)
        .sort((a, b) => a.cpu.localeCompare(b.cpu)),
    }))
    .filter((series) => series.cpus.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function assembleBenchmarkSnapshot(runs: Run[]): BenchmarkSeries[] {
  return assembleBenchmarkSeries(
    runs.flatMap((run) => {
      const cached = currentBenchmarkRun(run);
      return cached?.cpu !== undefined && productMetricCount(cached) > 0
        ? [cached]
        : [];
    }),
  );
}

function assembleCachedBenchmarkSnapshot(
  runs: CachedBenchmarkRun[],
): BenchmarkSeries[] {
  return assembleBenchmarkSeries(runs);
}

async function loadCachedBenchmarkSnapshot(now = Date.now()): Promise<void> {
  await benchmarkStore.load();
  if (benchmarkStore.quarantineFuture(now)) {
    await benchmarkStore.save(now);
  }
  const cutoff = now - SPARK_DAYS * 86_400_000;
  const refreshedRuns = benchmarkStore.refreshedRuns();
  const cachedRuns = refreshedRuns ?? benchmarkStore.list(cutoff);
  if (cachedRuns.some((run) => run.cpu === undefined)) {
    benchmarkStore.invalidateRefresh(now);
    await benchmarkStore.save(now);
  }
  benchmarkRefreshedAt = benchmarkStore.refreshedAt;
  if (refreshedRuns === null) {
    const available = cachedRuns.map((run) => ({
      id: run.runId,
      run_attempt: run.runAttempt,
      created_at: new Date(run.at).toISOString(),
      conclusion: "success",
    }));
    snapshot = assembleBenchmarkSnapshot(
      sampleBenchmarkRuns(available, cutoff),
    );
  } else {
    snapshot = assembleCachedBenchmarkSnapshot(refreshedRuns);
  }
}

async function markBenchmarkRefreshed(
  runs: Run[],
  result: BenchmarkRefreshResult,
): Promise<void> {
  const cachedRuns = runs.map((run) => benchmarkStore.get(run.id)!);
  const previous = benchmarkStore.markRefreshed(
    Date.now(),
    cachedRuns,
    result,
  );
  await benchmarkStore.save().catch((error) => {
    benchmarkStore.restoreRefresh(previous);
    throw error;
  });
  const refreshedRuns = benchmarkStore.refreshedRuns();
  if (refreshedRuns !== null) {
    snapshot = assembleCachedBenchmarkSnapshot(refreshedRuns);
  }
  benchmarkRefreshedAt = benchmarkStore.refreshedAt;
}

// Every completed run in the window, thinned to one per collection bucket. A
// run's color does not decide whether it measured anything: `deno bench` exits
// non-zero when any one benchmark throws, having already written a complete
// report of the rest, and the workflow uploads that report either way. Over one
// recent 45-day stretch, 26 of the 30 red runs carried an artifact
// indistinguishable from a green run's, and they arrived in blocks of a dozen
// or more consecutive runs — so the runs the tile lost were concentrated
// exactly where a thinned line does the most damage. What makes a run usable is
// the artifact, and every reader below already checks that: a report has to
// parse, name a processor, and carry benchmarks the tile trends. The tile's red
// state is unaffected, because it reads the run list rather than this sample.
export function sampleBenchmarkRuns<
  T extends { created_at: string; conclusion: string | null },
>(runs: T[], cutoff: number): T[] {
  const perBucket = new Map<number, T>();
  for (const run of runs) {
    const at = Date.parse(run.created_at);
    if (run.conclusion === null || at < cutoff) continue;
    const bucket = Math.floor(at / COLLECTION_BUCKET_MS);
    const current = perBucket.get(bucket);
    if (!current || at > Date.parse(current.created_at)) {
      perBucket.set(bucket, run);
    }
  }
  return [...perBucket.values()].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at)
  );
}

const benchmarkDrill = {
  href: "/bench?view=runtime&repo=labs",
  hint: "metrics ↗",
};

function benchmarkUnavailable(sub: string, aside?: string): TileView {
  return {
    ...benchmarkDrill,
    aside,
    status: "unknown",
    value: "—",
    sub,
  };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// The geometric mean of the per-benchmark ratios between two runs on the same
// processor, over the benchmarks they share that match `select` (each with a
// positive 75th percentile). Geometric, not arithmetic, so a benchmark that
// doubles and one that halves cancel to no change. A benchmark in only one of
// the two runs is not in the ratio, so adding or removing one is not a change.
// `undefined` when the runs share no selected positive measurements.
//
// The ratio compares the 75th percentile of each benchmark rather than its
// average. `deno bench` measures each benchmark for a fixed wall-clock budget,
// so one stalled sample raises the reported average by the stall divided by
// that budget, whatever the sample count. A stall of a fifth of a second
// against a budget of half a second is a quarter added to the average, which is
// the size of the moves the trend is meant to detect. The runners stall that
// long often enough that reading the average reports steps no commit caused.
//
// The 75th percentile is far enough up the distribution to move when a change
// makes some but not all of an operation's runs slower, and far enough down
// that a handful of stalled samples cannot reach it. The fastest sample
// survives a stall equally well but is the floor of the distribution, so it is
// blind to a change that leaves the floor alone and widens everything above it
// — a slow path taken only sometimes moves nothing it can see.
//
// Both the product ratio and the calibration ratio read this one statistic, and
// have to: an index step divides the second out of the first, and two different
// statistics would not cancel.
//
// A change confined above the 75th percentile is still invisible here, and on
// user-facing timings that tail is what a person actually notices. Reading it
// from these runs would need the stalls told apart from the tail the code
// produces, which the current sample counts do not allow: on the busiest
// processor, `p99` puts 11% of neighboring run pairs more than a quarter
// apart with no change behind them, against 2% for the 75th percentile. The
// drill-down plots the whole ladder from `min` to `max` in the meantime.
function sharedBenchmarkRatio(
  previous: CachedBenchmarkRun,
  current: CachedBenchmarkRun,
  select: (key: string) => boolean,
): number | undefined {
  let logSum = 0, count = 0;
  for (const [key, stats] of current.metrics) {
    if (!select(key)) continue;
    const before = previous.metrics.get(key);
    if (before && before.p75 > 0 && stats.p75 > 0) {
      logSum += Math.log(stats.p75 / before.p75);
      count++;
    }
  }
  return count ? Math.exp(logSum / count) : undefined;
}

/**
 * Returns the selected benchmarks' change after machine calibration. A pair
 * without shared positive product measurements leaves the index unchanged.
 * A pair without shared calibration measurements reads uncorrected.
 */
function benchmarkStepRatio(
  previous: CachedBenchmarkRun,
  current: CachedBenchmarkRun,
  select: (key: string) => boolean,
): number {
  const product = sharedBenchmarkRatio(
    previous,
    current,
    (key) => !isCalibrationKey(key) && select(key),
  );
  if (product === undefined) return 1;
  const machine = sharedBenchmarkRatio(previous, current, isCalibrationKey) ?? 1;
  return product / machine;
}

const CPU_COLORS = [
  "#6ea8fe",
  "#d97757",
  "#10a37f",
  "#b58cf6",
  "#e0a852",
  "#56b6c2",
  "#e06c9f",
  "#9fb36b",
  "#ff9da7",
  "#8cd17d",
  "#b6992d",
  "#499894",
  "#d37295",
  "#fabfd2",
  "#b07aa1",
  "#86bcb6",
];
const CPU_LINE_MAX_X_GAP = 0.2;

function cpuHash(cpu: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < cpu.length; index++) {
    hash ^= cpu.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function generatedCpuColor(hash: number): string {
  const red = 112 + (hash & 0x7f);
  const green = 112 + ((hash >>> 7) & 0x7f);
  const blue = 112 + ((hash >>> 14) & 0x7f);
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(
    6,
    "0",
  )}`;
}

export function availableGeneratedCpuColor(
  hash: number,
  usedColors: Set<string>,
  generateColor: (hash: number) => string = generatedCpuColor,
): string {
  // The color uses the low 21 hash bits. Adding an odd number visits every
  // possible low-bit value before repeating.
  for (let salt = 0; salt <= usedColors.size; salt++) {
    const mixed = (hash + Math.imul(salt, 0x9e3779b9)) >>> 0;
    const candidate = generateColor(mixed);
    if (!usedColors.has(candidate)) return candidate;
  }
  throw new Error("Could not assign a distinct CPU color.");
}

function cpuColors(cpus: Iterable<string>): Map<string, string> {
  const colors = new Map<string, string>();
  const usedPaletteIndexes = new Set<number>();
  const usedColors = new Set<string>();
  const sorted = [...new Set(cpus)].sort((a, b) => a.localeCompare(b));
  for (const [ordinal, cpu] of sorted.entries()) {
    const hash = cpuHash(cpu);
    let color: string;
    if (ordinal < CPU_COLORS.length) {
      const start = hash % CPU_COLORS.length;
      let index = start;
      for (let offset = 0; offset < CPU_COLORS.length; offset++) {
        const candidate = (start + offset) % CPU_COLORS.length;
        if (!usedPaletteIndexes.has(candidate)) {
          index = candidate;
          break;
        }
      }
      usedPaletteIndexes.add(index);
      color = CPU_COLORS[index];
    } else {
      color = availableGeneratedCpuColor(hash, usedColors);
    }
    usedColors.add(color);
    colors.set(cpu, color);
  }
  return colors;
}

interface BenchmarkCpuIndex {
  cpu: string;
  color: string;
  points: { at: number; index: number }[];
  windowCount: number;
  windowPoints: { at: number; index: number }[];
  trend: ReturnType<typeof benchmarkTrend>;
}

export function benchmarkHeadlineCandidates<
  T extends { points: { at: number }[] },
>(indices: T[], now: number): T[] {
  const cutoff = now - BENCH_HEADLINE_MAX_AGE_HOURS * 60 * 60_000;
  return indices.filter((series) =>
    series.points.some((point) => point.at >= cutoff && point.at <= now)
  );
}

type CpuBenchmarkRun = CachedBenchmarkRun & { cpu: string };

// One run per trend bucket on one processor, newest kept, oldest first. The
// collection keeps far finer resolution than this, because the drill-down's
// shortest view needs it, and the trend does not: the benchmarks run four-
// hourly, so runs closer together than that are a re-run, a manual dispatch or
// a schedule catching up. Counted as separate samples they let one stretch of
// wall clock supply the whole of a level, and a level the headline is read off
// rests on as few as three samples.
export function benchmarkTrendRuns<T extends { at: number }>(runs: T[]): T[] {
  const perBucket = new Map<number, T>();
  for (const run of runs) {
    const bucket = Math.floor(run.at / BENCH_TREND_BUCKET_MS);
    const current = perBucket.get(bucket);
    if (!current || run.at > current.at) perBucket.set(bucket, run);
  }
  return [...perBucket.values()].sort((a, b) => a.at - b.at);
}

function benchmarkCpuIndices(
  cached: CpuBenchmarkRun[],
  now: number,
  select: (key: string) => boolean,
): BenchmarkCpuIndex[] {
  const byCpu = new Map<string, CachedBenchmarkRun[]>();
  for (const run of cached) {
    const runs = byCpu.get(run.cpu);
    if (runs) runs.push(run);
    else byCpu.set(run.cpu, [run]);
  }
  const windowCutoff = now - BENCH_TREND_MAX_AGE_DAYS * 86_400_000;
  const colors = cpuColors(byCpu.keys());
  return [...byCpu]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cpu, sampled]) => {
      const runs = benchmarkTrendRuns(sampled);
      const points: { at: number; index: number }[] = [];
      let index = 1;
      for (let run = 0; run < runs.length; run++) {
        if (run > 0) {
          index *= benchmarkStepRatio(runs[run - 1], runs[run], select);
        }
        points.push({ at: runs[run].at, index });
      }
      const inWindow = points.filter((point) =>
        point.at >= windowCutoff
      ).length;
      const windowCount = Math.min(
        points.length,
        Math.max(inWindow, BENCH_TREND_MIN_RUNS),
      );
      const windowPoints = points.slice(points.length - windowCount);
      return {
        cpu,
        color: colors.get(cpu)!,
        points,
        windowCount,
        windowPoints,
        trend: benchmarkTrend(
          windowPoints.map((point) => point.at),
          windowPoints.map((point) => point.index),
        ),
      };
    });
}

const runIsCompleted = (run: Run): boolean =>
  run.status === "completed" && run.conclusion !== null;

// Only a genuine failure counts (concDot's red set), so a cancelled or
// superseded run is not read as one.
const runFailed = (run: Run): boolean =>
  concDot(run.conclusion, run.run_attempt ?? 1) === "red";

// The newest completed run, reading the newest-first run list. A run still in
// flight is passed over until it finishes.
const latestCompletedRun = (runs: Run[]): Run | undefined =>
  runs.find(runIsCompleted);

// How many of the most recent runs failed in a row, reading the newest-first run
// list. Counting stops at the first completed run that did not fail. A run still
// in flight is passed over. The count covers the runs this collection fetched,
// so a streak reaching past the window reads as the length of the window.
function failedRunStreak(runs: Run[]): number {
  let streak = 0;
  for (const run of runs) {
    if (!runIsCompleted(run)) continue;
    if (!runFailed(run)) break;
    streak++;
  }
  return streak;
}

// The newest run that passed. A run that passed on a later attempt counts: it
// ran and it worked.
const lastSuccessfulRun = (runs: Run[]): Run | undefined =>
  runs.find((run) => run.conclusion === "success");

// The failed tile's line: how long ago the benchmarks last worked, and how many
// runs have failed since. The age comes first because it is the size of the
// outage. Without a passing run to date the outage from — every run in the
// window failed — the line is the count alone.
export function benchmarkFailureLabel(runs: Run[], now: number): string {
  const streak = failedRunStreak(runs);
  const failures = `${streak} run${streak === 1 ? "" : "s"} failed`;
  const good = lastSuccessfulRun(runs);
  if (good === undefined) {
    return streak > 1 ? `last ${streak} runs failed` : "last run failed";
  }
  return `last good ${
    humanSpan(now - Date.parse(good.created_at))
  } ago · ${failures}`;
}

export interface BenchmarkRerunHandoff {
  href: string;
  label: string;
  hint: string;
}

// Where the drill-down's rerun control sends the viewer. The dashboard reads
// GitHub with a read-only token, so starting a run is GitHub's own job: the
// control is a link, and GitHub decides whether the viewer may press the button
// it lands on. A failed newest run points at that run, whose "Re-run all jobs"
// repeats it. Anything else points at the workflow, whose "Run workflow" starts
// a fresh run. Without a run list the workflow is the target, which is one click
// from the newest run either way.
export function benchmarkRerunHandoff(
  runs: Run[] | undefined,
): BenchmarkRerunHandoff {
  const latest = latestCompletedRun(runs ?? []);
  return latest !== undefined && runFailed(latest)
    ? {
      href: `https://github.com/${REPO}/actions/runs/${latest.id}`,
      label: "rerun the failed benchmark run ↗",
      hint: "Select \"Re-run all jobs\" on GitHub to repeat the run.",
    }
    : {
      href: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`,
      label: "run benchmarks now ↗",
      hint: "Run workflow on GitHub starts a fresh run.",
    };
}

// A run that has not finished, anywhere in the list. A rerun of an older run
// keeps that run's place in the list rather than moving to the head, so this
// looks past the newest entries.
const runInFlight = (runs: Run[]): boolean =>
  runs.some((run) => run.status !== "completed");

const RUNNING_BADGE =
  `<span class="running"><span class="rdot"></span>running</span>`;

// The grid tile trends a scale-invariant benchmark index over about 45 days.
// Each processor has its own index and line. Every index starts at one and
// changes only between runs on that processor. Hardware changes therefore
// never become benchmark changes. The headline shows the largest established
// trend among processors measured in the last twelve hours. Orange means any
// eligible processor trends up. Red means the most recent run failed or
// produced no readable data. Its headline reads `failed (was <trend>)` when a
// cached trend is available, and `failed` otherwise. The line below dates the
// outage instead of counting the benchmarks measured. `offline` names a fetch
// failure and takes that line the same way, so an unreadable collection costs
// the count rather than adding a line to it. The tile then keeps its
// last-known trends gray, or shows a gray dash when no history is cached.
function benchmarkIndexView(
  runs: Run[],
  now: number,
  select: (key: string) => boolean,
  offline?: string,
): TileView {
  const cutoff = now - SPARK_DAYS * 86_400_000;
  // The most recent completed run sets the failed state.
  const latestCompleted = latestCompletedRun(runs);
  const failedCi = latestCompleted !== undefined && runFailed(latestCompleted);
  // A run under way is a header badge, and leaves the verdict to the runs that
  // have finished. The badge is what says the tile's color may be about to move.
  const aside = runInFlight(runs) ? RUNNING_BADGE : undefined;
  // A run that finished green on CI but whose artifact resolved to no readable
  // benchmark data is as good as failed: it ran and produced nothing usable. Only
  // a cached run with an empty result counts — a run still unread (or read-failed)
  // stays unknown and is retried, so a transient blip does not flash red.
  const latestResult = latestCompleted?.conclusion === "success"
    ? benchmarkStore.get(latestCompleted.id)
    : undefined;
  const noData = latestResult !== undefined &&
    productMetricCount(latestResult, select) === 0;
  const failed = failedCi || noData;
  const failSub = failedCi
    ? benchmarkFailureLabel(runs, now)
    : "no benchmark data";
  // The runs with processor identities and readable artifacts in the window,
  // oldest -> newest. The artifact decides, not the run's color.
  const cached = (benchmarkStore.refreshedRuns() ?? benchmarkStore.list(cutoff))
    .filter((run): run is CpuBenchmarkRun =>
      run.at >= cutoff && run.cpu !== undefined &&
      productMetricCount(run, select) > 0
    )
    .sort((a, b) => a.at - b.at);
  // A failed headline uses the latest measurements to date its trend window
  // and determine which processors are eligible.
  const trendAt = failed && !offline ? cached.at(-1)?.at ?? now : now;
  const indices = benchmarkCpuIndices(cached, trendAt, select);
  if (!indices.length) {
    // A fetch failure with nothing cached to stand on: a gray dash and the reason.
    if (offline) return benchmarkUnavailable(offline, aside);
    if (failed) {
      return {
        ...benchmarkDrill,
        status: "bad",
        value: "failed",
        sub: failSub,
        aside,
      };
    }
    // A completed fetch with runs but no readable artifacts reports the missing
    // data. A completed fetch with no runs reports the missing run history.
    return benchmarkUnavailable(
      runs.length ? "benchmark data unavailable" : "no benchmark runs",
      aside,
    );
  }
  const headlineCandidates = benchmarkHeadlineCandidates(indices, trendAt);
  if (!headlineCandidates.length && !offline && !failed) {
    return benchmarkUnavailable("no recent benchmark data", aside);
  }
  const displayCandidates = headlineCandidates.length
    ? headlineCandidates
    : indices;
  const established = displayCandidates.filter((series) =>
    series.trend.label !== "new"
  );
  const headlinePool = established.length ? established : displayCandidates;
  const headline = headlinePool.reduce((
    worst,
    series,
  ) => series.trend.pct > worst.trend.pct ? series : worst);
  const rising = headlineCandidates.some((series) =>
    series.trend.status === "warn" || series.trend.status === "bad"
  );
  // An offline collection keeps the trend but grays it: the run list it would need
  // to judge failed or rising could not be fetched, so it never asserts red or green.
  const status: Status = offline
    ? "unknown"
    : failed
    ? "bad"
    : rising
    ? "warn"
    : "good";
  const trendLabel = escapeHtml(headline.trend.label);
  const value = status === "bad"
    ? `failed <span style="font-size:14px">(was ${trendLabel})</span>`
    : trendLabel;
  const latest = cached[cached.length - 1];
  const count = productMetricCount(latest, select);
  // Name the highlighted window's span beside the count, like CI duration names its
  // median window — in days (via humanSpan), not "runs", so it does not read as the
  // main-CI run count. Only when a window is actually highlighted; otherwise the
  // whole sparkline is the window and its span already sits in the corner.
  const windowLabel = headline.windowCount < headline.points.length
    ? ` · last ${humanSpan(spanMs(headline.windowPoints))}`
    : "";
  // One line sits under the headline. A tile with something to say about why it
  // cannot measure says that there, in place of the count, rather than beside
  // it: a second line would grow the tile past the ones it shares a row with.
  const sub = offline ?? (failed ? failSub : undefined);
  const countLine = sub !== undefined
    ? ""
    : `<div style="font-size:13px;color:var(--text-muted);margin:5px 0 0">${count} benchmark${
      count === 1 ? "" : "s"
    }${windowLabel}</div>`;
  const allPoints = indices.flatMap((series) => series.points);
  const chartStart = Math.min(...allPoints.map((point) => point.at));
  const chartEnd = Math.max(...allPoints.map((point) => point.at));
  const chartSpan = chartEnd - chartStart;
  const chartAxis = chartSpan || 1;
  const chart = multiSparkline(
    indices.map((series) => ({
      vals: series.points.map((point) => point.index),
      ...themedChartSeries(series.color),
      xs: series.points.map((point) => (point.at - chartStart) / chartAxis),
      highlightCount: series.windowCount,
      maxXGap: CPU_LINE_MAX_X_GAP,
      showSinglePoint: true,
    })),
    { fade: true },
  );
  return {
    ...benchmarkDrill,
    status,
    value,
    valueLabel: status === "bad"
      ? `failed (was ${headline.trend.label})`
      : undefined,
    sub,
    extra: `${countLine}${chart}`,
    duration: chartSpan,
    aside,
  };
}

interface BenchmarkCollectionOutcome {
  error?: unknown;
}

async function collectBenchmark(
  token: string,
  progress: BenchmarkProgressRecord,
  github: BenchmarkGitHub,
  // The run list the caller has already paged, when it has one. The tile pages it
  // for its own headline moments earlier, and one list serves both.
  knownRuns?: Run[],
): Promise<BenchmarkCollectionOutcome> {
  const now = Date.now();
  const cutoff = now - SPARK_DAYS * 86_400_000;

  try {
    await benchmarkStore.load();
    const runs = knownRuns ?? await pageBenchmarkRuns(github, token, cutoff);
    latestBenchmarkRuns = runs;

    const chosen = sampleBenchmarkRuns(runs, cutoff);
    const priorRefresh = benchmarkStore.refresh;
    const chosenReferences = chosen.map((run) => ({
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
    }));
    if (
      priorRefresh &&
      JSON.stringify(priorRefresh.runs) !== JSON.stringify(chosenReferences)
    ) {
      benchmarkStore.invalidateRefresh(now);
      await benchmarkStore.save(now);
      benchmarkRefreshedAt = benchmarkStore.refreshedAt;
    }
    const isCached = (run: Run) => currentRunMetrics(run) !== undefined;
    const cachedRuns = chosen.filter(isCached);
    const missing = chosen.filter((run) => !isCached(run));
    updateBenchmarkProgress(progress, {
      phase: "fetching",
      totalRuns: chosen.length,
      cachedRuns: cachedRuns.length,
      needsReload: missing.length > 0,
    });
    if (!chosen.length) {
      snapshot = [];
      await markBenchmarkRefreshed([], "no-runs");
      return {};
    }

    let firstReadError: unknown;
    for (
      let index = 0;
      index < missing.length;
      index += BENCHMARK_FETCH_CONCURRENCY
    ) {
      const batch = missing.slice(index, index + BENCHMARK_FETCH_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (run) => {
        updateBenchmarkProgress(progress, {
          requestsMade: progress.state.requestsMade + 1,
        });
        let cached = false;
        try {
          const outcome = await loadRun(run, token, github);
          cached = outcome.cached;
          return outcome.error === undefined
            ? null
            : { readError: outcome.error };
        } catch (error) {
          return { persistenceError: error };
        } finally {
          updateBenchmarkProgress(progress, {
            responsesReceived: progress.state.responsesReceived + 1,
            successfulResponses: progress.state.successfulResponses +
              (cached ? 1 : 0),
            failedResponses: progress.state.failedResponses +
              (cached ? 0 : 1),
          });
        }
      }));
      const persistenceFailure = outcomes.find((outcome) =>
        outcome && "persistenceError" in outcome
      );
      if (persistenceFailure && "persistenceError" in persistenceFailure) {
        throw persistenceFailure.persistenceError;
      }
      const readFailure = outcomes.find((outcome) =>
        outcome && "readError" in outcome
      );
      if (
        firstReadError === undefined && readFailure &&
        "readError" in readFailure
      ) firstReadError = readFailure.readError;
    }

    updateBenchmarkProgress(progress, { phase: "saving" });
    await benchmarkStore.save(now);
    const withData = chosen.filter((run) =>
      (currentRunMetrics(run)?.size ?? 0) > 0
    );
    if (!withData.length) {
      if (firstReadError === undefined) snapshot = [];
      if (firstReadError === undefined) {
        await markBenchmarkRefreshed(chosen, "data-unavailable");
      }
      return { error: firstReadError };
    }
    const collectedSnapshot = assembleBenchmarkSnapshot(withData);
    if (collectedSnapshot.length || firstReadError === undefined) {
      snapshot = collectedSnapshot;
    }
    if (firstReadError === undefined) {
      await markBenchmarkRefreshed(
        chosen,
        collectedSnapshot.length ? "data" : "no-metric",
      );
    }
    return { error: firstReadError };
  } catch (error) {
    return { error };
  }
}

function startBenchmarkRefresh(
  ctx: Ctx,
  baseline?: string,
  snapshotIsFresh = false,
  scope: BenchmarkRefreshScope = "bench",
  // The caller's own run list, still in flight. Passing it registers this refresh
  // before the list arrives, so a drill-down request landing meanwhile queues
  // behind this collection instead of starting a second one. The refresh then
  // decides whether there is anything to fetch once the list is in.
  knownRuns?: Promise<Run[] | undefined>,
): BenchmarkRefresh {
  const github = scope === "bench"
    ? performanceBenchmarkGitHub
    : ordinaryBenchmarkGitHub;
  const token = (ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN"))!;
  const activeBenchmarkRefresh = activeBenchmarkRefreshes.get(scope);
  if (activeBenchmarkRefresh) {
    if (baseline !== undefined) {
      activeBenchmarkRefresh.progress.baselines.add(baseline);
    }
    return {
      progress: { ...activeBenchmarkRefresh.progress.state },
      result: activeBenchmarkRefresh.result,
    };
  }
  if (snapshotIsFresh) {
    return { progress: null, result: Promise.resolve({}) };
  }

  const progress = newBenchmarkProgress(baseline);
  const queuedBehindOtherScope = activeBenchmarkRefreshes.size > 0;
  const previousCollection = benchmarkCollectionTail;
  let finishCollection!: () => void;
  benchmarkCollectionTail = new Promise<void>((resolve) => {
    finishCollection = resolve;
  });
  const collection = async (): Promise<BenchmarkCollectionOutcome> => {
    await previousCollection;
    let known: Run[] | undefined;
    if (knownRuns) {
      known = await knownRuns;
      // The caller's list is the only one this refresh reads. Its failure is the
      // caller's to report, and there is nothing here to refresh against.
      if (!known) return {};
      // Nothing new has been sampled since the last refresh, and that refresh is
      // recent, so the artifact history already covers this list.
      if (
        benchmarkSnapshotIsFresh() && benchmarkRefreshCovers(known, Date.now())
      ) {
        return {};
      }
    } else if (queuedBehindOtherScope && benchmarkSnapshotIsFresh()) {
      // A queued refresh with no run list reuses the fresh shared artifact
      // history.
      return {};
    }
    return await collectBenchmark(token, progress, github, known);
  };
  let refreshFinished = false;
  const finishRefresh = () => {
    if (refreshFinished) return;
    refreshFinished = true;
    finishCollection();
    if (activeBenchmarkRefreshes.get(scope)?.progress === progress) {
      activeBenchmarkRefreshes.delete(scope);
    }
  };
  const result = collection().then((outcome) => {
    finishRefresh();
    if (outcome.error) {
      const message = outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
      if (scope === "bench") {
        benchmarkRefreshFailedAt = Date.now();
        benchmarkRefreshError = friendlyError(message);
      }
      const version = benchmarkSnapshotVersion();
      updateBenchmarkProgress(progress, {
        phase: "error",
        error: friendlyError(message),
        needsReload: [...progress.baselines].some((value) => value !== version),
      });
    } else {
      if (scope === "bench") {
        benchmarkRefreshFailedAt = 0;
        benchmarkRefreshError = "";
      }
      benchmarkRefreshedAt = benchmarkStore.refreshedAt;
      const version = benchmarkSnapshotVersion();
      updateBenchmarkProgress(progress, {
        phase: "complete",
        needsReload: [...progress.baselines].some((value) => value !== version),
      });
    }
    return outcome;
  }).finally(finishRefresh);
  activeBenchmarkRefreshes.set(scope, { progress, result });
  return { progress: { ...progress.state }, result };
}

// Whether the drill-down's last refresh already covers the runs this list names.
// The refresh records which runs it sampled, and only a successful run in a new
// time bucket changes that set, so an unchanged set means there is no artifact to
// fetch and no reason to redo the work.
function benchmarkRefreshCovers(runs: Run[], now: number): boolean {
  const refresh = benchmarkStore.refresh;
  if (!refresh) return false;
  const chosen = sampleBenchmarkRuns(runs, now - SPARK_DAYS * 86_400_000).map((
    run,
  ) => ({ runId: run.id, runAttempt: run.run_attempt ?? 1 }));
  return JSON.stringify(refresh.runs) === JSON.stringify(chosen);
}

function benchmarkSnapshotIsFresh(now = Date.now()): boolean {
  const age = now - benchmarkRefreshedAt;
  return Boolean(
    benchmarkRefreshedAt && age >= 0 && age < BENCHMARK_REFRESH_MS,
  );
}

function benchmarkRefreshRecentlyFailed(now = Date.now()): boolean {
  const age = now - benchmarkRefreshFailedAt;
  return Boolean(
    benchmarkRefreshFailedAt && !activeBenchmarkRefreshes.has("bench") &&
      age >= 0 && age < BENCHMARK_REFRESH_MS,
  );
}

function benchmarkLastRequestError(): string | null {
  return benchmarkRefreshFailedAt
    ? benchmarkRefreshError || "temporarily unavailable"
    : null;
}

function benchmarkServerContext(): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => Deno.env.get(key),
  };
}

/** Active collections shared by tiles using the same credentials. */
const benchmarkTileCollections = new Map<
  string,
  ReturnType<typeof collectBenchmarkTileRuns>
>();

/** Collects the workflow list together with its completed artifact refresh. */
async function collectBenchmarkTileRuns(
  ctx: Ctx,
  token: string,
): Promise<{ runs: Run[]; offline?: string }> {
  await loadCachedBenchmarkSnapshot();
  // Run status refreshes every collection; artifact history has its own cadence.
  let listError: unknown;
  const listing = pageBenchmarkRuns(
    ordinaryBenchmarkGitHub,
    token,
    Date.now() - SPARK_DAYS * 86_400_000,
  ).catch((error) => {
    listError = error;
    return undefined;
  });
  const refresh = startBenchmarkRefresh(
    ctx,
    undefined,
    false,
    "dashboard",
    listing,
  ).result;
  const runs = await listing;
  if (runs) latestBenchmarkRuns = runs;
  await refresh;
  return {
    runs: runs ?? [],
    offline: runs ? undefined : friendlyError(errorMessage(listError)),
  };
}

/** Builds a benchmark tile over the selected product measurements. */
function makeBenchmarkTile(
  label: string,
  select: (key: string) => boolean = () => true,
  href = benchmarkDrill.href,
): Tile {
  return {
    label,
    intervalMs: 60_000,
    showOnlyCompletedViews: true,
    async collect(ctx): Promise<TileView> {
      const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
      if (!token) return { ...benchmarkUnavailable("set GH_TOKEN"), href };
      let collection = benchmarkTileCollections.get(token);
      if (!collection) {
        collection = collectBenchmarkTileRuns(ctx, token).finally(() => {
          benchmarkTileCollections.delete(token);
        });
        benchmarkTileCollections.set(token, collection);
      }
      const { runs, offline } = await collection;
      return { ...benchmarkIndexView(runs, Date.now(), select, offline), href };
    },
  };
}

/** All product benchmarks, with the shared performance history routes. */
export const benchmark: Tile = {
  ...makeBenchmarkTile("all benchmarks"),
  routes: [
    {
      path: "/bench",
      handler: (_req, url) => {
        const view = url.searchParams.get("view");
        if (view === "ci") {
          return ciJobHistoryResponse(url);
        }
        if (view === "gantt") {
          return new Response(ciGanttPage(url), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (view !== "runtime") {
          return new Response("unknown performance view", { status: 400 });
        }
        return benchmarkHistoryResponse(url);
      },
    },
    {
      path: "/bench/check",
      handler: (_req, url) => {
        const view = url.searchParams.get("view");
        if (view === "ci") {
          return ciJobHistoryCheckResponse(url);
        }
        if (view === "runtime") return benchmarkHistoryCheckResponse();
        return new Response("unknown performance view", { status: 400 });
      },
    },
    {
      path: "/bench/ci-progress",
      handler: (_req, url) => ciJobHistoryProgressResponse(url),
    },
    {
      path: "/bench/runtime-progress",
      handler: (_req, url) => benchmarkHistoryProgressResponse(url),
    },
  ] satisfies Route[],
};

/** Topic board journey and 100-topic load measurements. */
export const keyBenchmarks: Tile = makeBenchmarkTile(
  "key benchmarks",
  isKeyBenchmark,
  `${benchmarkDrill.href}&key=1`,
);

export async function benchmarkHistoryResponse(
  url: URL,
  ctx = benchmarkServerContext(),
): Promise<Response> {
  await loadCachedBenchmarkSnapshot();
  const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
  const baseline = benchmarkSnapshotVersion();
  let progress: BenchmarkFetchProgress | undefined;
  let refreshError: string | undefined;
  if (!token) {
    refreshError = snapshot.length
      ? "Set GH_TOKEN to refresh runtime benchmark history."
      : "Set GH_TOKEN to collect runtime benchmark history.";
  }
  if (token && !benchmarkRefreshRecentlyFailed()) {
    const refresh = startBenchmarkRefresh(
      ctx,
      baseline,
      benchmarkSnapshotIsFresh(),
    );
    progress = refresh.progress ?? undefined;
    if (progress) void refresh.result;
    else await refresh.result;
  }
  const lastRequestError = progress
    ? undefined
    : benchmarkLastRequestError() ?? undefined;
  return new Response(
    benchPage(
      url.searchParams.get("stat") ?? DEFAULT_LABEL,
      url.searchParams.get("sort") ?? "file",
      ciHistoryDays(url.searchParams.get("days")),
      Date.now(),
      ciHistorySource(url.searchParams.get("repo")).key,
      {
        progress,
        refreshError,
        lastRequestError,
        fragment: url.searchParams.get("fragment") === "range",
        keyOnly: url.searchParams.get("key") === "1",
      },
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function benchmarkHistoryCheckResponse(
  ctx = benchmarkServerContext(),
): Promise<Response> {
  await loadCachedBenchmarkSnapshot();
  const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
  let progress: BenchmarkFetchProgress | null = null;
  if (
    token &&
    (!benchmarkRefreshFailedAt || activeBenchmarkRefreshes.has("bench") ||
      Date.now() - benchmarkRefreshFailedAt >= BENCHMARK_REFRESH_MS)
  ) {
    const refresh = startBenchmarkRefresh(
      ctx,
      benchmarkSnapshotVersion(),
      benchmarkSnapshotIsFresh(),
    );
    progress = refresh.progress;
    if (progress) void refresh.result;
    else await refresh.result;
  }
  const lastRequestError = progress ? null : benchmarkLastRequestError();
  return Response.json(
    { version: benchmarkSnapshotVersion(), progress, lastRequestError },
    { headers: { "cache-control": "no-store" } },
  );
}

interface BenchmarkProgressProvider {
  progress(id: string): BenchmarkFetchProgress | null;
  subscribe(
    id: string,
    listener: (progress: BenchmarkFetchProgress) => void,
  ): (() => void) | null;
}

const defaultBenchmarkProgressProvider: BenchmarkProgressProvider = {
  progress: benchmarkProgress,
  subscribe: subscribeBenchmarkProgress,
};

export function benchmarkHistoryProgressResponse(
  url: URL,
  provider = defaultBenchmarkProgressProvider,
): Response {
  const id = url.searchParams.get("id");
  if (!id) return new Response("missing progress id", { status: 400 });
  if (!provider.progress(id)) {
    return new Response("unknown progress id", { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (progress: BenchmarkFetchProgress) => {
        if (closed) return;
        controller.enqueue(encoder.encode(
          `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        ));
        if (progress.phase === "complete" || progress.phase === "error") {
          closed = true;
          controller.close();
          unsubscribe?.();
        }
      };
      unsubscribe = provider.subscribe(id, send) ?? undefined;
      if (closed) unsubscribe?.();
    },
    cancel() {
      closed = true;
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export function pointsForWindow<T extends { at: number }>(
  points: T[],
  axisStart: number,
  bucketMs: number,
  axisEnd = Infinity,
): T[] {
  const buckets = new Map<number, T>();
  for (const point of points) {
    if (point.at < axisStart || point.at > axisEnd) continue;
    const bucket = Math.floor(point.at / bucketMs);
    const current = buckets.get(bucket);
    if (!current || point.at > current.at) buckets.set(bucket, point);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

export function representativeBenchmarkCpu<
  T extends { cpu: string; sampleCount: number; points: { at: number }[] },
>(series: T[]): T | undefined {
  let representative: T | undefined;
  for (const candidate of series) {
    if (!representative) {
      representative = candidate;
      continue;
    }
    const candidateLatest = candidate.points.at(-1)?.at ?? -Infinity;
    const representativeLatest = representative.points.at(-1)?.at ?? -Infinity;
    if (
      candidate.sampleCount > representative.sampleCount ||
      (candidate.sampleCount === representative.sampleCount &&
        candidateLatest > representativeLatest) ||
      (candidate.sampleCount === representative.sampleCount &&
        candidateLatest === representativeLatest &&
        candidate.cpu.localeCompare(representative.cpu) < 0)
    ) {
      representative = candidate;
    }
  }
  return representative;
}

const dateLabel = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

// The /bench drill-down: every benchmark's processor-specific lines for the
// chosen measurement, grouped by source file.
interface BenchmarkPageOptions {
  progress?: BenchmarkFetchProgress;
  refreshError?: string;
  lastRequestError?: string;
  fragment?: boolean;
  keyOnly?: boolean;
}

export function benchPage(
  statLabel: string,
  sortMode: string,
  days: number,
  now = Date.now(),
  repo: CiHistorySourceKey = "labs",
  options: BenchmarkPageOptions = {},
): string {
  // "p50" is what the mean column used to be called, so a link saved under the
  // old name still opens the column it named.
  const requested = statLabel === "p50" ? "mean" : statLabel;
  const stat = STATS.find((s) => s.label === requested) ??
    STATS.find((s) => s.label === DEFAULT_LABEL)!;
  const sort = sortMode === "trend" || sortMode === "duration"
    ? sortMode
    : "file";
  const href = (st: string, so: string) =>
    performanceViewHref("runtime", {
      repo,
      days,
      sort: so,
      stat: st,
      keyOnly: options.keyOnly,
    });
  const statSel = STATS.map((s) =>
    `<a class="stat${s.label === stat.label ? " on" : ""}" href="${
      href(s.label, sort)
    }"${s.label === stat.label ? ' aria-current="true"' : ""}>${s.label}</a>`
  ).join("");
  const sortSel = (["file", "duration", "trend"] as const).map((so) =>
    `<a class="stat${sort === so ? " on" : ""}" href="${href(stat.label, so)}"${
      sort === so ? ' aria-current="true"' : ""
    }>${so}</a>`
  ).join("");
  const viewNav = performanceViewNav("runtime", {
    repo,
    days,
    sort,
    stat: stat.label,
    keyOnly: options.keyOnly,
  });
  const version = benchmarkSnapshotVersion();
  const handoff = benchmarkRerunHandoff(latestBenchmarkRuns);
  const progress = options.progress;
  const progressIdle = !progress || progress.phase === "complete" ||
    progress.phase === "error";
  const lastRequestError = progress?.phase === "error"
    ? progress.error ?? "unknown error"
    : !progress
    ? options.lastRequestError
    : undefined;
  const progressTitle = progressIdle
    ? "Idle"
    : progress.phase === "discovering"
    ? "Finding benchmark runs…"
    : `${progress.completedRuns} of ${progress.totalRuns} artifact checks complete`;
  const progressTotal = progressIdle
    ? "0 outstanding"
    : `${progress.completedRuns} / ${progress.totalRuns || "?"}`;
  const progressDetail = lastRequestError
    ? `Last collection stopped: ${escapeHtml(lastRequestError)}`
    : !progressIdle && progress
    ? `${progress.cachedRuns} cached · ${progress.requestsMade} artifact checks made · ${progress.responsesReceived} responded · ${progress.outstandingRequests} outstanding · ${progress.queuedRuns} queued`
    : "No requests in progress.";
  const progressUrl = progress
    ? `/bench/runtime-progress?id=${
      escapeHtml(encodeURIComponent(progress.id))
    }`
    : "";
  const progressHtml = `<section class="fetch-progress${
    lastRequestError ? " error" : ""
  }" id="fetch-progress" aria-live="polite" data-check-url="/bench/check?view=runtime" data-snapshot-version="${
    escapeHtml(version)
  }" data-refresh-on-complete="${
    progress && !progressIdle && !snapshot.length ? "1" : "0"
  }"${
    lastRequestError
      ? ` data-last-request-error="${escapeHtml(lastRequestError)}"`
      : ""
  }${
    progressUrl ? ` data-progress-url="${progressUrl}"` : ""
  }><div class="fetch-head"><strong id="fetch-title">${progressTitle}</strong><span id="fetch-total">${progressTotal}</span></div><progress id="fetch-bar" max="${
    progressIdle ? 1 : Math.max(1, progress?.totalRuns ?? 1)
  }"${
    !progressIdle && progress && !progress.totalRuns
      ? ""
      : ` value="${progressIdle ? 0 : progress?.completedRuns ?? 0}"`
  } aria-label="Runtime benchmark fetch progress"></progress><p id="fetch-detail">${progressDetail}</p></section>`;
  const refreshNotice = options.refreshError && snapshot.length
    ? `<p class="refresh-error">${escapeHtml(options.refreshError)}</p>`
    : "";

  let body: string;
  let cpuLegend = "";
  if (!snapshot.length) {
    body = progress && !progressIdle ? "" : `<p class="empty">${
      escapeHtml(
        options.refreshError ??
          "No runtime benchmark samples were found in the history window.",
      )
    }</p>`;
  } else {
    const axisEnd = now;
    const axisStart = axisEnd - days * 86_400_000;
    const axisSpan = axisEnd - axisStart || 1;
    const bucketMs = ciHistoryBucketMs(days);
    const colors = cpuColors(
      snapshot.flatMap((series) => series.cpus.map((cpu) => cpu.cpu)),
    );
    const cpuKeys = new Map(
      [...colors.keys()].map((cpu, index) => [
        cpu,
        { label: `CPU ${index + 1}`, anchor: `cpu-type-${index + 1}` },
      ]),
    );
    const rows = snapshot.flatMap((s) => {
      if (options.keyOnly && !isKeyBenchmark(s.key)) return [];
      const visibleCpus = s.cpus.flatMap((series) => {
        const sourcePoints = series.points.filter((point) =>
          point.at >= axisStart && point.at <= axisEnd
        );
        const points = pointsForWindow(
          sourcePoints,
          axisStart,
          bucketMs,
          axisEnd,
        );
        if (!points.length) return [];
        const values = points.map((point) => point.stats[stat.field]);
        const trend = benchmarkTrend(
          points.map((point) => point.at),
          values,
        );
        return [{
          cpu: series.cpu,
          color: colors.get(series.cpu)!,
          sampleCount: sourcePoints.length,
          points,
          values,
          pct: trend.pct,
          status: trend.status,
          trend: trend.label,
          latest: values[values.length - 1],
        }];
      });
      if (!visibleCpus.length) return [];
      const cpus = visibleCpus;
      const representative = representativeBenchmarkCpu(cpus)!;
      const status = representative.status;
      const pct = representative.pct;
      const allPoints = cpus.flatMap((series) => series.points);
      const firstAt = Math.min(...allPoints.map((point) => point.at));
      const lastAt = Math.max(...allPoints.map((point) => point.at));
      const spark = multiSparkline(
        cpus.map((series) => ({
          vals: series.values,
          ...themedChartSeries(series.color),
          xs: series.points.map((point) => (point.at - axisStart) / axisSpan),
          maxXGap: CPU_LINE_MAX_X_GAP,
          showSinglePoint: true,
        })),
        {
          fade: true,
          scale: {
            trim: PERFORMANCE_HISTORY_SCALE_TRIM,
            minValues: PERFORMANCE_HISTORY_SCALE_MIN_VALUES,
          },
        },
      );
      return [{
        key: s.key,
        file: s.key.split(" > ")[0],
        pct,
        st: status,
        spark,
        dur: lastAt > firstAt ? durationTag(lastAt - firstAt) : "",
        latest: representative.latest,
        representative,
        cpus,
      }];
    });
    const cpuDetails = new Map<string, {
      color: string;
      benchmarks: number;
      runs: Set<string>;
      firstAt: number;
      lastAt: number;
    }>();
    for (const row of rows) {
      for (const series of row.cpus) {
        let detail = cpuDetails.get(series.cpu);
        if (!detail) {
          detail = {
            color: series.color,
            benchmarks: 0,
            runs: new Set(),
            firstAt: series.points[0].at,
            lastAt: series.points[series.points.length - 1].at,
          };
          cpuDetails.set(series.cpu, detail);
        }
        detail.benchmarks++;
        for (const point of series.points) {
          detail.runs.add(`${point.runId}:${point.runAttempt}`);
          detail.firstAt = Math.min(detail.firstAt, point.at);
          detail.lastAt = Math.max(detail.lastAt, point.at);
        }
      }
    }
    if (cpuDetails.size) {
      cpuLegend =
        `<section class="cpu-legend" aria-labelledby="cpu-legend-title"><h2 class="cpu-legend-title" id="cpu-legend-title">CPU types</h2><div class="cpu-keys">${
          [...cpuDetails]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cpu, detail]) => {
              const displayColor = themedChartSeries(detail.color).color;
              const benchmarks = `${detail.benchmarks} benchmark${
                detail.benchmarks === 1 ? "" : "s"
              }`;
              const runs = `${detail.runs.size} run${
                detail.runs.size === 1 ? "" : "s"
              }`;
              const observed = detail.firstAt === detail.lastAt
                ? `observed ${dateLabel(detail.firstAt)}`
                : `observed ${dateLabel(detail.firstAt)}–${
                  dateLabel(detail.lastAt)
                }`;
              const { label: cpuId, anchor } = cpuKeys.get(cpu)!;
              return `<div class="cpu-key" id="${anchor}" data-cpu-id="${cpuId}"><span class="swatch" style="background:${
                escapeHtml(displayColor)
              }"></span><span class="cpu-id" style="--cpu-color:${
                escapeHtml(displayColor)
              }">${cpuId}</span><span class="cpu-description"><span class="cpu-name">${
                escapeHtml(cpu)
              }</span><span class="cpu-detail">${benchmarks} · ${runs} · ${observed}</span></span></div>`;
            }).join("")
        }</div></section>`;
    }
    const rowHtml = (r: (typeof rows)[number], label: string) => {
      const series = r.representative;
      const displayColor = themedChartSeries(series.color).color;
      const { label: cpuId, anchor } = cpuKeys.get(series.cpu)!;
      const latest = formatNs(series.latest);
      const sampleCount = series.sampleCount;
      const samples = `${sampleCount} sample${
        sampleCount === 1 ? "" : "s"
      } in the selected window`;
      return `<div class="brow ${r.st}"><div class="bspark">${r.spark}${r.dur}</div><div class="bmeta">` +
        `<span class="bname">${escapeHtml(label)}</span>` +
        `<span class="bval" data-cpu-id="${cpuId}" data-sample-count="${sampleCount}" style="--cpu-color:${
          escapeHtml(displayColor)
        }" title="${
          escapeHtml(`${series.cpu} · ${samples}`)
        }" aria-label="${
          escapeHtml(
            `Representative CPU ${series.cpu}: ${latest}, ${series.trend}; ${samples}`,
          )
        }"><a class="cpu-id" href="#${anchor}" aria-label="${
          escapeHtml(`${cpuId}: ${series.cpu}; jump to CPU types legend`)
        }">${cpuId}</a>${latest}<span class="btrend">${
          escapeHtml(series.trend)
        }</span></span>` +
        `</div></div>`;
    };
    const axis = `<div class="axisrow"><div class="timeaxis"><span>${
      dateLabel(axisStart)
    }</span><span>${dateLabel(axisEnd)}</span></div></div>`;
    if (!rows.length) {
      body =
        `<p class="empty">No benchmark samples were found in the selected window.</p>`;
    } else if (sort === "trend" || sort === "duration") {
      const sorted = [...rows].sort((a, b) => {
        const difference = sort === "duration"
          ? b.latest - a.latest
          : b.pct - a.pct;
        return difference || a.key.localeCompare(b.key);
      });
      body = `${axis}<div class="blist">${
        sorted.map((r) => rowHtml(r, r.key)).join("")
      }</div>`;
    } else {
      // Grouped by source file, in the snapshot's alphabetical order.
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const arr = groups.get(r.file);
        if (arr) arr.push(r);
        else groups.set(r.file, [r]);
      }
      body = axis +
        [...groups.entries()].map(([file, rs]) =>
          `<section class="benchmark-group"><h2>${escapeHtml(file)}</h2><div class="blist">${
            rs.map((r) =>
              rowHtml(r, r.key.split(" > ").slice(1).join(" > ") || r.key)
            ).join("")
          }</div></section>`
        ).join("");
    }
  }

  const rangeContent = `<div id="range-content">
    ${progressHtml}${refreshNotice}
    <p class="legend">Per-op time across a run's samples — p0 = the fastest, p100 = the slowest, mean = the arithmetic mean. Lower is faster. Each CPU has its own colored line. The value, trend, and row color use the CPU with the most benchmark samples in the selected ${days}-day window; a tie uses the CPU with the newest sample. Fewer than seven distinct days are marked new. Duration and trend sorting use the displayed value and trend.</p>
    ${body}
    ${cpuLegend}
    <p class="note">Successful main runs come from the <a href="https://github.com/${REPO}/actions/workflows/${WORKFLOW}" target="_blank" rel="noopener">${WORKFLOW} runs ↗</a> (deno bench artifacts). Collection keeps enough samples for the shortest window, and charts reduce longer windows to about ${CI_HISTORY_POINT_TARGET} evenly spaced points.</p>
    <p class="handoff"><a href="${
    escapeHtml(handoff.href)
  }" target="_blank" rel="noopener">${
    escapeHtml(handoff.label)
  }</a><span>${
    escapeHtml(handoff.hint)
  } This board reads GitHub and does not start runs itself.</span></p>
  </div>`;
  if (options.fragment) return rangeContent;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Benchmarks — ${
    escapeHtml(stat.label)
  }</title>
${DASHBOARD_THEME_HEAD}
<style>
  ${PERFORMANCE_VIEW_STYLES}
  .bval{display:flex;align-items:baseline;min-width:0}
  .bval .cpu-id{margin-right:7px;align-self:center}
  .bval a.cpu-id{text-decoration:none}
  .bval a.cpu-id:hover{border-color:var(--accent);color:var(--text-strong)}
  .bval a.cpu-id:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btrend{margin-left:8px}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;flex:none;box-shadow:0 0 0 1px var(--icon-subtle)}
  .cpu-id{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--cpu-color,var(--border-hover));border-radius:4px;padding:1px 4px;font-size:9px;line-height:1.2;font-weight:500;color:var(--text-secondary);white-space:nowrap}
  .cpu-legend{margin-top:22px}.cpu-legend-title{margin:0 0 8px}
  .handoff{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:10px}
  .handoff a{font-size:13px;color:var(--text-secondary);text-decoration:none;border:1px solid var(--border-strong);border-radius:6px;padding:4px 10px}
  .handoff a:hover{border-color:var(--accent);color:var(--text-strong)}
  .handoff a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .handoff span{font-size:11px;color:var(--text-faint)}
  .cpu-keys{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:7px}
  .cpu-key{display:flex;align-items:flex-start;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
  .cpu-key:target{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 24%,transparent);scroll-margin-top:16px}
  .cpu-key>.swatch,.cpu-key>.cpu-id{margin-top:3px}.cpu-description{min-width:0}
  .cpu-name{display:block;font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere}
  .cpu-detail{display:block;font-size:10px;color:var(--text-subtle);margin-top:2px}
  body.hide-green .brow.good{display:none}
  body.hide-green .benchmark-group:not(:has(.brow:not(.good))){display:none}
</style></head><body data-snapshot-version="${escapeHtml(version)}">
  <div class="top"><a class="back" href="/">← dashboard</a><b>Performance history</b><span>${
    escapeHtml(REPO)
  } · ${WORKFLOW}</span></div>
  ${viewNav}
  <form class="controls" method="get" action="/bench"><input type="hidden" name="view" value="runtime"><input type="hidden" name="repo" value="${repo}"><input type="hidden" name="stat" value="${
    escapeHtml(stat.label)
  }"><input type="hidden" name="sort" value="${sort}"><label class="field" for="days">window <output id="daysv" for="days">${days} day${
    days === 1 ? "" : "s"
  }</output><input type="range" id="days" name="days" min="${CI_HISTORY_MIN_DAYS}" max="${CI_HISTORY_DAYS}" step="1" value="${days}"></label><nav class="choice-group" aria-label="Benchmark metric"><span class="lbl">metric</span>${statSel}</nav><nav class="choice-group" aria-label="Sort benchmarks"><span class="lbl">sort</span>${sortSel}</nav><label class="check trailing"><input type="checkbox" id="key-only" name="key" value="1"${options.keyOnly ? " checked" : ""}> key only</label><label class="check"><input type="checkbox" id="hg"> hide green</label></form>
  ${rangeContent}
${dashboardThemeToggle()}
${DASHBOARD_THEME_CLIENT}
<script>
  const hg = document.getElementById("hg"), days = document.getElementById("days"), daysv = document.getElementById("daysv"), controls = days.form, KEY = "benchHideGreen", DEFAULT_DAYS = days.value;
  let rangeContent = document.getElementById("range-content"), fetchProgress = document.getElementById("fetch-progress"), title = document.getElementById("fetch-title"), total = document.getElementById("fetch-total"), detail = document.getElementById("fetch-detail"), bar = document.getElementById("fetch-bar"), pageVersion = fetchProgress.dataset.snapshotVersion, appliedDays = days.value;
  let navigating = false, pendingRefresh = false, checking = false, eventStream = null, connectedProgressUrl = "", serverVersionChanged = false, collectionFailed = false, transportFailed = false, rangeRequest = null, rangeRequestDays = "", rangeSequence = 0, viewRevision = 0;
  const apply = () => document.body.classList.toggle("hide-green", hg.checked);
  hg.checked = sessionStorage.getItem(KEY) === "1";
  apply();
  hg.addEventListener("change", () => {
    sessionStorage.setItem(KEY, hg.checked ? "1" : "0");
    apply();
  });
  const keyOnly = document.getElementById("key-only");
  const restoreKeyOnly = () => keyOnly.checked = new URL(location.href).searchParams.get("key") === "1";
  keyOnly.addEventListener("change", () => controls.requestSubmit());
  const syncDayLinks = () => {
    for (const link of document.querySelectorAll('a[href^="/bench?"]')) {
      const target = new URL(link.href);
      target.searchParams.set("days", days.value);
      link.href = target.pathname + "?" + target.searchParams.toString();
    }
  };
  days.addEventListener("input", () => {
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
  });
  const applyDays = () => {
    if (days.value !== appliedDays) {
      if (!rangeRequest || rangeRequestDays !== days.value) void loadRange("push");
    } else if (rangeRequest && rangeRequestDays !== days.value) {
      void loadRange("restore");
    } else if (pendingRefresh && !rangeRequest) {
      pendingRefresh = false;
      void loadRange("refresh");
    }
  };
  days.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDays();
    }
  });
  days.addEventListener("change", applyDays);
  const isSameTabLink = (event, link) =>
    link.target !== "_blank" && event.button === 0 && !event.metaKey &&
    !event.ctrlKey && !event.shiftKey && !event.altKey;
  const isSameDocumentFragment = (link) => {
    const url = new URL(link.href);
    return url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash !== "";
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (
      link && isSameTabLink(event, link) && !isSameDocumentFragment(link)
    ) navigating = true;
  }, true);
  controls.addEventListener("submit", () => navigating = true);
  window.addEventListener("pagehide", () => {
    navigating = true;
    rangeRequest?.abort();
    eventStream?.close();
  });
  const renderIdle = (lastRequestError = fetchProgress.dataset.lastRequestError || "") => {
    collectionFailed = Boolean(lastRequestError);
    transportFailed = false;
    if (lastRequestError) {
      fetchProgress.dataset.lastRequestError = lastRequestError;
    } else delete fetchProgress.dataset.lastRequestError;
    fetchProgress.classList.toggle("error", collectionFailed);
    title.textContent = "Idle";
    total.textContent = "0 outstanding";
    bar.max = 1;
    bar.value = 0;
    detail.textContent = lastRequestError
      ? "Last collection stopped: " + lastRequestError
      : "No requests in progress.";
  };
  const refreshRangeWhenIdle = () => {
    if (navigating) return;
    if (
      days.value !== appliedDays || rangeContent.contains(document.activeElement) ||
      rangeRequest
    ) {
      pendingRefresh = true;
      return;
    }
    void loadRange("refresh");
  };
  document.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (
        pendingRefresh && !navigating && !rangeRequest &&
        !rangeContent.contains(document.activeElement)
      ) {
        pendingRefresh = false;
        refreshRangeWhenIdle();
      }
    });
  });
  const renderProgress = (state) => {
    collectionFailed = state.phase === "error";
    transportFailed = false;
    fetchProgress.classList.remove("error");
    if (collectionFailed) {
      fetchProgress.dataset.lastRequestError = state.error || "unknown error";
    } else delete fetchProgress.dataset.lastRequestError;
    if (state.phase === "discovering") {
      title.textContent = "Finding benchmark runs…";
      total.textContent = "starting";
      bar.removeAttribute("value");
    } else {
      title.textContent = state.phase === "saving"
        ? "Saving completed responses…"
        : state.completedRuns + " of " + state.totalRuns + " artifact checks complete";
      total.textContent = state.completedRuns + " / " + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
    }
    detail.textContent = state.cachedRuns + " cached · " +
      state.requestsMade + " artifact checks made · " +
      state.responsesReceived + " responded · " +
      state.outstandingRequests + " outstanding · " +
      state.queuedRuns + " queued" +
      (state.failedResponses ? " · " + state.failedResponses + " failed" : "");
    if (state.phase === "error") {
      fetchProgress.classList.add("error");
      title.textContent = "Idle";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = "Last collection stopped: " +
        fetchProgress.dataset.lastRequestError;
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
    } else if (state.phase === "complete") {
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      if (state.needsReload || serverVersionChanged || fetchProgress.dataset.refreshOnComplete === "1") refreshRangeWhenIdle();
      else renderIdle();
    }
  };
  const connectProgress = (url) => {
    if (!url || connectedProgressUrl === url) return;
    eventStream?.close();
    connectedProgressUrl = url;
    const stream = new EventSource(url);
    eventStream = stream;
    stream.addEventListener("progress", (event) => {
      if (eventStream !== stream) return;
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        stream.close();
        eventStream = null;
        connectedProgressUrl = "";
        transportFailed = true;
        fetchProgress.classList.add("error");
        title.textContent = "Could not read collection progress";
      }
    });
    stream.onerror = () => {
      if (eventStream !== stream) return;
      stream.close();
      eventStream = null;
      connectedProgressUrl = "";
      transportFailed = true;
      fetchProgress.classList.add("error");
      title.textContent = "Progress connection closed; collection continues on the server";
    };
  };
  const checkForUpdates = async () => {
    if (checking || navigating || document.visibilityState === "hidden") return;
    checking = true;
    const revision = viewRevision;
    try {
      const response = await fetch(fetchProgress.dataset.checkUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const state = await response.json();
      if (revision !== viewRevision) return;
      serverVersionChanged ||= state.version !== pageVersion;
      if (state.progress) {
        connectProgress("/bench/runtime-progress?id=" + encodeURIComponent(state.progress.id));
        renderProgress(state.progress);
      } else if (serverVersionChanged) refreshRangeWhenIdle();
      else if ("lastRequestError" in state) renderIdle(state.lastRequestError || "");
      else if (!collectionFailed) renderIdle();
    } catch {
      if (!eventStream && !collectionFailed && !transportFailed) renderIdle();
    } finally {
      checking = false;
    }
  };
  const bindRangeContent = () => {
    viewRevision++;
    fetchProgress = rangeContent.querySelector("#fetch-progress");
    title = rangeContent.querySelector("#fetch-title");
    total = rangeContent.querySelector("#fetch-total");
    detail = rangeContent.querySelector("#fetch-detail");
    bar = rangeContent.querySelector("#fetch-bar");
    pageVersion = fetchProgress.dataset.snapshotVersion;
    document.body.dataset.snapshotVersion = pageVersion;
    serverVersionChanged = false;
    collectionFailed = false;
    transportFailed = false;
    connectedProgressUrl = "";
    if (fetchProgress.dataset.progressUrl) connectProgress(fetchProgress.dataset.progressUrl);
    else renderIdle();
  };
  const showRangeLoading = (requestedDays) => {
    rangeContent.setAttribute("aria-busy", "true");
    fetchProgress.classList.remove("error");
    title.textContent = "Loading " + requestedDays + "-day view…";
    total.textContent = "updating";
    bar.removeAttribute("value");
    detail.textContent = "Reading cached history and checking for new benchmark data.";
  };
  const loadRange = async (mode) => {
    if (navigating) return;
    if (rangeRequest) {
      if (mode === "refresh") {
        pendingRefresh = true;
        return;
      }
      rangeRequest.abort();
    }
    const requestedDays = days.value;
    const url = new URL(location.href);
    url.searchParams.set("days", requestedDays);
    const sequence = ++rangeSequence;
    const controller = new AbortController();
    rangeRequest = controller;
    rangeRequestDays = requestedDays;
    let loaded = false;
    showRangeLoading(requestedDays);
    try {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("fragment", "range");
      const response = await fetch(requestUrl.pathname + requestUrl.search, {
        cache: "no-store",
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const replacement = page.getElementById("range-content");
      if (!replacement) throw new Error("Range content was missing from the response.");
      if (sequence !== rangeSequence || navigating) return;
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      rangeContent.replaceWith(replacement);
      rangeContent = replacement;
      appliedDays = requestedDays;
      const target = url.pathname + url.search;
      if (mode === "push" && target !== location.pathname + location.search) {
        history.pushState(null, "", target);
      }
      bindRangeContent();
      syncDayLinks();
      loaded = true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== rangeSequence) return;
      pendingRefresh = false;
      rangeContent.removeAttribute("aria-busy");
      fetchProgress.classList.add("error");
      title.textContent = "Could not update the history window";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === rangeSequence) {
        rangeRequest = null;
        rangeRequestDays = "";
        if (loaded && pendingRefresh) {
          pendingRefresh = false;
          refreshRangeWhenIdle();
        }
      }
    }
  };
  const daysFromLocation = () => {
    const parameter = new URL(location.href).searchParams.get("days");
    if (parameter === null || parameter.trim() === "") return DEFAULT_DAYS;
    const value = Number(parameter);
    if (!Number.isFinite(value)) return DEFAULT_DAYS;
    return String(Math.max(Number(days.min), Math.min(Number(days.max), Math.floor(value))));
  };
  window.addEventListener("popstate", () => {
    restoreKeyOnly();
    days.value = daysFromLocation();
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
    void loadRange("pop");
  });
  window.addEventListener("pageshow", (event) => {
    navigating = false;
    restoreKeyOnly();
    if (event.persisted) {
      bindRangeContent();
      void checkForUpdates();
    }
  });
  bindRangeContent();
  setInterval(checkForUpdates, ${PERFORMANCE_CHECK_MS});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdates();
  });
</script>
</body></html>`;
}
