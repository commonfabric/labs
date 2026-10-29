import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getTimingStatsBreakdown,
  resetAllTimingBaselines,
  resetAllTimingStats,
  setGlobalLogFloor,
  type TimingStats,
} from "@commonfabric/utils/logger";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

setGlobalLogFloor("error");

export const benchSigner = await Identity.fromPassphrase(
  "scheduler benchmark operator",
);
export const benchSpace = benchSigner.did();

export const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

export const objectSchema = {
  type: "object",
  properties: {
    value: numberSchema,
    payload: {
      type: "object",
      properties: {
        value: numberSchema,
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const satisfies JSONSchema;

export type SchedulerBenchEnv = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
};

type TimingDelta = {
  count: number;
  totalTime: number;
  average: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};

type SchedulerTimingSummary = Record<string, TimingDelta | undefined>;

const timingSummaries = new Map<string, SchedulerTimingSummary>();

const timingKeys = [
  ["execute", "scheduler/execute"],
  ["execute/event", "scheduler/execute/event"],
  ["event/presync", "scheduler/execute/event/presyncInputs"],
  ["event/populate", "scheduler/execute/event/pullPopulateDependencies"],
  ["event/log", "scheduler/execute/event/pullTxToReactivityLog"],
  ["event/depCommit", "scheduler/execute/event/pullDepCommitStart"],
  [
    "event/collectInvalid",
    "scheduler/execute/event/pullCollectInvalidUpstream",
  ],
  [
    "event/scheduleInvalid",
    "scheduler/execute/event/pullScheduleInvalidUpstream",
  ],
  ["execute/depCollect", "scheduler/execute/depCollect"],
  ["run", "scheduler/run"],
  ["run/action", "scheduler/run/action"],
  ["run/commit", "scheduler/run/commit"],
  ["run/resubscribe", "scheduler/run/resubscribe"],
] as const;

let blackhole = 0;

export function createSchedulerBenchEnv(): SchedulerBenchEnv {
  const storageManager = StorageManager.emulate({
    as: benchSigner,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  return { runtime, storageManager };
}

export async function cleanupSchedulerBenchEnv(env: SchedulerBenchEnv) {
  await env.runtime.dispose();
  await env.storageManager.close();
}

export function benchOptions(group: string, baseline = false) {
  return {
    group,
    baseline,
    n: 1,
    warmup: 0,
  } as const;
}

export function createNumberCell(
  env: SchedulerBenchEnv,
  tx: ReturnType<Runtime["edit"]>,
  id: string,
  value: number,
): Cell<number> {
  const cell = env.runtime.getCell<number>(
    benchSpace,
    id,
    numberSchema,
    tx,
  );
  cell.set(value);
  return cell;
}

export function consumeNumber(value: number | undefined) {
  blackhole = (blackhole + (value ?? 0)) | 0;
}

export function consumeNumbers(values: Iterable<number | undefined>) {
  for (const value of values) {
    consumeNumber(value);
  }
}

export async function runWithSchedulerTiming(
  benchmarkName: string,
  fn: (resetMeasuredTiming: () => void) => Promise<void> | void,
) {
  resetMeasuredTiming();
  await fn(resetMeasuredTiming);
  recordSchedulerTimingSummary(
    benchmarkName,
    getTimingStatsBreakdown().scheduler ?? {},
  );
}

function resetMeasuredTiming() {
  resetAllTimingStats();
  resetAllTimingBaselines();
}

function percentileFromCDF(
  cdf: Array<{ x: number; y: number }> | null | undefined,
  percentile: number,
): number {
  if (!cdf || cdf.length === 0) return 0;
  return cdf.find((point) => point.y >= percentile)?.x ??
    cdf[cdf.length - 1].x;
}

function extractTimingDelta(
  stats: Record<string, TimingStats>,
  key: string,
): TimingDelta | undefined {
  const stat = stats[key];
  if (!stat || stat.count <= 0) return undefined;

  const cdf = stat.cdfSinceBaseline ?? stat.cdf;
  return {
    count: stat.count,
    totalTime: stat.totalTime,
    average: stat.totalTime / stat.count,
    min: cdf[0]?.x ?? stat.min,
    p50: percentileFromCDF(cdf, 0.5),
    p95: percentileFromCDF(cdf, 0.95),
    max: cdf[cdf.length - 1]?.x ?? stat.max,
  };
}

function recordSchedulerTimingSummary(
  benchmarkName: string,
  stats: Record<string, TimingStats>,
) {
  const summary: SchedulerTimingSummary = {};
  for (const [label, key] of timingKeys) {
    summary[label] = extractTimingDelta(stats, key);
  }

  const currentWeight = Object.values(summary).reduce(
    (total, delta) => total + (delta?.totalTime ?? 0),
    0,
  );
  const previous = timingSummaries.get(benchmarkName);
  const previousWeight = previous
    ? Object.values(previous).reduce(
      (total, delta) => total + (delta?.totalTime ?? 0),
      0,
    )
    : -1;

  if (currentWeight >= previousWeight) {
    timingSummaries.set(benchmarkName, summary);
  }
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  if (value >= 100) return `${value.toFixed(0)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

function formatTimingDelta(label: string, delta?: TimingDelta): string | null {
  if (!delta) return null;
  return `${label}: x${delta.count}, total ${formatMs(delta.totalTime)}, avg ${
    formatMs(delta.average)
  }, p50 ${formatMs(delta.p50)}, p95 ${formatMs(delta.p95)}, max ${
    formatMs(delta.max)
  }`;
}

const benchDiagnosticsEnabled = Deno.env.get("BENCH_DIAGNOSTICS") === "1";

addEventListener("unload", () => {
  if (!benchDiagnosticsEnabled) return;
  if (timingSummaries.size === 0) return;

  console.error("\nSynthetic scheduler timing summaries:");
  for (const [benchmarkName, summary] of timingSummaries) {
    console.error(`- ${benchmarkName}`);
    for (const [label] of timingKeys) {
      const line = formatTimingDelta(label, summary[label]);
      if (line) console.error(`  ${line}`);
    }
  }
});
