import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import {
  baseJobName,
  buildCiJobHistory,
  CI_HISTORY_DAYS,
  CI_HISTORY_MIN_DAYS,
  CI_HISTORY_POINT_TARGET,
  CI_HISTORY_SOURCES,
  ciFetchProgressPanel,
  type CiGanttInput,
  ciGanttOptions,
  ciGanttProgressResponse,
  ciHistoryDays,
  type CiHistorySample,
  type CiHistorySource,
  type CiJobFetchProgress,
  ciJobHistoryCheckResponse,
  CiJobHistoryCollector as RateLimitedCiJobHistoryCollector,
  ciJobHistoryPage,
  ciJobHistoryProgressResponse,
  ciJobHistoryResponse,
  ciJobHistorySnapshotVersion,
  collectCiGanttInput,
  type GanttSelection,
  PROGRESS_RECORD_MAX,
  projectWorkflowRun,
  sampleWorkflowRuns,
  SNAPSHOT_CACHE_MAX,
  type WorkflowRun,
} from "./ci-job-history.ts";
import {
  type CachedCiGanttJob,
  type CachedCiGanttRunFields,
  type CachedCiHistoryRefresh,
  type CachedCiRun,
  CI_JOB_CACHE_DAYS,
  CI_JOB_HISTORY_SAMPLING_VERSION,
  CiJobHistoryStore,
  ganttRunSummary,
} from "./ci-job-cache.ts";
import { CiGanttDetailStore, ganttDetailDirectory } from "./ci-gantt-detail.ts";
import {
  CI_RUNS_MAX,
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "./config.ts";
import { github, STALE_RUNS_ERROR } from "./lib.ts";
import { GitHubRateLimitBudgetError } from "./github-rate-limit.ts";
import { PERFORMANCE_VIEW_STYLES } from "./performance-views.ts";

// Existing collector tests exercise history and persistence behavior against
// precise request stubs. The rate-budget implementation has its own tests.
class CiJobHistoryCollector extends RateLimitedCiJobHistoryCollector {
  constructor(store = new CiJobHistoryStore()) {
    super(store, github);
  }
}

type SeededCiRun =
  & Omit<CachedCiRun, "gantt">
  & { gantt: CachedCiGanttRunFields };

function cachedRunEntry(
  entry: SeededCiRun,
  ganttJobs: CachedCiGanttJob[] = [],
): CachedCiRun {
  return { ...entry, gantt: ganttRunSummary(entry.gantt, ganttJobs) };
}

function detailStoreFor(store: CiJobHistoryStore): CiGanttDetailStore {
  return new CiGanttDetailStore(ganttDetailDirectory(store.file));
}

// Places a run in the cache the way a collection does: the index entry names
// the attempt, and the Gantt detail store beside it holds the jobs a chart
// draws.
async function seedCachedRun(
  store: CiJobHistoryStore,
  entry: SeededCiRun,
  ganttJobs: CachedCiGanttJob[] = [],
): Promise<void> {
  const cached = cachedRunEntry(entry, ganttJobs);
  await detailStoreFor(store).write(
    cached,
    cached.runId,
    cached.runAttempt,
    ganttJobs,
  );
  store.set(cached);
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-06-20T18:00:00Z");
const HEAD_SHA = "a".repeat(40);

function workflowRun(
  id: number,
  at: number,
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    run_attempt: 1,
    run_started_at: new Date(at).toISOString(),
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    ...overrides,
  };
}

// A request for a workflow's newest page, which names no branch, as the
// searches for successful runs on main do.
const isNewestPage = (url: string) => /\/runs\?per_page=100&page=\d+$/.test(url);

function historySamples(): CiHistorySample[] {
  return Array.from({ length: 8 }, (_, day) => ({
    runId: 100 + day,
    runUrl: `https://example.test/runs/${100 + day}`,
    at: NOW - (7 - day) * DAY,
    overallSeconds: 300 + day * 15,
    jobs: [
      { name: "Test (1/2)", seconds: 100 + day * 2 },
      { name: "Test (2/2)", seconds: 120 + day * 12 },
      { name: "Check", seconds: 200 - day * 5 },
      { name: "One platform (linux)", seconds: 60 },
      ...(day === 0 ? [{ name: "Test (1/2)", seconds: 10 }] : []),
    ],
  }));
}

Deno.test("CI job history keeps every eligible build below the point target", () => {
  const sameWindowOld = workflowRun(1, NOW - HOUR * 2);
  const sameWindowNew = workflowRun(2, NOW - HOUR);
  const previousWindow = workflowRun(3, NOW - HOUR * 14);
  const runs = [
    sameWindowOld,
    previousWindow,
    workflowRun(4, NOW, { conclusion: "failure" }),
    workflowRun(5, NOW, { event: "pull_request" }),
    workflowRun(6, NOW, { head_branch: "release" }),
    workflowRun(7, NOW - (CI_HISTORY_DAYS + 1) * DAY),
    sameWindowNew,
  ];

  assertEquals(
    sampleWorkflowRuns(runs, NOW).map((run) => run.id),
    [3, 1, 2],
  );
});

Deno.test("CI Gantt options retain valid selected run attempts", () => {
  const parameters = new URLSearchParams();
  parameters.append("run", "8101:1");
  parameters.append("run", "not-a-run");
  parameters.append("run", "8102:3");
  parameters.set("limit", "2");
  parameters.set("mainOnly", "1");
  parameters.set("sha", HEAD_SHA.toUpperCase());
  assertEquals(ciGanttOptions(parameters), {
    limit: 2,
    mainOnly: true,
    allConclusions: false,
    headSha: HEAD_SHA,
    selectedRuns: [
      { runId: 8101, runAttempt: 1 },
      { runId: 8102, runAttempt: 3 },
    ],
  });
});

Deno.test("CI Gantt limits exact run selections before collecting", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selection-limit-test-",
  });
  const requested: number[] = [];
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string): Promise<T> => {
      const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
      if (!match) throw new Error(`unexpected selected-run request: ${path}`);
      const id = Number(match[1]);
      requested.push(id);
      return Promise.resolve(workflowRun(id, NOW, {
        status: "in_progress",
        conclusion: null,
        head_sha: HEAD_SHA,
        path: `.github/workflows/${CI_WORKFLOW}`,
      }) as T);
    },
  );
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selection-limit-token",
          CI_HISTORY_SOURCES.labs,
          {
            limit: 1,
            mainOnly: true,
            headSha: HEAD_SHA,
            selectedRuns: Array.from({ length: 151 }, (_, index) => ({
              runId: 20_000 + index,
              runAttempt: 1,
            })),
          },
          NOW,
        ),
      Error,
      "Every selected CI run must be a completed successful main push",
    );
    assertEquals(requested.length, 150);
    assertEquals(requested.includes(20_150), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history keeps every eligible build at the point target", () => {
  const runs = Array.from(
    { length: CI_HISTORY_POINT_TARGET },
    (_, index) => workflowRun(2_000 + index, NOW - HOUR - index * 1_000),
  );

  assertEquals(
    sampleWorkflowRuns(runs, NOW).map((run) => run.id).sort((a, b) => a - b),
    runs.map((run) => run.id),
  );
});

Deno.test("CI job history sampling matches the main tile run limit", () => {
  assertEquals(CI_HISTORY_POINT_TARGET, CI_RUNS_MAX);
});

Deno.test("CI job history keeps the exact target across clustered builds", () => {
  const clustered = Array.from(
    { length: CI_HISTORY_POINT_TARGET + 1 },
    (_, index) => workflowRun(1_000 + index, NOW - HOUR - index * 1_000),
  );

  const sampled = sampleWorkflowRuns(clustered, NOW);
  assertEquals(sampled.length, CI_HISTORY_POINT_TARGET);
  assertEquals(new Set(sampled.map((run) => run.id)).size, sampled.length);
  assertEquals(sampled[0].id, 1_000 + CI_HISTORY_POINT_TARGET);
  assertEquals(sampled.at(-1)?.id, 1_000);
});

Deno.test("CI job history keeps a similar point count when the window gets shorter", () => {
  const denseRuns = (days: number, firstId: number) =>
    Array.from(
      { length: CI_HISTORY_POINT_TARGET * 2 + 1 },
      (_, sample) =>
        workflowRun(
          firstId + sample,
          NOW - sample * days * DAY / (CI_HISTORY_POINT_TARGET * 2),
        ),
    );
  const full = sampleWorkflowRuns(
    denseRuns(CI_HISTORY_DAYS, 20_000),
    NOW,
    CI_HISTORY_DAYS,
  );
  const short = sampleWorkflowRuns(
    denseRuns(CI_HISTORY_MIN_DAYS, 30_000),
    NOW,
    CI_HISTORY_MIN_DAYS,
  );

  assertEquals(full.length, CI_HISTORY_POINT_TARGET);
  assertEquals(short.length, CI_HISTORY_POINT_TARGET);
  assert(
    short.every((run) =>
      Date.parse(run.run_started_at) >= NOW - CI_HISTORY_MIN_DAYS * DAY
    ),
  );
  assertEquals(ciHistoryDays(null), CI_HISTORY_DAYS);
  assertEquals(ciHistoryDays("0"), CI_HISTORY_MIN_DAYS);
  assertEquals(ciHistoryDays("2"), 2);
  assertEquals(ciHistoryDays("100"), CI_HISTORY_DAYS);
});

Deno.test("CI job history groups concurrent suffix jobs and keeps every shard", () => {
  const snapshot = buildCiJobHistory(historySamples());

  assertEquals(snapshot.runCount, 8);
  assertEquals(snapshot.successfulRunTimes, null);
  assertEquals(snapshot.stale, false);
  assertEquals(snapshot.axisStart, NOW - 7 * DAY);
  assertEquals(snapshot.axisEnd, NOW);
  assertEquals(snapshot.overall?.kind, "overall");
  assertEquals(
    snapshot.overall?.points.map((point) => point.seconds),
    Array.from({ length: 8 }, (_, day) => 300 + day * 15),
  );
  assertEquals(snapshot.groups.length, 1);
  assertEquals(snapshot.groups[0].base, "Test");
  assertEquals(snapshot.groups[0].maxConcurrent, 2);
  assertEquals(
    snapshot.groups[0].shards.map((series) => series.name),
    ["Test (1/2)", "Test (2/2)"],
  );
  assertEquals(
    snapshot.groups[0].aggregate.points.map((point) => point.seconds),
    Array.from({ length: 8 }, (_, day) => 120 + day * 12),
  );
  assertEquals(
    snapshot.groups[0].shards[0].points[0].seconds,
    100,
  );
  assertEquals(
    snapshot.jobs.map((series) => series.name),
    ["Check", "One platform (linux)"],
  );
  assertEquals(
    baseJobName("Package Integration Tests (runner)"),
    "Package Integration Tests",
  );
});

Deno.test("CI job history preserves changing shard layouts and labels maximum concurrency", () => {
  const snapshot = buildCiJobHistory([
    {
      runId: 1,
      runUrl: "https://example.test/runs/1",
      at: NOW - DAY,
      jobs: [
        { name: "Test (1/3)", seconds: 40 },
        { name: "Test (2/3)", seconds: 45 },
        { name: "Test (3/3)", seconds: 60 },
      ],
    },
    {
      runId: 2,
      runUrl: "https://example.test/runs/2",
      at: NOW,
      jobs: [
        { name: "Test (1/2)", seconds: 50 },
        { name: "Test (2/2)", seconds: 55 },
      ],
    },
  ]);

  assertEquals(snapshot.groups[0].maxConcurrent, 3);
  assertEquals(snapshot.groups[0].shards.length, 5);
  assertStringIncludes(
    ciJobHistoryPage(snapshot, "job"),
    "up to 3 concurrent · 5 historical variants",
  );
  assertStringIncludes(
    ciJobHistoryPage(snapshot, "job"),
    "Individual shard · last seen Jun 19",
  );
});

Deno.test("CI job history page shows the slowest shard, every shard, and unsharded jobs", () => {
  const html = ciJobHistoryPage(
    buildCiJobHistory(
      historySamples(),
      0,
      undefined,
      [],
      Array.from({ length: 418 }, (_, index) => NOW - index),
    ),
    "job",
  );

  assertStringIncludes(html, "<title>CI job history</title>");
  assertStringIncludes(html, PERFORMANCE_VIEW_STYLES);
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99" aria-current="page"',
  );
  assertStringIncludes(html, '<select id="repo" name="repo">');
  assertStringIncludes(
    html,
    'type="range" id="days" name="days" min="1" max="45"',
  );
  assertStringIncludes(html, '<span class="cname">Overall CI</span>');
  assertStringIncludes(html, "First job start to last job completion");
  assertStringIncludes(html, "<h2>Test <span>up to 2 concurrent</span></h2>");
  assertStringIncludes(html, 'data-kind="group"');
  assertStringIncludes(
    html,
    '<span class="cname">longest-running shard</span>',
  );
  assertStringIncludes(html, '<span class="cname">1/2</span>');
  assertStringIncludes(html, '<span class="cname">2/2</span>');
  assertStringIncludes(html, '<span class="cname">Check</span>');
  assertStringIncludes(html, '<span class="cname">One platform (linux)</span>');
  assertStringIncludes(html, "3m 24s");
  assertStringIncludes(html, "<svg");
  assertStringIncludes(html, "Jun 13");
  assertStringIncludes(html, "Jun 20");
  assertStringIncludes(html, "longest-running shard in each run");
  assertStringIncludes(
    html,
    "Coverage: 8 sampled builds shown out of 418 successful main builds.",
  );
  assert(
    html.indexOf('id="fetch-progress"') < html.indexOf('class="coverage"'),
    "coverage follows the progress panel",
  );
  assert(
    html.indexOf('class="coverage"') < html.indexOf('class="legend"'),
    "the duration explanation follows coverage",
  );
  assertStringIncludes(html, "Slowest shard duration · last seen Jun 20");
  assertStringIncludes(
    html,
    "Every successful main run is sampled when the selected window contains at most 200",
  );
  assertStringIncludes(
    html,
    "Larger sets keep exactly 200 builds spread evenly through the chronological run sequence",
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');
  assertStringIncludes(html, "0 outstanding");
  assertEquals([...html.matchAll(/class="crow /g)].length, 6);
});

Deno.test("CI history graphs ignore two values at each end when twenty are shown", () => {
  const seconds = [
    102,
    11,
    1,
    26,
    101,
    12,
    2,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
  ];
  const snapshot = buildCiJobHistory(seconds.map((value, index) => ({
    runId: 10_000 + index,
    runUrl: `https://example.test/runs/${10_000 + index}`,
    at: NOW - (seconds.length - 1 - index) * HOUR,
    overallSeconds: value,
    jobs: [{ name: "Check", seconds: value }],
  })));
  const points = ciJobHistoryPage(snapshot, "job")
    .match(/<polyline points="([^"]+)"/)?.[1]
    .split(" ")
    .map((point) => Number(point.split(",")[1]));

  assert(points);
  assertEquals(points.filter((point) => point < 0).length, 2);
  assertEquals(points.filter((point) => point > 26).length, 2);
});

Deno.test("CI job history trend sort is flat and includes groups and exact job names", () => {
  const html = ciJobHistoryPage(buildCiJobHistory(historySamples()), "trend");

  assert(!html.includes("<h2>"));
  assertStringIncludes(html, "Test — slowest of up to 2 shards");
  assertStringIncludes(html, '<span class="cname">Test (1/2)</span>');
  assertStringIncludes(html, '<span class="cname">Test (2/2)</span>');
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=trend"',
  );
});

Deno.test("CI job history duration sort puts the longest latest value first", () => {
  const html = ciJobHistoryPage(
    buildCiJobHistory(historySamples()),
    "duration",
  );
  const names = [...html.matchAll(/<span class="cname">([^<]*)<\/span>/g)]
    .map((match) => match[1]);

  assertEquals(names[0], "Overall CI");
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=duration"',
  );
  assertStringIncludes(html, 'aria-label="Sort CI history"');
  assertStringIncludes(html, 'aria-current="true">duration</a>');

  const fromRuntime = ciJobHistoryPage(
    buildCiJobHistory(historySamples()),
    "duration",
    undefined,
    { runtimeStat: "p75" },
  );
  assertStringIncludes(
    fromRuntime,
    'href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=duration&amp;stat=p75">Runtime benchmarks</a>',
  );
  assertStringIncludes(fromRuntime, 'name="stat" value="p75"');
  assertStringIncludes(
    fromRuntime,
    "repo=labs&amp;days=45&amp;sort=duration&amp;stat=p75",
  );
});

Deno.test("CI job history page can select the loom workflow", () => {
  const html = ciJobHistoryPage(
    buildCiJobHistory(historySamples()),
    "job",
    undefined,
    {
      source: CI_HISTORY_SOURCES.loom,
      days: 14,
    },
  );

  assertStringIncludes(html, `${LOOM_REPO} · ${LOOM_CI_WORKFLOW}`);
  assertStringIncludes(html, '<option value="loom" selected>loom</option>');
  assertStringIncludes(html, 'value="14"');
  assertStringIncludes(html, "selected 14-day trend");
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=loom&amp;days=14&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
});

