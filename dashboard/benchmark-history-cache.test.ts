import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BENCHMARK_HISTORY_CACHE_DAYS,
  BENCHMARK_HISTORY_SAMPLING_VERSION,
  BenchmarkHistoryStore,
  type BenchmarkStats,
} from "./benchmark-history-cache.ts";

const DAY_MS = 86_400_000;

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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
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
    assertEquals(
      await Deno.stat(`${file}.tmp`).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history replaces CPU-less data", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const legacy = new BenchmarkHistoryStore(file);
    await legacy.load();
    legacy.set({
      runId: 125,
      runAttempt: 1,
      at: now,
      metrics: new Map([["runtime/a.bench.ts > works", stats(1_000)]]),
    });
    await legacy.save(now);

    const migrated = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(file);
    await writer.load();
    writer.set({
      runId: 150,
      runAttempt: 1,
      at: now,
      metrics: new Map([["old", stats(1_000)]]),
    });
    writer.markRefreshed(now, []);
    await writer.save(now);

    const reader = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
    await reader.load();
    assertEquals(reader.refreshedAt, now);
    assertEquals(reader.refreshedRuns()?.[0].runAttempt, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history drops freshness with a malformed run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(file);
    await writer.load();
    writer.set({
      runId: 175,
      runAttempt: 1,
      at: now,
      metrics: new Map([["valid", stats(1_000)]]),
    });
    writer.markRefreshed(now, writer.list());
    await writer.save(now);
    const persisted = JSON.parse(await Deno.readTextFile(file));
    persisted.runs.push({ runId: "invalid" });
    await Deno.writeTextFile(file, JSON.stringify(persisted));

    const reader = new BenchmarkHistoryStore(file);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [175]);
    assertEquals(reader.refreshedAt, 0);
    assertEquals(reader.refreshedRuns(), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history prunes entries outside its retention window", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(file);
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

    const loaded = new BenchmarkHistoryStore(file);
    await loaded.load();
    assertEquals(loaded.list().map((run) => run.runId), [201, 202]);
    await loaded.save(now);

    const reader = new BenchmarkHistoryStore(file);
    await reader.load();
    assertEquals(reader.list().map((run) => run.runId), [202]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history merges writes from concurrent stores", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const first = new BenchmarkHistoryStore(file);
    const second = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  try {
    const store = new BenchmarkHistoryStore(file);
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

Deno.test("runtime benchmark history does not replace an unreadable cache", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const malformed = "{not json";
  try {
    const store = new BenchmarkHistoryStore(file);
    await store.load();
    store.set({
      runId: 401,
      runAttempt: 1,
      at: Date.now(),
      metrics: new Map([["local", stats(6_000)]]),
    });
    await Deno.writeTextFile(file, malformed);

    await assertRejects(() => store.save());
    assertEquals(await Deno.readTextFile(file), malformed);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history rejects malformed cache structures before merging", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const now = Date.now();
  const localRun = {
    runId: 501,
    runAttempt: 1,
    at: now,
    metrics: new Map([["local", stats(1_000)]]),
  };
  const cases: { value: unknown; message: string }[] = [
    { value: null, message: "Invalid runtime benchmark history cache" },
    {
      value: { version: 2, runs: [] },
      message: "Unsupported runtime benchmark history cache format",
    },
    {
      value: {
        version: 1,
        runs: [{ runId: 1, runAttempt: 1, at: now, metrics: { bad: null } }],
      },
      message: "Invalid runtime benchmark history cache entry",
    },
    {
      value: { version: 1, runs: [], invalidatedAt: -1 },
      message: "Invalid runtime benchmark refresh invalidation",
    },
    {
      value: {
        version: 1,
        runs: [],
        refresh: { refreshedAt: now, runs: [null] },
      },
      message: "Invalid runtime benchmark refresh manifest",
    },
    {
      value: { version: 1, runs: [null] },
      message: "Invalid runtime benchmark history cache entry",
    },
    {
      value: { version: 1, runs: [], refresh: null },
      message: "Invalid runtime benchmark refresh manifest",
    },
    {
      value: {
        version: 1,
        runs: [],
        refresh: {
          refreshedAt: now,
          runs: [{ runId: 999, runAttempt: 1 }],
          result: "data",
        },
      },
      message: "references a missing run",
    },
  ];
  try {
    for (const [index, testCase] of cases.entries()) {
      const file = `${directory}/${index}.json`;
      await Deno.writeTextFile(file, JSON.stringify(testCase.value));
      const store = new BenchmarkHistoryStore(file);
      await store.load();
      assertEquals(store.list(), []);
      store.set(localRun);
      await assertRejects(() => store.save(now), Error, testCase.message);
    }

    const futureFile = `${directory}/future-strict.json`;
    const futureStore = new BenchmarkHistoryStore(futureFile);
    await futureStore.load();
    futureStore.set(localRun);
    await Deno.writeTextFile(
      futureFile,
      JSON.stringify({
        version: 1,
        invalidatedAt: now + DAY_MS,
        runs: [],
      }),
    );
    await assertRejects(
      () => futureStore.save(now),
      Error,
      "Invalid runtime benchmark refresh invalidation",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history refreshes legacy manifests without dropping their runs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    await Deno.writeTextFile(
      file,
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
    const store = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const store = new BenchmarkHistoryStore(file);
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
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  try {
    const store = new BenchmarkHistoryStore(file);
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
    assertEquals(
      [...Deno.readDirSync(directory)].some((entry) =>
        entry.name.endsWith(".tmp")
      ),
      false,
    );
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history preserves a write error when temporary cleanup fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  const remove = Deno.remove;
  try {
    const store = new BenchmarkHistoryStore(file);
    await store.load();
    store.set({
      runId: 802,
      runAttempt: 1,
      at: Date.now(),
      metrics: new Map([["current", stats(4_000)]]),
    });
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    Deno.remove = ((path, options) =>
      String(path).endsWith(".tmp")
        ? Promise.reject(new Error("remove failed"))
        : remove(path, options)) as typeof Deno.remove;
    await assertRejects(
      () =>
        store.save(),
      Error,
      "rename failed",
    );
  } finally {
    Deno.rename = rename;
    Deno.remove = remove;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark history reads a series cached under `packages/` by its current path", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const file = `${directory}/history.json`;
  const now = Date.now();
  try {
    const writer = new BenchmarkHistoryStore(file);
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

    const reader = new BenchmarkHistoryStore(file);
    await reader.load();
    assertEquals([...(reader.get(101)?.metrics.keys() ?? [])], [
      "runtime/runner/bench/a.bench.ts > works",
      "packages/bakery/a.bench.ts > works",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
