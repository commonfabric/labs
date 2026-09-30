import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { AliasResolver } from "@commonfabric/test-support/records";

import {
  collectDay,
  type DayAggregate,
  isDayAggregate,
  TestRecordsHistoryStore,
} from "./test-records-history.ts";

// A listing response naming one object, then that object's NDJSON body.
function storeFetch(records: string[]): typeof fetch {
  return ((input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/storage/v1/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ name: "labs/test-records/submissions/ci/v1/2026/08/16/run-1.ndjson" }],
          }),
          { status: 200 },
        ),
      );
    }
    const context = JSON.stringify({
      schema: 1,
      line: "context",
      reportId: "01HISTORY000000000000000",
      repo: "commonfabric/labs",
      commit: "a".repeat(40),
      dirty: false,
      env: "ci",
      ci: { workflowRunId: "1", runAttempt: 1, workflow: "CI", job: "Check" },
      os: "linux",
      arch: "x86_64",
      denoVersion: "2.9.4",
      startedAt: "2026-08-16T01:00:00Z",
    });
    return Promise.resolve(
      new Response([context, ...records].join("\n") + "\n", { status: 200 }),
    );
  }) as typeof fetch;
}

const PASS = JSON.stringify({
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze" },
  outcome: "pass",
  durationMs: 100,
});
const FAIL = JSON.stringify({
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze" },
  outcome: "fail",
  durationMs: 300,
});
const FORK_PASS = JSON.stringify({
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze" },
  outcome: "pass",
  durationMs: 50,
});

Deno.test("collectDay aggregates runs, failures, and durations per identity", async () => {
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([PASS, FAIL, "not a record"]),
  });
  assertEquals(aggregates, [{
    key: '["unit","bakery","glaze"]',
    day: "2026/08/16",
    runs: 2,
    failures: 1,
    skips: 0,
    totalDurationMs: 100,
    maxDurationMs: 100,
  }]);
  assertEquals(isDayAggregate(aggregates[0]), true);
});

Deno.test("collectDay reads durations from passing records alone", async () => {
  // A failure ended by a wait's safety net reports that net's bound, so a
  // duration read from one describes the net rather than the test. Two
  // passing runs of different lengths follow it, so the total is a sum
  // and the worst is not simply the last one read.

  const passing = (durationMs: number) =>
    JSON.stringify({
      line: "record",
      test: { k: "unit", s: "bakery", n: "glaze" },
      outcome: "pass",
      durationMs,
    });
  const wedged = JSON.stringify({
    line: "record",
    test: { k: "unit", s: "bakery", n: "glaze" },
    outcome: "fail",
    durationMs: 300_000,
  });
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([wedged, passing(100), passing(40)]),
  });
  assertEquals(aggregates, [{
    key: '["unit","bakery","glaze"]',
    day: "2026/08/16",
    runs: 3,
    failures: 1,
    skips: 0,
    totalDurationMs: 140,
    maxDurationMs: 100,
  }]);
});

Deno.test("collectDay separates variant records from default history", async () => {
  const variant = JSON.stringify({
    line: "record",
    test: {
      k: "unit",
      s: "bakery",
      n: "glaze",
      v: "wood-fired",
    },
    outcome: "pass",
    durationMs: 200,
  });
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([PASS, variant]),
  });
  assertEquals(aggregates.map(({ key, runs }) => ({ key, runs })), [{
    key: '["unit","bakery","glaze","wood-fired"]',
    runs: 1,
  }, {
    key: '["unit","bakery","glaze"]',
    runs: 1,
  }]);
});

Deno.test("collectDay counts nothing for a lane measuring itself", async () => {
  // A lane writes what its setup and each of its batches cost through the
  // record machinery every test uses, so those arrive beside the tests they
  // were recorded with. A batch carries the duration of everything it ran.

  const laneBatch = JSON.stringify({
    line: "record",
    test: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
    outcome: "pass",
    durationMs: 322_500,
  });
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([PASS, laneBatch]),
  });
  assertEquals(aggregates.map(({ key }) => key), [
    '["unit","bakery","glaze"]',
  ]);
});

