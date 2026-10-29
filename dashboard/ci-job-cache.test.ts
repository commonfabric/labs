import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type CachedCiHistoryRefresh,
  type CachedCiRun,
  CI_JOB_CACHE_DAYS,
  CI_JOB_HISTORY_SAMPLING_VERSION,
  CiJobHistoryStore,
  ganttRunSummary,
} from "./ci-job-cache.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 20);
const REPO = "owner/repo";
const WORKFLOW = "ci.yml";

function cachedRun(
  runId: number,
  runAttempt = 1,
  at = NOW,
  repo = REPO,
  workflow = WORKFLOW,
): CachedCiRun {
  const startedAt = new Date(at).toISOString();
  const completedAt = new Date(at + 60_000).toISOString();
  return {
    repo,
    workflow,
    runId,
    runAttempt,
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    at,
    overallSeconds: 60,
    jobs: [{ name: "test", seconds: 60 }],
    gantt: ganttRunSummary({
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      workflowName: "CI",
      startedAt,
    }, [{
      attempt: runAttempt,
      name: "test",
      status: "completed",
      conclusion: "success",
      started_at: startedAt,
      completed_at: completedAt,
      steps: [],
    }]),
  };
}

Deno.test("CI job cache removes the layout that held step detail inline", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const superseded = `${directory}/fabric-wall-ci-job-history.json`;
  const file = `${directory}/fabric-wall-ci-run-index.json`;
  try {
    await Deno.writeTextFile(superseded, JSON.stringify({ version: 1 }));
    await Deno.writeTextFile(`${superseded}.lock`, "");
    // What an interrupted save under that layout leaves behind, as large as
    // the file it was replacing.
    const abandoned = `${superseded}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(abandoned, JSON.stringify({ version: 1 }));
    const run = cachedRun(1);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ version: 1, runs: [run] }),
    );

    const store = new CiJobHistoryStore(file);
    await store.load();

    // The superseded file is never read, only deleted: it grows large enough
    // that reading it would cost the memory the split layout saves.
    await assertRejects(() => Deno.stat(superseded), Deno.errors.NotFound);
    await assertRejects(
      () => Deno.stat(`${superseded}.lock`),
      Deno.errors.NotFound,
    );
    await assertRejects(() => Deno.stat(abandoned), Deno.errors.NotFound);
    assertEquals(store.get(REPO, WORKFLOW, 1, 1), run);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache reports a superseded file it cannot reach", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/fabric-wall-ci-run-index.json`;
  const logged: string[] = [];
  const originalError = console.error;
  const originalRemove = Deno.remove;
  const originalReadDir = Deno.readDir;
  try {
    await Deno.writeTextFile(
      `${directory}/fabric-wall-ci-job-history.json`,
      JSON.stringify({ version: 1 }),
    );
    console.error = (...parts: unknown[]) =>
      void logged.push(parts.map(String).join(" "));
    Deno.readDir = () => {
      throw new Deno.errors.PermissionDenied("cannot list");
    };
    Deno.remove = () =>
      Promise.reject(new Deno.errors.PermissionDenied("cannot remove"));

    // The store still loads: a cache directory that cannot be swept is not a
    // reason to lose the CI history.
    await new CiJobHistoryStore(file).load();
  } finally {
    console.error = originalError;
    Deno.remove = originalRemove;
    Deno.readDir = originalReadDir;
    await Deno.remove(directory, { recursive: true });
  }

  // These files are the largest in the cache directory, so a process that
  // cannot reach them says so rather than leaving the volume full in silence.
  assertEquals(logged.length, 3);
  assertStringIncludes(logged[0], "could not list");
  assertStringIncludes(logged[1], "fabric-wall-ci-job-history.json");
  assertStringIncludes(logged[1], "cannot remove");
});