Deno.test("CI job history page exposes live collection progress without disabling controls", () => {
  const progress: CiJobFetchProgress = {
    id: "labs-14-progress",
    source: "labs",
    days: 14,
    phase: "fetching",
    discoveryRequestsMade: 4,
    discoveryResponsesReceived: 4,
    discoveryOutstandingRequests: 0,
    totalRuns: 30,
    cachedRuns: 8,
    requestsMade: 12,
    responsesReceived: 7,
    sharedRequests: 2,
    sharedResponses: 1,
    successfulResponses: 6,
    failedResponses: 1,
    completedRuns: 16,
    queuedRuns: 8,
    outstandingRequests: 6,
    needsReload: true,
    updatedAt: NOW,
  };
  const html = ciJobHistoryPage(null, "job", undefined, {
    days: 14,
    progress,
  });

  assertStringIncludes(html, 'id="fetch-progress"');
  assertStringIncludes(html, '<progress id="fetch-bar" max="30" value="16"');
  assertStringIncludes(
    html,
    "12 run requests made · 2 shared · 8 responded",
  );
  assertStringIncludes(html, 'state.sharedRequests + " shared');
  assertStringIncludes(
    html,
    "state.responsesReceived + state.sharedResponses",
  );
  assertStringIncludes(html, "6 outstanding · 8 queued");
  assertStringIncludes(html, 'data-refresh-on-complete="1"');
  assertStringIncludes(html, "const stream = new EventSource(url)");
  assertStringIncludes(html, 'id="days" name="days"');
  assert(!html.includes('id="days" name="days" disabled'));
  assertStringIncludes(html, 'controls.addEventListener("submit"');
  assertStringIncludes(html, '<div id="range-content">');
  assertStringIncludes(html, 'days.addEventListener("keydown"');
  assertStringIncludes(html, "syncDayLinks()");
  assertStringIncludes(html, 'days.addEventListener("change", applyDays)');
  assert(!html.includes("keyboardEditing"));
  assertStringIncludes(html, "new DOMParser().parseFromString");
  assertStringIncludes(html, "rangeContent.replaceWith(replacement)");
  assertStringIncludes(html, "history.pushState(null");
  assertStringIncludes(html, 'window.addEventListener("popstate"');
  assertStringIncludes(html, 'void loadRange("pop")');
  assertStringIncludes(html, 'void loadRange("restore")');
  assertStringIncludes(html, 'if (mode === "refresh")');
  assertStringIncludes(html, "rangeRequestDays !== days.value");
  assertStringIncludes(html, "if (loaded && pendingRefresh)");
  assertStringIncludes(html, "days.value !== appliedDays ||");
  assertStringIncludes(
    html,
    "if (!Number.isFinite(value)) return DEFAULT_DAYS",
  );
  assertStringIncludes(html, "rangeRequest.abort()");
  assertStringIncludes(html, "refreshRangeWhenIdle()");
  assert(!html.includes("location.reload()"));
  assert(!html.includes("ciJobsRestoreDaysFocus"));
  assertStringIncludes(html, "setInterval(checkForUpdates, 60000)");
  assertStringIncludes(
    html,
    'fetchProgress.dataset.refreshOnComplete === "1"',
  );
  assertStringIncludes(
    html,
    'collectionFailed = state.phase === "error"',
  );
  assertStringIncludes(
    html,
    'else if ("lastRequestError" in state) renderIdle(state.lastRequestError || "");',
  );
  assertStringIncludes(
    html,
    "else if (!collectionFailed) renderIdle();",
  );
  assertStringIncludes(
    html,
    "else delete fetchProgress.dataset.lastRequestError;",
  );
  assertStringIncludes(
    html,
    "if (!eventStream && !collectionFailed && !transportFailed) renderIdle()",
  );
  assertStringIncludes(html, "transportFailed = true");
  assert(
    !html.includes(
      "No completed CI job timings were found in the history window.",
    ),
  );
  assertStringIncludes(
    html,
    'data-check-url="/bench/check?view=ci&amp;repo=labs&amp;days=14"',
  );
  assert(
    !html.includes(
      ".views a.on,.controls a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assertStringIncludes(
    html,
    "section:has(.clist):not(:has(.crow:not(.good)))",
  );
  assert(!html.includes("section:not(:has(.crow:not(.good)))"));
});

Deno.test("CI job history page reports workflow discovery requests", () => {
  const progress: CiJobFetchProgress = {
    id: "loom-discovery",
    source: "loom",
    days: 45,
    phase: "discovering",
    discoveryRequestsMade: 3,
    discoveryResponsesReceived: 2,
    discoveryOutstandingRequests: 1,
    totalRuns: 0,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 0,
    completedRuns: 0,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
  };
  const html = ciJobHistoryPage(null, "job", undefined, {
    source: CI_HISTORY_SOURCES.loom,
    days: 45,
    progress,
  });

  assertStringIncludes(
    html,
    '<strong id="fetch-title">Finding workflow runs…</strong>',
  );
  assertStringIncludes(html, '<span id="fetch-total">1 outstanding</span>');
  assertStringIncludes(
    html,
    "3 workflow requests made · 2 responded · 1 outstanding",
  );
  assertStringIncludes(
    html,
    'state.discoveryRequestsMade + " workflow requests made',
  );
});

Deno.test("CI fetch progress panel retains a completed collection warning", () => {
  const html = ciFetchProgressPanel({
    id: "gantt-cached-warning",
    source: "loom",
    days: 45,
    phase: "complete",
    discoveryRequestsMade: 1,
    discoveryResponsesReceived: 1,
    discoveryOutstandingRequests: 0,
    totalRuns: 12,
    cachedRuns: 11,
    requestsMade: 1,
    responsesReceived: 1,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 1,
    completedRuns: 12,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
    warning: "Showing cached runs because GitHub reported rate limit hit.",
  });

  assertStringIncludes(html, 'class="fetch-progress warning"');
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');
  assertStringIncludes(
    html,
    "Showing cached runs because GitHub reported rate limit hit.",
  );
});

Deno.test("CI fetch progress panel retains the last failed collection", () => {
  const html = ciFetchProgressPanel({
    id: "ci-failed",
    source: "labs",
    days: 45,
    phase: "error",
    discoveryRequestsMade: 1,
    discoveryResponsesReceived: 1,
    discoveryOutstandingRequests: 0,
    totalRuns: 12,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 1,
    completedRuns: 0,
    queuedRuns: 12,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
    error: "source unreachable",
  });

  assertStringIncludes(html, 'class="fetch-progress error"');
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');
  assertStringIncludes(
    html,
    'data-last-request-error="source unreachable"',
  );
  assertStringIncludes(
    html,
    '<p id="fetch-detail">Last collection stopped: source unreachable</p>',
  );
  assert(!html.includes("No requests in progress."));
});

Deno.test("CI job history response keeps a remembered failure in its idle panel", async () => {
  const cached = buildCiJobHistory(historySamples());
  const provider = {
    cached: () => Promise.resolve(cached),
    startRefresh: () => ({
      progress: null,
      result: Promise.resolve(cached),
    }),
    lastRefreshError: () => "source unreachable",
  };

  const response = await ciJobHistoryResponse(
    new URL("http://x/bench?view=ci"),
    provider,
    "response-token",
  );
  const html = await response.text();

  assertStringIncludes(html, 'class="fetch-progress error"');
  assertStringIncludes(
    html,
    '<p id="fetch-detail">Last collection stopped: source unreachable</p>',
  );
  assertStringIncludes(
    html,
    'else if ("lastRequestError" in state) renderIdle(state.lastRequestError || "");',
  );
});

Deno.test("CI job history response uses a refresh that completed after its cache read", async () => {
  const cached = buildCiJobHistory([{
    runId: 7_101,
    runUrl: "https://example.test/runs/7101",
    at: NOW,
    jobs: [{ name: "Old only", seconds: 20 }],
  }]);
  const refreshed = buildCiJobHistory([{
    runId: 7_102,
    runUrl: "https://example.test/runs/7102",
    at: NOW,
    jobs: [{ name: "Fresh result", seconds: 30 }],
  }]);
  const provider = {
    cached: () => Promise.resolve(cached),
    startRefresh: () => ({
      progress: null,
      result: Promise.resolve(refreshed),
    }),
  };

  const response = await ciJobHistoryResponse(
    new URL("http://x/bench?view=ci"),
    provider,
    "response-token",
  );
  const html = await response.text();

  assertStringIncludes(html, "Fresh result");
  assert(!html.includes("Old only"));
  assertStringIncludes(html, 'id="fetch-progress"');
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');

  const fragmentResponse = await ciJobHistoryResponse(
    new URL("http://x/bench?view=ci&days=7&fragment=range"),
    provider,
    "",
  );
  const fragment = await fragmentResponse.text();
  assert(fragment.startsWith('<div id="range-content">'));
  assertStringIncludes(fragment, "selected 7-day trend");
  assert(!fragment.includes("<!doctype html>"));
  assert(!fragment.includes('<form class="controls"'));
});

Deno.test("CI job history update check uses the selected repository and window", async () => {
  const cached = buildCiJobHistory(historySamples());
  const progress: CiJobFetchProgress = {
    id: "loom-9-check",
    source: "loom",
    days: 9,
    phase: "discovering",
    discoveryRequestsMade: 0,
    discoveryResponsesReceived: 0,
    discoveryOutstandingRequests: 0,
    totalRuns: 0,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 0,
    completedRuns: 0,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
  };
  let selected: { source: CiHistorySource; days: number } | undefined;
  const provider = {
    cached: (_source: CiHistorySource, _days: number) =>
      Promise.resolve(cached),
    startRefresh: (
      _token: string,
      source: CiHistorySource,
      days: number,
    ) => {
      selected = { source, days };
      return { progress, result: Promise.resolve(cached) };
    },
  };

  const response = await ciJobHistoryCheckResponse(
    new URL("http://x/bench/check?view=ci&repo=loom&days=9"),
    provider,
    "check-token",
  );
  const state = await response.json();

  assertEquals(selected?.source, CI_HISTORY_SOURCES.loom);
  assertEquals(selected?.days, 9);
  assertEquals(state.progress, progress);
  assertEquals(state.lastRequestError, null);
  assertEquals(typeof state.version, "string");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("CI job history update checks freshness-gate a failed collection", async () => {
  const test = await temporaryCollector();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  };

  try {
    const first = test.collector.startRefreshForCheck(
      "check-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assert(first);
    await assertRejects(() => first.result);

    assertEquals(
      test.collector.startRefreshForCheck(
        "check-token",
        CI_HISTORY_SOURCES.labs,
        14,
      ),
      null,
    );
    const checked = await ciJobHistoryCheckResponse(
      new URL("http://x/bench/check?view=ci&repo=labs&days=7"),
      test.collector,
      "check-token",
    );
    const state = await checked.json();
    assertEquals(state.progress, null);
    assertEquals(state.lastRequestError, "temporarily unavailable");
    assertEquals(
      test.collector.lastRefreshError(CI_HISTORY_SOURCES.labs, 14),
      null,
    );
    assertEquals(calls, 1);

    let releaseRecovery!: (response: Response) => void;
    const recoveryResponse = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    globalThis.fetch = () => recoveryResponse.then((response) => response.clone());
    const recovery = test.collector.startRefresh(
      "check-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    const joinedRecovery = test.collector.startRefreshForCheck(
      "check-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    releaseRecovery(Response.json({
      total_count: 0,
      workflow_runs: [],
    }));
    assert(joinedRecovery);
    assertEquals(joinedRecovery.progress?.id, recovery.progress?.id);
    await recovery.result;
    assertEquals(
      test.collector.lastRefreshError(CI_HISTORY_SOURCES.labs, 7),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI history retains a failed request until replacement data is persisted", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-history-failure-persistence-",
  });
  const originalFetch = globalThis.fetch;
  let blockSave = false;
  let markSaveStarted!: () => void;
  let releaseSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  class BlockingStore extends CiJobHistoryStore {
    override async save(now = Date.now()): Promise<void> {
      if (blockSave) {
        markSaveStarted();
        await saveGate;
      }
      await super.save(now);
    }
  }
  const collector = new CiJobHistoryCollector(
    new BlockingStore(`${directory}/history.json`),
  );

  try {
    globalThis.fetch = () =>
      Promise.resolve(new Response("unavailable", { status: 503 }));
    const failed = collector.startRefresh(
      "failure-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    await assertRejects(() => failed.result);
    assertEquals(
      collector.lastRefreshError(CI_HISTORY_SOURCES.labs, 7),
      "temporarily unavailable",
    );

    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        total_count: 0,
        workflow_runs: [],
      }));
    blockSave = true;
    const recovery = collector.startRefresh(
      "recovery-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    await saveStarted;
    assertEquals(
      collector.lastRefreshError(CI_HISTORY_SOURCES.labs, 7),
      "temporarily unavailable",
    );

    releaseSave();
    await recovery.result;
    assertEquals(
      collector.lastRefreshError(CI_HISTORY_SOURCES.labs, 7),
      null,
    );
  } finally {
    releaseSave();
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history page escapes job names and labels a short series as new", () => {
  const snapshot = buildCiJobHistory([{
    runId: 999,
    runUrl: "https://example.test/?a=1&b=2",
    at: NOW,
    jobs: [{ name: "Check <unsafe>", seconds: 42 }],
  }]);
  const html = ciJobHistoryPage(snapshot, "job");

  assertStringIncludes(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  assertStringIncludes(html, "Check &lt;unsafe&gt;");
  assertStringIncludes(html, 'href="https://example.test/?a=1&amp;b=2"');
  assertStringIncludes(html, "new · 1 runs");
  assertStringIncludes(html, 'class="crow unknown"');
  assert(!html.includes('class="crow good"'));
  assertStringIncludes(
    ciJobHistoryPage(null, "job", "Refresh failed: <unsafe>."),
    "Refresh failed: &lt;unsafe&gt;.",
  );
});

function apiJob(
  name: string,
  seconds: number,
  conclusion: string | null = "success",
) {
  const start = NOW - HOUR;
  return {
    name,
    conclusion,
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + seconds * 1_000).toISOString(),
  };
}

async function temporaryCollector(): Promise<{
  collector: CiJobHistoryCollector;
  file: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const file = `${directory}/history.json`;
  return {
    collector: new CiJobHistoryCollector(new CiJobHistoryStore(file)),
    file,
    cleanup: () => Deno.remove(directory, { recursive: true }),
  };
}

Deno.test("CI duration history never loads the Gantt step detail", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-duration-detail-" });
  const file = `${directory}/history.json`;
  const reads: number[] = [];
  class CountingDetailStore extends CiGanttDetailStore {
    override read(
      ...args: Parameters<CiGanttDetailStore["read"]>
    ): Promise<CachedCiGanttJob[] | null> {
      reads.push(args[1]);
      return super.read(...args);
    }
  }
  const store = new CiJobHistoryStore(file);
  const now = Date.now();
  const runs = Array.from(
    { length: 5 },
    (_, index) => workflowRun(11_000 + index, now - index * HOUR),
  );
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: runs } as T);
      }
      return Promise.resolve(
        {
          jobs: [{
            ...apiJob("Check", 90),
            steps: [{
              name: "🔎 Check",
              number: 1,
              conclusion: "success",
              started_at: new Date(now - HOUR).toISOString(),
              completed_at: new Date(now - HOUR + 90_000).toISOString(),
            }],
          }],
        } as T,
      );
    },
    new CountingDetailStore(ganttDetailDirectory(file)),
  );
  try {
    // A collection and every later read of the duration chart go through the
    // run index alone. Only a Gantt request opens a detail file.
    assertEquals(
      (await collector.collect("token", now, CI_HISTORY_SOURCES.labs, 45))
        .runCount,
      runs.length,
    );
    assertEquals(
      (await collector.cached(CI_HISTORY_SOURCES.labs, 45, now))?.runCount,
      runs.length,
    );
    assertEquals(reads, []);

    const gantt = await collector.gantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      { limit: 2, mainOnly: true },
      now,
    );
    assertEquals(gantt.runs.length, 2);
    assertEquals(gantt.runs[0].jobs[0].steps[0].name, "🔎 Check");
    // Only the two attempts the chart draws, not the five the index holds.
    // Each is read twice and let go of in between: once to settle whether the
    // chart can draw it, and once to hand it over. Holding what the first read
    // returned would mean holding the whole chart's timings at once, which is
    // what reading one attempt at a time exists to avoid.
    assertEquals(new Set(reads), new Set([runs[0].id, runs[1].id]));
    assertEquals(reads.length, 4);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the Gantt renderer's input file holds every run of the chart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-input-" });
  const destination = `${directory}/input.json`;
  const runs = [workflowRun(15_000, NOW), workflowRun(15_001, NOW - HOUR)];
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: runs } as T);
      }
      const id = Number(path.match(/\/runs\/(\d+)\//)![1]);
      return Promise.resolve({ jobs: [apiJob(`Check ${id}`, 30)] } as T);
    },
  );
  try {
    const selection = await collector.startGantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      { limit: 2, mainOnly: true },
      NOW,
    ).result;
    const runCount = await collector.writeGanttInput(
      CI_HISTORY_SOURCES.labs,
      selection,
      destination,
    );

    assertEquals(runCount, 2);
    const written = JSON.parse(await Deno.readTextFile(destination));
    assertEquals(
      written.runs.map((entry: CiGanttInput["runs"][number]) =>
        entry.run.databaseId
      ),
      [15_000, 15_001],
    );
    assertEquals(written.runs[0].jobs[0].name, "Check 15000");
    // Written run by run, so the separators have to come out as valid JSON
    // rather than a trailing or doubled comma.
    assertEquals(
      await collector.ganttRuns(CI_HISTORY_SOURCES.labs, selection),
      written,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected run whose detail goes missing mid-chart is an error", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-vanish-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const run = workflowRun(15_100, NOW, {
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  // Readable while the chart is settled, gone by the time it is handed over.
  class VanishingDetailStore extends CiGanttDetailStore {
    reads = 0;
    override read(
      ...args: Parameters<CiGanttDetailStore["read"]>
    ): Promise<CachedCiGanttJob[] | null> {
      return this.reads++ === 0 ? super.read(...args) : Promise.resolve(null);
    }
  }
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>() => Promise.resolve({ jobs: [apiJob("Check", 30)] } as T),
    new VanishingDetailStore(ganttDetailDirectory(file)),
  );
  try {
    await seedCachedRun(store, {
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: run.id,
      runAttempt: 1,
      headSha: HEAD_SHA,
      runUrl: run.html_url,
      at: NOW,
      overallSeconds: 30,
      jobs: [{ name: "Check", seconds: 30 }],
      gantt: {
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        headBranch: run.head_branch ?? undefined,
        startedAt: run.run_started_at,
        workflowName: "CI",
      },
    }, [{
      attempt: 1,
      name: "Check",
      status: "completed",
      conclusion: "success",
      started_at: new Date(NOW).toISOString(),
      completed_at: new Date(NOW + 30_000).toISOString(),
      steps: [],
    }]);
    await store.save(NOW);

    // A chart of particular runs that silently omitted one would misrepresent
    // the commit, so it fails instead.
    await assertRejects(
      () =>
        collector.gantt("token", CI_HISTORY_SOURCES.labs, {
          limit: 1,
          mainOnly: true,
          headSha: HEAD_SHA,
          selectedRuns: [{ runId: run.id, runAttempt: 1 }],
        }, NOW),
      Error,
      "Not every selected CI run has cached job timings",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a run whose detail goes missing mid-chart is left out of it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-omit-" });
  const file = `${directory}/history.json`;
  const runs = [workflowRun(15_300, NOW), workflowRun(15_301, NOW - HOUR)];
  // The first attempt handed over reads back; the second does not.
  class HalfVanishingDetailStore extends CiGanttDetailStore {
    handed = 0;
    override read(
      ...args: Parameters<CiGanttDetailStore["read"]>
    ): Promise<CachedCiGanttJob[] | null> {
      const settled = this.settled;
      if (settled) this.handed++;
      return settled && this.handed > 1
        ? Promise.resolve(null)
        : super.read(...args);
    }
    settled = false;
  }
  const detail = new HalfVanishingDetailStore(ganttDetailDirectory(file));
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string) =>
      Promise.resolve(
        path.includes("/runs?")
          ? { workflow_runs: runs } as T
          : { jobs: [apiJob("Check", 30)] } as T,
      ),
    detail,
  );
  try {
    const selection = await collector.startGantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      { limit: 2, mainOnly: true },
      NOW,
    ).result;
    assertEquals(selection.entries.length, 2);

    // A chart that was not asked for particular runs draws what it still has
    // rather than failing.
    detail.settled = true;
    const chart = await collector.ganttRuns(CI_HISTORY_SOURCES.labs, selection);
    assertEquals(chart.runs.map((entry) => entry.run.databaseId), [15_300]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a chart is served even when its detail cannot be pruned", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-prune-fail-" });
  const file = `${directory}/history.json`;
  const run = workflowRun(15_200, NOW);
  class UnprunableDetailStore extends CiGanttDetailStore {
    override prune(): Promise<void> {
      return Promise.reject(new Error("cannot prune"));
    }
  }
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string) =>
      Promise.resolve(
        path.includes("/runs?")
          ? { workflow_runs: [run] } as T
          : { jobs: [apiJob("Check", 30)] } as T,
      ),
    new UnprunableDetailStore(ganttDetailDirectory(file)),
  );
  const logged: string[] = [];
  const originalError = console.error;
  try {
    console.error = (...parts: unknown[]) =>
      void logged.push(parts.map(String).join(" "));
    const chart = await collector.gantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      NOW,
    );
    // The chart is already settled by then, so the failure is reported and the
    // request still answers.
    assertEquals(chart.runs.length, 1);
    assertStringIncludes(logged.join("\n"), "was not pruned: cannot prune");
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a chart of no runs is still a readable input file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-empty-" });
  const destination = `${directory}/input.json`;
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
  );
  try {
    const runCount = await collector.writeGanttInput(
      CI_HISTORY_SOURCES.labs,
      { entries: [], exactSelection: false },
      destination,
    );
    assertEquals(runCount, 0);
    assertEquals(JSON.parse(await Deno.readTextFile(destination)), {
      runs: [],
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("pruning keeps the detail of every attempt the run index holds", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-prune-invariant-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const detail = new CiGanttDetailStore(ganttDetailDirectory(file));
  const now = Date.now();
  // Several runs inside the index's retention window and one past it. The
  // stale one is dropped from the index by the same save that prunes detail.
  const retained = [17_000, 17_001, 17_002, 17_003];
  const stale = 17_009;
  const jobs = [{
    attempt: 1,
    name: "Check",
    status: "completed",
    conclusion: "success",
    started_at: new Date(now - HOUR).toISOString(),
    completed_at: new Date(now - HOUR + 30_000).toISOString(),
    steps: [],
  }];
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) =>
      Promise.resolve(
        path.includes("/runs?")
          ? { workflow_runs: [workflowRun(retained[0], now - HOUR)] } as T
          : { jobs: [apiJob("Check", 30)] } as T,
      ),
    detail,
  );
  try {
    for (
      const [runId, at] of [
        ...retained.map((runId, index) =>
          [runId, now - (index + 1) * HOUR] as const
        ),
        [stale, now - (CI_JOB_CACHE_DAYS + 1) * DAY] as const,
      ]
    ) {
      await seedCachedRun(store, {
        repo: REPO,
        workflow: CI_WORKFLOW,
        runId,
        runAttempt: 1,
        runUrl: `https://github.com/${REPO}/actions/runs/${runId}`,
        at,
        overallSeconds: 30,
        jobs: [{ name: "Check", seconds: 30 }],
        gantt: {
          status: "completed",
          conclusion: "success",
          event: "push",
          headBranch: "main",
          startedAt: new Date(at).toISOString(),
          workflowName: "CI",
        },
      }, jobs);
    }

    await collector.collect("token", now, CI_HISTORY_SOURCES.labs, 45);

    // This is what makes pruning safe to run alongside chart assembly: a chart
    // draws the runs the index names, and every one of those still has its
    // detail afterwards. Only a run the index itself has dropped loses it.
    for (
      const { runId, runAttempt } of store.attempts(REPO, CI_WORKFLOW)
    ) {
      assert(
        await detail.read(CI_HISTORY_SOURCES.labs, runId, runAttempt),
        `run ${runId} attempt ${runAttempt} lost its detail`,
      );
    }
    assertEquals(store.attempts(REPO, CI_WORKFLOW).length, retained.length);
    assertEquals(store.get(REPO, CI_WORKFLOW, stale, 1), undefined);
    assertEquals(await detail.read(CI_HISTORY_SOURCES.labs, stale, 1), null);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt collects an attempt whose detail cannot be read", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-unreadable-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const run = workflowRun(11_500, NOW);
  let jobRequests = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      jobRequests++;
      return Promise.resolve({ jobs: [apiJob("Recovered", 30)] } as T);
    },
  );
  try {
    await seedCachedRun(store, {
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: run.id,
      runAttempt: 1,
      runUrl: run.html_url,
      at: NOW,
      overallSeconds: 30,
      jobs: [{ name: "Check", seconds: 30 }],
      gantt: {
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        headBranch: run.head_branch ?? undefined,
        startedAt: run.run_started_at,
        workflowName: "CI",
      },
    }, [{
      name: "Check",
      status: "completed",
      conclusion: "success",
      started_at: new Date(NOW - HOUR).toISOString(),
      completed_at: new Date(NOW - HOUR + 30_000).toISOString(),
      steps: [],
    }]);
    await store.save(NOW);

    // Overwrite the stored detail with a layout this version does not
    // recognize. The index entry stays intact and still says the attempt is
    // drawable, so nothing but reading the file reveals it is unusable.
    for await (const entry of Deno.readDir(ganttDetailDirectory(file))) {
      await Deno.writeTextFile(
        `${ganttDetailDirectory(file)}/${entry.name}`,
        JSON.stringify({ version: 99, jobs: [] }),
      );
    }

    const chart = await collector.gantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      NOW,
    );
    assertEquals(jobRequests, 1);
    assertEquals(chart.runs[0].jobs[0].name, "Recovered");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("walking the range slider past the snapshot cache costs no requests or writes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-snapshot-cache-" });
  const file = `${directory}/history.json`;
  class CountingStore extends CiJobHistoryStore {
    saves = 0;
    override save(now = Date.now()): Promise<void> {
      this.saves++;
      return super.save(now);
    }
  }
  const store = new CountingStore(file);
  const now = Date.now();
  const runs = Array.from(
    { length: 12 },
    (_, index) => workflowRun(12_000 + index, now - index * DAY),
  );
  let requests = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) => {
      requests++;
      return Promise.resolve(
        path.includes("/runs?")
          ? { workflow_runs: runs } as T
          : { jobs: [apiJob("Check", 30)] } as T,
      );
    },
  );
  // One window past the cache for every window the slider can rest on.
  const windows = Array.from(
    { length: SNAPSHOT_CACHE_MAX + 4 },
    (_, index) => index + 1,
  );
  try {
    for (const days of windows) {
      await collector.startRefresh("token", CI_HISTORY_SOURCES.labs, days)
        .result;
    }
    const settled = { requests, saves: store.saves };

    // Walk back over every window, including the ones eviction has dropped.
    // A rebuilt snapshot comes from the run index, so revisiting a window
    // neither contacts GitHub nor rewrites the index.
    for (const days of [...windows].reverse()) {
      assert(
        (await collector.cached(CI_HISTORY_SOURCES.labs, days, now))?.runCount,
      );
      await collector.startRefresh("token", CI_HISTORY_SOURCES.labs, days)
        .result;
    }
    assertEquals([requests, store.saves], [settled.requests, settled.saves]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a discovered workflow run keeps every field and nothing else", () => {
  // What GitHub actually sends with every entry: the repository, the head
  // repository, the whole head commit, and both actors, around fifty times the
  // size of what a chart reads. A window is thousands of runs held for half an
  // hour, so none of the surplus is kept.
  const surplus = {
    repository: { id: 1, full_name: REPO, description: "x".repeat(500) },
    head_repository: { id: 1, full_name: REPO },
    head_commit: { id: "sha", message: "y".repeat(500) },
    actor: { login: "someone", id: 2 },
    triggering_actor: { login: "someone", id: 2 },
    check_suite_id: 99,
  };
  const complete: Required<WorkflowRun> = {
    id: 13_000,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
    run_attempt: 2,
    run_started_at: new Date(NOW).toISOString(),
    html_url: `https://github.com/${REPO}/actions/runs/13000`,
    name: "CI",
  };

  const projected = projectWorkflowRun({ ...complete, ...surplus });

  // Every field the collector reads survives. Dropping one would not fail
  // loudly; it would quietly read as undefined wherever the chart uses it.
  assertEquals(projected, complete);
  assertEquals(Object.keys(projected).filter((key) => key in surplus), []);
});