Deno.test("collectDay counts a fork run's report", async () => {
  // A body holding two reports, one from this repository and one from a fork.
  // See `docs/specs/test-records.md`, "Trust boundaries for consumers", for
  // what the store's member gate leaves the fork flag meaning. The fork
  // report carries a passing run as well as a failing one, so its runs and
  // its durations are both counted, and its failure's duration is not.

  const sameRepositoryContext = JSON.stringify({
    schema: 1,
    line: "context",
    reportId: "01HISTORYSAME00000000000",
    repo: "commonfabric/labs",
    commit: "a".repeat(40),
    dirty: false,
    env: "ci",
    ci: { workflowRunId: "1", runAttempt: 1, workflow: "CI", job: "Check" },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-16T01:00:00Z",
  });
  const forkContext = JSON.stringify({
    schema: 1,
    line: "context",
    reportId: "01HISTORYFORK00000000000",
    repo: "commonfabric/labs",
    commit: "b".repeat(40),
    dirty: false,
    env: "ci",
    ci: {
      workflowRunId: "2",
      runAttempt: 1,
      workflow: "CI",
      job: "Check",
      fork: true,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-16T02:00:00Z",
  });
  const fetchImpl = ((input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/storage/v1/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: [{ name: "x/run-1.ndjson" }] }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        [sameRepositoryContext, PASS, forkContext, FAIL, FORK_PASS]
          .join("\n") + "\n",
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  const aggregates = await collectDay("2026/08/16", { fetchImpl });
  assertEquals(aggregates, [{
    key: '["unit","bakery","glaze"]',
    day: "2026/08/16",
    runs: 3,
    failures: 1,
    skips: 0,
    totalDurationMs: 150,
    maxDurationMs: 100,
  }]);
});

Deno.test("collectDay resolves identities through the alias file", async () => {
  const aliases = new AliasResolver([{
    date: "2026-08-17",
    from: { k: "unit", s: "bakery", n: "glaze" },
    to: { k: "unit", s: "bakery", n: "glaze > sets" },
  }]);
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([PASS]),
    aliases,
  });
  assertEquals(aggregates[0]?.key, '["unit","bakery","glaze > sets"]');
});

Deno.test("collectDay asks the alias file nothing about a lane measurement", async () => {
  // What a record is, is read from the identity the lane wrote, so the
  // alias file cannot turn a lane's overhead into a test's history.

  const laneBatch = JSON.stringify({
    line: "record",
    test: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
    outcome: "pass",
    durationMs: 322_500,
  });
  const aggregates = await collectDay("2026/08/16", {
    fetchImpl: storeFetch([laneBatch]),
    aliases: new AliasResolver([{
      date: "2026-08-17",
      from: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
      to: { k: "unit", s: "bakery", n: "glaze" },
    }]),
  });
  assertEquals(aggregates, []);
});

Deno.test("isDayAggregate rejects inconsistent aggregates", () => {
  const sound: DayAggregate = {
    key: '["unit","bakery","glaze"]',
    day: "2026/08/16",
    runs: 2,
    failures: 1,
    skips: 0,
    totalDurationMs: 100,
    maxDurationMs: 100,
  };
  assertEquals(isDayAggregate(sound), true);
  assertEquals(
    isDayAggregate({
      ...sound,
      key: '["unit","bakery","glaze","wood-fired"]',
    }),
    true,
  );
  assertEquals(isDayAggregate({ ...sound, failures: 2, skips: 1 }), false);
  assertEquals(isDayAggregate({ ...sound, runs: 1.5 }), false);
  assertEquals(isDayAggregate({ ...sound, totalDurationMs: NaN }), false);
  assertEquals(isDayAggregate({ ...sound, maxDurationMs: -1 }), false);
  assertEquals(isDayAggregate({ ...sound, key: "not a triple" }), false);
  assertEquals(isDayAggregate({ ...sound, key: '["unit","bakery"]' }), false);
  assertEquals(
    isDayAggregate({ ...sound, key: '["unit","bakery","glaze",""]' }),
    false,
  );
});

