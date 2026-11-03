import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BENCHMARK_HISTORY_CACHE_DAYS,
  BENCHMARK_HISTORY_SAMPLING_VERSION,
  BenchmarkHistoryStore,
  type BenchmarkStats,
} from "./benchmark-history-cache.ts";

const DAY_MS = 86_400_000;

const temporaryFiles = async (path: string): Promise<string[]> =>
  (await Array.fromAsync(Deno.readDir(path)))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".tmp"));

const stats = (p99: number): BenchmarkStats => ({
  min: p99 / 4,
  avg: p99 / 2,
  max: p99 * 2,
  p75: p99 * 0.75,
  p99,
  p995: p99 * 1.05,
  p999: p99 * 1.1,
});

Deno.test("runtime benchmark history persists usable and empty artifacts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set({
      runId: 101,
      runAttempt: 1,
      at: now - DAY_MS,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([["runtime/a.bench.ts > works", stats(1_000)]]),
    });
    writer.set({
      runId: 101,
      runAttempt: 2,
      at: now - DAY_MS,
      cpu: "INTEL(R) XEON(R) PLATINUM 8573C",
      metrics: new Map([["runtime/a.bench.ts > works", stats(1_500)]]),
    });
    writer.set({
      runId: 102,
      runAttempt: 1,
      at: now,
      cpu: "AMD EPYC 9V74 80-Core Processor",
      metrics: new Map(),
    });
    writer.markRefreshed(now - 1_000, writer.list());
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [101, 102]);
    assertEquals(
      reader.get(101)?.metrics.get("runtime/a.bench.ts > works")?.p99,
      1_500,
    );
    assertEquals(reader.get(101)?.runAttempt, 2);
    assertEquals(reader.get(101)?.cpu, "INTEL(R) XEON(R) PLATINUM 8573C");
    assertEquals(reader.get(102)?.metrics.size, 0);
    assertEquals(reader.get(102)?.cpu, "AMD EPYC 9V74 80-Core Processor");
    assertEquals(reader.refreshedAt, now - 1_000);
    assertEquals(
      reader.refreshedRuns()?.map((run) => [run.runId, run.runAttempt]),
      [[101, 2], [102, 1]],
    );
    assertEquals(await temporaryFiles(history), []);
    assertEquals(await temporaryFiles(directory), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history replaces CPU-less data", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const legacy = new BenchmarkHistoryStore(history);
    await legacy.load();
    legacy.set({
      runId: 125,
      runAttempt: 1,
      at: now,
      metrics: new Map([["runtime/a.bench.ts > works", stats(1_000)]]),
    });
    await legacy.save(now);

    const migrated = new BenchmarkHistoryStore(history);
    await migrated.load();
    assertEquals(migrated.get(125)?.cpu, undefined);
    migrated.set({
      runId: 125,
      runAttempt: 1,
      at: now,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([["runtime/a.bench.ts > works", stats(2_000)]]),
    });
    await migrated.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.get(125)?.cpu, "AMD EPYC 7763 64-Core Processor");
    assertEquals(
      reader.get(125)?.metrics.get("runtime/a.bench.ts > works")?.p99,
      2_000,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history preserves a definitive empty refresh", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set({
      runId: 150,
      runAttempt: 1,
      at: now,
      metrics: new Map([["old", stats(1_000)]]),
    });
    writer.markRefreshed(now, []);
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [150]);
    assertEquals(reader.refreshedRuns(), []);
    assertEquals(reader.refresh?.result, "no-runs");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history retains the completed attempt while a rerun is incomplete", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    const first = writer.set({
      runId: 160,
      runAttempt: 1,
      at: now,
      metrics: new Map([["first", stats(1_000)]]),
    });
    writer.markRefreshed(now - 1_000, [first], "data");
    await writer.save(now);

    writer.set({
      runId: 160,
      runAttempt: 2,
      at: now,
      metrics: new Map([["second", stats(2_000)]]),
    });
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.refreshedAt, 0);
    assertEquals(reader.get(160)?.runAttempt, 2);
    assertEquals(reader.get(160, 1)?.metrics.has("first"), true);
    assertEquals(
      reader.refreshedRuns()?.map((run) => run.runAttempt),
      [1],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history can replace an in-process future refresh", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const run = store.set({
      runId: 170,
      runAttempt: 1,
      at: now,
      metrics: new Map([["current", stats(1_000)]]),
    });
    store.markRefreshed(now + DAY_MS, [run], "data");
    await store.save(now);

    assertEquals(store.quarantineFuture(now), true);
    await store.save(now);
    store.markRefreshed(now, [run], "data");
    await store.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.refreshedAt, now);
    assertEquals(reader.refreshedRuns()?.[0].runAttempt, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history drops freshness with a malformed run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    const refreshed = writer.set({
      runId: 175,
      runAttempt: 1,
      at: now,
      metrics: new Map([["valid", stats(1_000)]]),
    });
    writer.set(localRun(176, now - DAY_MS));
    writer.markRefreshed(now, [refreshed]);
    await writer.save(now);

    await Deno.writeFile(`${history}/999-1.run`, new Uint8Array([1, 2, 3]));
    const unrelated = new BenchmarkHistoryStore(history);
    await unrelated.load();
    assertEquals(unrelated.refreshedRuns()?.map((run) => run.runId), [175]);

    await Deno.writeFile(`${history}/175-1.run`, new Uint8Array([1, 2, 3]));
    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [176]);
    assertEquals(reader.refreshedAt, 0);
    assertEquals(reader.refreshedRuns(), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history prunes entries outside its retention window", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set({
      runId: 201,
      runAttempt: 1,
      at: now - (BENCHMARK_HISTORY_CACHE_DAYS + 1) * DAY_MS,
      metrics: new Map([["old", stats(2_000)]]),
    });
    store.set({
      runId: 202,
      runAttempt: 1,
      at: now,
      metrics: new Map([["current", stats(3_000)]]),
    });
    await store.save(now - BENCHMARK_HISTORY_CACHE_DAYS * DAY_MS);

    const loaded = new BenchmarkHistoryStore(history);
    await loaded.load();
    assertEquals(loaded.list().map((run) => run.runId), [201, 202]);
    await loaded.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [202]);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(history)))
        .map((entry) => entry.name)
        .sort(),
      ["202-1.run", "state.json"],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history merges writes from concurrent stores", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const first = new BenchmarkHistoryStore(history);
    const second = new BenchmarkHistoryStore(history);
    await Promise.all([first.load(), second.load()]);
    first.set({
      runId: 301,
      runAttempt: 1,
      at: now - DAY_MS,
      metrics: new Map([["first", stats(4_000)]]),
    });
    second.set({
      runId: 302,
      runAttempt: 1,
      at: now,
      metrics: new Map([["second", stats(5_000)]]),
    });

    await Promise.all([first.save(now), second.save(now)]);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [301, 302]);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(directory))).filter((entry) =>
        entry.name.endsWith(".tmp")
      ),
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history coalesces concurrent saves from one store", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set({
      runId: 350,
      runAttempt: 1,
      at: Date.now(),
      metrics: new Map([["current", stats(5_000)]]),
    });
    await Promise.all([store.save(), store.save()]);
    assertEquals(store.dirty, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history replaces a state file that does not decode", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const now = Date.now();
  const states = [
    "{not json",
    "[]",
    JSON.stringify({ invalidatedAt: -1 }),
    JSON.stringify({ refresh: null, invalidatedAt: "soon" }),
    JSON.stringify({ refresh: { refreshedAt: now, runs: [null] } }),
  ];
  try {
    for (const [index, state] of states.entries()) {
      const history = `${directory}/${index}`;
      await Deno.mkdir(history);
      await Deno.writeTextFile(`${history}/state.json`, state);
      const store = new BenchmarkHistoryStore(history);
      await store.load();
      assertEquals(store.refresh, null);
      const run = store.set(localRun(401, now));
      store.markRefreshed(now, [run]);
      await store.save(now);

      const reader = new BenchmarkHistoryStore(history);
      await reader.load();
      assertEquals(reader.refreshedRuns()?.map((value) => value.runId), [401]);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history keeps what checks out of a malformed legacy file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const now = Date.now();
  const valid = {
    runId: 502,
    runAttempt: 1,
    at: now - DAY_MS,
    metrics: { kept: stats(2_000) },
  };
  const validText = JSON.stringify(valid);
  const cases: { legacy: string; runs: number[]; refreshed?: number[] }[] = [
    { legacy: "{not json", runs: [] },
    { legacy: "null", runs: [] },
    { legacy: JSON.stringify({ version: 2, runs: [valid] }), runs: [] },
    {
      legacy: `{"version":1,"runs":[${validText},{"runId":3,,}],` +
        `"refresh":{"refreshedAt":${now},"runs":[{"runId":502,"runAttempt":1}]}}`,
      runs: [502],
      refreshed: [502],
    },
    {
      legacy: `{"version":1,"runs":[${validText},{"runId":3,"at":`,
      runs: [502],
    },
    {
      legacy: JSON.stringify({
        version: 1,
        runs: [
          valid,
          { runId: 1, runAttempt: 1, at: now, metrics: { bad: null } },
          null,
        ],
        refresh: {
          refreshedAt: now,
          runs: [{ runId: 502, runAttempt: 1 }],
          result: "data",
        },
      }),
      runs: [502],
      refreshed: [502],
    },
    {
      legacy: JSON.stringify({ version: 1, runs: [valid], invalidatedAt: -1 }),
      runs: [502],
    },
  ];
  try {
    for (const [index, testCase] of cases.entries()) {
      const history = `${directory}/${index}`;
      await Deno.writeTextFile(`${history}.json`, testCase.legacy);
      const store = new BenchmarkHistoryStore(history);
      await store.load();
      assertEquals(store.dirty, true);
      assertEquals(store.list().map((run) => run.runId), testCase.runs);
      assertEquals(
        store.refreshedRuns()?.map((run) => run.runId) ?? null,
        testCase.refreshed ?? null,
      );
      store.set(localRun(501, now));
      await store.save(now);
      assertEquals(
        await Deno.stat(`${history}.json`).then(() => true, () => false),
        false,
      );

      const reader = new BenchmarkHistoryStore(history);
      await reader.load();
      assertEquals(
        reader.list().map((run) => run.runId),
        [...testCase.runs, 501],
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history refuses to save past an invalidation in the future", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set(localRun(503, now));
    await Deno.mkdir(history);
    await Deno.writeTextFile(
      `${history}/state.json`,
      JSON.stringify({ invalidatedAt: now + DAY_MS }),
    );
    await assertRejects(
      () => store.save(now),
      Error,
      "Invalid runtime benchmark refresh invalidation",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history refreshes legacy manifests without dropping their runs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    await Deno.writeTextFile(
      `${history}.json`,
      JSON.stringify({
        version: 1,
        runs: [{
          runId: 550,
          runAttempt: 1,
          at: now,
          metrics: { current: stats(1_000) },
        }],
        refresh: {
          refreshedAt: now,
          runs: [{ runId: 550, runAttempt: 1 }],
        },
      }),
    );
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.refresh?.result, "data");
    assertEquals(store.refresh?.samplingVersion, undefined);
    assertEquals(store.refreshedAt, 0);
    assertEquals(store.refreshedRuns()?.map((run) => run.runId), [550]);

    store.markRefreshed(now, store.list());
    assertEquals(
      store.refresh?.samplingVersion,
      BENCHMARK_HISTORY_SAMPLING_VERSION,
    );
    assertEquals(store.refreshedAt, now);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history validates refresh state transitions", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const run = store.set({
      runId: 601,
      runAttempt: 1,
      at: now,
      metrics: new Map([["current", stats(2_000)]]),
    });
    assertEquals(store.set(run), run);
    assertEquals(store.list(now + 1), []);
    assertEquals(store.markRefreshed(Number.NaN, [run]), null);
    assertThrows(
      () => {
        store.markRefreshed(now, [{ ...run, runId: 999 }]);
      },
      Error,
      "contains an uncached run",
    );

    store.markRefreshed(now, [run], "data");
    const refresh = store.refresh!;
    assertEquals(store.markRefreshed(now - 1, [run]), refresh);
    store.restoreRefresh(null);
    assertEquals(store.refresh, null);
    store.restoreRefresh(refresh);
    assertEquals(store.refreshedRuns()?.map((value) => value.runId), [601]);

    store.invalidateRefresh(now + DAY_MS);
    store.invalidateRefresh(now);
    assertEquals(store.quarantineFuture(now), true);
    assertEquals(store.quarantineFuture(now), true);
    await store.save(now);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history drops a refresh whose retained run is pruned", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const old = store.set({
      runId: 701,
      runAttempt: 1,
      at: now - (BENCHMARK_HISTORY_CACHE_DAYS + 1) * DAY_MS,
      metrics: new Map([["old", stats(3_000)]]),
    });
    store.markRefreshed(now - DAY_MS, [old]);
    await store.save(now);
    assertEquals(store.refresh, null);
    assertEquals(store.refreshedRuns(), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history removes a temporary file after rename fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const rename = Deno.rename;
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set({
      runId: 801,
      runAttempt: 1,
      at: Date.now(),
      metrics: new Map([["current", stats(4_000)]]),
    });
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    await assertRejects(() => store.save(), Error, "rename failed");
    Deno.rename = rename;
    assertEquals(await temporaryFiles(history), []);
    assertEquals(store.dirty, true);
    await store.save();
    assertEquals(await temporaryFiles(history), []);
    assertEquals(store.dirty, false);
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads a series cached under `packages/` by its current path", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set({
      runId: 101,
      runAttempt: 1,
      at: now - DAY_MS,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([
        ["packages/runner/bench/a.bench.ts > works", stats(1_000)],
        ["packages/bakery/a.bench.ts > works", stats(2_000)],
      ]),
    });
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals([...(reader.get(101)?.metrics.keys() ?? [])], [
      "runtime/runner/bench/a.bench.ts > works",
      "packages/bakery/a.bench.ts > works",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const runBytes = (header: unknown, values: number[]): Uint8Array => {
  const text = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(4 + text.length + values.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, text.length, true);
  bytes.set(text, 4);
  values.forEach((value, index) =>
    view.setFloat64(4 + text.length + index * 8, value, true)
  );
  return bytes;
};

const STAT_NAMES = [
  "min",
  "avg",
  "max",
  "p75",
  "p99",
  "p995",
  "p999",
] as const;

const row = (value: BenchmarkStats): number[] =>
  STAT_NAMES.map((name) => value[name]);

const localRun = (runId: number, at: number) => ({
  runId,
  runAttempt: 1,
  at,
  metrics: new Map([["local", stats(runId)]]),
});

Deno.test("runtime benchmark history moves a legacy JSON file into its directory", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    await Deno.writeTextFile(
      `${history}.json`,
      JSON.stringify({
        version: 1,
        refresh: {
          refreshedAt: now - 1_000,
          samplingVersion: 1,
          runs: [{ runId: 901, runAttempt: 1 }, { runId: 902, runAttempt: 2 }],
          result: "data",
        },
        runs: [{
          runId: 901,
          runAttempt: 1,
          at: now - DAY_MS,
          cpu: "AMD EPYC 7763 64-Core Processor",
          metrics: {
            "packages/runner/bench/a.bench.ts > works": stats(1_000),
            'runtime/b.bench.ts > "quoted" ] , {': stats(1_234.5678),
          },
        }, {
          runId: 902,
          runAttempt: 2,
          at: now,
          cpu: "AMD EPYC 9V74 80-Core Processor",
          metrics: {},
        }],
      }),
    );
    const leftovers = [
      `${history}.json.0b5c2c4e-6c3e-4b8e-9d8a-1f6c2e0d9a11.tmp`,
      `${directory}/other.json.tmp`,
    ];
    for (const path of leftovers) await Deno.writeTextFile(path, "partial");

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.dirty, true);
    assertEquals(await temporaryFiles(directory), ["other.json.tmp"]);
    assertEquals(
      [...(store.get(901)?.metrics.keys() ?? [])],
      [
        "runtime/runner/bench/a.bench.ts > works",
        'runtime/b.bench.ts > "quoted" ] , {',
      ],
    );
    assertEquals(store.refreshedAt, now - 1_000);
    await store.save(now);
    assertEquals(
      await Deno.stat(`${history}.json`).then(() => true, () => false),
      false,
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(history)))
        .map((entry) => entry.name)
        .sort(),
      ["901-1.run", "902-2.run", "state.json"],
    );

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.dirty, false);
    assertEquals(
      reader.get(901)?.metrics.get('runtime/b.bench.ts > "quoted" ] , {')
        ?.p75,
      1_234.5678 * 0.75,
    );
    assertEquals(reader.get(902, 2)?.metrics.size, 0);
    assertEquals(reader.get(902, 2)?.cpu, "AMD EPYC 9V74 80-Core Processor");
    assertEquals(reader.refreshedAt, now - 1_000);
    assertEquals(
      reader.refreshedRuns()?.map((run) => [run.runId, run.runAttempt]),
      [[901, 1], [902, 2]],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history merges a legacy JSON file found beside its directory", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set({
      runId: 911,
      runAttempt: 1,
      at: now - DAY_MS,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([["directory", stats(1_000)]]),
    });
    await writer.save(now);
    await Deno.writeTextFile(
      `${history}.json`,
      JSON.stringify({
        version: 1,
        runs: [{
          runId: 912,
          runAttempt: 1,
          at: now,
          cpu: "AMD EPYC 7763 64-Core Processor",
          metrics: { legacy: stats(2_000) },
        }],
      }),
    );

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.list().map((run) => run.runId), [911, 912]);
    await store.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [911, 912]);
    assertEquals(reader.get(912)?.metrics.get("legacy")?.p99, 2_000);
    assertEquals(
      await Deno.stat(`${history}.json`).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history writes each run as a JSON header and little-endian floats", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set({
      runId: 921,
      runAttempt: 3,
      at: now,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([["b", stats(2_000)], ["a", stats(0.1)]]),
    });
    await store.save(now);

    assertEquals(
      await Deno.readFile(`${history}/921-3.run`),
      runBytes({
        runId: 921,
        runAttempt: 3,
        at: now,
        cpu: "AMD EPYC 7763 64-Core Processor",
        stats: STAT_NAMES,
        keys: ["b", "a"],
      }, [...row(stats(2_000)), ...row(stats(0.1))]),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads statistics by name and ignores what it does not know", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    await Deno.mkdir(history);
    const names = ["p999", "future", ...STAT_NAMES.slice(0, 6)];
    const values = (value: BenchmarkStats) => [
      value.p999,
      -1,
      ...row(value).slice(0, 6),
    ];
    await Deno.writeFile(
      `${history}/931-1.run`,
      runBytes({
        runId: 931,
        runAttempt: 1,
        at: now,
        cpu: "AMD EPYC 7763 64-Core Processor",
        added: { anything: true },
        stats: names,
        keys: ["first", "second"],
      }, [...values(stats(1_000)), ...values(stats(3_000))]),
    );
    await Deno.writeFile(
      `${history}/932-1.run`,
      runBytes({
        runId: 932,
        runAttempt: 1,
        at: now,
        stats: STAT_NAMES.slice(1),
        keys: ["first"],
      }, row(stats(1_000)).slice(1)),
    );

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.list().map((run) => run.runId), [931]);
    assertEquals(store.get(931)?.metrics.get("second")?.p999, 3_000 * 1.1);
    assertEquals(
      JSON.parse(JSON.stringify(store.get(931)?.metrics.get("first"))),
      stats(1_000),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history removes run files that do not decode", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const header = {
    runId: 941,
    runAttempt: 1,
    at: now,
    stats: STAT_NAMES,
    keys: ["valid"],
  };
  const invalid: Record<string, Uint8Array> = {
    "941-1.run": new Uint8Array([1, 2]),
    "941-2.run": runBytes(header, row(stats(1_000))),
    "941-3.run": runBytes(
      { ...header, runAttempt: 3 },
      row(stats(1_000)).slice(1),
    ),
    "941-5.run": runBytes(
      { ...header, runId: "941", runAttempt: 5 },
      row(stats(1_000)),
    ),
    "941-6.run": runBytes(
      { ...header, runAttempt: 6, keys: [6] },
      row(stats(1_000)),
    ),
    "941-7.run": new Uint8Array([255, 0, 0, 0, 123]),
  };
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    const valid = writer.set({
      runId: 942,
      runAttempt: 1,
      at: now,
      metrics: new Map([["valid", stats(2_000)]]),
    });
    writer.markRefreshed(now, [valid]);
    await writer.save(now);
    for (const [name, bytes] of Object.entries(invalid)) {
      await Deno.writeFile(`${history}/${name}`, bytes);
    }
    // A name that is not the canonical name of a run is not a run file.
    await Deno.writeFile(
      `${history}/0942-1.run`,
      runBytes({ ...header, runId: 942 }, row(stats(3_000))),
    );

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.list().map((run) => run.runId), [942]);
    assertEquals(store.get(942)?.metrics.get("valid")?.p99, 2_000);
    assertEquals(store.refreshedRuns()?.map((run) => run.runId), [942]);
    for (const name of Object.keys(invalid)) {
      assertEquals(
        await Deno.stat(`${history}/${name}`).then(() => true),
        true,
      );
    }

    store.set({ ...localRun(943, now) });
    await store.save(now);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(history)))
        .map((entry) => entry.name)
        .sort(),
      ["0942-1.run", "942-1.run", "943-1.run", "state.json"],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history drops a refresh that names a missing run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    const first = writer.set(localRun(951, now - 2 * DAY_MS));
    const second = writer.set(localRun(952, now - DAY_MS));
    writer.markRefreshed(now, [first, second]);
    await writer.save(now);
    await Deno.remove(`${history}/951-1.run`);

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.list().map((run) => run.runId), [952]);
    assertEquals(store.refreshedRuns(), null);
    store.set(localRun(953, now));
    await store.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [952, 953]);
    assertEquals(reader.refresh, null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history removes temporary files that interrupted writes left", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  try {
    await Deno.mkdir(history);
    await Deno.writeTextFile(`${history}/951-1.run.1234.tmp`, "partial");
    await Deno.writeTextFile(`${history}/state.json.5678.tmp`, "partial");
    await Deno.writeTextFile(
      `${directory}/history.json.0b5c2c4e-6c3e-4b8e-9d8a-1f6c2e0d9a11.tmp`,
      "partial",
    );
    await Deno.writeTextFile(`${directory}/history-other.json.tmp`, "kept");

    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(await temporaryFiles(history), []);
    assertEquals(await temporaryFiles(directory), ["history-other.json.tmp"]);
    assertEquals(store.dirty, false);

    await Deno.writeTextFile(`${history}/952-1.run.1234.tmp`, "partial");
    await Deno.writeTextFile(
      `${directory}/history.json.6f1d3a52-9b7e-4c1a-8e2f-3d4c5b6a7e8f.tmp`,
      "partial",
    );
    const saver = new BenchmarkHistoryStore(history);
    saver.set(localRun(952, Date.now()));
    await saver.save();
    assertEquals(await temporaryFiles(history), []);
    assertEquals(await temporaryFiles(directory), ["history-other.json.tmp"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history picks up a processor another store recorded", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const first = new BenchmarkHistoryStore(history);
    await first.load();
    first.set({
      runId: 961,
      runAttempt: 1,
      at: now,
      metrics: new Map([["before", stats(1_000)]]),
    });
    await first.save(now);

    const second = new BenchmarkHistoryStore(history);
    await second.load();
    second.set({
      runId: 961,
      runAttempt: 1,
      at: now,
      cpu: "AMD EPYC 7763 64-Core Processor",
      metrics: new Map([["after", stats(2_000)]]),
    });
    await second.save(now);

    first.set({
      runId: 962,
      runAttempt: 1,
      at: now,
      metrics: new Map(),
    });
    await first.save(now);
    assertEquals(first.get(961)?.cpu, "AMD EPYC 7763 64-Core Processor");
    assertEquals(first.get(961)?.metrics.has("after"), true);
    assertEquals(first.get(961)?.metrics.has("before"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads a run's metrics like a map", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const run = store.set({
      runId: 971,
      runAttempt: 1,
      at: Date.now(),
      metrics: new Map([
        ["runtime/runner/bench/a.bench.ts > works", stats(1_000)],
        ["z", stats(2_000)],
        ["packages/runner/bench/a.bench.ts > works", stats(3_000)],
      ]),
    });
    const metrics = run.metrics;
    assertEquals(metrics.size, 2);
    assertEquals([...metrics.keys()], [
      "runtime/runner/bench/a.bench.ts > works",
      "z",
    ]);
    assertEquals(
      metrics.get("runtime/runner/bench/a.bench.ts > works")?.p99,
      3_000,
    );
    assertEquals(metrics.has("z"), true);
    assertEquals(
      metrics.has("packages/runner/bench/a.bench.ts > works"),
      false,
    );
    assertEquals(metrics.get("missing"), undefined);
    assertEquals([...metrics.values()].map((value) => value.min), [750, 500]);
    assertEquals(
      [...metrics].map(([key, value]) => [key, value.avg]),
      [["runtime/runner/bench/a.bench.ts > works", 1_500], ["z", 1_000]],
    );
    const seen: string[] = [];
    metrics.forEach((value, key, map) => {
      assertEquals(map, metrics);
      seen.push(`${key}:${value.max}`);
    });
    assertEquals(seen, [
      "runtime/runner/bench/a.bench.ts > works:6000",
      "z:4000",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history saves only the runs missing from disk", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const inode = async (name: string) =>
    (await Deno.stat(`${history}/${name}`)).ino;
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set(localRun(961, now - DAY_MS));
    await writer.save(now);
    const first = await inode("961-1.run");

    writer.set(localRun(962, now));
    await writer.save(now);
    assertEquals(await inode("961-1.run"), first);

    const other = new BenchmarkHistoryStore(history);
    await other.load();
    await Deno.remove(`${history}/962-1.run`);
    other.set(localRun(963, now));
    await other.save(now);
    assertEquals(await inode("961-1.run"), first);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(history)))
        .map((entry) => entry.name)
        .sort(),
      ["961-1.run", "962-1.run", "963-1.run", "state.json"],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history leaves runs another store moved out of a legacy file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    await Deno.writeTextFile(
      `${history}.json`,
      JSON.stringify({
        version: 1,
        runs: [{
          runId: 971,
          runAttempt: 1,
          at: now,
          metrics: { legacy: stats(1_000) },
        }],
      }),
    );
    const first = new BenchmarkHistoryStore(history);
    const second = new BenchmarkHistoryStore(history);
    await Promise.all([first.load(), second.load()]);
    await first.save(now);
    const moved = (await Deno.stat(`${history}/971-1.run`)).ino;

    second.set(localRun(972, now));
    await second.save(now);
    assertEquals((await Deno.stat(`${history}/971-1.run`)).ino, moved);
    assertEquals(second.dirty, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history creates a missing cache directory", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/missing/cache/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set(localRun(981, now));
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [981]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history loads again after a load fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const blocker = `${directory}/blocker`;
  try {
    await Deno.writeTextFile(blocker, "not a directory");
    const store = new BenchmarkHistoryStore(`${blocker}/history`);
    await assertRejects(() => store.load());
    await Deno.remove(blocker);
    await store.load();
    assertEquals(store.list(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads a legacy file's runs wherever they sit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const run = JSON.stringify({
    runId: 991,
    runAttempt: 1,
    at: now,
    metrics: { "a > [b], {c}": stats(1_000) },
  });
  try {
    await Deno.writeTextFile(
      `${history}.json`,
      `{ "other": [[1], {"runs": []}], "runs" : [ ${run} ] ,\n"version": 1 }`,
    );
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    assertEquals(store.list().map((value) => value.runId), [991]);
    assertEquals(
      store.get(991)?.metrics.get("a > [b], {c}")?.p99,
      1_000,
    );

    for (const malformed of ['{"version":1,"runs":[,{}]}', '{"runs":[,]}']) {
      const reader = new BenchmarkHistoryStore(
        `${history}-${malformed.length}`,
      );
      await Deno.writeTextFile(
        `${history}-${malformed.length}.json`,
        malformed,
      );
      await reader.load();
      assertEquals(reader.list(), []);
      await reader.save(now);
      assertEquals(
        await Deno.stat(`${history}-${malformed.length}.json`).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history writes run files before the state that names them", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const rename = Deno.rename;
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const first = store.set(localRun(1001, now - DAY_MS));
    store.markRefreshed(now - 1, [first]);
    await store.save(now);
    const state = await Deno.readTextFile(`${history}/state.json`);

    const second = store.set(localRun(1002, now));
    store.markRefreshed(now, [first, second]);
    Deno.rename = ((from, to) =>
      String(to).endsWith(".run")
        ? Promise.reject(new Error("rename failed"))
        : rename(from, to)) as typeof Deno.rename;
    await assertRejects(
      () =>
        store.save(now),
      Error,
      "rename failed",
    );
    assertEquals(await Deno.readTextFile(`${history}/state.json`), state);
    Deno.rename = rename;

    await store.save(now);
    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(
      reader.refreshedRuns()?.map((run) => run.runId),
      [1001, 1002],
    );
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history keeps measurements that are not finite", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(history);
    await writer.load();
    writer.set({
      runId: 1011,
      runAttempt: 1,
      at: now,
      metrics: new Map([[
        "unbounded",
        { ...stats(1_000), max: Infinity, p999: Number.NaN },
      ]]),
    });
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    const read = reader.get(1011)?.metrics.get("unbounded");
    assertEquals(read?.max, Infinity);
    assertEquals(read?.p999, Number.NaN);
    assertEquals(read?.p99, 1_000);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history shares benchmark names and releases unused ones", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const measured = (runId: number, at: number, keys: string[]) => ({
    runId,
    runAttempt: 1,
    at,
    metrics: new Map(keys.map((key) => [key, stats(runId)])),
  });
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set(measured(1031, now - 1_000, ["a", "b"]));
    store.set(measured(1032, now, ["a", "b"]));
    assertEquals(store.accessForTestingOnly.nameLists, 1);
    store.set(
      measured(1033, now - (BENCHMARK_HISTORY_CACHE_DAYS + 1) * DAY_MS, ["c"]),
    );
    assertEquals(store.accessForTestingOnly.nameLists, 2);
    await store.save(now);
    assertEquals(store.accessForTestingOnly.nameLists, 1);
    store.set(measured(1034, now - DAY_MS, ["only"]));
    await store.save(now);

    // The legacy copy of 1034 is read first, so the directory's copy, and its
    // list of names, goes unused.
    await Deno.writeTextFile(
      `${history}.json`,
      JSON.stringify({
        version: 1,
        runs: [{
          ...measured(1034, now - DAY_MS, []),
          metrics: { z: stats(1) },
        }],
      }),
    );
    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [1034, 1031, 1032]);
    assertEquals([...(reader.get(1034)?.metrics.keys() ?? [])], ["z"]);
    assertEquals(reader.accessForTestingOnly.nameLists, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history saves a run recorded while a save is in progress", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  const rename = Deno.rename;
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    store.set(localRun(1041, now - DAY_MS));
    await store.save(now);

    let recorded = false;
    Deno.rename = ((from, to) => {
      if (!recorded) {
        recorded = true;
        store.set({
          ...localRun(1041, now - DAY_MS),
          cpu: "AMD EPYC 7763 64-Core Processor",
        });
      }
      return rename(from, to);
    }) as typeof Deno.rename;
    store.set(localRun(1042, now));
    await store.save(now);
    Deno.rename = rename;
    assertEquals(store.dirty, true);
    await store.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.get(1041)?.cpu, "AMD EPYC 7763 64-Core Processor");
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads a legacy file that spans many reads", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  // Names dense in multi-byte characters, escapes, and JSON punctuation, at
  // odd and even offsets, so the boundaries between reads fall inside each.
  const names = Array.from(
    { length: 40 },
    (_, index) =>
      `${"x".repeat(index % 2)}${"\\".repeat(300)}"}},é😀[]{},:${
        "ü".repeat(index)
      }"\\ > ${index} 漢字`,
  );
  const runs = Array.from({ length: 300 }, (_, index) => ({
    runId: 2000 + index,
    runAttempt: 1,
    at: now - index * 1_000,
    cpu: `CPU "${index % 3}" é`,
    metrics: Object.fromEntries(
      names.map((name, row) => [name, stats(index * 100 + row + 0.5)]),
    ),
  }));
  try {
    const text = JSON.stringify({
      version: 1,
      refresh: {
        refreshedAt: now,
        samplingVersion: 1,
        runs: [{ runId: 2000, runAttempt: 1 }],
        result: "data",
      },
      runs,
    });
    assertEquals(text.length > 1_000_000, true);
    await Deno.writeTextFile(`${history}.json`, text);
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    await store.save(now);

    const reader = new BenchmarkHistoryStore(history);
    await reader.load();
    assertEquals(reader.refreshedRuns()?.map((run) => run.runId), [2000]);
    assertEquals(reader.list().length, runs.length);
    for (const run of runs) {
      const read = reader.get(run.runId);
      assertEquals(read?.cpu, run.cpu);
      assertEquals(
        [...(read?.metrics ?? [])].map(([key, value]) => [key, row(value)]),
        Object.entries(run.metrics).map(([key, value]) => [key, row(value)]),
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history orders runs created together by run number", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const history = `${directory}/history`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(history);
    await store.load();
    const later = store.set(localRun(1052, now));
    const earlier = store.set(localRun(1051, now));
    assertEquals(store.list().map((run) => run.runId), [1051, 1052]);
    store.markRefreshed(now, [later, earlier]);
    assertEquals(
      store.refreshedRuns()?.map((run) => run.runId),
      [1051, 1052],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