Deno.test("a slow run does not hold up the runs behind it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-in-flight-" });
  const now = Date.now();
  // More runs than can be outstanding at once, so the collector has to keep
  // taking new ones as earlier ones finish.
  const runs = Array.from(
    { length: 24 },
    (_, index) => workflowRun(14_000 + index, now - index * HOUR),
  );
  // Whichever run the collector asks for first, so the stall lands in the
  // first slots rather than wherever the sampling order happens to put a
  // particular run.
  let slow: number | undefined;
  const deferred = () => {
    let settle: () => void = () => {};
    const waited = new Promise<void>((resolve) => settle = resolve);
    return { waited, settle };
  };
  const slowRequest = deferred();
  const everyOtherFinished = deferred();
  const started: number[] = [];
  const finished: number[] = [];
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    async <T>(path: string): Promise<T> => {
      if (path.includes("/runs?")) {
        return { total_count: runs.length, workflow_runs: runs } as T;
      }
      const id = Number(path.match(/\/runs\/(\d+)\//)![1]);
      started.push(id);
      slow ??= id;
      // It answers only once every other run has been served, which can only
      // happen if its slot is not holding the rest up.
      if (id === slow) await slowRequest.waited;
      finished.push(id);
      if (finished.length === runs.length - 1) everyOtherFinished.settle();
      return { jobs: [apiJob("Check", 30)] } as T;
    },
  );
  try {
    const collection = collector.collect(
      "token",
      now,
      CI_HISTORY_SOURCES.labs,
      45,
    );
    // Taking a whole group at a time would stop after the first group of
    // JOB_FETCH_CONCURRENCY and never settle this.
    await everyOtherFinished.waited;
    assertEquals(started.length, runs.length);
    assert(slow !== undefined && !finished.includes(slow));

    slowRequest.settle();
    const snapshot = await collection;
    assertEquals(snapshot.runCount, runs.length);
    assertEquals(finished.length, runs.length);
  } finally {
    slowRequest.settle();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a window still collecting keeps its snapshot through an eviction", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-snapshot-inflight-" });
  const now = Date.now();
  const runs = Array.from(
    { length: 4 },
    (_, index) => workflowRun(16_000 + index, now - index * HOUR),
  );
  const deferred = () => {
    let settle: () => void = () => {};
    const waited = new Promise<void>((resolve) => settle = resolve);
    return { waited, settle };
  };
  const reachedSave = deferred();
  const releaseSave = deferred();
  // Holds a refresh open at the point it records its manifest, which is where
  // it reads back the sampled runs an eviction would take.
  class HeldSaveStore extends CiJobHistoryStore {
    hold = false;
    override async save(at = Date.now()): Promise<void> {
      if (this.hold) {
        this.hold = false;
        reachedSave.settle();
        await releaseSave.waited;
      }
      await super.save(at);
    }
  }
  const store = new HeldSaveStore(`${directory}/history.json`);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) =>
      Promise.resolve(
        (path.includes("/runs?")
          ? { total_count: runs.length, workflow_runs: runs }
          : { jobs: [apiJob("Check", 30)] }) as T,
      ),
  );
  let collecting: Promise<unknown> = Promise.resolve();
  try {
    await collector.startRefresh("token", CI_HISTORY_SOURCES.labs, 45).result;

    store.hold = true;
    collecting = collector.startRefresh(
      "token",
      CI_HISTORY_SOURCES.labs,
      1,
      buildCiJobHistory([]),
    ).result;
    await reachedSave.waited;
    assert(collector.snapshot(CI_HISTORY_SOURCES.labs, 1));

    // Enough other windows to push the cache past its bound.
    for (let days = 2; days <= SNAPSHOT_CACHE_MAX + 4; days++) {
      await collector.cached(CI_HISTORY_SOURCES.labs, days, now);
    }

    // The collecting window keeps its snapshot, so the manifest it records
    // names the runs it actually sampled.
    assert(collector.snapshot(CI_HISTORY_SOURCES.labs, 1));
    releaseSave.settle();
    await collecting;
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, 1)?.sampledRuns.length,
      collector.snapshot(CI_HISTORY_SOURCES.labs, 1)?.runCount,
    );
  } finally {
    releaseSave.settle();
    await collecting.catch(() => {});
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history reports shared workflow discovery progress", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-discovery-test-",
  });
  const now = Date.now();
  let releaseFirst!: (value: unknown) => void;
  let releaseSecond!: (value: unknown) => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstResponse = new Promise<unknown>((resolve) => {
    releaseFirst = resolve;
  });
  const secondResponse = new Promise<unknown>((resolve) => {
    releaseSecond = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let requests = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>() => {
      requests++;
      if (requests === 1) {
        markFirstStarted();
        return firstResponse as Promise<T>;
      }
      if (requests === 2) {
        markSecondStarted();
        return secondResponse as Promise<T>;
      }
      if (requests === 3) return Promise.resolve({ workflow_runs: [] } as T);
      throw new Error(`unexpected workflow request ${requests}`);
    },
  );
  let stopShort: (() => void) | null = null;
  let wideResult: Promise<unknown> | undefined;
  let shortResult: Promise<unknown> | undefined;
  try {
    const wide = collector.startRefresh(
      "discovery-token",
      CI_HISTORY_SOURCES.labs,
      45,
    );
    assert(wide.progress);
    wideResult = wide.result;
    await firstStarted;
    assertEquals(
      [
        collector.progress(wide.progress.id)?.discoveryRequestsMade,
        collector.progress(wide.progress.id)?.discoveryResponsesReceived,
        collector.progress(wide.progress.id)?.discoveryOutstandingRequests,
        collector.progress(wide.progress.id)?.requestsMade,
      ],
      [1, 0, 1, 0],
    );

    const short = collector.startRefresh(
      "discovery-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assert(short.progress);
    shortResult = short.result;
    let markShortJoined!: () => void;
    const shortJoined = new Promise<void>((resolve) => {
      markShortJoined = resolve;
    });
    stopShort = collector.subscribeProgress(short.progress.id, (state) => {
      if (state.discoveryRequestsMade === 1) markShortJoined();
    });
    assert(stopShort);
    await shortJoined;

    releaseFirst({
      total_count: 101,
      workflow_runs: Array.from(
        { length: 100 },
        (_, index) =>
          workflowRun(11_000 + index, now - index * 1_000, {
            conclusion: "failure",
          }),
      ),
    });
    await secondStarted;
    for (const progress of [wide.progress, short.progress]) {
      assertEquals(
        [
          collector.progress(progress.id)?.discoveryRequestsMade,
          collector.progress(progress.id)?.discoveryResponsesReceived,
          collector.progress(progress.id)?.discoveryOutstandingRequests,
        ],
        [2, 1, 1],
      );
    }

    releaseSecond({
      workflow_runs: [workflowRun(11_100, now, { conclusion: "failure" })],
    });
    await Promise.all([wide.result, short.result]);
    for (const progress of [wide.progress, short.progress]) {
      assertEquals(
        [
          collector.progress(progress.id)?.phase,
          collector.progress(progress.id)?.discoveryRequestsMade,
          collector.progress(progress.id)?.discoveryResponsesReceived,
          collector.progress(progress.id)?.discoveryOutstandingRequests,
          collector.progress(progress.id)?.requestsMade,
        ],
        ["complete", 3, 3, 0, 0],
      );
    }
    // Two pages of the search, then the workflow's newest page.
    assertEquals(requests, 3);
  } finally {
    stopShort?.();
    releaseFirst({ workflow_runs: [] });
    releaseSecond({ workflow_runs: [] });
    await Promise.allSettled(
      [wideResult, shortResult].filter(
        (result): result is Promise<unknown> => result !== undefined,
      ),
    );
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history reports progress and persists wider-window responses after a slider change", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const oldRun = workflowRun(8_901, now - 30 * DAY);
  const recentRun = workflowRun(8_902, now - DAY);
  let releaseOld!: (response: Response) => void;
  let releaseRecent!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => releaseOld = resolve);
  const recentResponse = new Promise<Response>((resolve) => {
    releaseRecent = resolve;
  });
  let markRequestsStarted!: () => void;
  const requestsStarted = new Promise<void>((resolve) => {
    markRequestsStarted = resolve;
  });
  let actualJobRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [recentRun, oldRun],
      }));
    }
    const runId = Number(
      url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1],
    );
    if (runId === oldRun.id || runId === recentRun.id) {
      actualJobRequests++;
      if (actualJobRequests === 2) markRequestsStarted();
      return runId === oldRun.id ? oldResponse : recentResponse;
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  let stopWide: (() => void) | null = null;
  let stopShort: (() => void) | null = null;
  try {
    const wide = test.collector.startRefresh(
      "progress-token",
      CI_HISTORY_SOURCES.labs,
      45,
    );
    assert(wide.progress);
    const progressUrl = new URL(
      `http://x/bench/ci-progress?id=${wide.progress.id}`,
    );
    const progressResponse = ciJobHistoryProgressResponse(
      progressUrl,
      test.collector,
    );
    assertEquals(
      progressResponse.headers.get("content-type"),
      "text/event-stream",
    );
    const progressReader = progressResponse.body!.getReader();
    const firstProgressEvent = await progressReader.read();
    assertStringIncludes(
      new TextDecoder().decode(firstProgressEvent.value),
      'event: progress\ndata: {"id":',
    );
    await progressReader.cancel();
    const widePhases: string[] = [];
    let markWideResponse!: () => void;
    const wideResponded = new Promise<void>((resolve) => {
      markWideResponse = resolve;
    });
    stopWide = test.collector.subscribeProgress(wide.progress.id, (state) => {
      widePhases.push(state.phase);
      if (state.responsesReceived === 1) markWideResponse();
    });
    assert(stopWide);

    await requestsStarted;
    assertEquals(test.collector.progress(wide.progress.id)?.requestsMade, 2);
    assertEquals(
      test.collector.progress(wide.progress.id)?.outstandingRequests,
      2,
    );

    const short = test.collector.startRefresh(
      "progress-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assert(short.progress);
    let markShortStarted!: () => void;
    const shortStarted = new Promise<void>((resolve) => {
      markShortStarted = resolve;
    });
    stopShort = test.collector.subscribeProgress(short.progress.id, (state) => {
      if (state.sharedRequests === 1) markShortStarted();
    });
    assert(stopShort);
    await shortStarted;

    releaseOld(Response.json({ jobs: [apiJob("Old check", 100)] }));
    await wideResponded;
    const partiallyPersisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(
      partiallyPersisted.runs.map((run: { runId: number }) => run.runId),
      [oldRun.id],
    );

    releaseRecent(Response.json({ jobs: [apiJob("Recent check", 80)] }));
    const [wideSnapshot, shortSnapshot] = await Promise.all([
      wide.result,
      short.result,
    ]);
    assertEquals(wideSnapshot.runCount, 2);
    assertEquals(shortSnapshot.runCount, 1);
    const wideDone = test.collector.progress(wide.progress.id);
    assertEquals(
      [
        wideDone?.phase,
        wideDone?.completedRuns,
        wideDone?.responsesReceived,
        wideDone?.outstandingRequests,
        wideDone?.queuedRuns,
      ],
      ["complete", 2, 2, 0, 0],
    );
    assert(widePhases.includes("discovering"));
    assert(widePhases.includes("fetching"));
    assert(widePhases.includes("saving"));
    assert(widePhases.includes("complete"));
    const cachedWindow = test.collector.startRefresh(
      "progress-token",
      CI_HISTORY_SOURCES.labs,
      14,
    );
    assert(cachedWindow.progress);
    await cachedWindow.result;
    const cachedDone = test.collector.progress(cachedWindow.progress.id);
    assertEquals(
      [
        cachedDone?.phase,
        cachedDone?.totalRuns,
        cachedDone?.cachedRuns,
        cachedDone?.requestsMade,
        cachedDone?.needsReload,
      ],
      ["complete", 1, 1, 0, false],
    );
    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(
      persisted.runs.map((run: { runId: number }) => run.runId),
      [oldRun.id, recentRun.id],
    );
    assertEquals(actualJobRequests, 2);
  } finally {
    stopWide?.();
    stopShort?.();
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history reloads a short page when a wider collection populated its cache", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const firstRun = workflowRun(8_911, now - 2 * DAY);
  const addedRun = workflowRun(8_912, now - DAY);
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [addedRun, firstRun],
      }));
    }
    const runId = Number(
      url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1],
    );
    if (runId === firstRun.id || runId === addedRun.id) {
      jobCalls++;
      return Promise.resolve(Response.json({
        jobs: [apiJob(`Check ${runId}`, runId === firstRun.id ? 60 : 70)],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const initial = await test.collector.collect(
      "baseline-token",
      now,
      CI_HISTORY_SOURCES.labs,
      7,
      [firstRun],
    );
    assertEquals(initial.runCount, 1);

    const baseline = test.collector.snapshot(CI_HISTORY_SOURCES.labs, 7);
    assert(baseline);
    const wide = await test.collector.collect(
      "baseline-token",
      now,
      CI_HISTORY_SOURCES.labs,
      45,
      [firstRun, addedRun],
    );
    assertEquals(wide.runCount, 2);

    const refresh = test.collector.startRefresh(
      "baseline-token",
      CI_HISTORY_SOURCES.labs,
      7,
      baseline,
    );
    assert(refresh.progress);
    const updated = await refresh.result;
    const progress = test.collector.progress(refresh.progress.id);

    assertEquals(updated.runCount, 2);
    assertEquals(progress?.requestsMade, 0);
    assertEquals(progress?.needsReload, true);
    assertEquals(jobCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history rebuilds a fresh short range after a wider range repairs its cache", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const stableRun = workflowRun(8_916, now - 2 * DAY);
  const repairedRun = workflowRun(8_917, now - DAY);
  let repairAvailable = false;
  const jobCalls = new Map<number, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [repairedRun, stableRun],
      }));
    }
    const runId = Number(
      url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1],
    );
    if (runId === stableRun.id) {
      jobCalls.set(runId, (jobCalls.get(runId) ?? 0) + 1);
      return Promise.resolve(Response.json({ jobs: [apiJob("Stable", 60)] }));
    }
    if (runId === repairedRun.id) {
      jobCalls.set(runId, (jobCalls.get(runId) ?? 0) + 1);
      return repairAvailable
        ? Promise.resolve(Response.json({ jobs: [apiJob("Repaired", 70)] }))
        : Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const short = test.collector.startRefresh(
      "repair-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    const partial = await short.result;
    assertEquals([partial.runCount, partial.failedRunCount], [1, 1]);

    repairAvailable = true;
    const wide = await test.collector.startRefresh(
      "repair-token",
      CI_HISTORY_SOURCES.labs,
      45,
    ).result;
    assertEquals([wide.runCount, wide.failedRunCount], [2, 0]);

    const rebuilt = test.collector.startRefresh(
      "repair-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assert(rebuilt.progress);
    const complete = await rebuilt.result;
    assertEquals([complete.runCount, complete.failedRunCount], [2, 0]);
    assertEquals(jobCalls.get(stableRun.id), 1);
    assertEquals(jobCalls.get(repairedRun.id), 2);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history joins a wider repair before taking the short-range freshness path", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const stableRun = workflowRun(8_918, now - 2 * DAY);
  const repairedRun = workflowRun(8_919, now - DAY);
  let repairCalls = 0;
  let stableCalls = 0;
  let markRepairStarted!: () => void;
  const repairStarted = new Promise<void>((resolve) =>
    markRepairStarted = resolve
  );
  let releaseRepair!: (response: Response) => void;
  const repairResponse = new Promise<Response>((resolve) =>
    releaseRepair = resolve
  );
  let repairReleased = false;
  const unblockRepair = () => {
    if (repairReleased) return;
    repairReleased = true;
    releaseRepair(Response.json({ jobs: [apiJob("Repaired", 70)] }));
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [repairedRun, stableRun],
      }));
    }
    const runId = Number(
      url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1],
    );
    if (runId === stableRun.id) {
      stableCalls++;
      return Promise.resolve(Response.json({ jobs: [apiJob("Stable", 60)] }));
    }
    if (runId === repairedRun.id) {
      repairCalls++;
      if (repairCalls === 1) {
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }
      markRepairStarted();
      return repairResponse;
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const pending: Promise<unknown>[] = [];
  try {
    const partial = await test.collector.startRefresh(
      "active-repair-token",
      CI_HISTORY_SOURCES.labs,
      7,
    ).result;
    assertEquals([partial.runCount, partial.failedRunCount], [1, 1]);

    const wide = test.collector.startRefresh(
      "active-repair-token",
      CI_HISTORY_SOURCES.labs,
      45,
    );
    pending.push(wide.result);
    await repairStarted;

    const lateShort = test.collector.startRefresh(
      "active-repair-token",
      CI_HISTORY_SOURCES.labs,
      7,
      partial,
    );
    assert(lateShort.progress);
    pending.push(lateShort.result);
    unblockRepair();
    const [wideResult, shortResult] = await Promise.all([
      wide.result,
      lateShort.result,
    ]);

    assertEquals([wideResult.runCount, wideResult.failedRunCount], [2, 0]);
    assertEquals([shortResult.runCount, shortResult.failedRunCount], [2, 0]);
    assertEquals(
      test.collector.progress(lateShort.progress.id)?.needsReload,
      true,
    );
    assertEquals([stableCalls, repairCalls], [1, 2]);
  } finally {
    unblockRepair();
    await Promise.allSettled(pending);
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history keeps labs fresh while loom has a pending cache write", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-history-source-cache-test-",
  });
  const file = `${directory}/history.json`;
  let markLoomSaveStarted!: () => void;
  const loomSaveStarted = new Promise<void>((resolve) =>
    markLoomSaveStarted = resolve
  );
  let releaseLoomSave!: () => void;
  const loomSaveGate = new Promise<void>((resolve) =>
    releaseLoomSave = resolve
  );
  let loomSaveReleased = false;
  const unblockLoomSave = () => {
    if (loomSaveReleased) return;
    loomSaveReleased = true;
    releaseLoomSave();
  };
  class SourceStore extends CiJobHistoryStore {
    saveCalls = 0;

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      if (this.saveCalls === 3) {
        markLoomSaveStarted();
        await loomSaveGate;
        throw new Error("loom save failed");
      }
      await super.save(now);
    }
  }
  const store = new SourceStore(file);
  const collector = new CiJobHistoryCollector(store);
  const labsRun = workflowRun(8_926, Date.now() - DAY);
  const loomRun = workflowRun(8_927, Date.now() - DAY, {
    html_url: `https://github.com/${LOOM_REPO}/actions/runs/8927`,
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(`/repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({ workflow_runs: [labsRun] }));
    }
    if (
      url.includes(
        `/repos/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}/runs?`,
      )
    ) {
      return Promise.resolve(Response.json({ workflow_runs: [loomRun] }));
    }
    if (
      url.includes(
        `/repos/${REPO}/actions/runs/${labsRun.id}/attempts/1/jobs`,
      )
    ) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Labs", 60)] }));
    }
    if (
      url.includes(
        `/repos/${LOOM_REPO}/actions/runs/${loomRun.id}/attempts/1/jobs`,
      )
    ) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Loom", 70)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const pending: Promise<unknown>[] = [];
  try {
    const labs = await collector.startRefresh(
      "source-token",
      CI_HISTORY_SOURCES.labs,
      7,
    ).result;
    assertEquals(labs.runCount, 1);

    const loom = collector.startRefresh(
      "source-token",
      CI_HISTORY_SOURCES.loom,
      7,
    );
    pending.push(loom.result);
    await loomSaveStarted;

    const labsDuringLoom = collector.startRefresh(
      "source-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assertEquals(labsDuringLoom.progress, null);
    assertEquals((await labsDuringLoom.result).runCount, 1);
    assertEquals(store.saveCalls, 3);

    unblockLoomSave();
    await assertRejects(() => loom.result, Error, "loom save failed");
    const labsAfterFailure = collector.startRefresh(
      "source-token",
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assertEquals(labsAfterFailure.progress, null);
    assertEquals((await labsAfterFailure.result).runCount, 1);
    assertEquals(store.saveCalls, 3);
    assertEquals(
      calls.filter((url) => url.includes(`/repos/${REPO}/`) && !isNewestPage(url))
        .length,
      2,
    );
  } finally {
    unblockLoomSave();
    await Promise.allSettled(pending);
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history persists a shared job response once across active windows", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-history-save-test-",
  });
  const file = `${directory}/history.json`;
  class CountingStore extends CiJobHistoryStore {
    saveCalls = 0;

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      await super.save(now);
    }
  }
  const store = new CountingStore(file);
  const collector = new CiJobHistoryCollector(store);
  const run = workflowRun(8_921, Date.now() - DAY);
  let releaseJob!: (response: Response) => void;
  const jobResponse = new Promise<Response>((resolve) => releaseJob = resolve);
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return jobResponse;
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const stops: (() => void)[] = [];
  try {
    const refreshes = [7, 8, 9, 10, 11].map((days) =>
      collector.startRefresh(
        "shared-save-token",
        CI_HISTORY_SOURCES.labs,
        days,
        null,
      )
    );
    await Promise.all(refreshes.map((refresh) => {
      assert(refresh.progress);
      return new Promise<void>((resolve) => {
        const stop = collector.subscribeProgress(
          refresh.progress!.id,
          (state) => {
            if (state.requestsMade + state.sharedRequests === 1) resolve();
          },
        );
        assert(stop);
        stops.push(stop);
      });
    }));

    releaseJob(Response.json({ jobs: [apiJob("Shared check", 90)] }));
    await Promise.all(refreshes.map((refresh) => refresh.result));

    assertEquals(jobCalls, 1);
    assertEquals(store.saveCalls, 6);
    assertEquals(
      refreshes.reduce(
        (total, refresh) =>
          total + (collector.progress(refresh.progress!.id)?.requestsMade ?? 0),
        0,
      ),
      1,
    );
    assertEquals(
      refreshes.reduce(
        (total, refresh) =>
          total +
          (collector.progress(refresh.progress!.id)?.sharedRequests ?? 0),
        0,
      ),
      4,
    );
  } finally {
    for (const stop of stops) stop();
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history joins persistence when a range starts after the response", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-history-late-range-test-",
  });
  const file = `${directory}/history.json`;
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => markSaveStarted = resolve);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => releaseSave = resolve);
  let saveReleased = false;
  const unblockSave = () => {
    if (saveReleased) return;
    saveReleased = true;
    releaseSave();
  };
  class BlockingStore extends CiJobHistoryStore {
    saveCalls = 0;

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      markSaveStarted();
      await saveGate;
      await super.save(now);
    }
  }
  const store = new BlockingStore(file);
  const collector = new CiJobHistoryCollector(store);
  const run = workflowRun(8_931, Date.now() - DAY);
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(
        Response.json({ jobs: [apiJob("Late check", 90)] }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const results: Promise<unknown>[] = [];
  const stops: (() => void)[] = [];
  try {
    const wide = collector.startRefresh(
      "late-range-token",
      CI_HISTORY_SOURCES.labs,
      45,
      null,
    );
    results.push(wide.result);
    await saveStarted;

    const short = collector.startRefresh(
      "late-range-token",
      CI_HISTORY_SOURCES.labs,
      7,
      null,
    );
    results.push(short.result);
    assert(short.progress);
    await new Promise<void>((resolve) => {
      const stop = collector.subscribeProgress(short.progress!.id, (state) => {
        if (state.sharedRequests === 1) resolve();
      });
      assert(stop);
      stops.push(stop);
    });
    const waiting = collector.progress(short.progress.id);
    assertEquals(waiting?.cachedRuns, 0);
    assertEquals(waiting?.completedRuns, 0);
    assertEquals(waiting?.outstandingRequests, 1);
    assertEquals(store.saveCalls, 1);

    unblockSave();
    await Promise.all(results);
    assertEquals(jobCalls, 1);
    assertEquals(store.saveCalls, 3);
    assertEquals(collector.progress(short.progress.id)?.phase, "complete");
  } finally {
    for (const stop of stops) stop();
    unblockSave();
    await Promise.allSettled(results);
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history fetches selected runs once and filters unusable jobs", async () => {
  const test = await temporaryCollector();
  const runs = [
    workflowRun(9_001, NOW - 2 * DAY),
    workflowRun(9_002, NOW - DAY),
    workflowRun(9_003, NOW),
    workflowRun(9_004, NOW - HOUR, { conclusion: "failure" }),
    workflowRun(9_005, NOW - DAY),
  ];
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-token",
    );
    if (isNewestPage(url)) {
      return Promise.resolve(Response.json({ workflow_runs: [] }));
    }
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      const parsed = new URL(url);
      assertEquals(parsed.searchParams.get("branch"), "main");
      assertEquals(parsed.searchParams.get("event"), "push");
      assertEquals(parsed.searchParams.get("status"), "success");
      assert(parsed.searchParams.get("created")?.includes(".."));
      return Promise.resolve(Response.json({ workflow_runs: runs }));
    }
    const match = url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/);
    if (match) {
      const id = Number(match[1]);
      return Promise.resolve(Response.json({
        jobs: [
          apiJob("Check", 100 + id - 9_001),
          apiJob("Test (1/2)", 120 + id - 9_001),
          apiJob("Test (2/2)", 140 + id - 9_001),
          apiJob("Cancelled", 300, "cancelled"),
          {
            name: "No timing",
            conclusion: "success",
            started_at: null,
            completed_at: null,
          },
        ],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = await test.collector.collect("test-token", NOW);
    assertEquals(first.runCount, 4);
    assertEquals(first.successfulRunTimes, [
      NOW - 2 * DAY,
      NOW - DAY,
      NOW - DAY,
      NOW,
    ]);
    assertEquals(first.failedRunCount, 0);
    assertEquals(first.axisStart, NOW - CI_HISTORY_DAYS * DAY);
    assertEquals(first.axisEnd, NOW);
    assertEquals(
      first.overall?.points.map((point) => point.seconds),
      [140, 141, 144, 142],
    );
    assertEquals(first.groups[0].aggregate.points.length, 4);
    assertEquals(first.jobs.map((series) => series.name), ["Check"]);
    assertEquals(
      first.groups[0].aggregate.points.map((point) => point.seconds),
      [140, 141, 144, 142],
    );
    assert(!JSON.stringify(first).includes("Cancelled"));
    assert(!JSON.stringify(first).includes("No timing"));

    const firstJobCalls = calls.filter((call) =>
      call.includes("/jobs?")
    ).length;
    assertEquals(firstJobCalls, 4);
    await test.collector.collect("test-token", NOW);
    const secondJobCalls = calls.filter((call) =>
      call.includes("/jobs?")
    ).length;
    assertEquals(secondJobCalls, firstJobCalls);

    const runCallsBeforeRefresh =
      calls.filter((call) =>
        call.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`) &&
        !isNewestPage(call)
      ).length;
    await test.collector.refresh("test-token");
    await test.collector.refresh("test-token");
    const runCallsAfterRefresh =
      calls.filter((call) =>
        call.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`) &&
        !isNewestPage(call)
      ).length;
    assertEquals(runCallsAfterRefresh, runCallsBeforeRefresh + 1);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history reloads completed attempts from its server cache", async () => {
  const test = await temporaryCollector();
  const run = workflowRun(9_101, NOW);
  let runCalls = 0;
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      if (!isNewestPage(url)) runCalls++;
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", 90), apiJob("Test", 120)],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = await test.collector.collect("cache-token", NOW);
    assertEquals(first.overall?.points[0].seconds, 120);
    assertEquals([runCalls, jobCalls], [1, 1]);

    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(persisted.version, 1);
    assertEquals(persisted.runs[0].repo, REPO);
    assertEquals(persisted.runs[0].runAttempt, 1);

    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const cached = await restarted.cached(CI_HISTORY_SOURCES.labs, 45, NOW);
    assertEquals(cached?.jobs.map((series) => series.name), ["Check", "Test"]);
    assertEquals([runCalls, jobCalls], [1, 1]);

    const short = await restarted.cached(CI_HISTORY_SOURCES.labs, 7, NOW);
    assertEquals(short?.runCount, 1);
    const expired = await restarted.cached(
      CI_HISTORY_SOURCES.labs,
      7,
      NOW + 8 * DAY,
    );
    assertEquals(expired?.runCount, 0);
    assertEquals(expired?.overall, null);
    assertEquals(expired?.groups, []);
    assertEquals(expired?.jobs, []);
    assertEquals(expired?.axisStart, NOW + DAY);
    assertEquals(expired?.axisEnd, NOW + 8 * DAY);

    await restarted.collect("cache-token", NOW);
    assertEquals(runCalls, 2);
    assertEquals(jobCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history reuses a fresh completed collection after a dashboard restart", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const run = workflowRun(9_103, now);
  let runCalls = 0;
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      if (!isNewestPage(url)) runCalls++;
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", 90)],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = test.collector.startRefresh(
      "restart-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    );
    assert(first.progress);
    await first.result;
    assertEquals([runCalls, jobCalls], [1, 1]);

    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(persisted.refreshes.length, 1);
    assertEquals(persisted.refreshes[0].days, CI_HISTORY_DAYS);
    assertEquals(
      persisted.refreshes[0].samplingVersion,
      CI_JOB_HISTORY_SAMPLING_VERSION,
    );
    assertEquals(persisted.refreshes[0].successfulRunTimes, [now]);
    assertEquals(persisted.refreshes[0].sampledRuns, [{
      runId: run.id,
      runAttempt: 1,
    }]);
    assertEquals(persisted.refreshes[0].failedRunCount, 0);

    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const cached = await restarted.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      Date.now(),
    );
    assertEquals(cached?.successfulRunTimes, [now]);
    const refresh = restarted.startRefresh(
      "restart-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      cached,
    );
    assertEquals(refresh.progress, null);
    assertEquals((await refresh.result).runCount, 1);
    assertEquals([runCalls, jobCalls], [1, 1]);
    assertEquals(
      (await restarted.cached(
        CI_HISTORY_SOURCES.labs,
        CI_HISTORY_DAYS,
        now + (CI_HISTORY_DAYS + 1) * DAY,
      ))?.runCount,
      0,
    );

    const validCache = await Deno.readTextFile(test.file);
    const malformed = JSON.parse(validCache);
    malformed.runs.push({ runId: "invalid" });
    await Deno.writeTextFile(test.file, JSON.stringify(malformed));
    const damaged = new CiJobHistoryStore(test.file);
    await damaged.load();
    assertEquals(
      damaged.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
    await Deno.writeTextFile(test.file, validCache);

    const emptyStore = new CiJobHistoryStore(test.file);
    await emptyStore.load();
    emptyStore.invalidateRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS);
    emptyStore.markRefreshed(
      REPO,
      CI_WORKFLOW,
      CI_HISTORY_DAYS,
      Date.now(),
      [],
      [],
      0,
      [],
      false,
    );
    await emptyStore.save();
    const emptyRestart = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    assertEquals(
      (await emptyRestart.cached(
        CI_HISTORY_SOURCES.labs,
        CI_HISTORY_DAYS,
        Date.now(),
      ))?.runCount,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history does not rebuild a matching persisted manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  class CachedReadCollector extends CiJobHistoryCollector {
    cachedReads = 0;

    override cached(
      ...args: Parameters<CiJobHistoryCollector["cached"]>
    ): ReturnType<CiJobHistoryCollector["cached"]> {
      this.cachedReads++;
      return super.cached(...args);
    }
  }
  const run = workflowRun(9_105, Date.now() - HOUR);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    return Promise.resolve(
      url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)
        ? Response.json({ workflow_runs: [run] })
        : Response.json({ jobs: [apiJob("Check", 90)] }),
    );
  };

  try {
    const collector = new CachedReadCollector(
      new CiJobHistoryStore(`${directory}/history.json`),
    );
    assertEquals(
      (await collector.startRefresh("matching-manifest-token").result)
        .runCount,
      1,
    );
    assertEquals(collector.cachedReads, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history does not bless a preserved legacy sample", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const first = workflowRun(9_106, now - HOUR);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    return Promise.resolve(
      url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)
        ? Response.json({ workflow_runs: [first] })
        : Response.json({ jobs: [apiJob("Check", 90)] }),
    );
  };

  try {
    await test.collector.startRefresh("legacy-sample-token").result;
    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    delete persisted.refreshes[0].samplingVersion;
    const reruns = Array.from(
      { length: CI_HISTORY_POINT_TARGET + 1 },
      (_, index) =>
        workflowRun(
          first.id + index,
          now - HOUR - index * 1_000,
          { run_attempt: 2 },
        ),
    );
    persisted.refreshes[0].successfulRunTimes = reruns.map((run) =>
      Date.parse(run.run_started_at)
    );
    await Deno.writeTextFile(test.file, JSON.stringify(persisted));

    globalThis.fetch = (input) => {
      const url = String(input);
      return Promise.resolve(
        url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)
          ? Response.json({ workflow_runs: reruns })
          : new Response("unavailable", { status: 503 }),
      );
    };
    const store = new CiJobHistoryStore(test.file);
    const collector = new CiJobHistoryCollector(store);
    const baseline = await collector.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      now,
    );
    assertEquals(baseline?.runCount, 1);

    const result = await collector.startRefresh(
      "legacy-sample-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      baseline,
    ).result;
    assertEquals(result.runCount, 1);
    assertEquals(result.stale, true);
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)?.samplingVersion,
      undefined,
    );
    assertEquals(
      store.freshRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history does not bless a preserved manifestless sample", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const first = workflowRun(9_107, now - HOUR);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    return Promise.resolve(
      url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)
        ? Response.json({ workflow_runs: [first] })
        : Response.json({ jobs: [apiJob("Check", 90)] }),
    );
  };

  try {
    await test.collector.startRefresh("manifestless-sample-token").result;
    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    persisted.refreshes = [];
    await Deno.writeTextFile(test.file, JSON.stringify(persisted));
    const reruns = Array.from(
      { length: CI_HISTORY_POINT_TARGET + 1 },
      (_, index) =>
        workflowRun(
          first.id + index,
          now - HOUR - index * 1_000,
          { run_attempt: 2 },
        ),
    );

    globalThis.fetch = (input) => {
      const url = String(input);
      return Promise.resolve(
        url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)
          ? Response.json({ workflow_runs: reruns })
          : new Response("unavailable", { status: 503 }),
      );
    };
    const store = new CiJobHistoryStore(test.file);
    const collector = new CiJobHistoryCollector(store);
    const baseline = await collector.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      now,
    );
    assertEquals(baseline?.runCount, 1);

    const result = await collector.startRefresh(
      "manifestless-sample-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      baseline,
    ).result;
    assertEquals(result.runCount, 1);
    assertEquals(result.stale, true);
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)?.samplingVersion,
      undefined,
    );
    assertEquals(
      store.freshRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history preserves an all-failed refresh warning and retries after restart", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const run = workflowRun(9_104, now - HOUR);
  let failing = false;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (!isNewestPage(url)) calls++;
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [{ ...run, run_attempt: failing ? 2 : 1 }],
      }));
    }
    if (url.includes(`/actions/runs/${run.id}/`)) {
      return failing
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    await test.collector.startRefresh(
      "restart-failure-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    ).result;
    failing = true;

    const second = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const baseline = await second.cached(CI_HISTORY_SOURCES.labs, 7, now);
    assertEquals(baseline?.runCount, 1);
    const failed = await second.startRefresh(
      "restart-failure-token",
      CI_HISTORY_SOURCES.labs,
      7,
      baseline,
    ).result;
    assertEquals(failed.runCount, 1);
    assertEquals(failed.failedRunCount, 1);
    assertEquals(failed.stale, true);

    const callsBeforeRestart = calls;
    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const cached = await restarted.cached(
      CI_HISTORY_SOURCES.labs,
      7,
      Date.now(),
    );
    assertEquals(cached?.runCount, 1);
    assertEquals(cached?.failedRunCount, 1);
    assertEquals(cached?.failedRunTimes, [Date.parse(run.run_started_at)]);
    assertEquals(cached?.stale, true);
    const refresh = restarted.startRefresh(
      "restart-failure-token",
      CI_HISTORY_SOURCES.labs,
      7,
      cached,
    );
    assert(refresh.progress);
    assertEquals((await refresh.result).stale, true);
    assertEquals(calls, callsBeforeRestart + 2);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history preserves current sampling provenance after an all-failed refresh", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  let clock = now;
  const run = workflowRun(9_108, now - HOUR);
  let failing = false;
  let calls = 0;
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => clock;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (!isNewestPage(url)) calls++;
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [{ ...run, run_attempt: failing ? 2 : 1 }],
      }));
    }
    if (url.includes(`/actions/runs/${run.id}/`)) {
      if (failing) {
        clock++;
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    await test.collector.startRefresh(
      "current-sample-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    ).result;
    clock += HOUR;
    failing = true;

    const store = new CiJobHistoryStore(test.file);
    const second = new CiJobHistoryCollector(store);
    const baseline = await second.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      clock,
    );
    assertEquals(baseline?.runCount, 1);
    const failed = await second.startRefresh(
      "current-sample-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      baseline,
    ).result;
    assertEquals(failed.runCount, 1);
    assertEquals(failed.stale, true);
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)?.samplingVersion,
      CI_JOB_HISTORY_SAMPLING_VERSION,
    );

    const callsBeforeRestart = calls;
    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const cached = await restarted.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      Date.now(),
    );
    const refresh = restarted.startRefresh(
      "current-sample-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      cached,
    );
    assertEquals(refresh.progress, null);
    assertEquals((await refresh.result).stale, true);
    assertEquals(calls, callsBeforeRestart);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history does not mark a rate-limited collection fresh", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-rate-limited-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const run = workflowRun(9_105, Date.now() - HOUR);
  const warmed = new RateLimitedCiJobHistoryCollector(
    store,
    <T = unknown>(path: string): Promise<T> => {
      if (path.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      return Promise.resolve({ jobs: [apiJob("Check", 90)] } as T);
    },
  );
  await warmed.startRefresh(
    "rate-limited-token",
    CI_HISTORY_SOURCES.labs,
    CI_HISTORY_DAYS,
  ).result;
  const rerun = { ...run, run_attempt: 2 };
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T = unknown>(path: string): Promise<T> => {
      if (path.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
        return Promise.resolve({ workflow_runs: [rerun] } as T);
      }
      return Promise.reject(
        new GitHubRateLimitBudgetError(
          "GitHub rate limit has been hit at the 80% performance-history safety threshold.",
        ),
      );
    },
  );
  try {
    const refresh = collector.startRefresh(
      "rate-limited-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    );
    await assertRejects(
      () => refresh.result,
      GitHubRateLimitBudgetError,
    );
    assertEquals(
      store.freshRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)?.sampledRuns,
      [{ runId: run.id, runAttempt: 1 }],
    );
    assertEquals(collector.snapshot()?.failedRunCount, 1);
    assertEquals(collector.progress(refresh.progress!.id)?.phase, "error");

    const restartedStore = new CiJobHistoryStore(file);
    await restartedStore.load();
    assertEquals(
      restartedStore.freshRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
    assertEquals(
      restartedStore.get(REPO, CI_WORKFLOW, run.id, 1)?.runAttempt,
      1,
    );
    let discoveryCalls = 0;
    const restarted = new RateLimitedCiJobHistoryCollector(
      restartedStore,
      <T = unknown>(path: string): Promise<T> => {
        if (path.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
          if (!isNewestPage(path)) discoveryCalls++;
          return Promise.resolve({ workflow_runs: [rerun] } as T);
        }
        return Promise.reject(
          new GitHubRateLimitBudgetError("rate limit still reserved"),
        );
      },
    );
    await restarted.cached(CI_HISTORY_SOURCES.labs, CI_HISTORY_DAYS);
    const retry = restarted.startRefresh(
      "rate-limited-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    );
    assert(retry.progress);
    await assertRejects(() => retry.result, GitHubRateLimitBudgetError);
    assertEquals(discoveryCalls, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history can replace an in-process future refresh", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-future-refresh-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const run = workflowRun(9_106, Date.now() - HOUR);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T = unknown>(path: string): Promise<T> => {
      if (path.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      return Promise.resolve({ jobs: [apiJob("Check", 90)] } as T);
    },
  );
  try {
    await collector.startRefresh(
      "future-refresh-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    ).result;
    const completed = store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)!;
    store.markRefreshed(
      REPO,
      CI_WORKFLOW,
      CI_HISTORY_DAYS,
      Date.now() + DAY,
      completed.successfulRunTimes,
      completed.sampledRuns,
      completed.failedRunCount,
      completed.failedRunTimes,
      completed.stale,
    );
    await store.save();

    assertEquals(
      store.quarantineFutureRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      true,
    );
    await store.save();
    const replacementAt = Date.now();
    store.markRefreshed(
      REPO,
      CI_WORKFLOW,
      CI_HISTORY_DAYS,
      replacementAt,
      completed.successfulRunTimes,
      completed.sampledRuns,
      completed.failedRunCount,
      completed.failedRunTimes,
      completed.stale,
    );
    await store.save();

    const restarted = new CiJobHistoryStore(file);
    await restarted.load();
    assertEquals(
      restarted.freshRefresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS)?.refreshedAt,
      replacementAt,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reuses and reloads the CI history job cache", async () => {
  const test = await temporaryCollector();
  const now = Date.now();
  const run = workflowRun(9_105, now, { name: "CI" });
  let runCalls = 0;
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      if (!isNewestPage(url)) runCalls++;
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(Response.json({
        jobs: [{
          ...apiJob("Check", 90),
          status: "completed",
          steps: [{
            name: "🔎 Check",
            number: 1,
            conclusion: "success",
            started_at: new Date(now - HOUR).toISOString(),
            completed_at: new Date(now - HOUR + 90_000).toISOString(),
          }],
        }],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    await test.collector.startRefresh(
      "shared-cache-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    ).result;
    const gantt = await test.collector.gantt(
      "shared-cache-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true },
      now,
    );
    assertEquals(runCalls, 1);
    assertEquals(jobCalls, 1);
    assertEquals(gantt.runs[0].run.databaseId, run.id);
    assertEquals(gantt.runs[0].jobs[0].steps[0].name, "🔎 Check");

    // The index carries the run summary and no step detail; the jobs a chart
    // draws sit in the detail store beside it.
    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(persisted.runs[0].gantt.workflowName, "CI");
    assertEquals(persisted.runs[0].gantt.jobs, undefined);
    assertEquals(persisted.runs[0].gantt.drawable, true);
    const detail = new CiGanttDetailStore(ganttDetailDirectory(test.file));
    assertEquals(
      (await detail.read(CI_HISTORY_SOURCES.labs, run.id, 1))?.[0].name,
      "Check",
    );

    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    const reloaded = await restarted.gantt(
      undefined,
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true },
      now,
    );
    assertEquals(reloaded, gantt);
    assertEquals(jobCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("a selected-run Gantt reads only its run and then reuses the disk cache", async () => {
  const test = await temporaryCollector();
  const run = workflowRun(9_115, NOW, {
    name: "CI",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (
      url.pathname.endsWith(
        `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
      )
    ) {
      return Promise.resolve(Response.json(run));
    }
    if (
      url.pathname.endsWith(
        `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      )
    ) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 75)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const options = {
    limit: 1,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns: [
      { runId: 0, runAttempt: 1 },
      { runId: run.id, runAttempt: 0 },
      { runId: run.id, runAttempt: run.run_attempt },
    ],
  };

  try {
    const first = await test.collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    assertEquals(first.runs.map(({ run }) => run.databaseId), [run.id]);
    assertEquals(
      calls.filter((path) =>
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ).length,
      1,
    );
    assertEquals(
      calls.some((path) => path.includes(`/workflows/${CI_WORKFLOW}/runs`)),
      false,
    );

    const restarted = new CiJobHistoryCollector(
      new CiJobHistoryStore(test.file),
    );
    globalThis.fetch = () => {
      throw new Error("a cached selected-run Gantt contacted GitHub");
    };
    assertEquals(
      await restarted.gantt(
        undefined,
        CI_HISTORY_SOURCES.labs,
        options,
        NOW,
      ),
      first,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("a selected-run Gantt reuses fresh run metadata after a job failure", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-metadata-test-",
  });
  const run = workflowRun(9_116, NOW, {
    name: "CI",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  let metadataCalls = 0;
  let jobCalls = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ) {
        metadataCalls++;
        return Promise.resolve(run as T);
      }
      if (
        path.includes(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
        )
      ) {
        jobCalls++;
        return jobCalls === 1
          ? Promise.reject(new Error("job response failed"))
          : Promise.resolve({ jobs: [apiJob("Check", 75)] } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const options = {
    limit: 1,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options,
          NOW,
        ),
      Error,
      "job response failed",
    );
    const result = await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    assertEquals(result.runs.map(({ run }) => run.databaseId), [run.id]);
    assertEquals(metadataCalls, 1);
    assertEquals(jobCalls, 2);
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("selected-run metadata keeps only the most recent Gantt selection", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-metadata-limit-test-",
  });
  const metadataCalls = new Map<number, number>();
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string): Promise<T> => {
      const metadata = path.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
      if (metadata) {
        const id = Number(metadata[1]);
        metadataCalls.set(id, (metadataCalls.get(id) ?? 0) + 1);
        return Promise.resolve(workflowRun(id, NOW, {
          head_sha: HEAD_SHA,
          path: `.github/workflows/${CI_WORKFLOW}`,
        }) as T);
      }
      if (path.includes("/attempts/1/jobs")) {
        return Promise.reject(new Error("jobs unavailable"));
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const selections = Array.from({ length: 150 }, (_, index) => ({
    runId: 20_000 + index,
    runAttempt: 1,
  }));
  const options = (selectedRuns: typeof selections) => ({
    limit: selectedRuns.length,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options(selections),
          NOW,
        ),
      Error,
      "jobs unavailable",
    );
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options([{ runId: 30_000, runAttempt: 1 }]),
          NOW,
        ),
      Error,
      "jobs unavailable",
    );
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options([selections[1]]),
          NOW,
        ),
      Error,
      "jobs unavailable",
    );
    assertEquals(metadataCalls.get(selections[1].runId), 1);
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options([selections[0]]),
          NOW,
        ),
      Error,
      "jobs unavailable",
    );
    assertEquals(metadataCalls.get(selections[0].runId), 2);
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

const GANTT_PROGRESS_RUN_BASE = 40_000;

// Starts one Gantt collection more than the progress-record cap holds. Each
// selects a run of its own and each fails at its jobs request, so every record
// reaches a terminal phase. `hold` names the runs whose metadata request waits
// at the gate `release` opens, and `started` resolves once every collection
// has reached its metadata request.
async function overfillGanttProgressRecords(
  prefix: string,
  hold: (runId: number) => boolean,
  body: (collection: {
    collector: RateLimitedCiJobHistoryCollector;
    ids: string[];
    results: Promise<GanttSelection>[];
    release: () => void;
    started: Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    async <T>(path: string): Promise<T> => {
      const metadata = path.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
      if (metadata) {
        const runId = Number(metadata[1]);
        if (++reached === PROGRESS_RECORD_MAX + 1) markStarted();
        if (hold(runId)) await gate;
        return workflowRun(runId, NOW, {
          head_sha: HEAD_SHA,
          path: `.github/workflows/${CI_WORKFLOW}`,
        }) as T;
      }
      if (path.includes("/attempts/1/jobs")) {
        throw new Error("jobs unavailable");
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const ids: string[] = [];
  const results: Promise<GanttSelection>[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let index = 0; index < PROGRESS_RECORD_MAX + 1; index++) {
      const refresh = collector.startGantt(
        "selected-run-token",
        CI_HISTORY_SOURCES.labs,
        {
          limit: 1,
          mainOnly: true,
          headSha: HEAD_SHA,
          selectedRuns: [{
            runId: GANTT_PROGRESS_RUN_BASE + index,
            runAttempt: 1,
          }],
        },
        NOW,
      );
      ids.push(refresh.progress.id);
      results.push(refresh.result);
    }
    await body({ collector, ids, results, release, started });
  } finally {
    release();
    await Promise.allSettled(results);
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("CI Gantt retains a bounded set of completed progress records", () =>
  overfillGanttProgressRecords(
    "ci-gantt-progress-limit-test-",
    () => true,
    async ({ collector, ids, results, release, started }) => {
      await started;
      assertEquals(collector.progress(ids[0])?.phase, "discovering");
      assertEquals(collector.progress(ids.at(-1)!)?.phase, "discovering");
      release();
      const outcomes = await Promise.allSettled(results);
      assert(outcomes.every((outcome) => outcome.status === "rejected"));
      // One record over the cap is dropped, and only a record that has reached
      // a terminal phase can be the one dropped. The newest is always kept.
      //
      // Which one is dropped is not fixed. Trimming takes the first terminal
      // record in insertion order, so it depends on the order these
      // collections finish, and they finish in the order their file reads and
      // GitHub responses complete rather than the order they started.
      const retained = ids.filter((id) => collector.progress(id) !== null);
      assertEquals(retained.length, PROGRESS_RECORD_MAX);
      assert(retained.every((id) => collector.progress(id)?.phase === "error"));
      assertEquals(collector.progress(ids.at(-1)!)?.phase, "error");
    },
  ));

Deno.test("CI Gantt trimming spares the progress record handed out last", () =>
  overfillGanttProgressRecords(
    "ci-gantt-progress-newest-test-",
    // Holding every collection but the newest makes the newest the first to
    // fail, and so the only record trimming has to choose from when an older
    // collection fails after it.
    (runId) => runId !== GANTT_PROGRESS_RUN_BASE + PROGRESS_RECORD_MAX,
    async ({ collector, ids, results, release }) => {
      const newest = ids.at(-1)!;
      await assertRejects(() => results.at(-1)!, Error, "jobs unavailable");
      assertEquals(collector.progress(newest)?.phase, "error");
      release();
      await Promise.allSettled(results);
      // The newest record is exempt, so the set comes down to the cap by
      // dropping one of the collections that failed after it.
      assertEquals(collector.progress(newest)?.phase, "error");
      const retained = ids.filter((id) => collector.progress(id) !== null);
      assertEquals(retained.length, PROGRESS_RECORD_MAX);
    },
  ));

Deno.test("a selected-run Gantt repairs cached responses with no drawable jobs", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-empty-jobs-test-",
  });
  const file = `${directory}/history.json`;
  const run = workflowRun(9_117, NOW, {
    name: "CI",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  const store = new CiJobHistoryStore(file);
  let metadataCalls = 0;
  let jobCalls = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ) {
        metadataCalls++;
        return Promise.resolve(run as T);
      }
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        jobCalls++;
        return Promise.resolve({
          jobs: jobCalls === 1 ? [] : [apiJob("Recovered", 45)],
        } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const options = {
    limit: 1,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          options,
          NOW,
        ),
      Error,
      "No completed CI job timings were returned",
    );
    assertEquals(store.get(REPO, CI_WORKFLOW, run.id, 1), undefined);

    await seedCachedRun(store, {
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: run.id,
      runAttempt: run.run_attempt,
      headSha: HEAD_SHA,
      runUrl: run.html_url,
      at: NOW,
      overallSeconds: 0,
      jobs: [],
      gantt: {
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        headBranch: run.head_branch ?? undefined,
        startedAt: run.run_started_at,
        workflowName: run.name,
      },
    });
    await store.save(NOW);

    const repaired = await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    assertEquals(repaired.runs[0].jobs[0].name, "Recovered");
    assertEquals(metadataCalls, 1);
    assertEquals(jobCalls, 2);
    const detail = new CiGanttDetailStore(ganttDetailDirectory(store.file));
    assertEquals(
      (await detail.read(CI_HISTORY_SOURCES.labs, run.id, 1))?.[0].name,
      "Recovered",
    );

    const restarted = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(file),
      () => {
        throw new Error("a repaired selection contacted GitHub");
      },
    );
    assertEquals(
      await restarted.gantt(
        undefined,
        CI_HISTORY_SOURCES.labs,
        options,
        NOW,
      ),
      repaired,
    );
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt expands a collapsed rerun cache", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-rerun-cache-test-",
  });
  const file = `${directory}/history.json`;
  const run = workflowRun(9_118, NOW, {
    run_attempt: 2,
    name: "CI",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  const firstStart = NOW - HOUR;
  const retryStart = NOW;
  const jobAt = (
    attempt: number,
    start: number,
    conclusion: string,
  ) => ({
    ...apiJob("Retried job", attempt * 60, conclusion),
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + attempt * 60_000).toISOString(),
  });
  const store = new CiJobHistoryStore(file);
  await store.load();
  await seedCachedRun(store, {
    repo: REPO,
    workflow: CI_WORKFLOW,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: HEAD_SHA,
    runUrl: run.html_url,
    at: NOW,
    overallSeconds: 120,
    jobs: [{ name: "Retried job", seconds: 120 }],
    gantt: {
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      headBranch: run.head_branch ?? undefined,
      startedAt: run.run_started_at,
      workflowName: run.name,
    },
  }, [{
    name: "Retried job",
    status: "completed",
    conclusion: "success",
    started_at: new Date(firstStart).toISOString(),
    completed_at: new Date(firstStart + 60_000).toISOString(),
    steps: [],
  }]);
  await store.save(NOW);
  const requestedAttempts: number[] = [];
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string): Promise<T> => {
      const match = path.match(/\/attempts\/(\d+)\/jobs/);
      if (!match) throw new Error(`unexpected selected-run request: ${path}`);
      const attempt = Number(match[1]);
      requestedAttempts.push(attempt);
      return Promise.resolve({
        jobs: [
          attempt === 1
            ? jobAt(1, firstStart, "failure")
            : jobAt(2, retryStart, "success"),
        ],
      } as T);
    },
  );
  try {
    await assertRejects(
      () =>
        collector.gantt(
          undefined,
          CI_HISTORY_SOURCES.labs,
          { limit: 1, mainOnly: true },
          NOW,
        ),
      Error,
      "Set GH_TOKEN",
    );
    const result = await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      {
        limit: 1,
        mainOnly: true,
        headSha: HEAD_SHA,
        selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
      },
      NOW,
      [run],
    );
    assertEquals(requestedAttempts, [1, 2]);
    assertEquals(
      result.runs[0].jobs.map((job) => [
        job.attempt,
        job.conclusion,
        job.started_at,
      ]),
      [
        [1, "failure", new Date(firstStart).toISOString()],
        [2, "success", new Date(retryStart).toISOString()],
      ],
    );
    const persisted = JSON.parse(await Deno.readTextFile(file));
    assertEquals(persisted.runs[0].gantt.attemptTagged, true);
    const detail = new CiGanttDetailStore(ganttDetailDirectory(file));
    assertEquals(
      (await detail.read(CI_HISTORY_SOURCES.labs, run.id, run.run_attempt))
        ?.map((job) => job.attempt),
      [1, 2],
    );
    assertEquals(
      (await collector.gantt(
        undefined,
        CI_HISTORY_SOURCES.labs,
        { limit: 1, mainOnly: true },
        NOW,
      )).runs[0].jobs.map((job) => job.attempt),
      [1, 2],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt validates the commit and workflow before fetching jobs", async () => {
  const mismatches = [
    { head_sha: "b".repeat(40), path: `.github/workflows/${CI_WORKFLOW}` },
    { head_sha: HEAD_SHA, path: ".github/workflows/other.yml" },
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    const directory = await Deno.makeTempDir({
      prefix: "ci-gantt-selected-validation-test-",
    });
    const run = workflowRun(9_120 + index, NOW, {
      ...mismatch,
      name: "CI",
    });
    let jobCalls = 0;
    const store = new CiJobHistoryStore(`${directory}/history.json`);
    const collector = new RateLimitedCiJobHistoryCollector(
      store,
      <T>(path: string): Promise<T> => {
        if (
          path.endsWith(
            `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
          )
        ) {
          return Promise.resolve(run as T);
        }
        if (path.includes(`/actions/runs/${run.id}/attempts/`)) {
          jobCalls++;
          return Promise.resolve({ jobs: [apiJob("Check", 75)] } as T);
        }
        throw new Error(`unexpected selected-run request: ${path}`);
      },
    );
    try {
      await assertRejects(
        () =>
          collector.gantt(
            "selected-run-token",
            CI_HISTORY_SOURCES.labs,
            {
              limit: 1,
              mainOnly: true,
              headSha: HEAD_SHA,
              selectedRuns: [{
                runId: run.id,
                runAttempt: run.run_attempt,
              }],
            },
            NOW,
          ),
        Error,
        "does not match the requested commit and workflow",
      );
      assertEquals(jobCalls, 0);
      assertEquals(store.list(REPO, CI_WORKFLOW), []);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("a selected-run Gantt requires a valid commit SHA", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-sha-test-",
  });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    () => {
      throw new Error("an invalid selection contacted GitHub");
    },
  );
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          {
            limit: 1,
            mainOnly: true,
            headSha: "invalid",
            selectedRuns: [{ runId: 9_125, runAttempt: 1 }],
          },
          NOW,
        ),
      Error,
      "Selected CI runs require a commit SHA",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt enriches a shared cached attempt with its commit", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-cache-commit-test-",
  });
  const file = `${directory}/history.json`;
  const run = workflowRun(9_126, NOW, { name: "CI" });
  const selectedRun = {
    ...run,
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  };
  let immutableJobCalls = 0;
  const store = new CiJobHistoryStore(file);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ) {
        return Promise.resolve(selectedRun as T);
      }
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        immutableJobCalls++;
        return Promise.resolve({ jobs: [apiJob("Cached", 30)] } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const options = {
    limit: 1,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
  };
  try {
    await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      NOW,
      [run],
    );
    const selected = await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    assertEquals(selected.runs[0].jobs[0].name, "Cached");
    assertEquals(immutableJobCalls, 1);
    assertEquals(
      store.get(REPO, CI_WORKFLOW, run.id, run.run_attempt)?.headSha,
      HEAD_SHA,
    );

    const restarted = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(file),
      () => {
        throw new Error("the enriched cache contacted GitHub");
      },
    );
    assertEquals(
      await restarted.gantt(
        undefined,
        CI_HISTORY_SOURCES.labs,
        options,
        NOW,
      ),
      selected,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("selected and aggregate Gantt requests do not join different job queries", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-request-mode-test-",
  });
  const run = workflowRun(9_127, NOW, { name: "CI" });
  const selectedRun = {
    ...run,
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  };
  let releaseAggregate!: (value: { jobs: ReturnType<typeof apiJob>[] }) => void;
  let markAggregateStarted!: () => void;
  const aggregateResponse = new Promise<{ jobs: ReturnType<typeof apiJob>[] }>(
    (resolve) => {
      releaseAggregate = resolve;
    },
  );
  const aggregateStarted = new Promise<void>((resolve) => {
    markAggregateStarted = resolve;
  });
  let attemptJobCalls = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ) return Promise.resolve(selectedRun as T);
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        attemptJobCalls++;
        if (attemptJobCalls === 1) {
          markAggregateStarted();
          return aggregateResponse as Promise<T>;
        }
        return Promise.resolve({ jobs: [apiJob("Exact", 20)] } as T);
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  let aggregate: Promise<CiGanttInput> | undefined;
  try {
    aggregate = collector.gantt(
      "gantt-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      NOW,
      [run],
    );
    await aggregateStarted;
    const exact = await collector.gantt(
      "gantt-token",
      CI_HISTORY_SOURCES.labs,
      {
        limit: 1,
        mainOnly: true,
        headSha: HEAD_SHA,
        selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
      },
      NOW,
    );
    assertEquals(exact.runs[0].jobs[0].name, "Exact");
    releaseAggregate({ jobs: [apiJob("Aggregate", 30)] });
    await aggregate;
  } finally {
    releaseAggregate({ jobs: [] });
    if (aggregate) await Promise.allSettled([aggregate]);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt rejects timings outside cache retention", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-retention-test-",
  });
  const run = workflowRun(
    9_128,
    NOW - (CI_JOB_CACHE_DAYS + 1) * DAY,
    {
      name: "CI",
      head_sha: HEAD_SHA,
      path: `.github/workflows/${CI_WORKFLOW}`,
    },
  );
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        )
      ) return Promise.resolve(run as T);
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        return Promise.resolve({ jobs: [apiJob("Old", 20)] } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  try {
    await assertRejects(
      () =>
        collector.gantt(
          "selected-run-token",
          CI_HISTORY_SOURCES.labs,
          {
            limit: 1,
            mainOnly: true,
            headSha: HEAD_SHA,
            selectedRuns: [{ runId: run.id, runAttempt: run.run_attempt }],
          },
          NOW,
        ),
      Error,
      "Not every selected CI run has cached job timings",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt keeps each workflow attempt distinct", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-attempt-test-",
  });
  const file = `${directory}/history.json`;
  const runId = 9_130;
  const requestedJobAttempts: number[] = [];
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string): Promise<T> => {
      const metadata = path.match(
        new RegExp(`/actions/runs/${runId}/attempts/(\\d+)$`),
      );
      if (metadata) {
        const attempt = Number(metadata[1]);
        return Promise.resolve(workflowRun(runId, NOW, {
          run_attempt: attempt,
          name: "CI",
          head_sha: HEAD_SHA,
          path: `.github/workflows/${CI_WORKFLOW}`,
        }) as T);
      }
      const jobs = path.match(
        new RegExp(`/actions/runs/${runId}/attempts/(\\d+)/jobs`),
      );
      if (jobs) {
        requestedJobAttempts.push(Number(jobs[1]));
        return Promise.resolve({
          jobs: [apiJob(`Attempt ${jobs[1]}`, Number(jobs[1]) * 10)],
        } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  const options = (runAttempt: number) => ({
    limit: 1,
    mainOnly: true,
    headSha: HEAD_SHA,
    selectedRuns: [{ runId, runAttempt }],
  });
  try {
    await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options(1),
      NOW,
    );
    await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      options(2),
      NOW,
    );
    assertEquals(requestedJobAttempts, [1, 1, 2]);

    const restarted = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(file),
      () => {
        throw new Error("an exact cached attempt contacted GitHub");
      },
    );
    const firstAttempt = await restarted.gantt(
      undefined,
      CI_HISTORY_SOURCES.labs,
      options(1),
      NOW,
    );
    assertEquals(firstAttempt.runs[0].run.attempt, 1);
    assertEquals(firstAttempt.runs[0].jobs[0].name, "Attempt 1");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a selected-run Gantt does not render an incomplete cached selection", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-partial-cache-test-",
  });
  const file = `${directory}/history.json`;
  const first = workflowRun(9_140, NOW, {
    name: "CI",
    head_sha: HEAD_SHA,
    path: `.github/workflows/${CI_WORKFLOW}`,
  });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string): Promise<T> => {
      if (
        path.endsWith(
          `/actions/runs/${first.id}/attempts/${first.run_attempt}`,
        )
      ) {
        return Promise.resolve(first as T);
      }
      if (path.includes(`/actions/runs/${first.id}/attempts/1/jobs`)) {
        return Promise.resolve({ jobs: [apiJob("Check", 75)] } as T);
      }
      throw new Error(`unexpected selected-run request: ${path}`);
    },
  );
  try {
    await collector.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      {
        limit: 1,
        mainOnly: true,
        headSha: HEAD_SHA,
        selectedRuns: [{ runId: first.id, runAttempt: first.run_attempt }],
      },
      NOW,
    );
    const restarted = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(file),
      () => {
        throw new Error("a credential-free request contacted GitHub");
      },
    );
    await assertRejects(
      () =>
        restarted.gantt(
          undefined,
          CI_HISTORY_SOURCES.labs,
          {
            limit: 2,
            mainOnly: true,
            headSha: HEAD_SHA,
            selectedRuns: [
              { runId: first.id, runAttempt: first.run_attempt },
              { runId: 9_141, runAttempt: 1 },
            ],
          },
          NOW,
        ),
      Error,
      "Set GH_TOKEN",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("selected-run discovery settles a failed batch before stopping", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-selected-discovery-batch-test-",
  });
  const file = `${directory}/history.json`;
  const runs = Array.from(
    { length: 9 },
    (_, index) =>
      workflowRun(9_150 + index, NOW - index, {
        name: "CI",
        head_sha: HEAD_SHA,
        path: `.github/workflows/${CI_WORKFLOW}`,
      }),
  );
  const deferred = Array.from({ length: 8 }, () => {
    let resolve!: (run: WorkflowRun) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<WorkflowRun>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    return { promise, resolve, reject };
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const requested: number[] = [];
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string): Promise<T> => {
      if (path.includes("/jobs")) {
        return Promise.resolve({ jobs: [apiJob("Check", 30)] } as T);
      }
      const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
      if (!match) throw new Error(`unexpected selected-run request: ${path}`);
      requested.push(Number(match[1]));
      if (requested.length === 8) markStarted();
      return deferred[requested.length - 1].promise as Promise<T>;
    },
  );
  const active = collector.startGantt(
    "selected-run-token",
    CI_HISTORY_SOURCES.labs,
    {
      limit: runs.length,
      mainOnly: true,
      headSha: HEAD_SHA,
      selectedRuns: runs.map((run) => ({
        runId: run.id,
        runAttempt: run.run_attempt,
      })),
    },
    NOW,
  );
  const rejected = assertRejects(
    () => active.result,
    Error,
    "selected metadata failed",
  );
  try {
    await started;
    assertEquals(requested, runs.slice(0, 8).map((run) => run.id));
    assertEquals(
      [
        collector.progress(active.progress.id)?.discoveryRequestsMade,
        collector.progress(active.progress.id)?.discoveryResponsesReceived,
        collector.progress(active.progress.id)?.discoveryOutstandingRequests,
      ],
      [8, 0, 8],
    );
    deferred[0].reject(new Error("selected metadata failed"));
    for (let index = 1; index < deferred.length; index++) {
      deferred[index].resolve(runs[index]);
    }
    await rejected;
    assertEquals(requested.length, 8);
    assertEquals(
      [
        collector.progress(active.progress.id)?.phase,
        collector.progress(active.progress.id)?.discoveryResponsesReceived,
        collector.progress(active.progress.id)?.discoveryOutstandingRequests,
      ],
      ["error", 8, 0],
    );

    const restartedRequests: number[] = [];
    const restarted = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(file),
      <T>(path: string): Promise<T> => {
        if (path.includes("/jobs")) {
          return Promise.resolve({ jobs: [apiJob("Recovered", 40)] } as T);
        }
        const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
        if (!match) throw new Error(`unexpected recovery request: ${path}`);
        const run = runs.find((candidate) => candidate.id === Number(match[1]));
        if (!run) throw new Error(`unknown recovery run: ${match[1]}`);
        restartedRequests.push(run.id);
        return Promise.resolve(run as T);
      },
    );
    const recovered = await restarted.gantt(
      "selected-run-token",
      CI_HISTORY_SOURCES.labs,
      {
        limit: runs.length,
        mainOnly: true,
        headSha: HEAD_SHA,
        selectedRuns: runs.map((run) => ({
          runId: run.id,
          runAttempt: run.run_attempt,
        })),
      },
      NOW,
    );
    assertEquals(recovered.runs.length, runs.length);
    assertEquals(restartedRequests, [runs[0].id, runs[8].id]);
  } finally {
    for (const [index, response] of deferred.entries()) {
      response.resolve(runs[index]);
    }
    await Promise.allSettled([active.result]);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reports shared discovery and job-fetch progress", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-progress-test-",
  });
  const run = workflowRun(9_106, NOW);
  let releaseWorkflow!: (value: unknown) => void;
  let releaseJobs!: (value: unknown) => void;
  let markWorkflowStarted!: () => void;
  let markJobsStarted!: () => void;
  const workflowResponse = new Promise<unknown>((resolve) => {
    releaseWorkflow = resolve;
  });
  const jobsResponse = new Promise<unknown>((resolve) => {
    releaseJobs = resolve;
  });
  const workflowStarted = new Promise<void>((resolve) => {
    markWorkflowStarted = resolve;
  });
  const jobsStarted = new Promise<void>((resolve) => {
    markJobsStarted = resolve;
  });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        markWorkflowStarted();
        return workflowResponse as Promise<T>;
      }
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        markJobsStarted();
        return jobsResponse as Promise<T>;
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  const options = { limit: 1, mainOnly: false, allConclusions: true };
  let firstResult: Promise<GanttSelection> | undefined;
  try {
    const first = collector.startGantt(
      "gantt-progress-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    firstResult = first.result;
    const joined = collector.startGantt(
      "gantt-progress-token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
    );
    assertEquals(joined.progress.id, first.progress.id);
    assertEquals(joined.result, first.result);

    await workflowStarted;
    assertEquals(
      [
        collector.progress(first.progress.id)?.phase,
        collector.progress(first.progress.id)?.discoveryRequestsMade,
        collector.progress(first.progress.id)?.discoveryResponsesReceived,
        collector.progress(first.progress.id)?.discoveryOutstandingRequests,
      ],
      ["discovering", 1, 0, 1],
    );

    releaseWorkflow({ workflow_runs: [run] });
    await jobsStarted;
    assertEquals(
      [
        collector.progress(first.progress.id)?.phase,
        collector.progress(first.progress.id)?.totalRuns,
        collector.progress(first.progress.id)?.cachedRuns,
        collector.progress(first.progress.id)?.requestsMade,
        collector.progress(first.progress.id)?.responsesReceived,
        collector.progress(first.progress.id)?.outstandingRequests,
      ],
      ["fetching", 1, 0, 1, 0, 1],
    );

    releaseJobs({ jobs: [apiJob("Check", 30)] });
    const result = await collector.ganttRuns(
      CI_HISTORY_SOURCES.labs,
      await first.result,
    );
    assertEquals(result.runs[0].run.databaseId, run.id);
    assertEquals(
      [
        collector.progress(first.progress.id)?.phase,
        collector.progress(first.progress.id)?.completedRuns,
        collector.progress(first.progress.id)?.successfulResponses,
        collector.progress(first.progress.id)?.outstandingRequests,
      ],
      ["complete", 1, 1, 0],
    );

    const cached = collector.startGantt(
      "gantt-progress-token",
      CI_HISTORY_SOURCES.labs,
      { ...options, limit: 2 },
      NOW,
    );
    await cached.result;
    assertEquals(
      [
        collector.progress(cached.progress.id)?.phase,
        collector.progress(cached.progress.id)?.totalRuns,
        collector.progress(cached.progress.id)?.cachedRuns,
        collector.progress(cached.progress.id)?.requestsMade,
      ],
      ["complete", 1, 1, 0],
    );
  } finally {
    releaseWorkflow({ workflow_runs: [] });
    releaseJobs({ jobs: [] });
    if (firstResult) await Promise.allSettled([firstResult]);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reuses a run cached while collection is starting", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-concurrent-cache-test-",
  });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  const run = workflowRun(9_110, NOW);
  let jobRequests = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      if (path.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
        jobRequests++;
        return Promise.resolve({ jobs: [apiJob("Check", 30)] } as T);
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  // The step detail is on disk from the start; only the index entry appears
  // part-way through the collection, which is what decides whether the run is
  // reused or fetched.
  const entry = cachedRunEntry({
    repo: REPO,
    workflow: CI_WORKFLOW,
    runId: run.id,
    runAttempt: run.run_attempt,
    runUrl: run.html_url,
    at: NOW,
    overallSeconds: 30,
    jobs: [{ name: "Check", seconds: 30 }],
    gantt: {
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      headBranch: run.head_branch ?? undefined,
      startedAt: run.run_started_at,
      workflowName: "CI",
    },
  });
  try {
    await detailStoreFor(store).write(entry, entry.runId, entry.runAttempt, []);
    const refresh = collector.startGantt(
      "concurrent-cache-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: false, allConclusions: true },
      NOW,
    );
    let populated = false;
    const unsubscribe = collector.subscribeProgress(
      refresh.progress.id,
      (progress) => {
        if (populated || progress.phase !== "fetching") return;
        populated = true;
        store.set(entry);
      },
    );
    const result = await collector.ganttRuns(
      CI_HISTORY_SOURCES.labs,
      await refresh.result,
    );
    unsubscribe?.();

    assert(populated);
    assertEquals(jobRequests, 0);
    assertEquals(result.runs[0].run.databaseId, run.id);
    assertEquals(result.runs[0].jobs, []);
    assertEquals(
      [
        collector.progress(refresh.progress.id)?.cachedRuns,
        collector.progress(refresh.progress.id)?.requestsMade,
        collector.progress(refresh.progress.id)?.responsesReceived,
        collector.progress(refresh.progress.id)?.sharedRequests,
        collector.progress(refresh.progress.id)?.sharedResponses,
        collector.progress(refresh.progress.id)?.outstandingRequests,
      ],
      [1, 0, 0, 0, 0, 0],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt progress endpoint streams collection failures", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-progress-response-test-",
  });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
  );
  try {
    const response = ciGanttProgressResponse(
      new Request("http://dashboard/bench/gantt-progress"),
      new URL(
        "http://dashboard/bench/gantt-progress?repo=loom&limit=12&mainOnly=1&allConclusions=1",
      ),
      collector,
      "",
    );
    assertEquals(response.headers.get("content-type"), "text/event-stream");
    const events = await response.text();
    assertStringIncludes(events, "event: progress");
    assertStringIncludes(events, '"source":"loom"');
    assertStringIncludes(events, '"phase":"error"');
    assertStringIncludes(events, '"error":"set GH_TOKEN"');
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt progress reports a cached discovery fallback", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-cached-warning-test-",
  });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  await store.load();
  const run = workflowRun(9_107, NOW);
  await seedCachedRun(store, {
    repo: REPO,
    workflow: CI_WORKFLOW,
    runId: run.id,
    runAttempt: run.run_attempt,
    runUrl: run.html_url,
    at: NOW,
    overallSeconds: 30,
    jobs: [{ name: "Check", seconds: 30 }],
    gantt: {
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      headBranch: run.head_branch ?? undefined,
      startedAt: run.run_started_at,
      workflowName: "CI",
    },
  });
  await store.save(NOW);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    () => Promise.reject(new Error("workflow source unreachable")),
  );
  try {
    const refresh = collector.startGantt(
      "cached-warning-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: false, allConclusions: true },
      NOW,
    );
    const result = await collector.ganttRuns(
      CI_HISTORY_SOURCES.labs,
      await refresh.result,
    );
    const progress = collector.progress(refresh.progress.id);
    assertEquals(result.runs[0].run.databaseId, run.id);
    assertEquals(progress?.phase, "complete");
    assertEquals(
      [
        progress?.discoveryRequestsMade,
        progress?.discoveryResponsesReceived,
        progress?.discoveryOutstandingRequests,
      ],
      [1, 1, 0],
    );
    assertStringIncludes(progress?.warning ?? "", "Showing cached runs");
    assertStringIncludes(progress?.warning ?? "", "source unreachable");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt progress reports partial job responses and rate limits", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-partial-warning-test-",
  });
  const successful = workflowRun(9_108, NOW);
  const unavailable = workflowRun(9_109, NOW - 1_000);
  const limited = workflowRun(9_110, NOW - 2_000);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({
          workflow_runs: [successful, unavailable, limited],
        } as T);
      }
      if (path.includes(`/actions/runs/${successful.id}/attempts/1/jobs`)) {
        return Promise.resolve({ jobs: [apiJob("Check", 30)] } as T);
      }
      if (path.includes(`/actions/runs/${unavailable.id}/attempts/1/jobs`)) {
        return Promise.reject(new Error("workflow source unreachable"));
      }
      if (path.includes(`/actions/runs/${limited.id}/attempts/1/jobs`)) {
        return Promise.reject(
          new GitHubRateLimitBudgetError(
            "GitHub rate limit has been hit at the 80% performance-history safety threshold.",
          ),
        );
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const refresh = collector.startGantt(
      "partial-warning-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 3, mainOnly: false, allConclusions: true },
      NOW,
    );
    const result = await collector.ganttRuns(
      CI_HISTORY_SOURCES.labs,
      await refresh.result,
    );
    const progress = collector.progress(refresh.progress.id);
    assertEquals(result.runs.map(({ run }) => run.databaseId), [successful.id]);
    assertEquals(
      [
        progress?.phase,
        progress?.totalRuns,
        progress?.successfulResponses,
        progress?.failedResponses,
        progress?.outstandingRequests,
      ],
      ["complete", 3, 1, 2, 0],
    );
    assertStringIncludes(progress?.warning ?? "", "2 run checks");
    assertStringIncludes(progress?.warning ?? "", "rate limit hit");
    assert(!(progress?.warning ?? "").includes("source unreachable"));
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt preserves the quota error when no run can be rendered", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-quota-error-test-",
  });
  const first = workflowRun(9_111, NOW);
  const second = workflowRun(9_112, NOW - 1_000);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: [first, second] } as T);
      }
      if (path.includes("/jobs")) {
        return Promise.reject(
          new GitHubRateLimitBudgetError(
            "GitHub rate limit has been hit at the 80% performance-history safety threshold.",
          ),
        );
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const refresh = collector.startGantt(
      "quota-error-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 2, mainOnly: false, allConclusions: true },
      NOW,
    );
    await assertRejects(
      () => refresh.result,
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
    assertEquals(collector.progress(refresh.progress.id)?.phase, "error");
    assertEquals(
      collector.progress(refresh.progress.id)?.error,
      "rate limit hit",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt preserves a specific job error when no run can be rendered", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-job-error-test-",
  });
  const run = workflowRun(9_113, NOW);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      if (path.includes("/jobs")) {
        return Promise.reject(new Error("job network unreachable"));
      }
      throw new Error(`unexpected Gantt request: ${path}`);
    },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const refresh = collector.startGantt(
      "job-error-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: false, allConclusions: true },
      NOW,
    );
    await assertRejects(
      () => refresh.result,
      Error,
      "job network unreachable",
    );
    assertEquals(collector.progress(refresh.progress.id)?.phase, "error");
    assertEquals(
      collector.progress(refresh.progress.id)?.error,
      "source unreachable",
    );
    assertEquals(collector.progress(refresh.progress.id)?.warning, undefined);
  } finally {
    console.error = originalError;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt persists a completed response before a discovery fallback reuses it", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-gantt-cache-write-test-",
  });
  const file = `${directory}/history.json`;
  class FailOnceStore extends CiJobHistoryStore {
    saveCalls = 0;

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      if (this.saveCalls === 1) throw new Error("cache unavailable");
      await super.save(now);
    }
  }
  const store = new FailOnceStore(file);
  const collector = new CiJobHistoryCollector(store);
  const run = workflowRun(9_107, NOW);
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    await assertRejects(
      () =>
        collector.gantt(
          "shared-cache-token",
          CI_HISTORY_SOURCES.labs,
          { limit: 10, mainOnly: true },
          NOW,
          [run],
        ),
      Error,
      "Could not persist CI job history",
    );
    assertEquals([jobCalls, store.saveCalls, store.dirty], [1, 1, true]);

    const cached = await collector.gantt(
      "shared-cache-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true },
      NOW,
    );
    assertEquals(cached.runs[0].run.databaseId, run.id);
    assertEquals([jobCalls, store.saveCalls, store.dirty], [1, 2, false]);
    assertEquals(
      JSON.parse(await Deno.readTextFile(file)).runs[0].runId,
      run.id,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt includes failed main pushes when all conclusions are selected", async () => {
  const test = await temporaryCollector();
  const failed = workflowRun(9_108, NOW, { conclusion: "failure" });
  const runQueries: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      runQueries.push(url);
      return Promise.resolve(Response.json({ workflow_runs: [failed] }));
    }
    if (
      url.pathname.includes(`/actions/runs/${failed.id}/attempts/1/jobs`)
    ) {
      return Promise.resolve(Response.json({
        jobs: [apiJob("Failed check", 90, "failure")],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const gantt = await test.collector.gantt(
      "all-conclusions-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true, allConclusions: true },
      NOW,
    );
    assertEquals(gantt.runs[0].run.conclusion, "failure");
    assertEquals(gantt.runs[0].jobs[0].conclusion, "failure");
    assertEquals(runQueries.length, 1);
    assertEquals(runQueries[0].searchParams.get("branch"), null);
    assertEquals(runQueries[0].searchParams.get("event"), null);
    assertEquals(runQueries[0].searchParams.get("status"), null);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt keeps a constant page size while collecting 150 runs", async () => {
  const test = await temporaryCollector();
  const runs = Array.from(
    { length: 200 },
    (_, index) =>
      workflowRun(20_000 + index, NOW - index * 60_000, {
        status: index === 149 ? "completed" : "in_progress",
        conclusion: index === 149 ? "success" : null,
      }),
  );
  const pageSizes: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      pageSizes.push(perPage);
      const start = (page - 1) * perPage;
      return Promise.resolve(Response.json({
        workflow_runs: runs.slice(start, start + perPage),
      }));
    }
    if (
      url.pathname.includes(`/actions/runs/${runs[149].id}/attempts/1/jobs`)
    ) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const gantt = await test.collector.gantt(
      "paging-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 150, mainOnly: false },
      NOW,
    );
    assertEquals(pageSizes, [100, 100]);
    assertEquals(gantt.runs.map(({ run }) => run.databaseId), [runs[149].id]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI history rejects cache rows without run provenance", async () => {
  const test = await temporaryCollector();
  await Deno.writeTextFile(
    test.file,
    JSON.stringify({
      version: 1,
      runs: [{
        repo: REPO,
        workflow: CI_WORKFLOW,
        runId: 9_109,
        runAttempt: 1,
        runUrl: "https://example.test/runs/9109",
        at: NOW,
        overallSeconds: 90,
        jobs: [{ name: "Check", seconds: 90 }],
      }],
    }),
  );
  const collector = new CiJobHistoryCollector(
    new CiJobHistoryStore(test.file),
  );

  try {
    assertEquals(
      await collector.cached(CI_HISTORY_SOURCES.labs, 45, NOW),
      null,
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("CI history excludes pull request runs cached by the Gantt", async () => {
  const test = await temporaryCollector();
  const pullRequest = workflowRun(9_106, NOW, {
    event: "pull_request",
    head_branch: "feature",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/runs/${pullRequest.id}/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const gantt = await test.collector.gantt(
      "shared-cache-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: false },
      NOW,
      [pullRequest],
    );
    assertEquals(gantt.runs.length, 1);
    assertEquals(
      await test.collector.cached(
        CI_HISTORY_SOURCES.labs,
        CI_HISTORY_DAYS,
        NOW,
      ),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history recomputes shard concurrency as layouts age out", async () => {
  const test = await temporaryCollector();
  const oldRun = workflowRun(9_111, NOW - 6 * DAY);
  const recentRun = workflowRun(9_112, NOW);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/runs/${oldRun.id}/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({
        jobs: Array.from(
          { length: 8 },
          (_, shard) => apiJob(`Test (${shard + 1}/8)`, 100 + shard),
        ),
      }));
    }
    if (url.includes(`/actions/runs/${recentRun.id}/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({
        jobs: Array.from(
          { length: 4 },
          (_, shard) => apiJob(`Test (${shard + 1}/4)`, 100 + shard),
        ),
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const initial = await test.collector.collect(
      "layout-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      7,
      [oldRun, recentRun],
    );
    assertEquals(initial.groups[0].maxConcurrent, 8);

    const aged = await test.collector.cached(
      CI_HISTORY_SOURCES.labs,
      7,
      NOW + 2 * DAY,
    );
    assertEquals(aged?.runCount, 1);
    assertEquals(aged?.groups[0].maxConcurrent, 4);
    assertEquals(aged?.groups[0].shards.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history keeps a newer partial refresh ahead of its disk cache", async () => {
  const test = await temporaryCollector();
  const runId = 9_121;
  const stableRun = workflowRun(9_122, NOW - DAY);
  let attempt = 1;
  let failedCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/runs/${runId}/`)) {
      if (attempt === 2) {
        failedCalls++;
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      }
      return Promise.resolve(Response.json({ jobs: [apiJob("Changing", 80)] }));
    }
    if (url.includes(`/actions/runs/${stableRun.id}/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Stable", 70)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const initial = await test.collector.collect(
      "partial-cache-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [workflowRun(runId, NOW), stableRun],
    );
    assertEquals([initial.runCount, initial.failedRunCount], [2, 0]);

    attempt = 2;
    const partial = await test.collector.collect(
      "partial-cache-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [workflowRun(runId, NOW, { run_attempt: 2 }), stableRun],
    );
    assertEquals([partial.runCount, partial.failedRunCount, partial.stale], [
      1,
      1,
      false,
    ]);

    const cached = await test.collector.cached(
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      NOW,
    );
    assertEquals(
      [cached?.runCount, cached?.failedRunCount, cached?.stale],
      [1, 1, false],
    );
    assertEquals(failedCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history reports a cache write failure and retries without refetching jobs", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "ci-job-history-write-test-",
  });
  const parent = `${directory}/later`;
  const file = `${parent}/history.json`;
  let releaseRetrySave!: () => void;
  const retrySave = new Promise<void>((resolve) => releaseRetrySave = resolve);
  class CountingStore extends CiJobHistoryStore {
    saveCalls = 0;

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      if (this.saveCalls === 2) await retrySave;
      await super.save(now);
    }
  }
  const store = new CountingStore(file);
  const collector = new CiJobHistoryCollector(store);
  const run = workflowRun(9_131, Date.now());
  let jobCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (url.includes(`/actions/runs/${run.id}/attempts/1/jobs`)) {
      jobCalls++;
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = collector.startRefresh(
      "write-token",
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
    );
    assert(first.progress);
    await assertRejects(
      () => first.result,
      Error,
      "Could not persist CI job history",
    );
    const failed = collector.progress(first.progress.id);
    assertEquals(failed?.phase, "error");
    assertEquals(failed?.failedResponses, 1);
    assertEquals(store.dirty, true);
    assertEquals(jobCalls, 1);

    await Deno.mkdir(parent);
    const retries = [7, 14, 21, 30, 45].map((days) =>
      collector.startRefresh(
        "write-token",
        CI_HISTORY_SOURCES.labs,
        days,
      )
    );
    const stops: (() => void)[] = [];
    await Promise.all(retries.map((retry) => {
      assert(retry.progress);
      return new Promise<void>((resolve) => {
        const stop = collector.subscribeProgress(
          retry.progress!.id,
          (state) => {
            if (state.phase === "saving") resolve();
          },
        );
        assert(stop);
        stops.push(stop);
      });
    }));
    assertEquals(store.saveCalls, 2);
    releaseRetrySave();
    await Promise.all(retries.map((retry) => retry.result));
    for (const stop of stops) stop();
    for (const retry of retries) {
      assert(retry.progress);
      assertEquals(collector.progress(retry.progress.id)?.phase, "complete");
      assertEquals(collector.progress(retry.progress.id)?.requestsMade, 0);
    }
    assertEquals(store.dirty, false);
    assertEquals(store.saveCalls, 7);
    assertEquals(jobCalls, 1);

    const restarted = new CiJobHistoryCollector(new CiJobHistoryStore(file));
    assertEquals(
      (await restarted.cached(
        CI_HISTORY_SOURCES.labs,
        CI_HISTORY_DAYS,
        Date.now(),
      ))
        ?.runCount,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history reads loom when that repository is selected", async () => {
  const test = await temporaryCollector();
  const run = workflowRun(9_151, NOW, {
    html_url: `https://github.com/${LOOM_REPO}/actions/runs/9151`,
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (
      url.includes(
        `/repos/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}/runs?`,
      )
    ) {
      return Promise.resolve(Response.json({ workflow_runs: [run] }));
    }
    if (
      url.includes(
        `/repos/${LOOM_REPO}/actions/runs/${run.id}/attempts/1/jobs`,
      )
    ) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Tests", 75)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const snapshot = await test.collector.collect(
      "loom-token",
      NOW,
      CI_HISTORY_SOURCES.loom,
    );
    assertEquals(snapshot.jobs[0].name, "Tests");
    assert(calls.every((call) => call.includes(`/repos/${LOOM_REPO}/`)));
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

// Serves the search for successful runs on main from `searched` and the
// workflow's newest page from `newest`, answering each run's jobs with one
// timed job.
function servingSearchAndNewestPage(
  searched: WorkflowRun[],
  newest: WorkflowRun[],
): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isNewestPage(url)) {
      return Promise.resolve(Response.json({ workflow_runs: newest }));
    }
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({ workflow_runs: searched }));
    }
    if (url.includes("/jobs")) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("CI job history refuses a search that does not reach the workflow's newest page", async () => {
  // The search was served from before run 9_302 finished, so the runs between
  // it and the newest page are missing from both.
  const test = await temporaryCollector();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = servingSearchAndNewestPage(
    [workflowRun(9_301, NOW - 5 * DAY)],
    [
      workflowRun(9_303, NOW - HOUR, { head_branch: "feature" }),
      workflowRun(9_302, NOW - 2 * HOUR),
    ],
  );
  try {
    await assertRejects(
      () => test.collector.collect("stale-token", NOW),
      Error,
      STALE_RUNS_ERROR,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history takes the runs a search lags behind from the newest page", async () => {
  // The search reaches run 9_312 but was cut before run 9_313 finished. Older
  // on the page are a re-run's later attempt, which the search may still know
  // by its first, and a run on another branch; neither is a first attempt on
  // main, so neither is the run the search has to reach.
  const test = await temporaryCollector();
  const originalFetch = globalThis.fetch;
  const reached = workflowRun(9_312, NOW - 3 * HOUR);
  globalThis.fetch = servingSearchAndNewestPage(
    [reached, workflowRun(9_311, NOW - DAY)],
    [
      workflowRun(9_314, NOW - HOUR / 2, { head_branch: "feature" }),
      workflowRun(9_313, NOW - HOUR),
      reached,
      workflowRun(9_310, NOW - 4 * HOUR, { run_attempt: 2 }),
      workflowRun(9_309, NOW - 5 * HOUR, { head_branch: "feature" }),
    ],
  );
  try {
    const snapshot = await test.collector.collect("lagging-token", NOW);
    assertEquals(snapshot.successfulRunTimes, [
      NOW - DAY,
      NOW - 4 * HOUR,
      NOW - 3 * HOUR,
      NOW - HOUR,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history holds a search only to newest-page runs inside its window", async () => {
  // A quiet workflow's newest page reaches back past the window; the search
  // covers only the window, so it cannot be asked to reach that run.
  const test = await temporaryCollector();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = servingSearchAndNewestPage(
    [],
    [workflowRun(9_331, NOW - (CI_HISTORY_DAYS + 5) * DAY)],
  );
  try {
    const snapshot = await test.collector.collect("quiet-token", NOW);
    assertEquals(snapshot.runCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt picks main's pushes out of the unfiltered run list", async () => {
  const test = await temporaryCollector();
  const main = workflowRun(9_321, NOW, { conclusion: "failure" });
  const pages: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      pages.push(url);
      return Promise.resolve(Response.json({
        workflow_runs: [
          workflowRun(9_323, NOW, { head_branch: "feature" }),
          workflowRun(9_322, NOW, { event: "pull_request" }),
          main,
        ],
      }));
    }
    if (url.pathname.includes("/jobs")) {
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", 90, "failure")],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  try {
    const gantt = await test.collector.gantt(
      "main-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true, allConclusions: true },
      NOW,
    );
    assertEquals(gantt.runs.map(({ run }) => run.databaseId), [main.id]);
    assertEquals(pages.map((url) => url.search), ["?per_page=100&page=1"]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt leaves out runs past the history window on the last page it reads", async () => {
  const test = await temporaryCollector();
  const recent = workflowRun(9_341, NOW);
  const old = workflowRun(9_340, NOW - (CI_HISTORY_DAYS + 5) * DAY);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      return Promise.resolve(Response.json({ workflow_runs: [recent, old] }));
    }
    if (url.pathname.includes("/jobs")) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  try {
    const gantt = await test.collector.gantt(
      "window-edge-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 10, mainOnly: true, allConclusions: true },
      NOW,
    );
    assertEquals(gantt.runs.map(({ run }) => run.databaseId), [recent.id]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt counts a run two pages repeat once toward its limit", async () => {
  // A run landing between the two reads pushes page one's last run onto page
  // two as well.
  const test = await temporaryCollector();
  const runs = Array.from(
    { length: 200 },
    (_, index) => workflowRun(40_000 - index, NOW - index * 60_000),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      const page = Number(url.searchParams.get("page"));
      return Promise.resolve(Response.json({
        workflow_runs: page === 1 ? runs.slice(0, 100) : runs.slice(99, 199),
      }));
    }
    if (url.pathname.includes("/jobs")) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  try {
    const gantt = await test.collector.gantt(
      "repeat-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 150, mainOnly: true, allConclusions: true },
      NOW,
    );
    assertEquals(gantt.runs.length, 150);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt stops walking the unfiltered run list at the history window", async () => {
  const test = await temporaryCollector();
  const pages: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/actions/workflows/${CI_WORKFLOW}/runs`)) {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      // Every page is full of pull request runs, each twenty days older than
      // the page before it, so the third reaches past the history window. The
      // list ends at the fifth.
      return Promise.resolve(Response.json({
        workflow_runs: page > 5 ? [] : Array.from(
          { length: 100 },
          (_, index) =>
            workflowRun(30_000 + page * 100 + index, NOW - page * 20 * DAY, {
              event: "pull_request",
            }),
        ),
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  try {
    await assertRejects(
      () =>
        test.collector.gantt(
          "window-token",
          CI_HISTORY_SOURCES.labs,
          { limit: 10, mainOnly: true, allConclusions: true },
          NOW,
        ),
      Error,
      "No completed CI runs",
    );
    assertEquals(pages, [1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history splits a saturated workflow-run search", async () => {
  const test = await temporaryCollector();
  const ranges: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    assertStringIncludes(
      url.pathname,
      `/actions/workflows/${CI_WORKFLOW}/runs`,
    );
    if (isNewestPage(url.href)) {
      return Promise.resolve(Response.json({ workflow_runs: [] }));
    }
    ranges.push(url.searchParams.get("created") ?? "");
    return Promise.resolve(Response.json({
      total_count: ranges.length === 1 ? 1_000 : 0,
      workflow_runs: [],
    }));
  };

  try {
    const snapshot = await test.collector.collect("split-token", NOW);
    assertEquals(snapshot.runCount, 0);
    assertEquals(ranges.length, 3);
    assert(ranges.every((range) => range.includes("..")));
    assert(ranges[1] !== ranges[2]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history refreshes the complete latest job set after a subset rerun", async () => {
  const test = await temporaryCollector();
  const runId = 9_201;
  let attempt = 1;
  const jobCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [
          workflowRun(runId, NOW, { run_attempt: attempt }),
        ],
      }));
    }
    const attempted = url.match(/\/actions\/runs\/\d+\/attempts\/(\d+)\/jobs/);
    if (attempted) {
      jobCalls.push(url);
      const attemptedNumber = Number(attempted[1]);
      return Promise.resolve(Response.json({
        jobs: attemptedNumber === 1
          ? [apiJob("Check", 100), apiJob("Retried job", 100)]
          : attemptedNumber === 2
          ? [apiJob("Retried job", 200)]
          : [apiJob("Check", 300)],
      }));
    }
    if (url.includes(`/actions/runs/${runId}/`)) {
      jobCalls.push(url);
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", 100), apiJob("Retried job", 100)],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = await test.collector.collect("rerun-token", NOW);
    attempt = 2;
    const second = await test.collector.collect("rerun-token", NOW);
    attempt = 3;
    const third = await test.collector.collect("rerun-token", NOW);
    await test.collector.collect("rerun-token", NOW);
    assertEquals(
      first.jobs.map((series) => [series.name, series.points[0].seconds]),
      [["Check", 100], ["Retried job", 100]],
    );
    assertEquals(
      second.jobs.map((series) => [series.name, series.points[0].seconds]),
      [["Check", 100], ["Retried job", 200]],
    );
    assertEquals(
      third.jobs.map((series) => [series.name, series.points[0].seconds]),
      [["Check", 300], ["Retried job", 200]],
    );
    assertEquals(jobCalls.length, 6);
    assertStringIncludes(jobCalls[0], `/attempts/1/jobs`);
    assertStringIncludes(jobCalls[1], `/attempts/1/jobs`);
    assertStringIncludes(jobCalls[2], `/attempts/2/jobs`);
    assertStringIncludes(jobCalls[5], `/attempts/3/jobs`);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI Gantt keeps every execution of a rerun job", async () => {
  const test = await temporaryCollector();
  const runId = 9_205;
  const firstStart = NOW - HOUR;
  const retryStart = NOW + 6 * HOUR;
  const jobAt = (name: string, seconds: number, start: number) => ({
    ...apiJob(name, seconds),
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + seconds * 1_000).toISOString(),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/runs/${runId}/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({
        jobs: [
          { ...jobAt("Check", 100, firstStart), id: 100 },
          {
            ...jobAt("Retried job", 100, firstStart + 120_000),
            conclusion: "failure",
          },
        ],
      }));
    }
    if (url.includes(`/actions/runs/${runId}/attempts/2/jobs`)) {
      return Promise.resolve(Response.json({
        jobs: [
          { ...jobAt("Check", 100, firstStart), id: 200 },
          jobAt("Retried job", 200, retryStart),
        ],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const run = workflowRun(runId, NOW, { run_attempt: 2 });
    const history = await test.collector.collect(
      "rerun-gantt-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [run],
    );
    assertEquals(
      history.jobs.find((series) => series.name === "Retried job")?.points[0]
        .seconds,
      200,
    );

    const gantt = await test.collector.gantt(
      "rerun-gantt-token",
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      NOW,
      [run],
    );
    assertEquals(
      gantt.runs[0].jobs.filter((job) => job.name === "Check").map((job) => ({
        attempt: job.attempt,
        startedAt: job.started_at,
      })),
      [{
        attempt: 1,
        startedAt: new Date(firstStart).toISOString(),
      }],
    );
    assertEquals(
      gantt.runs[0].jobs.filter((job) => job.name === "Retried job").map(
        (job) => ({
          attempt: job.attempt,
          conclusion: job.conclusion,
          startedAt: job.started_at,
          completedAt: job.completed_at,
        }),
      ),
      [
        {
          attempt: 1,
          conclusion: "failure",
          startedAt: new Date(firstStart + 120_000).toISOString(),
          completedAt: new Date(firstStart + 220_000).toISOString(),
        },
        {
          attempt: 2,
          conclusion: "success",
          startedAt: new Date(retryStart).toISOString(),
          completedAt: new Date(retryStart + 200_000).toISOString(),
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history keeps the higher attempt when requests finish out of order", async () => {
  const test = await temporaryCollector();
  const runId = 9_211;
  let releaseLower!: (response: Response) => void;
  let markLowerRequested!: () => void;
  const lowerResponse = new Promise<Response>((resolve) => {
    releaseLower = resolve;
  });
  const lowerRequested = new Promise<void>((resolve) => {
    markLowerRequested = resolve;
  });
  const calls: string[] = [];
  let attemptOneCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(`/actions/runs/${runId}/attempts/1/jobs`)) {
      attemptOneCalls++;
      if (attemptOneCalls === 1) {
        markLowerRequested();
        return lowerResponse;
      }
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", 100)],
      }));
    }
    const attempted = url.match(/\/actions\/runs\/\d+\/attempts\/(\d+)\/jobs/);
    if (attempted) {
      return Promise.resolve(Response.json({
        jobs: [apiJob("Check", Number(attempted[1]) * 100)],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const lowerRequest = test.collector.collect(
      "ordering-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [workflowRun(runId, NOW)],
    );
    await lowerRequested;
    const higher = await test.collector.collect(
      "ordering-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [workflowRun(runId, NOW, { run_attempt: 2 })],
    );
    releaseLower(Response.json({ jobs: [apiJob("Check", 100)] }));
    const lower = await lowerRequest;

    assertEquals(higher.jobs[0].points[0].seconds, 200);
    assertEquals(lower.jobs[0].points[0].seconds, 200);
    const callsBeforeCachedLower = calls.length;
    const cachedLower = await test.collector.collect(
      "ordering-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      CI_HISTORY_DAYS,
      [workflowRun(runId, NOW)],
    );
    assertEquals(cachedLower.jobs[0].points[0].seconds, 200);
    assertEquals(calls.length, callsBeforeCachedLower);

    const persisted = JSON.parse(await Deno.readTextFile(test.file));
    assertEquals(
      persisted.runs.map((run: { runAttempt: number }) => run.runAttempt)
        .sort(),
      [1, 2],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history keeps successful samples when another run cannot be read", async () => {
  const test = await temporaryCollector();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: [
          workflowRun(9_301, NOW),
          workflowRun(9_302, NOW - 6 * DAY),
        ],
      }));
    }
    if (url.includes(`/actions/runs/9301/attempts/1/jobs`)) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }));
    }
    if (url.includes(`/actions/runs/9302/attempts/1/jobs`)) {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const snapshot = await test.collector.collect(
      "partial-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assertEquals(snapshot.runCount, 1);
    assertEquals(snapshot.successfulRunTimes, [NOW - 6 * DAY, NOW]);
    assertEquals(snapshot.failedRunCount, 1);
    assertEquals(snapshot.failedRunTimes, [NOW - 6 * DAY]);
    assertEquals(snapshot.stale, false);
    assertEquals(snapshot.jobs.map((series) => series.name), ["Check"]);
    const html = ciJobHistoryPage(snapshot, "job");
    assertStringIncludes(html, "Showing partial data.");
    assertStringIncludes(html, "1 sampled run could not be read.");
    assertStringIncludes(
      html,
      "Coverage: 1 sampled build shown out of 2 successful main builds.",
    );
    assertStringIncludes(html, '<span class="cname">Check</span>');
    assertStringIncludes(
      ciJobHistoryPage(buildCiJobHistory([], 2), "job"),
      "CI job timings could not be read for 2 sampled runs.",
    );
    assertStringIncludes(
      ciJobHistoryPage(buildCiJobHistory([], 1), "job"),
      "CI job timings could not be read for 1 sampled run.",
    );
    assertEquals(buildCiJobHistory([], 1).stale, true);

    const aged = await test.collector.cached(
      CI_HISTORY_SOURCES.labs,
      7,
      NOW + 2 * DAY,
    );
    assertEquals(aged?.runCount, 1);
    assertEquals(aged?.successfulRunTimes, [NOW]);
    assertEquals(aged?.failedRunCount, 0);
    assertEquals(aged?.failedRunTimes, []);
    assertEquals(aged?.jobs.map((series) => series.name), ["Check"]);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history keeps the last snapshot when every refreshed attempt fails", async () => {
  const test = await temporaryCollector();
  const previousRunId = 9_400;
  const runId = 9_401;
  let attempt = 1;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/${CI_WORKFLOW}/runs?`)) {
      return Promise.resolve(Response.json({
        workflow_runs: attempt === 1
          ? [
            workflowRun(previousRunId, NOW - 6 * DAY),
            workflowRun(runId, NOW),
          ]
          : [workflowRun(runId, NOW, { run_attempt: attempt })],
      }));
    }
    if (url.includes(`/actions/runs/${previousRunId}/`)) {
      return Promise.resolve(Response.json({ jobs: [apiJob("Check", 80)] }));
    }
    if (url.includes(`/actions/runs/${runId}/`)) {
      return attempt === 1
        ? Promise.resolve(Response.json({ jobs: [apiJob("Check", 90)] }))
        : Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    if (url.includes("/actions/runs/9402/")) {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  try {
    const first = await test.collector.collect(
      "stale-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      7,
    );
    attempt = 2;
    const stale = await test.collector.collect(
      "stale-token",
      NOW,
      CI_HISTORY_SOURCES.labs,
      7,
    );
    assertEquals(first.jobs[0].points.map((point) => point.seconds), [80, 90]);
    assertEquals(stale.jobs[0].points.map((point) => point.seconds), [80, 90]);
    assertEquals(first.successfulRunTimes, [NOW - 6 * DAY, NOW]);
    assertEquals(stale.successfulRunTimes, [NOW - 6 * DAY, NOW]);
    assertEquals(stale.runCount, 2);
    assertEquals(stale.failedRunCount, 1);
    assertEquals(stale.failedRunTimes, [NOW]);
    assertEquals(stale.stale, true);
    const html = ciJobHistoryPage(stale, "job");
    assertStringIncludes(
      html,
      "Coverage: 2 sampled builds shown out of 2 successful main builds.",
    );
    assertStringIncludes(html, "Showing the last collected data.");
    assert(!html.includes("Showing partial data."));

    const expired = await test.collector.collect(
      "stale-token",
      NOW + 8 * DAY,
      CI_HISTORY_SOURCES.labs,
      7,
      [workflowRun(9_402, NOW + 8 * DAY)],
    );
    assertEquals(expired.runCount, 0);
    assertEquals(expired.failedRunCount, 1);
    assertEquals(expired.failedRunTimes, [NOW + 8 * DAY]);
    assertEquals(expired.stale, true);
    assertEquals(expired.overall, null);
    assertEquals(expired.groups, []);
    assertEquals(expired.jobs, []);
  } finally {
    globalThis.fetch = originalFetch;
    await test.cleanup();
  }
});

Deno.test("CI job history sorts named shard suffixes and formats hour-long jobs", () => {
  const snapshot = buildCiJobHistory([{
    runId: 9_501,
    runUrl: "https://example.test/runs/9501",
    at: NOW,
    jobs: [
      { name: "Build (windows)", seconds: 3_700 },
      { name: "Build (linux)", seconds: 3_600 },
    ],
  }]);

  assertEquals(
    snapshot.groups[0].shards.map((series) => series.name),
    ["Build (linux)", "Build (windows)"],
  );
  assertStringIncludes(ciJobHistoryPage(snapshot, "job"), "1h 01m");
});

Deno.test("CI job history rejects a one-second workflow search with over 1,000 runs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>() => Promise.resolve({ total_count: 1_000, workflow_runs: [] } as T),
  );
  try {
    await assertRejects(
      () => collector.collect("token", NOW),
      Error,
      "exceeded 1,000 results in one second",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history paginates workflow searches and honors the reported total", async () => {
  for (const reportsTotal of [false, true]) {
    const directory = await Deno.makeTempDir({
      prefix: "ci-job-history-test-",
    });
    const pages: number[] = [];
    const runs = Array.from(
      { length: 100 },
      (_, index) =>
        workflowRun(10_000 + index, NOW - index, { conclusion: "failure" }),
    );
    const collector = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(`${directory}/history.json`),
      <T>(path: string) => {
        if (isNewestPage(path)) return Promise.resolve({ workflow_runs: [] } as T);
        const page = Number(
          new URL(`https://example.test/${path}`).searchParams.get("page"),
        );
        pages.push(page);
        return Promise.resolve({
          ...(reportsTotal ? { total_count: 100 } : {}),
          workflow_runs: page === 1 ? runs : [
            workflowRun(10_101, NOW - 101, { conclusion: "failure" }),
          ],
        } as T);
      },
    );
    try {
      assertEquals((await collector.collect("token", NOW)).runCount, 0);
      assertEquals(pages, reportsTotal ? [1] : [1, 2]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("CI job history ignores invalid job times and uses a timed rerun in the Gantt", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const run = workflowRun(10_200, NOW, { run_attempt: 2 });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      const jobs = path.includes("attempts/1")
        ? [{
          name: "Retry",
          status: "completed",
          conclusion: "failure",
          started_at: null,
          completed_at: null,
        }, {
          name: "Invalid clock",
          status: "completed",
          conclusion: "success",
          started_at: "not-a-date",
          completed_at: new Date(NOW).toISOString(),
        }]
        : [{ ...apiJob("Retry", 30), status: "completed" }];
      return Promise.resolve({ jobs } as T);
    },
  );
  try {
    const snapshot = await collector.collect("token", NOW, undefined, 45, [
      run,
    ]);
    assertEquals(snapshot.jobs.map((series) => series.name), ["Retry"]);
    const gantt = await collector.gantt(
      undefined,
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true, allConclusions: false },
      NOW,
    );
    const retry = gantt.runs[0].jobs.find((job) => job.attempt === 2);
    assertEquals(retry?.conclusion, "success");
    assertEquals(
      retry?.started_at,
      apiJob("Retry", 30).started_at,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history removes progress listeners that throw", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  let resolveRuns: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((resolve) => resolveRuns = resolve);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>() => pending as Promise<T>,
  );
  try {
    const refresh = collector.startRefresh("token");
    assert(refresh.progress);
    assertEquals(collector.subscribeProgress("missing", () => {}), null);
    assertEquals(
      collector.subscribeProgress(refresh.progress.id, () => {
        throw new Error("initial listener failed");
      }),
      null,
    );
    let calls = 0;
    assert(collector.subscribeProgress(refresh.progress.id, () => {
      calls++;
      if (calls > 1) throw new Error("update listener failed");
    }));
    resolveRuns({ workflow_runs: [] });
    await refresh.result;
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history quarantines a future refresh when reading cached data", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const file = `${directory}/history.json`;
  const store = new CiJobHistoryStore(file);
  const now = Date.now();
  try {
    await store.load();
    const run = store.set(cachedRunEntry({
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: 10_300,
      runAttempt: 1,
      runUrl: `https://github.com/${REPO}/actions/runs/10300`,
      at: now,
      overallSeconds: 30,
      jobs: [{ name: "Check", seconds: 30 }],
      gantt: {
        status: "completed",
        conclusion: "success",
        event: "push",
        headBranch: "main",
        workflowName: "CI",
        startedAt: new Date(now).toISOString(),
      },
    }));
    store.markRefreshed(
      REPO,
      CI_WORKFLOW,
      45,
      now + DAY,
      [now],
      [{ runId: run.runId, runAttempt: run.runAttempt }],
      0,
      [],
      false,
    );
    await store.save(now);

    const collector = new RateLimitedCiJobHistoryCollector(store);
    assertEquals((await collector.cached(undefined, 45, now))?.runCount, 1);
    const persisted = JSON.parse(await Deno.readTextFile(file));
    assertEquals(persisted.refreshes, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reports missing credentials and includes cached failed main runs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  const collector = new RateLimitedCiJobHistoryCollector(store);
  try {
    await assertRejects(
      () =>
        collector.gantt(undefined, CI_HISTORY_SOURCES.labs, {
          limit: 1,
          mainOnly: true,
          allConclusions: true,
        }),
      Error,
      "Set GH_TOKEN",
    );
    const failed = workflowRun(10_400, NOW, { conclusion: "failure" });
    await seedCachedRun(store, {
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: failed.id,
      runAttempt: 1,
      runUrl: failed.html_url,
      at: NOW,
      overallSeconds: 0,
      jobs: [],
      gantt: {
        status: "completed",
        conclusion: "failure",
        event: "push",
        headBranch: "main",
        workflowName: "CI",
        startedAt: failed.run_started_at,
      },
    });
    await store.save(NOW);
    const cachedRefresh = collector.startGantt(
      undefined,
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true, allConclusions: true },
      NOW,
    );
    const cached = await collector.ganttRuns(
      CI_HISTORY_SOURCES.labs,
      await cachedRefresh.result,
    );
    assertEquals(cached.runs[0].run.conclusion, "failure");
    assertEquals(
      collector.progress(cachedRefresh.progress.id)?.warning,
      "Showing cached runs; set GH_TOKEN to check for newer attempts.",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the production CI Gantt wrapper writes the file it is given", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-wrapper-" });
  const file = `${directory}/history.json`;
  // The wrapper takes no clock of its own, so the run has to be recent.
  const run = workflowRun(15_400, Date.now() - HOUR);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(file),
    <T>(path: string) =>
      Promise.resolve(
        path.includes("/runs?")
          ? { workflow_runs: [run] } as T
          : { jobs: [apiJob("Check", 30)] } as T,
      ),
  );
  try {
    const destination = `${directory}/input.json`;
    const runCount = await collectCiGanttInput(
      CI_HISTORY_SOURCES.labs,
      { limit: 1, mainOnly: true },
      destination,
      "token",
      collector,
    );

    assertEquals(runCount, 1);
    const written = JSON.parse(await Deno.readTextFile(destination));
    assertEquals(written.runs[0].run.databaseId, run.id);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the production CI Gantt wrapper forwards a source with no cached data", async () => {
  const source: CiHistorySource = {
    ...CI_HISTORY_SOURCES.labs,
    repo: `uncached/repo-${crypto.randomUUID()}`,
  };
  const directory = await Deno.makeTempDir({ prefix: "ci-gantt-wrapper-" });
  try {
    await assertRejects(
      () =>
        collectCiGanttInput(
          source,
          {
            limit: 1,
            mainOnly: true,
            allConclusions: false,
          },
          `${directory}/input.json`,
          "",
        ),
      Error,
      "Set GH_TOKEN",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history detects when its exact stale snapshot cannot be retained", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  let failJobs = false;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>() =>
      failJobs
        ? Promise.reject(new Error("jobs unavailable"))
        : Promise.resolve({ jobs: [apiJob("Check", 30)] } as T),
  );
  const run = workflowRun(10_500, NOW);
  try {
    assertEquals(
      (await collector.collect("token", NOW, undefined, 45, [run])).runCount,
      1,
    );
    await store.save(NOW + 100 * DAY);
    failJobs = true;
    await assertRejects(
      () => collector.collect("token", NOW, undefined, 45, [run]),
      Error,
      "could not preserve the exact previous run set",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reuses recent discovery and reports discovery failure without cache", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const run = workflowRun(10_600, NOW);
  let workflowRequests = 0;
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>(path: string) => {
      if (path.includes("/runs?")) {
        workflowRequests++;
        return Promise.resolve({ workflow_runs: [run] } as T);
      }
      return Promise.resolve({ jobs: [apiJob("Check", 30)] } as T);
    },
  );
  const options = { limit: 1, mainOnly: false, allConclusions: true };
  try {
    assertEquals(
      (await collector.gantt("token", CI_HISTORY_SOURCES.labs, options, NOW))
        .runs.length,
      1,
    );
    assertEquals(
      (await collector.gantt("token", CI_HISTORY_SOURCES.labs, options, NOW))
        .runs.length,
      1,
    );
    assertEquals(workflowRequests, 1);

    const failed = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(`${directory}/failed.json`),
      () => Promise.reject(new Error("discovery failed")),
    );
    await assertRejects(
      () => failed.gantt("token", CI_HISTORY_SOURCES.labs, options, NOW),
      Error,
      "discovery failed",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI Gantt reports job failures and falls back to an older cached attempt", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const options = { limit: 1, mainOnly: true, allConclusions: false };
  try {
    const noRuns = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(`${directory}/no-runs.json`),
    );
    await assertRejects(
      () =>
        noRuns.gantt(
          "token",
          CI_HISTORY_SOURCES.labs,
          options,
          NOW,
          [],
        ),
      Error,
      "No completed CI runs with cached job timings",
    );

    const empty = new RateLimitedCiJobHistoryCollector(
      new CiJobHistoryStore(`${directory}/empty.json`),
      () => Promise.reject("job request failed"),
    );
    await assertRejects(
      () =>
        empty.gantt(
          "token",
          CI_HISTORY_SOURCES.labs,
          options,
          NOW,
          [workflowRun(10_700, NOW)],
        ),
      Error,
      "job request failed",
    );

    const store = new CiJobHistoryStore(`${directory}/cached.json`);
    await store.load();
    const oldRun = workflowRun(10_701, NOW);
    await seedCachedRun(store, {
      repo: REPO,
      workflow: CI_WORKFLOW,
      runId: oldRun.id,
      runAttempt: 1,
      runUrl: oldRun.html_url,
      at: NOW,
      overallSeconds: 30,
      jobs: [{ name: "Old check", seconds: 30 }],
      gantt: {
        status: "completed",
        conclusion: "success",
        event: "push",
        headBranch: "main",
        workflowName: "CI",
        startedAt: oldRun.run_started_at,
      },
    });
    await store.save(NOW);
    const cached = new RateLimitedCiJobHistoryCollector(
      store,
      () => Promise.reject(new Error("new attempt failed")),
    );
    const result = await cached.gantt(
      "token",
      CI_HISTORY_SOURCES.labs,
      options,
      NOW,
      [{ ...oldRun, run_attempt: 2 }],
    );
    assertEquals(result.runs[0].run.attempt, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history joins an active refresh for the same window", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  let resolveRuns: (value: unknown) => void = () => {};
  const runs = new Promise<unknown>((resolve) => resolveRuns = resolve);
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>() => runs as Promise<T>,
  );
  try {
    const first = collector.startRefresh("token", CI_HISTORY_SOURCES.labs, 7);
    const second = collector.startRefresh(
      "token",
      CI_HISTORY_SOURCES.labs,
      7,
      buildCiJobHistory([]),
    );
    assert(first.progress);
    assertEquals(second.progress?.id, first.progress.id);
    assertEquals(second.result, first.result);
    resolveRuns({ workflow_runs: [] });
    await second.result;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history restores its prior manifest when the manifest write fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  class FailManifestSaveStore extends CiJobHistoryStore {
    saveCalls = 0;
    failManifestSave = false;

    override markRefreshed(
      ...args: Parameters<CiJobHistoryStore["markRefreshed"]>
    ): void {
      super.markRefreshed(...args);
      this.failManifestSave = true;
    }

    override async save(now = Date.now()): Promise<void> {
      this.saveCalls++;
      if (this.failManifestSave) throw new Error("manifest write failed");
      await super.save(now);
    }
  }
  const store = new FailManifestSaveStore(`${directory}/history.json`);
  const run = workflowRun(10_800, Date.now() - 1_000);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>(path: string) =>
      Promise.resolve(
        (path.includes("/runs?")
          ? { workflow_runs: [run] }
          : { jobs: [apiJob("Check", 30)] }) as T,
      ),
  );
  try {
    await assertRejects(
      () => collector.startRefresh("token").result,
      Error,
      "manifest write failed",
    );
    assertEquals(store.saveCalls, 2);
    assertEquals(
      store.refresh(REPO, CI_WORKFLOW, CI_HISTORY_DAYS),
      undefined,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history rejects a missing persisted refresh manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  store.refresh = (() => undefined) as typeof store.refresh;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>() => Promise.resolve({ workflow_runs: [] } as T),
  );
  try {
    await assertRejects(
      () => collector.startRefresh("token").result,
      Error,
      "refresh manifest was not persisted",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history reloads when concurrent persistence changes its manifest", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  const readRefresh = store.refresh.bind(store);
  let reads = 0;
  store.refresh = ((...args): CachedCiHistoryRefresh | undefined => {
    const refresh = readRefresh(...args);
    reads++;
    return refresh && reads >= 2
      ? { ...refresh, stale: !refresh.stale }
      : refresh;
  }) as typeof store.refresh;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>() => Promise.resolve({ workflow_runs: [] } as T),
  );
  try {
    assertEquals((await collector.startRefresh("token").result).runCount, 0);
    assertEquals(reads >= 2, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history completes when a persisted manifest is immediately invalidated", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/history.json`);
  store.freshRefresh = (() => undefined) as typeof store.freshRefresh;
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    <T>() => Promise.resolve({ workflow_runs: [] } as T),
  );
  try {
    assertEquals((await collector.startRefresh("token").result).runCount, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history reports persistence failure while recording a rate limit", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const store = new CiJobHistoryStore(`${directory}/missing/history.json`);
  const collector = new RateLimitedCiJobHistoryCollector(
    store,
    () => Promise.reject(new GitHubRateLimitBudgetError("limited")),
  );
  try {
    const error = await assertRejects(
      () => collector.startRefresh("token").result,
      Error,
    );
    assertStringIncludes(error.message, "No such file or directory");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history progress responses close completed streams", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-history-test-" });
  const collector = new RateLimitedCiJobHistoryCollector(
    new CiJobHistoryStore(`${directory}/history.json`),
    <T>() => Promise.resolve({ workflow_runs: [] } as T),
  );
  try {
    assertEquals(
      ciJobHistoryProgressResponse(
        new URL("http://x/bench/ci-progress"),
        collector,
      ).status,
      400,
    );
    assertEquals(
      ciJobHistoryProgressResponse(
        new URL("http://x/bench/ci-progress?id=missing"),
        collector,
      ).status,
      404,
    );
    const refresh = collector.startRefresh("token");
    assert(refresh.progress);
    await refresh.result;
    const response = ciJobHistoryProgressResponse(
      new URL(`http://x/bench/ci-progress?id=${refresh.progress.id}`),
      collector,
    );
    const body = await response.text();
    assertStringIncludes(body, '"phase":"complete"');
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job history progress streams ignore duplicate terminal updates", async () => {
  const complete: CiJobFetchProgress = {
    id: "duplicate-terminal",
    source: "labs",
    days: 45,
    phase: "complete",
    discoveryRequestsMade: 1,
    discoveryResponsesReceived: 1,
    discoveryOutstandingRequests: 0,
    totalRuns: 0,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 0,
    completedRuns: 0,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
  };
  const collector = {
    progress: () => complete,
    subscribeProgress: (
      _id: string,
      listener: (progress: CiJobFetchProgress) => void,
    ) => {
      listener(complete);
      listener(complete);
      return () => {};
    },
  } as unknown as RateLimitedCiJobHistoryCollector;
  const response = ciJobHistoryProgressResponse(
    new URL("http://x/bench/ci-progress?id=duplicate-terminal"),
    collector,
  );
  assertStringIncludes(await response.text(), '"phase":"complete"');
});

Deno.test("CI history endpoints handle immediate and background refreshes", async () => {
  const cached = buildCiJobHistory(historySamples());
  const progress: CiJobFetchProgress = {
    id: "background",
    source: "labs",
    days: 45,
    phase: "discovering",
    discoveryRequestsMade: 0,
    discoveryResponsesReceived: 0,
    discoveryOutstandingRequests: 0,
    totalRuns: 0,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    sharedRequests: 0,
    sharedResponses: 0,
    successfulResponses: 0,
    failedResponses: 0,
    completedRuns: 0,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: NOW,
  };
  const immediate = {
    cached: () => Promise.resolve(null),
    startRefresh: () => ({ progress: null, result: Promise.resolve(cached) }),
  };
  const checked = await ciJobHistoryCheckResponse(
    new URL("http://x/bench/check?view=ci"),
    immediate,
    "token",
  );
  assertEquals(
    (await checked.json()).version,
    ciJobHistorySnapshotVersion(cached),
  );

  const background = {
    cached: () => Promise.resolve(cached),
    startRefresh: () => ({
      progress,
      result: Promise.reject(new Error("background failed")),
    }),
  };
  const response = await ciJobHistoryResponse(
    new URL("http://x/bench?view=ci"),
    background,
    "token",
  );
  assertStringIncludes(
    await response.text(),
    'data-progress-url="/bench/ci-progress?id=background"',
  );
});
