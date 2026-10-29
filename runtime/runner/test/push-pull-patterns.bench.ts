/**
 * Pull benchmarks using real patterns and list builtins.
 *
 * Pull-only since scheduler-v2 phase 0 removed push mode.
 * These benches go through createTrustedBuilder(runtime) + runtime.run() so
 * they exercise the actual map/filter/flatMap machinery instead of synthetic
 * scheduler actions.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getTimingStatsBreakdown,
  resetAllTimingBaselines,
  resetAllTimingStats,
  setGlobalLogFloor,
  type TimingStats,
} from "@commonfabric/utils/logger";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("bench push pull patterns");
const space = signer.did();

setGlobalLogFloor("error");

const LIST_SIZE = 64;
const UPDATE_ROUNDS = 12;
const SINK_ROUNDS = 20;
const TARGET_INDEX = Math.floor(LIST_SIZE / 2);
const FANOUT_WIDTH = 48;
const FANOUT_UPDATE_ROUNDS = 8;
const FANOUT_LIVE_SINKS = 24;
const FANOUT_SPARSE_PULLS = 4;
const FANOUT_WIDE_PULLS = 12;

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const booleanSchema = {
  type: "boolean",
} as const satisfies JSONSchema;

const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;

const numberElementArgumentSchema = {
  type: "object",
  properties: {
    element: numberSchema,
  },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberObjectSchema = {
  type: "object",
  properties: {
    value: numberSchema,
  },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberObjectElementArgumentSchema = {
  type: "object",
  properties: {
    element: numberObjectSchema,
  },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberListInputSchema = {
  type: "object",
  properties: {
    values: numberArraySchema,
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberObjectArraySchema = {
  type: "array",
  items: numberObjectSchema,
} as const satisfies JSONSchema;

const numberObjectListInputSchema = {
  type: "object",
  properties: {
    values: numberObjectArraySchema,
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const scalarInputSchema = {
  type: "object",
  properties: {
    value: numberSchema,
  },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const mappedResultSchema = {
  type: "object",
  properties: {
    mapped: numberArraySchema,
  },
  required: ["mapped"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const filteredResultSchema = {
  type: "object",
  properties: {
    filtered: numberArraySchema,
  },
  required: ["filtered"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const flatMappedResultSchema = {
  type: "object",
  properties: {
    flat: numberArraySchema,
  },
  required: ["flat"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const scalarResultSchema = {
  type: "object",
  properties: {
    result: numberSchema,
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

let blackhole = 0;

type BenchEnv = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
};

type ListScenario = {
  outputCell: Cell<number[]>;
  updateValue: (value: number) => Promise<void>;
};

type FanoutScenario = {
  targetCell: Cell<number>;
  outputCells: Cell<number>[];
  sinkCancels: Array<() => void>;
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

type BenchTimingSummary = {
  execute?: TimingDelta;
  run?: TimingDelta;
  runAction?: TimingDelta;
  depCollect?: TimingDelta;
};

const benchTimingSummaries = new Map<string, BenchTimingSummary>();

function benchOptions(group: string, baseline = false) {
  return {
    group,
    baseline,
    n: 1,
    warmup: 0,
  } as const;
}

function snapshotSchedulerTiming(): Record<string, TimingStats> {
  return getTimingStatsBreakdown().scheduler ?? {};
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
  before: Record<string, TimingStats>,
  after: Record<string, TimingStats>,
  key: string,
): TimingDelta | undefined {
  const afterStat = after[key];
  if (!afterStat) return undefined;

  const beforeStat = before[key];
  const count = afterStat.count - (beforeStat?.count ?? 0);
  const totalTime = afterStat.totalTime - (beforeStat?.totalTime ?? 0);
  if (count <= 0 || totalTime < 0) return undefined;

  const cdf = afterStat.cdfSinceBaseline ?? afterStat.cdf;
  return {
    count,
    totalTime,
    average: totalTime / count,
    min: cdf[0]?.x ?? afterStat.min,
    p50: percentileFromCDF(cdf, 0.5),
    p95: percentileFromCDF(cdf, 0.95),
    max: cdf[cdf.length - 1]?.x ?? afterStat.max,
  };
}

function recordSchedulerTimingSummary(
  benchmarkName: string,
  before: Record<string, TimingStats>,
  after: Record<string, TimingStats>,
) {
  const summary = {
    execute: extractTimingDelta(before, after, "scheduler/execute"),
    run: extractTimingDelta(before, after, "scheduler/run"),
    runAction: extractTimingDelta(before, after, "scheduler/run/action"),
    depCollect: extractTimingDelta(
      before,
      after,
      "scheduler/execute/depCollect",
    ),
  } satisfies BenchTimingSummary;

  const currentWeight = (summary.execute?.totalTime ?? 0) +
    (summary.run?.totalTime ?? 0);
  const previous = benchTimingSummaries.get(benchmarkName);
  const previousWeight = previous
    ? (previous.execute?.totalTime ?? 0) +
      (previous.run?.totalTime ?? 0)
    : -1;

  if (currentWeight >= previousWeight) {
    benchTimingSummaries.set(benchmarkName, summary);
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
  if (benchTimingSummaries.size === 0) return;

  console.error("\nScheduler timing summaries:");
  for (const [benchmarkName, summary] of benchTimingSummaries) {
    const executeTotal = summary.execute?.totalTime ?? 0;
    const runTotal = summary.run?.totalTime ?? 0;
    const actionTotal = summary.runAction?.totalTime ?? 0;
    const externalScheduling = Math.max(0, executeTotal - runTotal);
    const runWrapper = Math.max(0, runTotal - actionTotal);

    console.error(`- ${benchmarkName}`);
    console.error(
      `  scheduling vs compute: execute ${formatMs(executeTotal)}, run ${
        formatMs(runTotal)
      }, run/action ${formatMs(actionTotal)}, outside-run overhead ${
        formatMs(externalScheduling)
      }, in-run wrapper ${formatMs(runWrapper)}`,
    );

    for (
      const line of [
        formatTimingDelta("depCollect", summary.depCollect),
      ]
    ) {
      if (line) console.error(`  ${line}`);
    }
  }
});

function createEnv(): BenchEnv {
  const storageManager = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const { commonfabric } = createTrustedBuilder(runtime);
  const { lift, pattern } = commonfabric;

  return { runtime, storageManager, lift, pattern };
}

async function cleanup(env: BenchEnv) {
  await env.runtime.dispose();
  await env.storageManager.close();
}

function unaryNumberListOpPattern(
  env: BenchEnv,
  fn: (element: unknown) => unknown,
  resultSchema: JSONSchema,
) {
  return env.pattern<{ element: number }, unknown>(
    ({ element }) => fn(element),
    numberElementArgumentSchema,
    resultSchema,
  );
}

function unaryNumberObjectListOpPattern(
  env: BenchEnv,
  fn: (element: unknown) => unknown,
  resultSchema: JSONSchema,
) {
  return env.pattern<{ element: { value: number } }, unknown>(
    ({ element }) => fn(element),
    numberObjectElementArgumentSchema,
    resultSchema,
  );
}

async function createNumberCells(
  runtime: Runtime,
  prefix: string,
  size: number,
  valueAt: (index: number) => number,
): Promise<Cell<number>[]> {
  const tx = runtime.edit();
  const cells: Cell<number>[] = [];

  for (let i = 0; i < size; i++) {
    const cell = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      numberSchema,
      tx,
    );
    cell.set(valueAt(i));
    cells.push(cell);
  }

  await tx.commit().settled;
  return cells;
}

async function createNumberObjectCells(
  runtime: Runtime,
  prefix: string,
  size: number,
  valueAt: (index: number) => number,
): Promise<Cell<{ value: number }>[]> {
  const tx = runtime.edit();
  const cells: Cell<{ value: number }>[] = [];

  for (let i = 0; i < size; i++) {
    const cell = runtime.getCell<{ value: number }>(
      space,
      `${prefix}:item:${i}`,
      numberObjectSchema,
      tx,
    );
    cell.set({ value: valueAt(i) });
    cells.push(cell);
  }

  await tx.commit().settled;
  return cells;
}

async function setNumber(runtime: Runtime, cell: Cell<number>, value: number) {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  await tx.commit().settled;
}

async function setNestedNumber(
  runtime: Runtime,
  cell: Cell<{ value: number }>,
  value: number,
) {
  const tx = runtime.edit();
  cell.withTx(tx).key("value").set(value);
  await tx.commit().settled;
}

function consumeArray(value: readonly number[] | undefined) {
  if (!value) return;
  blackhole = (blackhole + value.length + (value[value.length - 1] ?? 0)) | 0;
}

function consumeNumber(value: number | undefined) {
  blackhole = (blackhole + (value ?? 0)) | 0;
}

function takeFirst<T>(values: T[], count: number): T[] {
  return values.slice(0, Math.min(count, values.length));
}

function takeLast<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  return values.slice(Math.max(0, values.length - count));
}

async function setupMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => index + 1,
  );

  const double = env.lift((x: number) => x * 2, numberSchema, numberSchema);
  const doublePattern = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => double(element as any),
    numberSchema,
  );

  const mapPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (values as any).mapWithPattern(doublePattern as any, {}),
    }),
    numberListInputSchema,
    mappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, mapPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("mapped") as Cell<number[]>,
    updateValue: (value) => setNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupFilterScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? -1 : index + 1),
  );

  const isPositive = env.lift(
    (x: number) => x > 0,
    numberSchema,
    booleanSchema,
  );
  const filterPatternFn = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => isPositive(element as any),
    booleanSchema,
  );

  const filterPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      filtered: (values as any).filterWithPattern(filterPatternFn as any, {}),
    }),
    numberListInputSchema,
    filteredResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ filtered: number[] }>(
    space,
    `${prefix}:result`,
    filteredResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, filterPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("filtered") as Cell<number[]>,
    updateValue: (value) => setNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupFlatMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? 0 : index + 1),
  );

  const expand = env.lift(
    (x: number) => (x > 0 ? [x, x * 10] : []),
    numberSchema,
    numberArraySchema,
  );
  const flatMapPatternFn = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => expand(element as any),
    numberArraySchema,
  );

  const flatMapPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      flat: (values as any).flatMapWithPattern(flatMapPatternFn as any, {}),
    }),
    numberListInputSchema,
    flatMappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ flat: number[] }>(
    space,
    `${prefix}:result`,
    flatMappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, flatMapPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("flat") as Cell<number[]>,
    updateValue: (value) => setNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupObjectMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberObjectCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => index + 1,
  );

  const double = env.lift((x: number) => x * 2, numberSchema, numberSchema);
  const doublePattern = unaryNumberObjectListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => double((element as any).value),
    numberSchema,
  );

  const mapPattern = env.pattern<{ values: Array<{ value: number }> }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (values as any).mapWithPattern(doublePattern as any, {}),
    }),
    numberObjectListInputSchema,
    mappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, mapPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("mapped") as Cell<number[]>,
    updateValue: (value) =>
      setNestedNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupObjectFilterScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberObjectCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? -1 : index + 1),
  );

  const isPositive = env.lift(
    (x: number) => x > 0,
    numberSchema,
    booleanSchema,
  );
  const filterPatternFn = unaryNumberObjectListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => isPositive((element as any).value),
    booleanSchema,
  );

  const filterPattern = env.pattern<{ values: Array<{ value: number }> }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      filtered: (values as any).filterWithPattern(filterPatternFn as any, {}),
    }),
    numberObjectListInputSchema,
    filteredResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ filtered: number[] }>(
    space,
    `${prefix}:result`,
    filteredResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, filterPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("filtered") as Cell<number[]>,
    updateValue: (value) =>
      setNestedNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupObjectFlatMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberObjectCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? 0 : index + 1),
  );

  const expand = env.lift(
    (x: number) => (x > 0 ? [x, x * 10] : []),
    numberSchema,
    numberArraySchema,
  );
  const flatMapPatternFn = unaryNumberObjectListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => expand((element as any).value),
    numberArraySchema,
  );

  const flatMapPattern = env.pattern<{ values: Array<{ value: number }> }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      flat: (values as any).flatMapWithPattern(flatMapPatternFn as any, {}),
    }),
    numberObjectListInputSchema,
    flatMappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ flat: number[] }>(
    space,
    `${prefix}:result`,
    flatMappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, flatMapPattern, { values }, resultCell);
  await tx.commit().settled;

  return {
    outputCell: result.key("flat") as Cell<number[]>,
    updateValue: (value) =>
      setNestedNumber(env.runtime, values[TARGET_INDEX], value),
  };
}

async function setupFanoutScenario(
  env: BenchEnv,
  prefix: string,
): Promise<FanoutScenario> {
  const tx = env.runtime.edit();
  const inputCell = env.runtime.getCell<{ value: number }>(
    space,
    `${prefix}:input`,
    scalarInputSchema,
    tx,
  );
  inputCell.set({ value: 1 });

  const outputCells: Cell<number>[] = [];

  for (let i = 0; i < FANOUT_WIDTH; i++) {
    const addOffset = env.lift(
      (value: number) => value + i + 1,
      numberSchema,
      numberSchema,
    );
    const derivePattern = env.pattern<{ value: number }>(
      ({ value }) => ({
        result: addOffset(value),
      }),
      scalarInputSchema,
      scalarResultSchema,
    );

    const resultCell = env.runtime.getCell<{ result: number }>(
      space,
      `${prefix}:result:${i}`,
      scalarResultSchema,
      tx,
    );
    const result = env.runtime.run(tx, derivePattern, inputCell, resultCell);
    outputCells.push(result.key("result") as Cell<number>);
  }

  await tx.commit().settled;

  return {
    targetCell: inputCell.key("value") as Cell<number>,
    outputCells,
    sinkCancels: [],
  };
}

async function runPullBench(
  b: Deno.BenchContext,
  options: {
    setupScenario: (env: BenchEnv, prefix: string) => Promise<ListScenario>;
    prefix: string;
    nextValue: (round: number) => number;
    rounds?: number;
  },
) {
  const env = createEnv();

  try {
    resetAllTimingStats();
    const scenario = await options.setupScenario(env, options.prefix);
    consumeArray(await scenario.outputCell.pull());
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    b.start();
    for (let i = 0; i < (options.rounds ?? UPDATE_ROUNDS); i++) {
      await scenario.updateValue(options.nextValue(i));
      consumeArray(await scenario.outputCell.pull());
    }
    b.end();

    recordSchedulerTimingSummary(
      b.name,
      timingBefore,
      snapshotSchedulerTiming(),
    );
  } finally {
    await cleanup(env);
  }
}

async function runSinkBench(
  b: Deno.BenchContext,
  options: {
    setupScenario: (env: BenchEnv, prefix: string) => Promise<ListScenario>;
    prefix: string;
    nextValue: (round: number) => number;
    rounds?: number;
  },
) {
  const env = createEnv();

  try {
    resetAllTimingStats();
    const scenario = await options.setupScenario(env, options.prefix);
    const cancel = scenario.outputCell.sink((value) => {
      consumeArray(value);
    });
    await env.runtime.idle();
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    try {
      b.start();
      for (let i = 0; i < (options.rounds ?? SINK_ROUNDS); i++) {
        await scenario.updateValue(options.nextValue(i));
        await env.runtime.idle();
      }
      b.end();
      recordSchedulerTimingSummary(
        b.name,
        timingBefore,
        snapshotSchedulerTiming(),
      );
    } finally {
      cancel();
    }
  } finally {
    await cleanup(env);
  }
}

async function runFanoutBench(
  b: Deno.BenchContext,
  options: {
    prefix: string;
    liveSinkCount: number;
    pulledOutputCount: number;
    rounds?: number;
  },
) {
  const env = createEnv();

  try {
    resetAllTimingStats();
    const scenario = await setupFanoutScenario(env, options.prefix);
    const liveOutputs = takeFirst(scenario.outputCells, options.liveSinkCount);
    const pulledOutputs = takeLast(
      scenario.outputCells,
      options.pulledOutputCount,
    );

    scenario.sinkCancels = liveOutputs.map((output) =>
      output.sink((value) => {
        consumeNumber(value);
      })
    );

    if (scenario.sinkCancels.length > 0) {
      await env.runtime.idle();
    }
    for (const output of pulledOutputs) {
      consumeNumber(await output.pull());
    }
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    try {
      b.start();
      for (let i = 0; i < (options.rounds ?? FANOUT_UPDATE_ROUNDS); i++) {
        await setNumber(env.runtime, scenario.targetCell, i + 2);
        if (scenario.sinkCancels.length > 0) {
          await env.runtime.idle();
        }
        for (const output of pulledOutputs) {
          consumeNumber(await output.pull());
        }
      }
      b.end();
      recordSchedulerTimingSummary(
        b.name,
        timingBefore,
        snapshotSchedulerTiming(),
      );
    } finally {
      for (const cancel of scenario.sinkCancels) cancel();
    }
  } finally {
    await cleanup(env);
  }
}

Deno.bench(
  "Pattern pull - mapWithPattern single element update + pull",
  benchOptions("pattern-map-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:map:pull",
      setupScenario: setupMapScenario,
      nextValue: (round) => LIST_SIZE + round + 1,
    });
  },
);

Deno.bench(
  "Pattern pull - filterWithPattern membership flip + pull",
  benchOptions("pattern-filter-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:filter:pull",
      setupScenario: setupFilterScenario,
      nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : -1),
    });
  },
);

Deno.bench(
  "Pattern pull - flatMapWithPattern expansion flip + pull",
  benchOptions("pattern-flatmap-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:flatmap:pull",
      setupScenario: setupFlatMapScenario,
      nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : 0),
    });
  },
);

Deno.bench(
  "Pattern pull - mapWithPattern single element update + sink",
  benchOptions("pattern-map-sink"),
  async (b) => {
    await runSinkBench(b, {
      prefix: "bench:map:sink",
      setupScenario: setupMapScenario,
      nextValue: (round) => LIST_SIZE + round + 1,
    });
  },
);

Deno.bench(
  "Pattern pull - mapWithPattern object element.value update + pull",
  benchOptions("pattern-map-object-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:map:object:pull",
      setupScenario: setupObjectMapScenario,
      nextValue: (round) => LIST_SIZE + round + 1,
    });
  },
);

Deno.bench(
  "Pattern pull - filterWithPattern object element.value flip + pull",
  benchOptions("pattern-filter-object-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:filter:object:pull",
      setupScenario: setupObjectFilterScenario,
      nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : -1),
    });
  },
);

Deno.bench(
  "Pattern pull - flatMapWithPattern object element.value flip + pull",
  benchOptions("pattern-flatmap-object-pull"),
  async (b) => {
    await runPullBench(b, {
      prefix: "bench:flatmap:object:pull",
      setupScenario: setupObjectFlatMapScenario,
      nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : 0),
    });
  },
);

Deno.bench(
  "Pattern pull - mapWithPattern object element.value update + sink",
  benchOptions("pattern-map-object-sink"),
  async (b) => {
    await runSinkBench(b, {
      prefix: "bench:map:object:sink",
      setupScenario: setupObjectMapScenario,
      nextValue: (round) => LIST_SIZE + round + 1,
    });
  },
);

Deno.bench(
  `Pattern pull - fanout ${FANOUT_WIDTH}, pull ${FANOUT_SPARSE_PULLS}`,
  benchOptions("pattern-fanout-pull-sparse"),
  async (b) => {
    await runFanoutBench(b, {
      prefix: "bench:fanout:pull-sparse",
      liveSinkCount: 0,
      pulledOutputCount: FANOUT_SPARSE_PULLS,
    });
  },
);

Deno.bench(
  `Pattern pull - fanout ${FANOUT_WIDTH}, pull ${FANOUT_WIDE_PULLS}`,
  benchOptions("pattern-fanout-pull-wide"),
  async (b) => {
    await runFanoutBench(b, {
      prefix: "bench:fanout:pull-wide",
      liveSinkCount: 0,
      pulledOutputCount: FANOUT_WIDE_PULLS,
    });
  },
);

Deno.bench(
  `Pattern pull - fanout ${FANOUT_WIDTH}, sink ${FANOUT_LIVE_SINKS}`,
  benchOptions("pattern-fanout-sinks"),
  async (b) => {
    await runFanoutBench(b, {
      prefix: "bench:fanout:sinks",
      liveSinkCount: FANOUT_LIVE_SINKS,
      pulledOutputCount: 0,
    });
  },
);

Deno.bench(
  `Pattern pull - fanout ${FANOUT_WIDTH}, sink ${FANOUT_LIVE_SINKS} + pull ${FANOUT_SPARSE_PULLS}`,
  benchOptions("pattern-fanout-mixed"),
  async (b) => {
    await runFanoutBench(b, {
      prefix: "bench:fanout:mixed",
      liveSinkCount: FANOUT_LIVE_SINKS,
      pulledOutputCount: FANOUT_SPARSE_PULLS,
    });
  },
);