Deno.test("the store refreshes missing days, persists, and reloads", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const file = join(directory, "history.json");
    const store = new TestRecordsHistoryStore(file);
    const now = Date.parse("2026-08-17T12:00:00Z");
    await store.refresh(now, {
      fetchImpl: storeFetch([PASS, FAIL]),
      windowDays: 2,
    });
    assertEquals(store.days(), ["2026/08/16", "2026/08/17"]);

    const reloaded = new TestRecordsHistoryStore(file);
    await reloaded.load();
    assertEquals(reloaded.days(), ["2026/08/16", "2026/08/17"]);
    const identities = reloaded.identities();
    assertEquals(identities[0]?.key, '["unit","bakery","glaze"]');
    const series = reloaded.series('["unit","bakery","glaze"]');
    assertEquals(series.passRates, [0.5, 0.5]);
    // Each day held one passing run of 100ms and one failure of 300ms.
    assertEquals(series.meanDurationsMs, [100, 100]);
    assertEquals(series.passRateTimes.length, 2);
    assertEquals(series.durationTimes, series.passRateTimes);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the store discards a cache written under the old rule", async () => {
  // Version 1 held durations summed over every record, so its figures
  // mean something else and the window is refetched rather than read.

  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const file = join(directory, "history.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        days: {
          "2026/08/16": [{
            key: '["unit","bakery","glaze"]',
            day: "2026/08/16",
            runs: 2,
            failures: 1,
            skips: 0,
            totalDurationMs: 400,
            maxDurationMs: 300,
          }],
        },
      }),
    );
    const store = new TestRecordsHistoryStore(file);
    await store.load();
    assertEquals(store.days(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the store ignores an invalid cache file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const file = join(directory, "history.json");
    await Deno.writeTextFile(file, '{"version":99}');
    const store = new TestRecordsHistoryStore(file);
    await store.load();
    assertEquals(store.days(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the store ignores a cache whose day keys disagree", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const file = join(directory, "history.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 2,
        days: {
          "2026/08/15": [{
            key: '["unit","bakery","glaze"]',
            day: "2026/08/16",
            runs: 1,
            failures: 0,
            skips: 0,
            totalDurationMs: 10,
            maxDurationMs: 10,
          }],
        },
      }),
    );
    const store = new TestRecordsHistoryStore(file);
    await store.load();
    assertEquals(store.days(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("refresh prunes days that fell out of the window and survives a failing day", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const file = join(directory, "history.json");
    const store = new TestRecordsHistoryStore(file);
    const day1 = Date.parse("2026-08-17T12:00:00Z");
    await store.refresh(day1, {
      fetchImpl: storeFetch([PASS]),
      windowDays: 2,
      aliases: new AliasResolver([]),
    });
    assertEquals(store.days(), ["2026/08/16", "2026/08/17"]);

    // A week later with a two-day window: both cached days age out, and
    // the store fetching nothing but failures keeps no stale days.
    const failing = (() =>
      Promise.reject(new Error("store down"))) as unknown as typeof fetch;
    await store.refresh(day1 + 7 * 24 * 60 * 60 * 1000, {
      fetchImpl: failing,
      windowDays: 2,
      aliases: new AliasResolver([]),
    });
    assertEquals(store.days(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("series returns an empty shape for an unknown identity", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const store = new TestRecordsHistoryStore(join(directory, "h.json"));
    const series = store.series('["unit","bakery","never-ran"]');
    assertEquals(series.passRateTimes, []);
    assertEquals(series.passRates, []);
    assertEquals(series.durationTimes, []);
    assertEquals(series.meanDurationsMs, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("series keeps a pass rate for a day with no passing run", async () => {
  const directory = await Deno.makeTempDir({ prefix: "test-records-history-" });
  try {
    const store = new TestRecordsHistoryStore(join(directory, "history.json"));
    await store.refresh(Date.parse("2026-08-16T12:00:00Z"), {
      fetchImpl: storeFetch([FAIL]),
      windowDays: 1,
      aliases: new AliasResolver([]),
    });
    const series = store.series('["unit","bakery","glaze"]');
    assertEquals(series.passRates, [0]);
    assertEquals(series.passRateTimes.length, 1);
    // Nothing passed, so the day says nothing about how long the test
    // takes and contributes no duration point.
    assertEquals(series.durationTimes, []);
    assertEquals(series.meanDurationsMs, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