Deno.test("CI job cache never removes the file it was given", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/fabric-wall-ci-job-history.json`;
  try {
    const run = cachedRun(1);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ version: 1, runs: [run] }),
    );

    const store = new CiJobHistoryStore(file);
    await store.load();

    assertEquals(store.get(REPO, WORKFLOW, 1, 1), run);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache orders retained attempts by when their run started", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  try {
    const store = new CiJobHistoryStore(`${directory}/history.json`);
    // A rerun keeps its original, smaller run identifier but starts later, so
    // ordering by identifier would put the newest attempt last.
    store.set(cachedRun(500, 1, NOW - 3 * DAY_MS));
    store.set(cachedRun(500, 2, NOW));
    store.set(cachedRun(900, 1, NOW - DAY_MS));

    assertEquals(store.attempts(REPO, WORKFLOW), [
      { runId: 500, runAttempt: 2 },
      { runId: 900, runAttempt: 1 },
      { runId: 500, runAttempt: 1 },
    ]);
    assertEquals(store.attempts(REPO, WORKFLOW, 2), [
      { runId: 500, runAttempt: 2 },
      { runId: 900, runAttempt: 1 },
    ]);
    assertEquals(store.attempts("other/repo", WORKFLOW), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache refreshes legacy and outdated samples without dropping their runs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const run = cachedRun(90);
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        runs: [run],
        refreshes: [
          {
            repo: REPO,
            workflow: WORKFLOW,
            days: 7,
            refreshedAt: NOW,
            successfulRunTimes: [NOW],
            sampledRuns: [{ runId: run.runId, runAttempt: run.runAttempt }],
            failedRunCount: 0,
            failedRunTimes: [],
            stale: false,
          },
          {
            repo: REPO,
            workflow: WORKFLOW,
            days: 8,
            refreshedAt: NOW,
            samplingVersion: CI_JOB_HISTORY_SAMPLING_VERSION - 1,
            successfulRunTimes: [NOW],
            sampledRuns: [{ runId: run.runId, runAttempt: run.runAttempt }],
            failedRunCount: 0,
            failedRunTimes: [],
            stale: false,
          },
        ],
      }),
    );

    const store = new CiJobHistoryStore(file);
    await store.load();

    assertEquals(store.refresh(REPO, WORKFLOW, 7)?.samplingVersion, undefined);
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 7), undefined);
    assertEquals(store.refreshedRuns(REPO, WORKFLOW, 7), [run]);
    assertEquals(
      store.refresh(REPO, WORKFLOW, 8)?.samplingVersion,
      CI_JOB_HISTORY_SAMPLING_VERSION - 1,
    );
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 8), undefined);
    assertEquals(store.refreshedRuns(REPO, WORKFLOW, 8), [run]);

    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW,
      [NOW],
      [{ runId: run.runId, runAttempt: run.runAttempt }],
      0,
      [],
      false,
    );
    assertEquals(
      store.freshRefresh(REPO, WORKFLOW, 7)?.samplingVersion,
      CI_JOB_HISTORY_SAMPLING_VERSION,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache rejects a sampling version that is not a version", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  try {
    const store = new CiJobHistoryStore(file);
    const mark = (samplingVersion: number | null) =>
      store.markRefreshed(
        REPO,
        WORKFLOW,
        7,
        NOW,
        [NOW],
        [],
        0,
        [],
        false,
        samplingVersion,
      );

    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity]) {
      assertThrows(
        () => mark(invalid),
        Error,
        "CI job history refresh has an invalid sampling version.",
      );
    }
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);

    // A null version records a sample of unknown provenance: it is stored
    // without a version, and it is never fresh.
    mark(null);
    assertEquals(store.refresh(REPO, WORKFLOW, 7)?.samplingVersion, undefined);
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 7), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache rejects malformed persisted structures before merging", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const valid = cachedRun(1);
  const invalidDrawable = structuredClone(valid);
  invalidDrawable.gantt.drawable = "yes" as never;
  const invalidAttemptTagged = structuredClone(valid);
  invalidAttemptTagged.gantt.attemptTagged = 1 as never;
  const missingDrawable = structuredClone(valid) as { gantt: unknown };
  missingDrawable.gantt = { ...valid.gantt, drawable: undefined };
  const invalidGantt = { ...valid, gantt: null };
  const invalidSha = { ...valid, headSha: "not-a-commit" };
  const cases: { value: unknown; message: string }[] = [
    { value: null, message: "Invalid CI job history cache" },
    {
      value: { version: 2, runs: [] },
      message: "Unsupported CI job history cache format",
    },
    {
      value: { version: 1, runs: [null] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidGantt] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidDrawable] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidAttemptTagged] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [missingDrawable] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidSha] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [], refreshes: {} },
      message: "Invalid CI job history refresh entry",
    },
    {
      value: { version: 1, runs: [], refreshes: [null] },
      message: "Invalid CI job history refresh entry",
    },
    {
      value: { version: 1, runs: [], invalidations: {} },
      message: "Invalid CI job history refresh invalidation",
    },
    {
      value: { version: 1, runs: [], invalidations: [null] },
      message: "Invalid CI job history refresh invalidation",
    },
    {
      value: {
        version: 1,
        runs: [],
        refreshes: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          refreshedAt: NOW,
          successfulRunTimes: [NOW],
          sampledRuns: [{ runId: 999, runAttempt: 1 }],
          failedRunCount: 0,
          failedRunTimes: [],
          stale: false,
        }],
      },
      message: "references a missing run",
    },
  ];

  try {
    for (const [index, testCase] of cases.entries()) {
      const file = `${directory}/${index}.json`;
      await Deno.writeTextFile(file, JSON.stringify(testCase.value));
      const store = new CiJobHistoryStore(file);
      await store.load();
      store.set(cachedRun(100 + index));
      await assertRejects(() => store.save(NOW), Error, testCase.message);
    }

    const file = `${directory}/future-strict.json`;
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(200));
    const future = Date.now() + DAY_MS;
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        runs: [],
        invalidations: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          invalidatedAt: future,
        }],
      }),
    );
    await assertRejects(
      () => store.save(NOW),
      Error,
      "Invalid CI job history refresh invalidation",
    );

    const malformedFile = `${directory}/malformed.json`;
    await Deno.writeTextFile(malformedFile, "{not json");
    const malformedStore = new CiJobHistoryStore(malformedFile);
    await malformedStore.load();
    malformedStore.set(cachedRun(201));
    await assertRejects(() => malformedStore.save(NOW), SyntaxError);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache records a validated commit on an exact run attempt", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  try {
    const store = new CiJobHistoryStore(`${directory}/history.json`);
    await store.load();
    const run = store.set(cachedRun(250));
    const revision = store.revision;
    assertEquals(
      store.setHeadSha(REPO, WORKFLOW, 999, 1, "a".repeat(40)),
      undefined,
    );
    const tagged = store.setHeadSha(
      REPO,
      WORKFLOW,
      run.runId,
      run.runAttempt,
      "A".repeat(40),
    );
    assertEquals(tagged, { ...run, headSha: "a".repeat(40) });
    assertEquals(store.revision, revision + 1);
    assertEquals(
      store.setHeadSha(
        REPO,
        WORKFLOW,
        run.runId,
        run.runAttempt,
        "a".repeat(40),
      ),
      tagged,
    );
    assertEquals(store.revision, revision + 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache quarantines future persisted refresh state", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const run = cachedRun(301);
  const observedNow = Date.now();
  const future = observedNow + DAY_MS;
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        runs: [run],
        refreshes: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          refreshedAt: future,
          successfulRunTimes: [NOW],
          sampledRuns: [{ runId: run.runId, runAttempt: run.runAttempt }],
          failedRunCount: 0,
          failedRunTimes: [],
          stale: false,
        }],
        invalidations: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          invalidatedAt: future,
        }],
      }),
    );

    const store = new CiJobHistoryStore(file);
    await store.load();
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    assertEquals(
      store.quarantineFutureRefresh(REPO, WORKFLOW, 7, observedNow),
      true,
    );
    await store.save(observedNow);
    const persisted = JSON.parse(await Deno.readTextFile(file));
    assertEquals(persisted.refreshes, []);
    assertEquals(persisted.invalidations, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache validates refresh changes and isolates source revisions", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const now = Date.now;
  Date.now = () => NOW;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    const first = store.set(cachedRun(401));
    assertEquals(store.set(first), first);
    const second = store.set(cachedRun(401, 2));
    store.set(cachedRun(402, 1, NOW, "other/repo"));
    store.set(cachedRun(403, 1, NOW, REPO, "other.yml"));
    assertEquals(store.get(REPO, WORKFLOW, 401, 1), first);
    assertEquals(store.latest(REPO, WORKFLOW, 401), second);
    assertEquals(store.list(REPO, WORKFLOW).map((run) => run.runId), [401]);
    assertEquals(store.list(REPO, WORKFLOW, NOW + 1), []);

    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      Number.NaN,
      [],
      [],
      0,
      [],
      false,
    );
    assertThrows(
      () => {
        store.markRefreshed(REPO, WORKFLOW, 7, NOW, [], [], -1, [], false);
      },
      Error,
      "invalid failure count",
    );
    assertThrows(
      () => {
        store.markRefreshed(
          REPO,
          WORKFLOW,
          7,
          NOW,
          [],
          [{ runId: 999, runAttempt: 1 }],
          0,
          [],
          false,
        );
      },
      Error,
      "contains an uncached run",
    );

    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW,
      [Number.NaN, NOW, NOW - 1],
      [{ runId: 401, runAttempt: 2 }],
      2,
      [Number.NaN, NOW - 2],
      true,
    );
    const refresh = store.refresh(REPO, WORKFLOW, 7)!;
    assertEquals(refresh.successfulRunTimes, [NOW - 1, NOW]);
    assertEquals(refresh.failedRunTimes, [NOW - 2]);
    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW - 1,
      [],
      [],
      0,
      [],
      false,
    );
    assertEquals(store.refresh(REPO, WORKFLOW, 7), refresh);
    assertEquals(store.refreshedRuns(REPO, WORKFLOW, 7)?.[0], second);

    const superseded = store.set(cachedRun(404, 1));
    store.markRefreshed(
      REPO,
      WORKFLOW,
      8,
      NOW,
      [NOW],
      [{ runId: superseded.runId, runAttempt: superseded.runAttempt }],
      0,
      [],
      false,
    );
    store.set(cachedRun(404, 2));
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 8), undefined);

    store.restoreRefresh(REPO, WORKFLOW, 7, undefined);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    store.restoreRefresh(REPO, WORKFLOW, 7, refresh);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), refresh);
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    const revision = store.revision;
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    assertEquals(store.revision, revision);
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 7), undefined);

    const futureRefresh: CachedCiHistoryRefresh = {
      ...refresh,
      refreshedAt: NOW + 2 * DAY_MS,
    };
    store.restoreRefresh(REPO, WORKFLOW, 7, futureRefresh);
    Date.now = () => NOW + 2 * DAY_MS;
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    assertEquals(store.quarantineFutureRefresh(REPO, WORKFLOW, 7, NOW), true);
    assertEquals(store.revisionFor(REPO, WORKFLOW) > 0, true);
    await store.save(NOW);
    await store.save(NOW);
  } finally {
    Date.now = now;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache drops a refresh whose retained run is pruned", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    const old = store.set(cachedRun(
      501,
      1,
      NOW - (CI_JOB_CACHE_DAYS + 1) * DAY_MS,
    ));
    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW - DAY_MS,
      [old.at],
      [{ runId: old.runId, runAttempt: old.runAttempt }],
      0,
      [],
      false,
    );
    const revision = store.revisionFor(REPO, WORKFLOW);
    await store.save(NOW);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    assertEquals(store.revisionFor(REPO, WORKFLOW), revision + 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache removes a temporary file after rename fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(601));
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    await assertRejects(() => store.save(NOW), Error, "rename failed");
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

Deno.test("CI job cache preserves a write error when temporary cleanup fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  const remove = Deno.remove;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(602));
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    Deno.remove = ((path, options) =>
      String(path).endsWith(".tmp")
        ? Promise.reject(new Error("remove failed"))
        : remove(path, options)) as typeof Deno.remove;
    await assertRejects(
      () =>
        store.save(NOW),
      Error,
      "rename failed",
    );
  } finally {
    Deno.rename = rename;
    Deno.remove = remove;
    await Deno.remove(directory, { recursive: true });
  }
});
