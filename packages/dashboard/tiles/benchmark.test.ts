/**
 * benchmark tile tests. The tile is driven through collect(ctx) and its /bench
 * route with globalThis.fetch stubbed, so the GitHub Actions workflow-run pages,
 * the per-run artifact listings and the artifact zips (real zip bytes, really
 * deflated) are all canned. No network, no files, no subprocess.
 *
 * The tile keeps a persistent cache of each run's results and a module-level
 * snapshot for the drill-down page. The dashboard test runner gives this module
 * a temporary server-data directory. These tests share that state, use distinct
 * run ids, and read snapshots after the collection that filled them.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Ctx, TileView } from "../types.ts";
import { BENCH_TREND_BUCKET_MS, REPO } from "../config.ts";
import { BenchmarkHistoryStore } from "../benchmark-history-cache.ts";
import {
  availableGeneratedCpuColor,
  benchmark,
  type BenchmarkFetchProgress,
  benchmarkHeadlineCandidates,
  benchmarkHistoryCheckResponse,
  benchmarkFailureLabel,
  benchmarkHistoryProgressResponse,
  benchmarkRerunHandoff,
  benchmarkTrend,
  benchmarkTrendRuns,
  benchPage,
  formatNs,
  keyBenchmarks,
  pointsForWindow,
  representativeBenchmarkCpu,
  sampleBenchmarkRuns,
  trendPct,
  trendStatus,
} from "./benchmark.ts";
import { CALIBRATION_FILE } from "../bench-report.ts";
import {
  CI_HISTORY_MIN_DAYS,
  CI_HISTORY_POINT_TARGET,
  ciHistoryBucketMs,
} from "../ci-job-history.ts";
import { PERFORMANCE_VIEW_STYLES } from "../performance-views.ts";
import { artifactZip, bytes, makeZip } from "../test/artifact-zip.ts";

// The history store falls back to the system temporary directory when no cache
// directory is named. The package's test runner names a fresh one for each run.
// Running this file directly gets whatever the last run left behind, which then
// feeds these tests in place of their own fixtures. Name a directory here when
// nothing else has.
if (Deno.env.get("DASHBOARD_CACHE_DIR") === undefined) {
  Deno.env.set(
    "DASHBOARD_CACHE_DIR",
    await Deno.makeTempDir({ prefix: "benchmark-test-cache-" }),
  );
}

// These tests hand each collection its token through the context. The /bench
// route handlers read theirs from the environment, and a page request that
// finds one there starts a drill-down refresh against GitHub. That refresh can
// run on into whichever test comes next, and its failure is remembered for the
// tests after it. So the environment holds no token unless a test puts one
// there.
Deno.env.delete("GH_TOKEN");
Deno.env.delete("GITHUB_TOKEN");

const DAY = 86_400_000;
const HOUR = 3_600_000;
// One full hour before the current hour keeps each common newest successful
// fixture inside the headline window.
const BASE = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
const COLLECTION_BUCKET = ciHistoryBucketMs(CI_HISTORY_MIN_DAYS);
const SAMPLED_BASE = Math.floor(BASE / COLLECTION_BUCKET) *
    COLLECTION_BUCKET +
  COLLECTION_BUCKET * 0.75;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

//
// zip building
//

// The shape the benchmarks.yml artifact upload takes.
const benchZip = (json: string) => artifactZip("results.json", json);

//
// the stub api
//

interface GhRun {
  id: number;
  run_attempt: number;
  status: string;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  conclusion: string | null;
}

// The default benchmarks.yml wall-clock the fixtures give each run. The tile times
// a run from run_started_at to updated_at, so a fixed span keeps the duration
// trend flat unless a test asks for a different one.
const RUN_MS = 5 * 60_000;

const ghRun = (
  id: number,
  at: number,
  conclusion: string | null = "success",
  runAttempt = 1,
  durationMs = RUN_MS,
): GhRun => ({
  id,
  run_attempt: runAttempt,
  status: "completed",
  created_at: new Date(at).toISOString(),
  run_started_at: new Date(at).toISOString(),
  updated_at: new Date(at + durationMs).toISOString(),
  conclusion,
});

interface Api {
  pages?: Record<number, GhRun[]>;
  // runId -> its artifact listing, or an HTTP status to fail with.
  artifacts?: Record<
    number,
    { id: number; name: string; expired: boolean }[] | number
  >;
  // artifactId -> the zip bytes, or an HTTP status to fail with.
  zips?: Record<number, Uint8Array<ArrayBuffer> | number>;
  // Thrown instead of answering, standing in for a dead network.
  throws?: Error;
  // Answered to everything, standing in for a refused request.
  status?: number;
}

// A stand-in GitHub Actions API answering exactly the three calls the tile makes.
function serve(api: Api): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/rate_limit") {
      return Response.json({
        resources: {
          core: {
            limit: 5_000,
            used: 0,
            remaining: 5_000,
            reset: Math.ceil(Date.now() / 1_000) + 3_600,
          },
        },
      });
    }
    if (api.throws) throw api.throws;
    if (api.status) return new Response("no", { status: api.status });
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Response.json({
        workflow_runs: api.pages?.[Number(url.searchParams.get("page"))] ?? [],
      });
    }
    const runId = url.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/)?.[1];
    if (runId) {
      const v = api.artifacts?.[Number(runId)];
      if (typeof v === "number") return new Response("no", { status: v });
      return Response.json({ artifacts: v ?? [] });
    }
    const artId = url.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/)?.[1];
    if (artId) {
      const v = api.zips?.[Number(artId)];
      if (v === undefined || typeof v === "number") {
        return new Response("no", { status: typeof v === "number" ? v : 404 });
      }
      return new Response(v);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
}

// Swap in the stub api for one test, recording every path requested, and put the
// real fetch back afterwards so no state leaks into the rest of the process.
async function withApi(
  api: Api,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const handler = serve(api);
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const runsPath = `/repos/${REPO}/actions/workflows/benchmarks.yml/runs`;
const artifactCalls = (calls: string[]) =>
  calls.filter((c) => c.includes("/artifacts"));
const apiCalls = (calls: string[]) =>
  calls.filter((call) => !call.startsWith("/rate_limit"));
const runListCalls = (calls: string[]) =>
  calls.filter((call) => call.startsWith(runsPath));

//
// bench json
//

interface Timings {
  min?: number;
  avg?: number;
  max?: number;
  p75?: number;
  p99?: number;
  p995?: number;
  p999?: number;
}

// deno bench's per-benchmark timings, spread around a chosen p99 so a change of
// measurement in the drill-down visibly changes the number.
const timings = (p99: number): Timings => ({
  min: p99 * 0.4,
  avg: p99 * 0.5,
  max: p99 * 1.5,
  p75: p99 * 0.8,
  p99,
  p995: p99 * 1.05,
  p999: p99 * 1.2,
});

const bench = (
  origin: string,
  group: string | null,
  name: string,
  ok: Timings | undefined,
) => ({
  origin: `file:///w/${origin}`,
  group,
  name,
  results: [ok ? { ok } : {}],
});

const TEST_CPU = "AMD EPYC 7763 64-Core Processor";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = [1, 3, 5].map((offset) =>
      Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    ).map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );
    return 0.2126 * channels[0] + 0.7152 * channels[1] +
      0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

// The deno bench report. `noise` stands in for a benchmark's own console output
// landing on stdout ahead of the JSON.
const report = (benches: unknown[], noise = "", cpu = TEST_CPU) =>
  noise + JSON.stringify({ version: 1, runtime: "deno", cpu, benches });

// Most tile tests use one benchmark whose average per-op time is `avgNs`.
const totalZip = (avgNs: number): Promise<Uint8Array<ArrayBuffer>> =>
  benchZip(
    report([bench("packages/a/x.bench.ts", null, "b", { avg: avgNs } as Timings)]),
  );

// Drive collect() over a series of successful/failed runs, attaching a
// single-benchmark artifact of the given total to each run that has one. Runs are
// listed newest first to the stub, matching the GitHub API.
async function withTotals(
  entries: { id: number; at: number; total?: number; conclusion?: string }[],
  run: (calls: string[]) => Promise<void>,
): Promise<void> {
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (const entry of entries) {
    runs.push(ghRun(entry.id, entry.at, entry.conclusion ?? "success"));
    if (entry.total !== undefined) {
      artifacts[entry.id] = [{ id: entry.id * 10, name: "bench-results", expired: false }];
      zips[entry.id * 10] = await totalZip(entry.total);
    }
  }
  await withApi({
    pages: { 1: [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) },
    artifacts,
    zips,
  }, run);
}

//
// the tests
//

Deno.test("benchmark: no token -> gray, and nothing is fetched", async () => {
  await withApi({ throws: new Error("no request expected") }, async (calls) => {
    const v = await benchmark.collect(ctx({}));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "set GH_TOKEN");
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    assertEquals(v.hint, "metrics ↗");
    assertEquals(calls, []);
  });
});

Deno.test("dashboard and /bench benchmark refreshes keep separate request scopes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-scope-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const isolated = await import(
    `./benchmark.ts?scope=${crypto.randomUUID()}`
  );
  const originalFetch = globalThis.fetch;
  const token = `benchmark-scope-${crypto.randomUUID()}`;
  const calls: string[] = [];
  let workflowCalls = 0;
  let dashboardReleased = false;
  let requestsOverlapped = false;
  let releaseDashboard!: (response: Response) => void;
  let markDashboardStarted!: () => void;
  let releasePerformance!: (response: Response) => void;
  let markPerformanceStarted!: () => void;
  const dashboardResponse = new Promise<Response>((resolve) => {
    releaseDashboard = resolve;
  });
  const dashboardStarted = new Promise<void>((resolve) => {
    markDashboardStarted = resolve;
  });
  const performanceResponse = new Promise<Response>((resolve) => {
    releasePerformance = resolve;
  });
  const performanceStarted = new Promise<void>((resolve) => {
    markPerformanceStarted = resolve;
  });
  const handler = serve({ pages: {} });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      workflowCalls++;
      if (workflowCalls === 1) {
        markDashboardStarted();
        return dashboardResponse;
      }
      requestsOverlapped ||= !dashboardReleased;
      markPerformanceStarted();
      return performanceResponse;
    }
    return Promise.resolve(handler(url));
  }) as typeof fetch;

  let dashboardResult: Promise<TileView> | undefined;
  try {
    dashboardResult = isolated.benchmark.collect(ctx({ GH_TOKEN: token }));
    await dashboardStarted;

    const url = new URL("http://x/bench?view=runtime");
    const page = await isolated.benchmarkHistoryResponse(
      url,
      ctx({ GH_TOKEN: token }),
    );
    const html = await page.text();
    const progressMatch = html.match(/data-progress-url="([^"]+)"/);
    assert(progressMatch);
    const progressResponse = isolated.benchmarkHistoryProgressResponse(
      new URL(progressMatch[1], url),
    );
    const progressText = progressResponse.text();

    dashboardReleased = true;
    releaseDashboard(new Response("unavailable", { status: 503 }));
    await dashboardResult;
    await performanceStarted;
    releasePerformance(Response.json({ workflow_runs: [] }));
    const events = await progressText;
    assertStringIncludes(events, '"phase":"complete"');
    assertEquals(events.includes('"phase":"error"'), false);

    assertEquals(workflowCalls, 2);
    assertEquals(requestsOverlapped, false);
    assertEquals(calls.includes("/rate_limit"), true);
  } finally {
    dashboardReleased = true;
    releaseDashboard(new Response("unavailable", { status: 503 }));
    releasePerformance(Response.json({ workflow_runs: [] }));
    await dashboardResult?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: GITHUB_TOKEN stands in for GH_TOKEN", async () => {
  await withApi({ pages: {} }, async (calls) => {
    const v = await benchmark.collect(ctx({ GITHUB_TOKEN: "t" }));
    assertEquals(v.sub, "no benchmark runs"); // it got past the token gate and asked
    assertEquals(apiCalls(calls).length, 1);
    assertStringIncludes(apiCalls(calls)[0], runsPath);
    assertEquals(calls.includes("/rate_limit"), false);
  });
});

Deno.test("benchmark: a fresh disk cache prevents artifact rediscovery after a restart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-restart-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const token = `benchmark-restart-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({ workflow_runs: [] }));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  try {
    const first = await import(`./benchmark.ts?restart=${crypto.randomUUID()}`);
    await first.benchmark.collect(ctx({ GH_TOKEN: token }));
    assert(calls.some((call) => call.endsWith("/benchmarks.yml/runs")));

    calls.length = 0;
    const restarted = await import(
      `./benchmark.ts?restart=${crypto.randomUUID()}`
    );
    const restartedView = await restarted.benchmark.collect(ctx({
      GH_TOKEN: token,
    }));
    // The tile still reads the run list to time the latest run, but the fresh
    // manifest keeps it from rediscovering artifacts.
    assertEquals(calls, [`/repos/${REPO}/actions/workflows/benchmarks.yml/runs`]);
    assertEquals(restartedView.sub, "no benchmark runs");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("fresh runtime history serves the page and update check without discovery", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    throw new Error("fresh runtime history must not request GitHub");
  }) as typeof fetch;

  try {
    const store = new BenchmarkHistoryStore();
    await store.load();
    store.markRefreshed(Date.now(), [], "no-runs");
    await store.save();

    const isolated = await import(
      `./benchmark.ts?fresh-history=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: "fresh-history-token" });
    const page = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    assertStringIncludes(await page.text(), "Idle");

    const checkIsolated = await import(
      `./benchmark.ts?fresh-check=${crypto.randomUUID()}`
    );
    const check = await checkIsolated.benchmarkHistoryCheckResponse(
      tokenContext,
    );
    assertEquals(await check.json(), {
      version: checkIsolated.benchmarkSnapshotVersion(),
      progress: null,
      lastRequestError: null,
    });
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a startup collection waits for the run list, then times it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-startup-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const token = `benchmark-startup-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);

  let releaseDiscovery!: (response: Response) => void;
  const discovery = new Promise<Response>((resolve) => {
    releaseDiscovery = resolve;
  });
  const archive = await totalZip(5_000_000);
  const handler = serve({
    artifacts: {
      81_003: [{ id: 810_030, name: "bench-results", expired: false }],
      81_004: [{ id: 810_040, name: "bench-results", expired: false }],
    },
    zips: { 810_030: archive, 810_040: archive },
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return discovery;
    }
    return Promise.resolve(handler(url));
  }) as typeof fetch;

  let collection: Promise<TileView> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?startup=${crypto.randomUUID()}`
    );
    const active: Promise<TileView> = isolated.benchmark.collect(
      ctx({ GH_TOKEN: token }),
    );
    collection = active;
    let settled = false;
    const observed = active.then((view) => {
      settled = true;
      return view;
    });
    // The tile does not report until GitHub answers with the run list.
    await Promise.resolve();
    assertEquals(settled, false);

    releaseDiscovery(Response.json({
      workflow_runs: [
        ghRun(81_004, Date.now() - HOUR),
        ghRun(81_003, Date.now() - DAY),
      ],
    }));
    const view = await observed;
    assertStringIncludes(view.value ?? "", "new"); // two runs is under a week, so the trend reads "new"
    assertEquals(view.status, "good");
  } finally {
    releaseDiscovery(Response.json({ workflow_runs: [] }));
    await collection?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a future refresh marker cannot suppress discovery", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-future-" });
  const file = `${directory}/fabric-wall-benchmark-history.json`;
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const store = new BenchmarkHistoryStore(file);
  await store.load();
  store.markRefreshed(Date.now() + DAY, []);
  await store.save();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    return Promise.resolve(Response.json({ workflow_runs: [] }));
  }) as typeof fetch;

  try {
    const restarted = await import(
      `./benchmark.ts?future=${crypto.randomUUID()}`
    );
    await restarted.benchmark.collect(ctx({
      GH_TOKEN: `benchmark-future-${crypto.randomUUID()}`,
    }));
    assert(calls.some((call) => call.endsWith("/benchmarks.yml/runs")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench requires an explicit performance view", () => {
  const missing = new URL("http://x/bench?days=5");
  const res = benchmark.routes![0].handler(
    new Request(missing),
    missing,
  ) as Response;
  assertEquals(benchmark.routes![0].path, "/bench");
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("location"), null);

  const unknown = new URL("http://x/bench?view=summary");
  assertEquals(
    (benchmark.routes![0].handler(
      new Request(unknown),
      unknown,
    ) as Response).status,
    400,
  );
});

Deno.test("/bench?view=runtime serves the runtime history page", async () => {
  const url = new URL("http://x/bench?view=runtime");
  const res = await benchmark.routes![0].handler(new Request(url), url);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");

  const fragmentUrl = new URL(
    "http://x/bench?view=runtime&days=7&fragment=range",
  );
  const fragmentResponse = await benchmark.routes![0].handler(
    new Request(fragmentUrl),
    fragmentUrl,
  );
  const fragment = await fragmentResponse.text();
  assert(fragment.startsWith('<div id="range-content">'));
  assertStringIncludes(fragment, "selected 7-day window");
  assert(!fragment.includes("<!doctype html>"));
  assert(!fragment.includes('<form class="controls"'));
});

Deno.test("/bench CI progress route rejects an unknown collection", async () => {
  const route = benchmark.routes![2];
  const url = new URL("http://x/bench/ci-progress?id=missing");
  const response = await route.handler(new Request(url), url);
  assertEquals(route.path, "/bench/ci-progress");
  assertEquals(response.status, 404);
});

Deno.test("/bench update check returns an uncached runtime snapshot version", async () => {
  const route = benchmark.routes![1];
  const url = new URL("http://x/bench/check?view=runtime");
  const response = await route.handler(new Request(url), url);
  const state = await response.json();
  assertEquals(route.path, "/bench/check");
  assertEquals(typeof state.version, "string");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("/bench update check requires an explicit supported view", async () => {
  const route = benchmark.routes![1];
  for (const query of ["", "?view=summary", "?view=gantt"]) {
    const url = new URL(`http://x/bench/check${query}`);
    const response = await route.handler(new Request(url), url);
    assertEquals(response.status, 400);
  }
});

Deno.test("runtime history shows live artifact progress and keeps collection running", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-progress-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const isolated = await import(
    `./benchmark.ts?progress=${crypto.randomUUID()}`
  );
  const originalFetch = globalThis.fetch;
  let releaseArtifact = (_response: Response) => {};
  let artifactRequested = () => {};
  const sawArtifact = new Promise<void>((resolve) =>
    artifactRequested = resolve
  );
  const artifactResponse = new Promise<Response>((resolve) => {
    releaseArtifact = resolve;
  });
  const runId = 39_001;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({
        workflow_runs: [ghRun(runId, BASE)],
      }));
    }
    if (url.pathname.endsWith(`/actions/runs/${runId}/artifacts`)) {
      artifactRequested();
      return artifactResponse;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  const tokenContext = ctx({ GH_TOKEN: "progress-token" });
  try {
    await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime&days=7"),
      tokenContext,
    );
    await sawArtifact;

    const check = await isolated.benchmarkHistoryCheckResponse(tokenContext);
    const state = await check.json();
    assertEquals(state.progress.phase, "fetching");
    assertEquals(state.progress.requestsMade, 1);
    assertEquals(state.progress.responsesReceived, 0);
    assertEquals(state.progress.outstandingRequests, 1);

    const pageResponse = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime&days=7"),
      tokenContext,
    );
    const html = await pageResponse.text();
    assertStringIncludes(html, "0 of 1 artifact checks complete");
    assertStringIncludes(html, "1 artifact checks made · 0 responded");
    assertStringIncludes(html, "1 outstanding · 0 queued");
    assertStringIncludes(html, 'data-refresh-on-complete="1"');
    assertStringIncludes(
      html,
      `/bench/runtime-progress?id=${state.progress.id}`,
    );
    assert(!html.includes("reload in a moment"));
    assert(!html.includes('id="days" name="days" disabled'));
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

    const progressUrl = new URL(
      `http://x/bench/runtime-progress?id=${state.progress.id}`,
    );
    const progressResponse = isolated.benchmarkHistoryProgressResponse(
      progressUrl,
    );
    const reader = progressResponse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assertStringIncludes(first, '"outstandingRequests":1');

    releaseArtifact(Response.json({ artifacts: [] }));
    let completed = first;
    while (!completed.includes('"phase":"complete"')) {
      const next = await reader.read();
      if (next.done) break;
      completed += new TextDecoder().decode(next.value);
    }
    assertStringIncludes(completed, '"phase":"complete"');
    assertStringIncludes(completed, '"responsesReceived":1');
    assertStringIncludes(completed, '"outstandingRequests":0');
  } finally {
    releaseArtifact(Response.json({ artifacts: [] }));
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench before any data shows an idle progress panel", async () => {
  const isolated = await import(
    `./benchmark.ts?idle=${crypto.randomUUID()}`
  );
  const html = isolated.benchPage("p99", "file", 45, BASE, "labs");
  assertStringIncludes(html, '<section class="fetch-progress"');
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');
  assertStringIncludes(
    html,
    "No runtime benchmark samples were found in the history window.",
  );
  assert(!html.includes("reload in a moment"));
  assertStringIncludes(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  assertStringIncludes(html, "<title>Benchmarks — p99</title>"); // p99 is the default measurement
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI duration history</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
  assertStringIncludes(
    html,
    "charts reduce longer windows to about 200 evenly spaced points",
  );
  assertStringIncludes(html, PERFORMANCE_VIEW_STYLES);
  assert(
    !html.includes('class="brow'),
    "no rows are drawn with nothing to draw",
  );
});

Deno.test("/bench?view=ci serves CI job history through the same drill-down", async () => {
  const cacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set(
    "DASHBOARD_CACHE_DIR",
    `/tmp/ci-job-history-missing-${crypto.randomUUID()}`,
  );
  try {
    const url = new URL("http://x/bench?view=ci");
    const response = await benchmark.routes![0].handler(new Request(url), url);
    const html = await response.text();
    assertEquals(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assertStringIncludes(html, "<title>CI job history</title>");
    assertStringIncludes(html, "Set GH_TOKEN to collect CI job history.");
  } finally {
    if (cacheDirectory === undefined) Deno.env.delete("DASHBOARD_CACHE_DIR");
    else Deno.env.set("DASHBOARD_CACHE_DIR", cacheDirectory);
  }
});

Deno.test("benchmark: paging stops at the 45-day cutoff, and an out-of-window run is not sampled", async () => {
  // One full page whose oldest run is past the window: the loop stops there rather
  // than asking for page 2. The run that succeeded is out of the window.
  const page1 = [
    ...Array.from(
      { length: 99 },
      (_, i) => ghRun(1_000 + i, BASE - i * HOUR, "failure"),
    ),
    ghRun(1_099, BASE - 50 * DAY, "success"), // in date order last, and older than the cutoff
  ];
  await withApi({ pages: { 1: page1 } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    // The most recent run failed, and none of the sampled runs had an artifact.
    assertEquals(v.status, "bad");
    expect(v.value).toBe("failed");
    // Every failure on the page, in a row. The one success is older than the
    // trend's window, but it is still on the page fetched, so it still dates the
    // outage the failures make.
    assertMatch(v.sub ?? "", /^last good \d+ days ago · 99 runs failed$/);
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    assertEquals(v.hint, "metrics ↗");
    assertEquals(runListCalls(calls).length, 1); // page 2 was never asked for
    // A red run is read for its artifact like any other, because whether it
    // measured anything is the artifact's answer and not the conclusion's. The
    // run past the cutoff is not read at all.
    assertEquals(artifactCalls(calls).length, 99);
    assertEquals(
      artifactCalls(calls).filter((call) => call.includes("/1099/")),
      [],
    );
  });
});

Deno.test("benchmark: an empty page ends the paging", async () => {
  const page1 = Array.from(
    { length: 100 },
    (_, i) => ghRun(2_000 + i, BASE - i * HOUR, "failure"),
  );
  await withApi({ pages: { 1: page1, 2: [] } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.sub, "last 100 runs failed"); // every run in the window failed
    // A full page still inside the window is followed; the empty page 2 stops it.
    assertEquals(
      runListCalls(calls).map((c) => c.match(/[?&]page=(\d+)/)![1]),
      ["1", "2"],
    );
  });
});

Deno.test("benchmark: the tile turns orange when the benchmark index trends up", async () => {
  // Eight successful days whose one benchmark climbs from 5 to 12 ms.
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  await withTotals(
    Array.from({ length: 8 }, (_, d) => ({ id: 9_100 + d, at: at(d), total: (5 + d) * 1e6 })),
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "warn"); // trending up, not a failure
      assertStringIncludes(v.value ?? "", "▲"); // the rising trend is the headline
      assertEquals(v.sub, undefined); // a mere rise is not a failure
      assertStringIncludes(v.extra ?? "", "1 benchmark"); // the count line
    },
  );
});

Deno.test("benchmark: a falling benchmark index stays green", async () => {
  // Eight successful days whose one benchmark drops from 12 to 5 ms.
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  await withTotals(
    Array.from({ length: 8 }, (_, d) => ({ id: 9_600 + d, at: at(d), total: (12 - d) * 1e6 })),
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "good"); // falling is fine
      assertStringIncludes(v.value ?? "", "▼"); // the falling trend is the headline
    },
  );
});

Deno.test("benchmark: a big regression in one benchmark of many barely moves the index", async () => {
  // Eight days, forty benchmarks. One quintuples over the window; the other 39 are
  // flat. Each weighs the same in log space, so 5x in one of 40 is only 5^(1/40) ≈
  // 4% on the index — under the orange threshold, so the tile stays green. (With the
  // real ~369 benchmarks the dilution is far stronger.) The sum-based tile would
  // have flagged this; the point is that it should not.
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 7; d++) {
    const id = 9_900 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const benches = [
      bench("packages/a/x.bench.ts", null, "hot", {
        avg: 1e6 * Math.pow(5, d / 7),
      } as Timings),
      ...Array.from({ length: 39 }, (_, i) =>
        bench("packages/a/x.bench.ts", null, "flat" + i, { avg: 1e6 } as Timings)),
    ];
    zips[id * 10] = await benchZip(report(benches));
  }
  await withApi({ pages: { 1: [...runs].reverse() }, artifacts, zips }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good"); // one benchmark's 5x is diluted below the threshold
    assertStringIncludes(v.value ?? "", "▲"); // it did rise, just not enough for orange
    assertStringIncludes(v.extra ?? "", "40 benchmarks"); // the count line
  });
});

Deno.test("benchmark: the trend reads the recent window only, not the whole history", async () => {
  // Forty daily runs, one benchmark. It doubled over the first twenty days, then
  // held flat for the last twenty. The whole history rose, but the tile trends only
  // the recent window (the last 20 runs here), which is flat, so it stays green —
  // while the sparkline still spans the full history.
  const at = (d: number) => SAMPLED_BASE - (39 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 39; d++) {
    const id = 9_950 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const avg = d < 20 ? 1e6 * Math.pow(2, d / 19) : 2e6;
    zips[id * 10] = await benchZip(
      report([bench("packages/a/x.bench.ts", null, "b", { avg } as Timings)]),
    );
  }
  await withApi({ pages: { 1: [...runs].reverse() }, artifacts, zips }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good"); // the recent window is flat, though history rose
    assertStringIncludes(v.value ?? "", "flat"); // the window trend
    assertEquals(v.duration, 39 * DAY); // the sparkline still spans the full history
    // The count line names the highlighted window's span: the newest 20 daily runs
    // (the run floor beats the 14-day age here) reach back 19 days.
    assertStringIncludes(
      v.extra ?? "",
      ">1 benchmark · last 19 days</div>",
    );
  });
});

// Ten daily runs of one product benchmark and one calibration benchmark. The
// last five carry `productFactor` on the product benchmark and `machineFactor`
// on the calibration one, which is how a change in the repository and a change
// in the host each look in an artifact.
async function withCalibratedRuns(
  idBase: number,
  productFactor: number,
  machineFactor: number,
  run: () => Promise<void>,
): Promise<void> {
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let day = 0; day < 10; day++) {
    const id = idBase + day;
    const shifted = day >= 5;
    runs.push(ghRun(id, SAMPLED_BASE - (9 - day) * DAY));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(report([
      bench("packages/a/x.bench.ts", null, "work", {
        avg: 5e6 * (shifted ? productFactor : 1),
      } as Timings),
      bench(CALIBRATION_FILE, null, "integer arithmetic", {
        avg: 1e6 * (shifted ? machineFactor : 1),
      } as Timings),
    ]));
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    run,
  );
}

Deno.test("benchmark: a run on a slower host reads as the host, not as a rise", async () => {
  // Everything the run measured is a quarter slower, the calibration included.
  // No commit slows arithmetic that calls nothing; the host does. Dividing the
  // calibration out of each step leaves the index where it was.
  await withCalibratedRuns(11_100, 1.25, 1.25, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good");
    assertStringIncludes(v.value ?? "", "flat");
  });
});

Deno.test("benchmark: a rise the machine did not cause reads at its full size", async () => {
  // The same quarter, this time on the product benchmarks alone while the
  // calibration holds. That is the repository getting slower, and the index
  // says so.
  await withCalibratedRuns(11_200, 1.25, 1, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "warn");
    assertStringIncludes(v.value ?? "", "▲25%");
  });
});

Deno.test("benchmark: a machine that sped up leaves the repository where it was", async () => {
  // The host got a fifth faster and took the product benchmarks with it. The
  // calibration moved by the same fifth, so the index does not read a win the
  // repository did not earn.
  await withCalibratedRuns(11_300, 0.8, 0.8, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good");
    assertStringIncludes(v.value ?? "", "flat");
  });
});

Deno.test("benchmark: the calibration is the ruler, not one of the benchmarks", async () => {
  // Three product benchmarks and two calibration ones. The count line and the
  // drill-down's rows both read the three.
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let day = 0; day < 8; day++) {
    const id = 11_400 + day;
    runs.push(ghRun(id, SAMPLED_BASE - (7 - day) * DAY));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(report([
      ...Array.from({ length: 3 }, (_, i) =>
        bench("packages/a/x.bench.ts", null, `work ${i}`, {
          avg: 5e6,
        } as Timings)),
      ...Array.from({ length: 2 }, (_, i) =>
        bench(CALIBRATION_FILE, null, `calibration ${i}`, {
          avg: 1e6,
        } as Timings)),
    ]));
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertStringIncludes(v.extra ?? "", ">3 benchmarks");
      const html = benchPage("p99", "file", 45, SAMPLED_BASE);
      assertEquals(
        rows(html).map((row) => row.name),
        ["work 0", "work 1", "work 2"],
      );
      assert(!html.includes("calibration 0"));
    },
  );
});

Deno.test("benchmark: runs from before the calibration read uncorrected", async () => {
  // The calibration lands at the sixth run, and the host slows by a fifth at
  // the eighth. Two things move the product benchmark: a real quarter at the
  // sixth run, which no calibration is there to judge, and the host's fifth at
  // the eighth, which one is. So the boundary step passes through at its face
  // value and the later step is corrected away, leaving the quarter. Reading
  // both uncorrected would say a half instead.
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let day = 0; day < 10; day++) {
    const id = 11_500 + day;
    runs.push(ghRun(id, SAMPLED_BASE - (9 - day) * DAY));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const host = day >= 7 ? 1.2 : 1;
    const benches = [
      bench("packages/a/x.bench.ts", null, "work", {
        avg: 5e6 * (day >= 5 ? 1.25 : 1) * host,
      } as Timings),
    ];
    if (day >= 5) {
      benches.push(
        bench(CALIBRATION_FILE, null, "integer arithmetic", {
          avg: 1e6 * host,
        } as Timings),
      );
    }
    zips[id * 10] = await benchZip(report(benches));
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "warn");
      assertStringIncludes(v.value ?? "", "▲25%");
      assertStringIncludes(v.extra ?? "", ">1 benchmark");
    },
  );
});

Deno.test("benchmark: runs inside one trend bucket are one sample, newest kept", () => {
  const run = (at: number) => ({ at });
  const base = Math.floor(SAMPLED_BASE / BENCH_TREND_BUCKET_MS) *
    BENCH_TREND_BUCKET_MS;
  assertEquals(
    benchmarkTrendRuns([
      run(base + BENCH_TREND_BUCKET_MS + 60_000),
      run(base + 30 * 60_000),
      run(base + 60_000),
      run(base + BENCH_TREND_BUCKET_MS),
    ]),
    [run(base + 30 * 60_000), run(base + BENCH_TREND_BUCKET_MS + 60_000)],
  );
  // A run alone in its bucket is kept whole, and the order out is ascending.
  assertEquals(
    benchmarkTrendRuns([run(base + 2 * BENCH_TREND_BUCKET_MS), run(base)]),
    [run(base), run(base + 2 * BENCH_TREND_BUCKET_MS)],
  );
});

Deno.test("benchmark: the headline considers CPUs measured in the last 12 hours", () => {
  const now = Date.UTC(2026, 7, 17, 12);
  const hours = (count: number) => count * HOUR;
  const stale = { name: "stale", points: [{ at: now - hours(12) - 1 }] };
  const boundary = { name: "boundary", points: [{ at: now - hours(12) }] };
  const recent = {
    name: "recent",
    points: [{ at: now - hours(20) }, { at: now - hours(1) }],
  };
  const future = { name: "future", points: [{ at: now + 1 }] };

  assertEquals(
    benchmarkHeadlineCandidates([stale, boundary, recent, future], now),
    [boundary, recent],
  );
});

Deno.test("benchmark: the tile reports when every CPU measurement is stale", async () => {
  const measurements = Array.from({ length: 8 }, (_, day) => ({
    id: 95_000 + day,
    at: BASE - (8 - day) * DAY,
    total: (5 + day) * 1e6,
  }));
  await withTotals(
    measurements,
    async () => {
      const tile = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(tile.status, "unknown");
      assertEquals(tile.value, "—");
      assertEquals(tile.sub, "no recent benchmark data");
    },
  );
  await withTotals([
    ...measurements,
    { id: 95_008, at: BASE, conclusion: "failure" },
  ], async () => {
    const tile = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    expect(tile.status).toBe("bad");
    expect(tile.value?.replace(/<[^>]*>/g, "")).toMatch(
      /^failed \(was ▲[\d.]+[%×]\)$/,
    );
    expect(tile.href).toBe("/bench?view=runtime&repo=labs");
    expect(tile.extra).toContain("<svg");
  });
});

Deno.test("benchmark: a stale failure keeps the latest measured CPU's trend", async () => {
  const measurements = [
    ...Array.from({ length: 8 }, (_, day) => ({
      cpu: "retired CPU",
      at: BASE - (30 - day) * DAY,
      avg: (5 + day) * 1e6,
    })),
    ...Array.from({ length: 8 }, (_, day) => ({
      cpu: TEST_CPU,
      at: BASE - (7 - day) * DAY,
      avg: 5e6,
    })),
  ];
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (const [index, measurement] of measurements.entries()) {
    const id = 96_000 + index;
    runs.push(ghRun(id, measurement.at));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(report([
      bench("packages/a/x.bench.ts", null, "work", { avg: measurement.avg }),
    ], "", measurement.cpu));
  }
  const pages = { 1: runs.toReversed() };
  const originalNow = Date.now;
  try {
    Date.now = () => BASE + 2 * HOUR;
    await withApi({ pages, artifacts, zips }, async () => {
      const before = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(before.status).toBe("good");
      expect(before.value).toBe("flat");

      Date.now = () => BASE + 14 * HOUR;
      pages[1].unshift(ghRun(96_099, BASE + 13 * HOUR, "failure"));
      const after = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(after.status).toBe("bad");
      expect(after.value?.replace(/<[^>]*>/g, "")).toBe("failed (was flat)");
    });
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("benchmark: a red run's measurements still reach the trend", async () => {
  // Eight daily runs whose one benchmark climbs. Three of them are red, because
  // `deno bench` exits non-zero when any single benchmark throws — having
  // already written a complete report of every other one. Dropping those three
  // would leave five distinct days, under the week a trend needs, and the tile
  // would read "new" while the climb went unreported.
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let day = 0; day < 8; day++) {
    const id = 11_600 + day;
    // The newest run is green, so the tile is judging a trend and not an outage.
    const red = day === 2 || day === 4 || day === 6;
    runs.push(ghRun(id, SAMPLED_BASE - (7 - day) * DAY, red ? "failure" : "success"));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(
      report([
        bench("packages/a/x.bench.ts", null, "work", {
          avg: (5 + day) * 1e6,
        } as Timings),
      ]),
    );
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    async (calls) => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "warn"); // a trend, not "new" and not an outage
      assertStringIncludes(v.value ?? "", "▲");
      // Every run was read for its artifact, the three red ones included.
      assertEquals(
        artifactCalls(calls).filter((call) => call.includes("/artifacts?"))
          .length,
        8,
      );
    },
  );
});

Deno.test("benchmark: a regression above the floor moves the trend", async () => {
  // Twenty-four daily runs of one benchmark whose fastest sample never moves
  // while its 75th percentile steps up by 45% halfway through: the shape of a
  // change that leaves the best case alone and makes some fraction of the runs
  // slower, such as a path that starts missing a cache. The trend reads the
  // rise. Comparing fastest samples would read it as flat, because the floor is
  // exactly where it was.
  const at = (d: number) => SAMPLED_BASE - (23 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 23; d++) {
    const id = 9_040 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const slow = d >= 12;
    zips[id * 10] = await benchZip(
      report([
        bench("packages/a/x.bench.ts", null, "b", {
          min: 1e6,
          avg: slow ? 1.3e6 : 1.05e6,
          max: slow ? 2.2e6 : 1.3e6,
          p75: slow ? 1.6e6 : 1.1e6,
          p99: slow ? 2e6 : 1.2e6,
          p995: slow ? 2.1e6 : 1.25e6,
          p999: slow ? 2.15e6 : 1.28e6,
        } as Timings),
      ]),
    );
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "warn");
      assertStringIncludes(v.value ?? "", "▲45%"); // the whole of the p75 step
    },
  );
});

Deno.test("benchmark: a stalled sample does not move the trend", async () => {
  // Twenty-four daily runs of one benchmark whose 75th percentile never moves,
  // so nothing about the code being measured changed over the window. From the
  // halfway point each run also carries one stalled sample, which shows up as a
  // far larger maximum and drags the reported average up by 40% — the shape a
  // stalled runner leaves in an artifact. A handful of stalled samples cannot
  // reach the 75th percentile, so the trend reads flat. Comparing averages
  // would read a 40% step that no commit caused.
  const at = (d: number) => SAMPLED_BASE - (23 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 23; d++) {
    const id = 9_000 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const stalled = d >= 12;
    zips[id * 10] = await benchZip(
      report([
        bench("packages/a/x.bench.ts", null, "b", {
          min: 1e6,
          avg: stalled ? 1.4e6 : 1e6,
          max: stalled ? 40e6 : 1.2e6,
          p75: 1.1e6,
          p99: 1.15e6,
          p995: 1.18e6,
          p999: 1.19e6,
        } as Timings),
      ]),
    );
  }
  await withApi(
    { pages: { 1: [...runs].reverse() }, artifacts, zips },
    async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(v.status, "good");
      assertStringIncludes(v.value ?? "", "flat");
    },
  );
});

Deno.test("benchmark: a run still in flight is not sampled", async () => {
  // A conclusion of null is not a color, it is an absence: the run has not
  // finished and has no artifact to read. Only completed runs are sampled.
  const id = 11_700;
  const inFlight = {
    ...ghRun(11_701, SAMPLED_BASE + HOUR),
    status: "in_progress",
    conclusion: null,
  };
  await withApi({
    pages: { 1: [inFlight, ghRun(id, SAMPLED_BASE)] },
    artifacts: {
      [id]: [{ id: id * 10, name: "bench-results", expired: false }],
    },
    zips: {
      [id * 10]: await benchZip(
        report([
          bench("packages/a/x.bench.ts", null, "work", { avg: 5e6 } as Timings),
        ]),
      ),
    },
  }, async (calls) => {
    await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(
      artifactCalls(calls).filter((call) => call.includes("/11701/")),
      [],
    );
  });
});

Deno.test("benchmark: returns a failed view after the run list settles", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "benchmark-settled-view-",
  });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const token = `benchmark-settled-view-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const key = "packages/a/x.bench.ts > b";
  const seed = new BenchmarkHistoryStore();
  await seed.load();
  const cachedRuns = Array.from({ length: 8 }, (_, day) => {
    const avg = (5 + day) * 1e6;
    return {
      runId: 84_001 + day,
      runAttempt: 1,
      at: SAMPLED_BASE - (7 - day) * DAY,
      cpu: TEST_CPU,
      metrics: new Map([[key, {
        min: avg,
        avg,
        max: avg,
        p75: avg,
        p99: avg,
        p995: avg,
        p999: avg,
      }]]),
    };
  });
  for (const cachedRun of cachedRuns) seed.set(cachedRun);
  seed.markRefreshed(Date.now(), cachedRuns);
  await seed.save();

  const failedRun = ghRun(84_099, SAMPLED_BASE + HOUR, "failure");
  let releaseRuns!: (response: Response) => void;
  const heldRuns = new Promise<Response>((resolve) => {
    releaseRuns = resolve;
  });
  let markRunsRequested!: () => void;
  const runsRequested = new Promise<void>((resolve) => {
    markRunsRequested = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      markRunsRequested();
      return heldRuns;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  let collection: Promise<TileView> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?settled-view=${crypto.randomUUID()}`
    );
    expect(isolated.benchmark.showOnlyCompletedViews).toBe(true);
    const active: Promise<TileView> = isolated.benchmark.collect(
      ctx({ GH_TOKEN: token }),
    );
    collection = active;
    await runsRequested;

    releaseRuns(Response.json({
      workflow_runs: [
        failedRun,
        ...cachedRuns.toReversed().map((run) => ghRun(run.runId, run.at)),
      ],
    }));
    const final = await active;
    expect(final.status).toBe("bad");
    expect(final.value?.replace(/<[^>]*>/g, "")).toMatch(
      /^failed \(was ▲[\d.]+[%×]\)$/,
    );
  } finally {
    releaseRuns(Response.json({ workflow_runs: [] }));
    await collection?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: shows the failure and cached trend when the most recent completed run failed", async () => {
  const at = (d: number) => SAMPLED_BASE - (6 - d) * DAY;
  // Seven daily measurements, then a failed run with no artifact.
  await withTotals([
    ...Array.from({ length: 7 }, (_, d) => ({ id: 9_200 + d, at: at(d), total: d === 6 ? 7e6 : 5e6 })),
    { id: 9_299, at: SAMPLED_BASE + HOUR, conclusion: "failure" },
  ], async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "bad"); // the newest run failed
    assertMatch(v.sub ?? "", /^last good .+ ago · 1 run failed$/);
    expect(v.value?.replace(/<[^>]*>/g, "")).toBe("failed (was flat)");
    expect(v.valueLabel).toBe("failed (was flat)");
    expect(v.href).toBe("/bench?view=runtime&repo=labs");
    assert(!(v.extra ?? "").includes("benchmark")); // the failure took the count line
  });
});

Deno.test("benchmark: consecutive failures are counted on the tile", async () => {
  const at = (d: number) => SAMPLED_BASE - (6 - d) * DAY;
  // Seven good days, then three failures in a row.
  await withTotals([
    ...Array.from({ length: 7 }, (_, d) => ({ id: 9_310 + d, at: at(d), total: 5e6 })),
    ...Array.from({ length: 3 }, (_, f) => ({
      id: 9_390 + f,
      at: SAMPLED_BASE + (f + 1) * HOUR,
      conclusion: "failure",
    })),
  ], async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "bad"); // red however flat the trend is
    assertMatch(v.sub ?? "", /^last good .+ ago · 3 runs failed$/);
    expect(v.value?.replace(/<[^>]*>/g, "")).toBe("failed (was flat)");
    assert(!(v.extra ?? "").includes("benchmark")); // no count line beside the failure line
  });
});

Deno.test("benchmark: a failure outranks a rising trend", async () => {
  // Eight days whose one benchmark climbs from 5 to 12 ms, which alone reads orange,
  // and then a failed run.
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  await withTotals([
    ...Array.from({ length: 8 }, (_, d) => ({ id: 9_330 + d, at: at(d), total: (5 + d) * 1e6 })),
    { id: 9_398, at: SAMPLED_BASE + HOUR, conclusion: "failure" },
  ], async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "bad"); // red, not the orange the rise would give
    assertMatch(v.sub ?? "", /^last good .+ ago · 1 run failed$/);
    expect(v.value?.replace(/<[^>]*>/g, "")).toMatch(
      /^failed \(was ▲[\d.]+[%×]\)$/,
    );
  });
});

Deno.test("benchmark: a cancelled run ends the count of consecutive failures", async () => {
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  // Two failures with a cancelled run between them: only the newest failure can be
  // counted, because the cancelled run neither failed nor succeeded.
  await withTotals([
    ...Array.from({ length: 7 }, (_, d) => ({ id: 9_320 + d, at: at(d), total: 5e6 })),
    { id: 9_395, at: SAMPLED_BASE + HOUR, conclusion: "failure" },
    { id: 9_396, at: SAMPLED_BASE + 2 * HOUR, conclusion: "cancelled" },
    { id: 9_397, at: SAMPLED_BASE + 3 * HOUR, conclusion: "failure" },
  ], async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "bad");
    assertMatch(v.sub ?? "", /^last good .+ ago · 1 run failed$/);
  });
});

Deno.test("benchmark: the failure line dates the outage and counts the failures", () => {
  const now = BASE + 3 * DAY;
  const good = ghRun(1, BASE, "success");
  const failures = [ghRun(3, BASE + 2 * DAY, "failure"), ghRun(2, BASE + DAY, "failure")];
  assertEquals(
    benchmarkFailureLabel([...failures, good], now),
    "last good 3 days ago · 2 runs failed",
  );
  assertEquals(
    benchmarkFailureLabel([ghRun(4, now - HOUR, "failure"), ghRun(5, now - 4 * HOUR, "success")], now),
    "last good 4 hours ago · 1 run failed",
  );
  // Nothing has passed in the window, so there is no outage to date.
  assertEquals(benchmarkFailureLabel(failures, now), "last 2 runs failed");
  assertEquals(benchmarkFailureLabel([failures[0]], now), "last run failed");
  // A cancelled run ends the count but is not a good run to date the outage from.
  assertEquals(
    benchmarkFailureLabel([failures[0], ghRun(6, BASE + DAY, "cancelled"), good], now),
    "last good 3 days ago · 1 run failed",
  );
  // A run that passed on a later attempt is still a run that passed.
  assertEquals(
    benchmarkFailureLabel([failures[0], ghRun(7, BASE + DAY, "success", 2)], now),
    "last good 2 days ago · 1 run failed",
  );
});

Deno.test("benchmark: a collection reads the run list every time and the artifacts only when a run is new", async () => {
  // The tile collects every minute to keep up with the run state. The artifact
  // history behind it moves with the runs, so a collection that finds the same
  // sampled runs downloads nothing.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cadence-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 7; d++) {
    const id = 9_280 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await totalZip(5e6);
  }
  const newestFirst = [...runs].reverse();
  const inFlight = {
    ...ghRun(9_289, SAMPLED_BASE + HOUR),
    status: "queued",
    conclusion: null,
  };
  try {
    const isolated = await import(`./benchmark.ts?cadence=${crypto.randomUUID()}`);
    await withApi({ pages: { 1: newestFirst }, artifacts, zips }, async (calls) => {
      await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      const firstArtifactReads = artifactCalls(calls).length;
      const firstListReads = apiCalls(calls).length - firstArtifactReads;
      assert(firstArtifactReads > 0); // a cold cache reads them
      assert(firstListReads > 0);

      const second = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(artifactCalls(calls).length, firstArtifactReads); // nothing new to read
      assert(apiCalls(calls).length - artifactCalls(calls).length > firstListReads);
      assertEquals(second.aside, undefined); // no run under way
      assertEquals(second.status, "good");
    });
    // A run starts. The next collection sees it from the run list alone.
    await withApi({ pages: { 1: [inFlight, ...newestFirst] }, artifacts, zips }, async (calls) => {
      const view = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertStringIncludes(view.aside ?? "", "running");
      assertEquals(artifactCalls(calls), []); // an unfinished run has no artifact
    });
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a run under way shows on the tile before there is any history", async () => {
  // Nothing has been collected yet, so the tile has no chart and no verdict. The
  // run list still says a run is going, and that is worth showing.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cold-badge-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  try {
    const isolated = await import(`./benchmark.ts?cold-badge=${crypto.randomUUID()}`);
    const inFlight = {
      ...ghRun(9_270, BASE),
      status: "in_progress",
      conclusion: null,
    };
    await withApi({ pages: { 1: [inFlight] } }, async () => {
      const view = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(view.value, "—"); // no history to headline
      assertEquals(view.sub, "benchmark data unavailable");
      assertStringIncludes(view.aside ?? "", "running");
    });
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: the rerun hand-off picks its target from the newest completed run", () => {
  const workflow = `https://github.com/${REPO}/actions/workflows/benchmarks.yml`;
  const failed = ghRun(3, BASE, "failure");
  const inFlight = { ...ghRun(4, BASE + HOUR), status: "in_progress", conclusion: null };
  assertEquals(benchmarkRerunHandoff(undefined).href, workflow); // no run list yet
  assertEquals(benchmarkRerunHandoff([]).href, workflow);
  assertEquals(benchmarkRerunHandoff([ghRun(1, BASE)]).href, workflow);
  assertEquals(benchmarkRerunHandoff([ghRun(2, BASE, "cancelled")]).href, workflow);
  assertEquals(benchmarkRerunHandoff([ghRun(5, BASE, "success", 2)]).href, workflow);
  const handoff = benchmarkRerunHandoff([failed]);
  assertEquals(handoff.href, `https://github.com/${REPO}/actions/runs/3`);
  assertStringIncludes(handoff.label, "rerun the failed benchmark run");
  // A run under way at the head does not hide the failure it sits above.
  assertEquals(
    benchmarkRerunHandoff([inFlight, failed]).href,
    `https://github.com/${REPO}/actions/runs/3`,
  );
});

Deno.test("benchmark: the drill-down closes with a rerun hand-off to the failed run", async () => {
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  await withTotals([
    ...Array.from({ length: 7 }, (_, d) => ({ id: 9_240 + d, at: at(d), total: 5e6 })),
    { id: 9_249, at: SAMPLED_BASE + HOUR, conclusion: "failure" },
  ], async () => {
    await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    const html = benchPage("p99", "file", 45, BASE);
    assertStringIncludes(html, `https://github.com/${REPO}/actions/runs/9249`);
    assertStringIncludes(html, "rerun the failed benchmark run ↗");
    assertStringIncludes(html, "does not start runs itself");
    // The hand-off closes the page, below the charts and the source note.
    assert(html.indexOf('<p class="handoff">') > html.indexOf('<p class="note">'));
    assert(html.indexOf('<p class="handoff">') > html.indexOf('class="blist"'));
    // A later collection that cannot reach GitHub leaves the hand-off naming the
    // run it knows failed, rather than dropping back to the workflow.
    await withApi({ status: 500 }, async () => {
      await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    });
    assertStringIncludes(
      benchPage("p99", "file", 45, BASE),
      `https://github.com/${REPO}/actions/runs/9249`,
    );
  });
});

Deno.test("benchmark: a run under way is a badge, not a verdict", async () => {
  const at = (d: number) => SAMPLED_BASE - (7 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 7; d++) {
    const id = 9_260 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await totalZip(5e6);
  }
  const newestFirst = [...runs].reverse();
  const inFlight = {
    ...ghRun(9_269, SAMPLED_BASE + HOUR),
    status: "in_progress",
    conclusion: null,
  };
  await withApi({ pages: { 1: [inFlight, ...newestFirst] }, artifacts, zips }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertStringIncludes(v.aside ?? "", "running");
    assertEquals(v.status, "good"); // the runs that finished still set the color
  });
  await withApi({ pages: { 1: newestFirst }, artifacts, zips }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.aside, undefined); // nothing under way
  });
});

Deno.test("benchmark: a cancelled most-recent run is not a failure", async () => {
  const at = (d: number) => SAMPLED_BASE - (6 - d) * DAY;
  await withTotals([
    ...Array.from({ length: 7 }, (_, d) => ({ id: 9_400 + d, at: at(d), total: d === 6 ? 7e6 : 5e6 })),
    { id: 9_499, at: SAMPLED_BASE + HOUR, conclusion: "cancelled" },
  ], async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good"); // a cancelled run is not a red failure
    assertStringIncludes(v.value ?? "", "flat"); // the trend over the successful runs
  });
});

Deno.test("benchmark: adding a benchmark is not read as a rise", async () => {
  // Two weeks of daily runs, all benchmarks flat. A second benchmark is added on
  // day 7. It is in only one run of each adjacent pair at that step, so it drops out
  // of the ratio and the index does not step — no reset needed, the tile stays flat.
  const at = (d: number) => SAMPLED_BASE - (13 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 13; d++) {
    const id = 9_700 + d;
    const added = d >= 7;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const benches = [
      bench("packages/a/x.bench.ts", null, "one", timings(1_000)), // avg 500
      ...(added
        ? [bench("packages/a/x.bench.ts", null, "two", timings(2_000))] // avg 1000
        : []),
    ];
    zips[id * 10] = await benchZip(report(benches));
  }
  await withApi({
    pages: { 1: [...runs].reverse() },
    artifacts,
    zips,
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good"); // adding a benchmark is not a regression
    assertStringIncludes(v.value ?? "", "flat"); // the headline trend, unmoved by the added benchmark
    assertEquals(v.duration, 13 * DAY); // the whole span, no reset
    assertStringIncludes(v.extra ?? "", "2 benchmarks"); // the count line
  });
});

Deno.test("benchmark: a run that finished green but produced no valid data reads red", async () => {
  // Seven good days, then a run that passes CI but whose artifact carries no
  // usable measurement.
  const at = (d: number) => d === 7
    ? SAMPLED_BASE + HOUR
    : SAMPLED_BASE - (6 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 7; d++) {
    const id = 9_800 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const benches = d === 7
      ? [bench("packages/a/x.bench.ts", null, "gone", undefined)] // no ok block
      : [bench("packages/a/x.bench.ts", null, "b", { avg: 5e6 } as Timings)];
    zips[id * 10] = await benchZip(report(benches));
  }
  await withApi({
    pages: { 1: [...runs].reverse() },
    artifacts,
    zips,
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "bad"); // it ran but made nothing usable
    assertEquals(v.sub, "no benchmark data");
    expect(v.value?.replace(/<[^>]*>/g, "")).toBe("failed (was flat)");
  });
});

Deno.test("benchmark: unusable artifacts gray out cold, then a blipped read is retried and recovers", async () => {
  // Five successful runs in five different windows, each with an artifact unusable
  // a different way. On a cold cache the sum has nothing to read, so the tile grays
  // out rather than inventing a number. The split is whether the answer can change
  // on a later try. 401 (only an expired artifact and the wrong one), 403 (a zip
  // holding no report) and 405 (a report that will not parse) are settled: the
  // bytes were read and a run attempt keeps the artifact it uploaded. 402 (the zip
  // download failed) and 404 (the listing itself failed) reached no answer at all
  // and must be retried when the source recovers. An isolated cache keeps
  // the cold-start assertion honest — a shared cache would leak another test's runs.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-unusable-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const runs = [
    ghRun(401, BASE - 3 * DAY),
    ghRun(402, BASE - 2 * DAY),
    ghRun(403, BASE - 1 * DAY),
    ghRun(405, BASE - HOUR),
    ghRun(404, BASE),
  ];
  const art = (id: number, name = "bench-results", expired = false) => ({
    id,
    name,
    expired,
  });
  const calls: string[] = [];
  let handler = serve({
    pages: { 1: [...runs].reverse() }, // newest first, as the API returns
    artifacts: {
      401: [art(4_010, "bench-results", true), art(4_011, "coverage")], // expired, and the wrong artifact
      402: [art(4_020)], // the zip download fails
      403: [art(4_030)], // the zip holds no json
      405: [art(4_050)], // the zip holds a report that will not parse
      404: 500, // the listing itself fails
    },
    zips: {
      4_020: 404,
      4_030: makeZip([{
        name: "notes.txt",
        method: 0,
        data: bytes("nothing useful"),
      }]),
      4_050: await benchZip("this is not the report"),
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  try {
    const isolated = await import(`./benchmark.ts?unusable=${crypto.randomUUID()}`);
    const cold = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(cold.status, "unknown"); // no readable data, but not a failure
    assertEquals(cold.value, "—");
    assertEquals(cold.sub, "benchmark data unavailable");
    assertEquals(cold.href, "/bench?view=runtime&repo=labs");
    // The expired artifact and the coverage artifact are never downloaded.
    assert(!calls.some((c) => c.includes("/artifacts/4010/zip")));
    assert(!calls.some((c) => c.includes("/artifacts/4011/zip")));

    // The source recovers for the two that blipped.
    calls.length = 0;
    const json = report([
      bench("packages/a/x.bench.ts", null, "tick", timings(1_000)), // avg 500
    ]);
    handler = serve({
      pages: { 1: [...runs].reverse() }, // newest first, as the API returns
      artifacts: {
        402: [{ id: 4_020, name: "bench-results", expired: false }],
        404: [{ id: 4_040, name: "bench-results", expired: false }],
      },
      zips: { 4_020: await benchZip(json), 4_040: await benchZip(json) },
    });
    const warm = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertStringIncludes(warm.value ?? "", "new"); // two recovered runs is under a week
    assert(
      calls.some((c) => c.includes("/runs/402/artifacts")),
      "the failed zip download is retried",
    );
    assert(
      calls.some((c) => c.includes("/runs/404/artifacts")),
      "the failed listing is retried",
    );
    assert(
      !calls.some((c) => c.includes("/runs/401/artifacts")),
      "a run with no usable artifact is settled",
    );
    assert(
      !calls.some((c) => c.includes("/runs/403/artifacts")),
      "a zip with no report is settled",
    );
    assert(
      !calls.some((c) => c.includes("/runs/405/artifacts")),
      "a report that will not parse is settled",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a failed newer attempt stays stale and reports an error", async () => {
  const firstRun = ghRun(40_101, BASE - DAY);
  const secondRun = ghRun(40_102, BASE);
  const key = "packages/a/rerun.bench.ts";
  await withApi({
    pages: { 1: [firstRun, secondRun] },
    artifacts: {
      40_101: [{
        id: 401_010,
        name: "bench-results",
        expired: false,
      }],
      40_102: [{
        id: 401_020,
        name: "bench-results",
        expired: false,
      }],
    },
    zips: {
      401_010: await benchZip(
        report([bench(key, null, "work", timings(1_000))]),
      ),
      401_020: await benchZip(
        report([bench(key, null, "work", timings(2_000))]),
      ),
    },
  }, async () => {
    const view = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertStringIncludes(view.value ?? "", "new"); // two runs is under a week, so "new"
  });

  const originalFetch = globalThis.fetch;
  let releaseAttempt = (_response: Response) => {};
  let attemptRequested = () => {};
  const sawAttempt = new Promise<void>((resolve) => attemptRequested = resolve);
  const attemptResponse = new Promise<Response>((resolve) => {
    releaseAttempt = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({
        workflow_runs: [
          ghRun(firstRun.id, BASE - DAY, "success", 2),
          secondRun,
        ],
      }));
    }
    if (url.pathname.endsWith(`/actions/runs/${firstRun.id}/artifacts`)) {
      attemptRequested();
      return attemptResponse;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  try {
    const collection = benchmark.collect(ctx({ GH_TOKEN: "t" }));
    await sawAttempt;
    const check = await benchmarkHistoryCheckResponse(ctx({ GH_TOKEN: "t" }));
    const state = await check.json();
    const progress = benchmarkHistoryProgressResponse(
      new URL(`http://x/bench/runtime-progress?id=${state.progress.id}`),
    );
    const reader = progress.body!.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);

    releaseAttempt(new Response("unavailable", { status: 503 }));
    const view = await collection;
    assertStringIncludes(view.value ?? "", "new"); // the tile's trend; the drill-down errored
    while (!events.includes('"phase":"error"')) {
      const next = await reader.read();
      if (next.done) break;
      events += new TextDecoder().decode(next.value);
    }
    assertStringIncludes(events, '"phase":"error"');
    assertStringIncludes(events, '"failedResponses":1');
    // The newer attempt failed, so the drill-down keeps the prior good series
    // (latest 2µs) rather than blanking or corrupting it.
    assertStringIncludes(await page(""), "2.0µs");

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
        return Promise.resolve(Response.json({ workflow_runs: [] }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch;
    await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(
      benchmarkHistoryProgressResponse(
        new URL(`http://x/bench/runtime-progress?id=${state.progress.id}`),
      ).status,
      404,
    );
  } finally {
    releaseAttempt(new Response("unavailable", { status: 503 }));
    globalThis.fetch = originalFetch;
  }
});

Deno.test("benchmark: a collection keeps one artifact per bucket, and a later one reads it from the cache", async (t) => {
  // The second step reads the run results the first step fetched and cached, so
  // the two run in order within one test.

  const at = (d: number) => SAMPLED_BASE - (11 - d) * DAY;

  await t.step("the tile sums the totals, and one artifact per bucket is kept", async () => {
    // Twelve days, one run a day. Two runs share the last window; the older one is a
    // wildly slow benchmark, so the drill-down must keep the newer one — and the tile
    // must sum the winner's 500ns avg, not the displaced twin's ~5ms.
    const key = "packages/runner/solo.bench.ts";
    const runs: GhRun[] = [];
    const artifacts: Api["artifacts"] = {};
    const zips: Api["zips"] = {};
    for (let d = 0; d <= 11; d++) {
      const id = 501 + d;
      runs.push(ghRun(id, at(d)));
      artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
      // No "version" key here: the report is parsed whole when there is no console
      // output to skip past.
      zips[id * 10] = await benchZip(
        JSON.stringify({
          cpu: TEST_CPU,
          benches: [bench(key, null, "tick", timings(1_000))],
        }),
      );
    }
    // The stale twin, listed before its window's winner so the newer one displaces it.
    runs.push(ghRun(599, at(11) - COLLECTION_BUCKET / 2));
    artifacts[599] = [{ id: 5_990, name: "bench-results", expired: false }];
    zips[5_990] = await benchZip(
      JSON.stringify({
        cpu: TEST_CPU,
        benches: [bench(key, null, "tick", timings(9_999_999))],
      }),
    );

    await withApi({
      pages: {
        1: [ghRun(599, at(11) - COLLECTION_BUCKET / 2), ...runs.slice(0, 12)],
      },
      artifacts,
      zips,
    }, async () => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertStringIncludes(v.value ?? "", "flat"); // the headline trend, flat over the window
      assertEquals(v.status, "good");
      assertEquals(v.duration, 11 * DAY);
      assertEquals(v.sub, undefined);
      assertStringIncludes(v.extra ?? "", "<svg");
      assertStringIncludes(v.extra ?? "", "1 benchmark"); // the count line, one benchmark
      // The drill-down kept the newer run in the shared bucket: it reads the 1µs
      // winner's metric, not the displaced 10ms twin's.
      const tick = rows(await page("")).find((r) => r.name === "tick");
      assertStringIncludes(tick?.value ?? "", "1.0µs");
    });
  });

  await t.step("a run's results are immutable, so a cached run is not refetched", async () => {
    const runs = [
      ghRun(599, at(11) - COLLECTION_BUCKET / 2),
      ...Array.from({ length: 12 }, (_, d) => ghRun(501 + d, at(d))),
    ];
    // Every artifact call would 500; the cache the step before filled answers instead.
    await withApi({ pages: { 1: runs } }, async (calls) => {
      const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertStringIncludes(v.value ?? "", "flat"); // the cached runs' trend
      assertEquals(v.status, "good");
      assertEquals(artifactCalls(calls), []);
    });
  });
});

Deno.test("sampleBenchmarkRuns keeps the newest successful run in each bucket", () => {
  const at = (d: number) => SAMPLED_BASE - (11 - d) * DAY;
  const winner = ghRun(512, at(11));
  const staleTwin = ghRun(599, at(11) - COLLECTION_BUCKET / 2);
  const sampled = sampleBenchmarkRuns(
    [staleTwin, winner, ...Array.from({ length: 11 }, (_, d) => ghRun(501 + d, at(d)))],
    SAMPLED_BASE - 45 * DAY,
  );
  const lastBucket = sampled.filter((run) =>
    Math.floor(Date.parse(run.created_at) / COLLECTION_BUCKET) ===
      Math.floor(at(11) / COLLECTION_BUCKET)
  );
  assertEquals(lastBucket.map((run) => run.id), [512]); // the twin is displaced
});

// A geometric series over twelve days: the Theil–Sen slope is exact, so the
// series ends at exactly `fold` times where it started.
const SHAPES = [
  // origin, group, name, p99 on day 0, end/start ratio
  [
    "packages/runner/scheduler-persistent-state.bench.ts",
    null,
    "commit",
    1_000,
    1.12,
  ],
  [
    "packages/runner/scheduler-persistent-state.bench.ts",
    "hot",
    "steep",
    1_000_000,
    20,
  ],
  ["packages/memory/query.bench.ts", null, "fivefold", 10_000, 5],
  ["packages/memory/query.bench.ts", null, "quarter", 400_000_000, 0.25],
  ["packages/html/render.bench.ts", null, "easing", 1_000, 0.9],
] as const;

async function fillVaried(): Promise<Api> {
  const at = (d: number) => BASE - (11 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 11; d++) {
    const id = 601 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const benches = [
      ...SHAPES.map(([origin, group, name, start, fold]) =>
        bench(origin, group, name, timings(start * Math.pow(fold, d / 11)))
      ),
      // Only an average reported: every percentile falls back to it.
      bench("packages/html/render.bench.ts", null, "flat", { avg: 2_500_000 }),
      // Neither of these is a measurement, so neither reaches the page.
      bench("packages/x/skip.bench.ts", null, "no-ok", undefined),
      bench(
        "packages/x/skip.bench.ts",
        null,
        "not-a-number",
        { avg: "quick" } as unknown as Timings,
      ),
    ];
    // A benchmark's own console output precedes the report on stdout.
    zips[id * 10] = await benchZip(
      report(benches, "running 7 benchmarks\ncpu: apple m2\n"),
    );
  }
  return { pages: { 1: runs }, artifacts, zips };
}

// Collects the varied history, which leaves it as the drill-down's snapshot for
// the /bench page to render.
async function collectVaried(): Promise<void> {
  await withApi(await fillVaried(), async () => {
    await benchmark.collect(ctx({ GH_TOKEN: "t" }));
  });
}

// Pull the rendered rows out of the drill-down html.
function rows(html: string) {
  return [...html.matchAll(
    /<div class="brow (\w+)">[\s\S]*?<span class="bname">([^<]*)<\/span><span class="bval"[^>]*><a class="cpu-id" [^>]*>CPU \d+<\/a>([^<]*)<span class="btrend">([^<]*)<\/span>/g,
  )].map((m) => ({ status: m[1], name: m[2], value: m[3], trend: m[4] }));
}

const page = async (query: string): Promise<string> => {
  const suffix = query ? `&${query.replace(/^\?/, "")}` : "";
  const url = new URL(`http://x/bench?view=runtime${suffix}`);
  return await (await benchmark.routes![0].handler(new Request(url), url))
    .text();
};

Deno.test("benchmark: the tile indexes every benchmark equally; the drill-down keeps them apart", async () => {
  await withApi(await fillVaried(), async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    // The index rises: `steep` (×20) and `fivefold` (×5) outweigh `quarter` (×¼) in
    // log space, so the typical benchmark got ~1.7× slower even though the summed
    // time (which `quarter` dominated) fell.
    assertEquals(v.status, "warn");
    assertEquals(v.duration, 11 * DAY);
    assertStringIncludes(v.value ?? "", "▲"); // the rising trend is the headline
    assertStringIncludes(v.extra ?? "", "6 benchmarks"); // the count line
    assert(!v.extra?.includes('class="swatch"'));
    assert(!v.extra?.includes(TEST_CPU));
    // The per-benchmark history the drill-down reads is still assembled.
    assert(!v.extra?.includes("hot/steep"));
  });
});

Deno.test("benchmark: stale CPU trends stay out of the headline while their lines remain", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cpus-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const cpus = [
    "AMD EPYC 7763 64-Core Processor",
    "Apple M2 Processor",
    "ARM Neoverse V1 Processor",
    ...Array.from(
      { length: 13 },
      (_, index) => `A Test CPU ${String(index).padStart(2, "0")}`,
    ),
    // These hashes produce the same initial generated color.
    "CPU-03098",
    "CPU-06084",
  ].sort((a, b) => a.localeCompare(b));
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  const samples: {
    cpuIndex: number;
    at: number;
    avg?: number;
    day?: number;
  }[] = [];
  for (let day = 0; day < 8; day++) {
    samples.push({
      cpuIndex: 0,
      at: BASE - (8 - day) * DAY,
      day,
    });
    if (day === 0) {
      samples.push({
        cpuIndex: 0,
        at: BASE - 8 * DAY + COLLECTION_BUCKET,
        day,
      });
    }
    samples.push({
      cpuIndex: 1,
      at: BASE - (8 - day) * DAY + 2 * COLLECTION_BUCKET,
      avg: 1_000_000 * Math.pow(2, day / 7),
      day,
    });
  }
  for (let cpuIndex = 2; cpuIndex < 9; cpuIndex++) {
    const offset = (cpuIndex + 2) * COLLECTION_BUCKET;
    samples.push({
      cpuIndex,
      at: BASE - (cpuIndex === 2 ? 20 : 2) * DAY + offset,
    });
    samples.push({ cpuIndex, at: BASE - DAY + offset });
  }
  for (let cpuIndex = 9; cpuIndex < cpus.length; cpuIndex++) {
    samples.push({
      cpuIndex,
      at: BASE - (cpuIndex + 2) * COLLECTION_BUCKET,
    });
  }
  for (
    const [sample, { cpuIndex, at, avg: sampleAvg, day }] of samples.entries()
  ) {
    const id = 90_000 + sample;
    const cpu = cpus[cpuIndex];
    const avg = sampleAvg ?? (cpuIndex === 0 ? 1_000 : cpuIndex * 1_000_000);
    const benches = [
      bench("packages/a/cpu.bench.ts", null, "flat", { avg } as Timings),
    ];
    if (day !== undefined && cpuIndex < 2) {
      const representativeAvg = cpuIndex === 0
        ? 1_000 * Math.pow(1.5, day / 7)
        : 500_000;
      benches.push(
        bench(
          "packages/a/cpu.bench.ts",
          null,
          "representative",
          { avg: representativeAvg } as Timings,
        ),
      );
    }
    runs.push(ghRun(id, at));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(
      report(benches, "", cpu),
    );
  }
  runs.sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at)
  );
  try {
    await withApi({
      pages: { 1: runs },
      artifacts,
      zips,
    }, async () => {
      const isolated = await import(
        `./benchmark.ts?cpus=${crypto.randomUUID()}`
      );
      const tile = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      // The Apple line rises, but its last point is a day old. The recent
      // one-point CPU lines set the headline and verdict while every line stays
      // in the chart.
      assertEquals(tile.status, "good");
      assertStringIncludes(tile.value ?? "", "new");
      assertStringIncludes(tile.extra ?? "", ">1 benchmark</div>");
      assert(!/\bCPUs?\b/.test(tile.extra ?? ""));
      assert(!(tile.extra ?? "").includes('class="swatch"'));
      assert(!(tile.extra ?? "").includes("AMD EPYC 7763"));
      assert(!(tile.extra ?? "").includes("Apple M2"));
      assert(!(tile.extra ?? "").includes("ARM Neoverse V1"));
      const tileLines = [
        ...(tile.extra ?? "").matchAll(
          /<polyline points="([^"]+)"[^>]*stroke="([^"]+)"/g,
        ),
      ].map((match) => ({
        pointCount: match[1].split(" ").length,
        stroke: match[2],
      }));
      // Eight points on each of the two long lines. The first CPU has nine
      // runs, but two of them sit in one collection bucket, minutes apart, and
      // the trend reads one run per BENCH_TREND_BUCKET_MS. The drill-down below
      // still counts all nine.
      assertEquals(
        tileLines.map((line) => line.pointCount).sort((a, b) => a - b),
        [2, 2, 2, 2, 2, 2, 8, 8],
      );
      assertEquals(new Set(tileLines.map((line) => line.stroke)).size, 8);
      const tileMarkerColors = [
        ...(tile.extra ?? "").matchAll(/<circle[^>]*fill="([^"]+)"/g),
      ].map((match) => match[1]);
      assertEquals(tileMarkerColors.length, 11);
      assertEquals(new Set(tileMarkerColors).size, 10);
      assert(!(tile.extra ?? "").includes("<mask"));

      const html = isolated.benchPage("p99", "file", 45, BASE);
      assertEquals(rows(html), [
        {
          status: "good",
          name: "flat",
          value: "1.0µs",
          trend: "flat",
        },
        {
          status: "bad",
          name: "representative",
          value: "1.5µs",
          trend: "▲50%",
        },
      ]);
      assertEquals([...html.matchAll(/<div class="brow /g)].length, 2);
      const pageLines = [
        ...html.matchAll(
          /<polyline points="([^"]+)"[^>]*stroke="([^"]+)"/g,
        ),
      ].map((match) => ({
        pointCount: match[1].split(" ").length,
        stroke: match[2],
      }));
      assertEquals(
        pageLines.map((line) => line.pointCount).sort((a, b) => a - b),
        [2, 2, 2, 2, 2, 2, 8, 8, 8, 8],
      );
      assertEquals(new Set(pageLines.map((line) => line.stroke)).size, 8);
      const pageMarkerColors = [
        ...html.matchAll(/<circle[^>]*fill="([^"]+)"/g),
      ].map((match) => match[1]);
      assertEquals(pageMarkerColors.length, 11);
      assertEquals(new Set(pageMarkerColors).size, 10);
      assert(!html.includes("<mask"));
      assertEquals([...html.matchAll(/class="bcpu"/g)].length, 0);
      assertEquals([...html.matchAll(/class="cpu-key"/g)].length, 18);
      const legendColors = [
        ...html.matchAll(
          /class="cpu-key"[^>]*><span class="swatch" style="background:([^"]+)"/g,
        ),
      ].map((match) => match[1]);
      assertEquals(legendColors.length, 18);
      assertEquals(new Set(legendColors).size, 18);
      for (const color of legendColors) {
        const pair = color.match(
          /^light-dark\((#[0-9a-f]{6}),(#[0-9a-f]{6})\)$/i,
        );
        assert(pair, `${color} is not a light and dark chart color`);
        assert(
          contrastRatio(pair[1], "#f5f7fa") >= 4.5,
          `${pair[1]} does not contrast with the light CPU legend background`,
        );
        assert(
          contrastRatio(pair[2], "#16181d") >= 3,
          `${pair[2]} does not contrast with the dark CPU legend background`,
        );
      }
      const rowCpuIds = [
        ...html.matchAll(/class="bval" data-cpu-id="([^"]+)"/g),
      ].map((match) => match[1]);
      const legendCpuIds = [
        ...html.matchAll(/class="cpu-key"[^>]*data-cpu-id="([^"]+)"/g),
      ].map((match) => match[1]);
      const legendTargets = new Map(
        [
          ...html.matchAll(
            /class="cpu-key" id="([^"]+)" data-cpu-id="([^"]+)"/g,
          ),
        ].map((match) => [match[1], match[2]]),
      );
      const rowCpuLinks = [
        ...html.matchAll(
          /<a class="cpu-id" href="#([^"]+)"[^>]*>(CPU \d+)<\/a>/g,
        ),
      ].map((match) => ({ target: match[1], cpuId: match[2] }));
      assertEquals(rowCpuIds, ["CPU 1", "CPU 1"]);
      assertEquals(new Set(legendCpuIds).size, 18);
      assertEquals(legendTargets.size, 18);
      assertEquals(rowCpuLinks, [
        { target: "cpu-type-1", cpuId: "CPU 1" },
        { target: "cpu-type-1", cpuId: "CPU 1" },
      ]);
      for (const link of rowCpuLinks) {
        assertEquals(legendTargets.get(link.target), link.cpuId);
      }
      assertStringIncludes(html, 'data-sample-count="9"');
      assertStringIncludes(
        html,
        'aria-label="Representative CPU A Test CPU 00: 1.0µs, flat; 9 samples in the selected window"',
      );
      assertStringIncludes(
        html,
        'aria-label="Representative CPU A Test CPU 00: 1.5µs, ▲50%; 9 samples in the selected window"',
      );
      assertStringIncludes(
        html,
        'aria-label="CPU 1: A Test CPU 00; jump to CPU types legend"',
      );
      assertStringIncludes(html, "AMD EPYC 7763 64-Core Processor");
      assertStringIncludes(html, "CPU-03098");
      assertStringIncludes(html, "CPU-06084");
      assertStringIncludes(
        html,
        '<span class="cpu-detail">2 benchmarks · 8 runs · observed ',
      );
      assertStringIncludes(
        html,
        '<span class="cpu-detail">1 benchmark · 1 run · observed ',
      );
      assert(
        html.indexOf('class="cpu-legend"') >
          html.lastIndexOf('class="brow '),
      );
      assert(!html.includes("1.0ms"));
      assert(!html.includes("17ms"));
      // The other CPU's latest values and trends put these benchmarks in the
      // opposite order.
      assertEquals(
        rows(isolated.benchPage("p99", "duration", 45, BASE)).map((row) =>
          row.name
        ),
        [
          "packages/a/cpu.bench.ts &gt; representative",
          "packages/a/cpu.bench.ts &gt; flat",
        ],
      );
      assertEquals(
        rows(isolated.benchPage("p99", "trend", 45, BASE)).map((row) =>
          row.name
        ),
        [
          "packages/a/cpu.bench.ts &gt; representative",
          "packages/a/cpu.bench.ts &gt; flat",
        ],
      );
    });
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("generated CPU colors fail when no candidate is available", () => {
  assertThrows(
    () =>
      availableGeneratedCpuColor(
        0,
        new Set(["#707070"]),
        () => "#707070",
      ),
    Error,
    "Could not assign a distinct CPU color.",
  );
});

Deno.test("benchmark: CPU-less reports are not pooled", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "benchmark-no-cpu-",
  });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const runs = [
    ghRun(90_102, BASE),
    ghRun(90_101, BASE - DAY),
  ];
  const artifacts: Api["artifacts"] = {
    90_101: [{ id: 901_010, name: "bench-results", expired: false }],
    90_102: [{ id: 901_020, name: "bench-results", expired: false }],
  };
  const noCpuReport = (avg: number) =>
    report(
      [bench("packages/a/cpu.bench.ts", null, "flat", {
        avg,
      } as Timings)],
      "",
      "",
    );
  const zips: Api["zips"] = {
    901_010: await benchZip(noCpuReport(1_000)),
    901_020: await benchZip(noCpuReport(1_000_000)),
  };
  try {
    await withApi(
      { pages: { 1: runs }, artifacts, zips },
      async (calls) => {
        const isolated = await import(
          `./benchmark.ts?no-cpu=${crypto.randomUUID()}`
        );
        const tile = await isolated.benchmark.collect(
          ctx({ GH_TOKEN: "t" }),
        );
        assertEquals(tile.status, "bad");
        assertEquals(tile.sub, "no benchmark data");
        assert(!(tile.extra ?? "").includes("Unknown CPU"));
        assertEquals(artifactCalls(calls).length, 4);

        await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
        assertEquals(artifactCalls(calls).length, 4);
        assert(
          !isolated.benchPage("p99", "file", 45, BASE).includes(
            'class="cpu-key"',
          ),
        );
      },
    );
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: CPU-less cached runs are fetched again", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "benchmark-cpu-migration-",
  });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const key = "packages/a/cpu.bench.ts > flat";
  const legacyStats = {
    min: 1_000,
    avg: 1_000,
    max: 1_000,
    p75: 1_000,
    p99: 1_000,
    p995: 1_000,
    p999: 1_000,
  };
  const legacy = new BenchmarkHistoryStore();
  await legacy.load();
  const legacyRuns = [
    {
      runId: 91_001,
      runAttempt: 1,
      at: BASE - DAY,
      metrics: new Map([[key, legacyStats]]),
    },
    {
      runId: 91_002,
      runAttempt: 1,
      at: BASE,
      metrics: new Map([[key, legacyStats]]),
    },
  ];
  for (const run of legacyRuns) legacy.set(run);
  legacy.markRefreshed(Date.now(), legacyRuns);
  await legacy.save();

  const runs = [
    ghRun(91_002, BASE),
    ghRun(91_001, BASE - DAY),
  ];
  const artifacts: Api["artifacts"] = {
    91_001: [{ id: 910_010, name: "bench-results", expired: false }],
    91_002: [{ id: 910_020, name: "bench-results", expired: false }],
  };
  const zips: Api["zips"] = {
    910_010: await totalZip(1_000),
    910_020: await totalZip(1_000),
  };
  try {
    await withApi({ pages: { 1: runs }, artifacts, zips }, async (calls) => {
      const isolated = await import(
        `./benchmark.ts?cpu-migration=${crypto.randomUUID()}`
      );
      const tile = await isolated.benchmark.collect(ctx({ GH_TOKEN: "t" }));
      assertEquals(artifactCalls(calls).length, 4);
      assert(!(tile.extra ?? "").includes(TEST_CPU));
      assert(!(tile.extra ?? "").includes("Unknown CPU"));
      const html = isolated.benchPage("p99", "file", 45, BASE);
      assertStringIncludes(html, TEST_CPU);
      assertEquals([...html.matchAll(/class="cpu-key"/g)].length, 1);

      const migrated = new BenchmarkHistoryStore();
      await migrated.load();
      assertEquals(migrated.get(91_001)?.cpu, TEST_CPU);
      assertEquals(migrated.get(91_002)?.cpu, TEST_CPU);
    });
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench: grouped by source file, each benchmark colored by its own trend", async () => {
  await collectVaried();
  const html = await page("?stat=p99&sort=file");
  assertEquals(
    [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]),
    [
      "packages/html/render.bench.ts",
      "packages/memory/query.bench.ts",
      "packages/runner/scheduler-persistent-state.bench.ts",
    ],
  );
  assertEquals(
    [...html.matchAll(/<section class="benchmark-group">/g)].length,
    3,
  );
  assertEquals(rows(html), [
    { status: "good", name: "easing", value: "900ns", trend: "▼10%" },
    { status: "good", name: "flat", value: "2.5ms", trend: "flat" },
    { status: "bad", name: "fivefold", value: "50µs", trend: "▲5.0×" },
    { status: "good", name: "quarter", value: "100ms", trend: "▼4.0×" }, // four times faster is still good
    { status: "warn", name: "commit", value: "1.1µs", trend: "▲12%" },
    { status: "bad", name: "hot/steep", value: "20ms", trend: "▲20×" },
  ]);
  // A bench with no `ok` block, or an average that is not a number, is not a
  // measurement and never reaches the page.
  assert(!html.includes("no-ok"), "a result with no ok block is dropped");
  assert(!html.includes("not-a-number"), "a non-numeric average is dropped");
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="true">p99</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p75">p75</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="true">file</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=duration&amp;stat=p99">duration</a>`,
  );
  assertStringIncludes(html, 'aria-label="Benchmark metric"');
  assertStringIncludes(html, 'aria-label="Sort benchmarks"');
  assertStringIncludes(
    html,
    'href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="page">Runtime benchmarks</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
  assertStringIncludes(
    html,
    '<input type="hidden" name="view" value="runtime">',
  );
  assertStringIncludes(html, '<input type="hidden" name="repo" value="labs">');
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
  assertStringIncludes(html, "const isSameDocumentFragment = (link) => {");
  assertStringIncludes(
    html,
    'url.search === location.search &&\n      url.hash !== ""',
  );
  assertStringIncludes(
    html,
    "link && isSameTabLink(event, link) && !isSameDocumentFragment(link)",
  );
  assert(!html.includes("location.reload()"));
  assert(!html.includes("benchRestoreDaysFocus"));
  assertStringIncludes(html, "setInterval(checkForUpdates, 60000)");
  assert(
    !html.includes(
      ".views a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assert(
    !html.includes(
      "a.stat.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assertStringIncludes(
    html,
    '<div class="axisrow"><div class="timeaxis"><span>',
  );
  assertEquals([...html.matchAll(/class="bcpu"/g)].length, 0);
  assertEquals([...html.matchAll(/class="cpu-key"/g)].length, 1);
  assertStringIncludes(html, TEST_CPU);
  assertStringIncludes(
    html,
    '<span class="cpu-detail">6 benchmarks · 12 runs · observed ',
  );
  assertEquals(
    [...html.matchAll(/class="bval" data-cpu-id="CPU 1"/g)].length,
    6,
  );
  assertEquals(
    [
      ...html.matchAll(
        /<a class="cpu-id" href="#cpu-type-1"[^>]*>CPU 1<\/a>/g,
      ),
    ].length,
    6,
  );
  assertStringIncludes(
    html,
    `aria-label="Representative CPU ${TEST_CPU}: 2.5ms, flat;`,
  );
  assertStringIncludes(
    html,
    'class="cpu-key" id="cpu-type-1" data-cpu-id="CPU 1"',
  );
  assertStringIncludes(html, ".bval a.cpu-id{text-decoration:none}");
  assert(!html.includes("text-underline-offset"));
  assert(!html.includes("Its numbered CPU key maps to the legend below."));
  assert(
    html.indexOf('class="cpu-legend"') >
      html.lastIndexOf('class="brow '),
  );
  assertStringIncludes(
    html,
    "body.hide-green .benchmark-group:not(:has(.brow:not(.good)))",
  );
  assert(!html.includes("body.hide-green section:not("));
});

Deno.test("/bench?sort=trend: a flat list, biggest rise first, showing the full key", async () => {
  await collectVaried();
  const html = await page("?stat=p99&sort=trend");
  // The " > " between a benchmark's file and its name is html-escaped on the page.
  assertEquals(rows(html).map((r) => r.name), [
    "packages/runner/scheduler-persistent-state.bench.ts &gt; hot/steep",
    "packages/memory/query.bench.ts &gt; fivefold",
    "packages/runner/scheduler-persistent-state.bench.ts &gt; commit",
    "packages/html/render.bench.ts &gt; flat",
    "packages/html/render.bench.ts &gt; easing",
    "packages/memory/query.bench.ts &gt; quarter",
  ]);
  assert(
    !html.includes('<section class="benchmark-group">'),
    "a flat list has no file groups",
  );
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=trend&amp;stat=p99" aria-current="true">trend</a>`,
  );
});

Deno.test("/bench?sort=duration lists the longest displayed benchmark first", async () => {
  await collectVaried();
  const html = await page("?stat=p99&sort=duration");
  assertEquals(rows(html).map((row) => row.name).slice(0, 3), [
    "packages/memory/query.bench.ts &gt; quarter",
    "packages/runner/scheduler-persistent-state.bench.ts &gt; hot/steep",
    "packages/html/render.bench.ts &gt; flat",
  ]);
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=duration&amp;stat=p99">CI duration history</a>',
  );
});

Deno.test("/bench history windows keep about the same chart point count", () => {
  const now = 45 * DAY;
  const step = 5 * 60_000;
  const points = Array.from(
    { length: Math.floor(45 * DAY / step) + 1 },
    (_, index) => ({ at: now - index * step }),
  );
  const full = pointsForWindow(points, 0, ciHistoryBucketMs(45));
  const short = pointsForWindow(
    points,
    now - CI_HISTORY_MIN_DAYS * DAY,
    ciHistoryBucketMs(CI_HISTORY_MIN_DAYS),
  );

  assert(
    full.length >= CI_HISTORY_POINT_TARGET - 1 &&
      full.length <= CI_HISTORY_POINT_TARGET + 1,
  );
  assert(
    short.length >= CI_HISTORY_POINT_TARGET - 1 &&
      short.length <= CI_HISTORY_POINT_TARGET + 1,
  );
});

Deno.test("representative benchmark CPU prefers coverage, recency, then name", () => {
  const series = (cpu: string, sampleCount: number, points: number[]) => ({
    cpu,
    sampleCount,
    points: points.map((at) => ({ at })),
  });
  assertEquals(
    representativeBenchmarkCpu([
      series("more recent", 100, [1, 4]),
      series("more covered", 1_000, [1, 3]),
    ])?.cpu,
    "more covered",
  );
  assertEquals(
    representativeBenchmarkCpu([
      series("older", 100, [1, 3]),
      series("newer", 100, [1, 4]),
    ])?.cpu,
    "newer",
  );
  assertEquals(
    representativeBenchmarkCpu([
      series("z CPU", 100, [1, 4]),
      series("a CPU", 100, [1, 4]),
    ])?.cpu,
    "a CPU",
  );
  assertEquals(representativeBenchmarkCpu([]), undefined);
});

Deno.test("benchmark collection retains enough runs for the shortest history window", () => {
  const now = 45 * DAY;
  const step = 5 * 60_000;
  const runs = Array.from(
    { length: Math.floor(45 * DAY / step) + 1 },
    (_, index) => ghRun(30_000 + index, now - index * step),
  );
  const collected = sampleBenchmarkRuns(runs, 0).map((run) => ({
    at: Date.parse(run.created_at),
  }));
  const short = pointsForWindow(
    collected,
    now - CI_HISTORY_MIN_DAYS * DAY,
    ciHistoryBucketMs(CI_HISTORY_MIN_DAYS),
    now,
  );

  assert(
    short.length >= CI_HISTORY_POINT_TARGET - 1 &&
      short.length <= CI_HISTORY_POINT_TARGET + 1,
  );
});

Deno.test("/bench: the measurement selector changes what is plotted", async () => {
  await collectVaried();
  const mean = rows(await page("?stat=mean"));
  assertEquals(mean.find((r) => r.name === "hot/steep")?.value, "10ms"); // the mean, half the p99
  // A benchmark that reported only an average reads the same at every measurement.
  assertEquals(mean.find((r) => r.name === "flat")?.value, "2.5ms");
  assertEquals(
    rows(await page("?stat=p0")).find((r) => r.name === "flat")?.value,
    "2.5ms",
  );
  assertStringIncludes(
    await page("?stat=mean"),
    "<title>Benchmarks — mean</title>",
  );
  // The mean column was once labeled p50, so a link saved under that name still
  // opens it rather than falling back to the default.
  assertEquals(
    rows(await page("?stat=p50")).find((r) => r.name === "hot/steep")?.value,
    "10ms",
  );
  // An unknown measurement falls back to the default rather than blanking the page.
  assertStringIncludes(
    await page("?stat=nonsense"),
    "<title>Benchmarks — p99</title>",
  );
  assertEquals(
    rows(await page("?stat=nonsense")).find((r) => r.name === "hot/steep")
      ?.value,
    "20ms",
  );
  // So does an unknown sort.
  assertStringIncludes(
    await page("?sort=nonsense"),
    "<h2>packages/html/render.bench.ts</h2>",
  );
});

Deno.test("/bench runtime graphs ignore two values at each end when twenty are shown", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-scale-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const values = [
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
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  try {
    const store = new BenchmarkHistoryStore(
      `${directory}/fabric-wall-benchmark-history.json`,
    );
    await store.load();
    const cached = values.map((value, index) =>
      store.set({
        runId: 120_000 + index,
        runAttempt: 1,
        at: BASE - (values.length - 1 - index) * DAY,
        cpu: TEST_CPU,
        metrics: new Map([[
          "packages/a/scale.bench.ts > scale",
          {
            min: value,
            avg: value,
            max: value,
            p75: value,
            p99: value,
            p995: value,
            p999: value,
          },
        ]]),
      })
    );
    store.markRefreshed(Date.now(), cached);
    await store.save();

    const isolated = await import(
      `./benchmark.ts?scale=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx(),
    );
    const html = await response.text();
    const points = html
      .match(/<polyline points="([^"]+)"/)?.[1]
      .split(" ")
      .map((point: string) => Number(point.split(",")[1]));

    assert(points, html);
    assertEquals(points.filter((point: number) => point < 0).length, 2);
    assertEquals(points.filter((point: number) => point > 34).length, 2);
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench: the history slider selects and clamps the displayed days", async () => {
  await collectVaried();
  const short = await page("?days=1");
  assertStringIncludes(
    short,
    'id="days" name="days" min="1" max="45" step="1" value="1"',
  );
  assertStringIncludes(short, "selected 1-day window");
  assertStringIncludes(
    await page("?days=7"),
    '<div class="axisrow"><div class="timeaxis"><span>',
  );
  assertStringIncludes(await page("?days=0"), ">1 day</output>");
  assertStringIncludes(await page("?days=100"), ">45 days</output>");

  const requestedEnd = BASE + DAY;
  const anchored = benchPage("p99", "file", 7, requestedEnd);
  const date = (at: number) =>
    new Date(at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  assertStringIncludes(
    anchored,
    `<div class="timeaxis"><span>${date(requestedEnd - 7 * DAY)}</span><span>${
      date(requestedEnd)
    }</span>`,
  );

  const stale = benchPage("p99", "file", 7, BASE + 20 * DAY);
  assertStringIncludes(
    stale,
    "No benchmark samples were found in the selected window.",
  );
  assert(!stale.includes('class="brow'));
});

Deno.test("/bench: the page names the repo and workflow it read", async () => {
  const html = await page("");
  assertStringIncludes(html, `${REPO} · benchmarks.yml`);
  assertStringIncludes(
    html,
    `https://github.com/${REPO}/actions/workflows/benchmarks.yml`,
  );
});

Deno.test("/bench runtime preserves the selected CI repository across its links", () => {
  const html = benchPage("p75", "duration", 9, BASE, "loom");

  assertStringIncludes(html, '<input type="hidden" name="repo" value="loom">');
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">CI duration history</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">CI run Gantt</a>',
  );
});

Deno.test("benchmark: an unreachable source grays out with a calm reason, and never reads red", async () => {
  await withApi({
    throws: new TypeError(
      "error sending request for url (https://api.github.com/...)",
    ),
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown"); // gray, never a stale red; the value is a
    // bare dash or a grayed last-known trend — the offline tests below pin both
    assertEquals(v.sub, "source unreachable"); // not a stack trace or an api path
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
  });
});

Deno.test("benchmark: a rejected token grays out as an auth failure", async () => {
  await withApi({ status: 401 }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "wrong" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.sub, "auth failed"); // the http status is not put on the dashboard
  });
});

Deno.test("benchmark: a failed fetch keeps a stale cached trend grayed", async () => {
  // Cache two runs older than the headline window, then make the source unreachable.
  // The tile keeps the cached trend and chart gray with the reason.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-offline-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const token = `benchmark-offline-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const key = "packages/a/x.bench.ts";
  const healthy = serve({
    pages: { 1: [ghRun(7_701, BASE - 2 * DAY), ghRun(7_702, BASE - DAY)] },
    artifacts: {
      7_701: [{ id: 77_010, name: "bench-results", expired: false }],
      7_702: [{ id: 77_020, name: "bench-results", expired: false }],
    },
    zips: {
      77_010: await benchZip(report([bench(key, null, "b", timings(1_000))])),
      77_020: await benchZip(report([bench(key, null, "b", timings(1_000))])),
    },
  });
  try {
    const isolated = await import(`./benchmark.ts?offline=${crypto.randomUUID()}`);
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
      return Promise.resolve(healthy(url));
    }) as typeof fetch;
    const online = await isolated.benchmark.collect(ctx({ GH_TOKEN: token }));
    assertEquals(online.status, "unknown");
    assertEquals(online.value, "—");
    assertEquals(online.sub, "no recent benchmark data");

    // The source becomes unreachable on the next collection.
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError("error sending request for url (https://api.github.com/...)"),
      )) as typeof fetch;
    const offline = await isolated.benchmark.collect(ctx({ GH_TOKEN: token }));
    assertEquals(offline.status, "unknown");
    assertEquals(offline.sub, "source unreachable");
    assertStringIncludes(offline.value ?? "", "new");
    assertStringIncludes(offline.extra ?? "", "<svg");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a failed fetch with no cached history grays to a dash", async () => {
  // Nothing cached yet and the source is unreachable: there is no trend to keep, so
  // the tile shows a bare gray dash with the reason.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-offline-cold-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const token = `benchmark-offline-cold-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = (() =>
    Promise.reject(
      new TypeError("error sending request for url (https://api.github.com/...)"),
    )) as typeof fetch;
  try {
    const isolated = await import(
      `./benchmark.ts?offline-cold=${crypto.randomUUID()}`
    );
    const v = await isolated.benchmark.collect(ctx({ GH_TOKEN: token }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—"); // nothing cached to fall back on
    assertEquals(v.sub, "source unreachable");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a fresh marker then an unreachable direct read grays with the reason", async () => {
  // A fresh refresh marker makes the collection short-circuit, so the tile reads the
  // run list directly for itself — and when that direct read is unreachable, it grays
  // with the reason rather than throwing.
  const directory = await Deno.makeTempDir({ prefix: "benchmark-fresh-offline-" });
  const file = `${directory}/fabric-wall-benchmark-history.json`;
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const store = new BenchmarkHistoryStore(file);
  await store.load();
  store.markRefreshed(Date.now(), [], "no-runs"); // recent + empty -> snapshot is fresh
  await store.save();
  globalThis.fetch = (() =>
    Promise.reject(
      new TypeError("error sending request for url (https://api.github.com/...)"),
    )) as typeof fetch;
  try {
    const isolated = await import(
      `./benchmark.ts?fresh-offline=${crypto.randomUUID()}`
    );
    const v = await isolated.benchmark.collect(
      ctx({ GH_TOKEN: `t-${crypto.randomUUID()}` }),
    );
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—"); // fresh but empty, and the direct read failed
    assertEquals(v.sub, "source unreachable");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: the drill-down keeps one-sample benchmarks", async () => {
  // Each run reports a different benchmark. The tile still indexes both runs.
  // The drill-down shows each benchmark's one sample as a point.
  const runs = [ghRun(801, BASE - DAY), ghRun(802, BASE)];
  await withApi({
    pages: { 1: runs },
    artifacts: {
      801: [{ id: 8_010, name: "bench-results", expired: false }],
      802: [{ id: 8_020, name: "bench-results", expired: false }],
    },
    zips: {
      8_010: await benchZip(
        report([bench("packages/a/one.bench.ts", null, "a", timings(10))]),
      ),
      8_020: await benchZip(
        report([bench("packages/a/two.bench.ts", null, "b", timings(20))]),
      ),
    },
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "good");
    assertStringIncludes(v.value ?? "", "new"); // under a week of days, the headline reads "new"
    assertEquals(v.sub, undefined);
    assertStringIncludes(v.extra ?? "", "1 benchmark"); // the count line
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    const drill = await page("");
    assertStringIncludes(drill, "one.bench.ts");
    assertStringIncludes(drill, "two.bench.ts");
    assertEquals([...drill.matchAll(/<circle/g)].length, 2);
  });
});

Deno.test("benchmark: trend classification — flat or falling good, a rise warn, a steep rise bad", () => {
  const t = (v: number[]) => v.map((_, i) => i * DAY);
  const st = (v: number[]) => trendStatus(trendPct(t(v), v));
  assertEquals(st([100, 101, 99, 100, 100, 101, 99, 100]), "good");
  assertEquals(st([130, 125, 120, 115, 110, 105, 100]), "good");
  assertEquals(st([100, 102, 104, 106, 108, 110, 112]), "warn");
  assertEquals(st([100, 120, 140, 160, 180, 200, 240]), "bad");
});

Deno.test("benchmark: a lone spike is not a level, so the trend stays flat", () => {
  // Seven days, three samples each, all at 100 apart from one spike of 10000 in
  // the middle of day 3. One sample cannot carry a level of its own, so the
  // series reads as the single level it is.
  const times: number[] = [], values: number[] = [];
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 3; s++) {
      times.push(d * DAY + s * HOUR);
      values.push(d === 3 && s === 1 ? 10_000 : 100);
    }
  }
  assertEquals(trendPct(times, values), 0);
  // Values at or below zero are not timings and are left out entirely.
  assertEquals(trendPct([...times, 7 * DAY], [...values, 0]), 0);
});

// Twenty-one samples spread over seven days, stepping from `before` to `after`
// at `at`, each nudged by a fixed amount that repeats without a pattern the fit
// can follow. The nudge keeps the samples from agreeing exactly, so the trend
// runs its change-point search rather than reading the two ends directly.
function steppedSeries(
  at: number,
  before: number,
  after: number,
): { times: number[]; values: number[] } {
  const times: number[] = [], values: number[] = [];
  for (let i = 0; i < 21; i++) {
    times.push(Math.floor(i / 3) * DAY + (i % 3) * HOUR);
    values.push((i < at ? before : after) * (1 + ((i * 7919) % 13 - 6) / 1000));
  }
  return { times, values };
}

Deno.test("benchmark: the same rise reads the same wherever it falls in the window", () => {
  // The old fit ran a line through the samples and reported its rise across the
  // window, so a step read large in the middle and almost vanished at either
  // end. The size of the step is what it is wherever it landed.
  for (const at of [3, 6, 10, 15, 18]) {
    const { times, values } = steppedSeries(at, 100, 105);
    const pct = trendPct(times, values);
    assert(
      Math.abs(pct - 0.05) < 0.01,
      `a 5% step at sample ${at} read as ${(pct * 100).toFixed(1)}%`,
    );
    assertEquals(trendStatus(pct), "warn");
  }
});

Deno.test("benchmark: a rise in the newest samples is reported at its full size", () => {
  // The freshest regression is the one worth catching soonest, and it has the
  // fewest samples behind it.
  const { times, values } = steppedSeries(18, 100, 130);
  const pct = trendPct(times, values);
  assert(
    Math.abs(pct - 0.30) < 0.02,
    `a 30% step in the last three samples read as ${(pct * 100).toFixed(1)}%`,
  );
  assertEquals(trendStatus(pct), "bad");
});

Deno.test("benchmark: a fall reads as a fall of its own size", () => {
  const { times, values } = steppedSeries(10, 125, 100);
  const pct = trendPct(times, values);
  assert(
    Math.abs(pct + 0.20) < 0.01,
    `a 20% drop read as ${(pct * 100).toFixed(1)}%`,
  );
  assertEquals(trendStatus(pct), "good");
});

Deno.test("benchmark: a series that only wobbles reads flat", () => {
  const { times, values } = steppedSeries(21, 100, 100);
  assertEquals(trendPct(times, values), 0);
  assertEquals(trendStatus(trendPct(times, values)), "good");
});

Deno.test("benchmark: more samples than the fit reads are grouped, and the rise survives", () => {
  // A 45-day window holds several hundred runs, more than the fit reads
  // directly, so they are grouped into equal-sized runs first. A step three
  // quarters of the way along still reports at its own size afterwards, and the
  // grouping does not smear it across the boundary it falls on.
  const times: number[] = [], values: number[] = [];
  for (let i = 0; i < 260; i++) {
    times.push(Math.floor(i / 6) * DAY + (i % 6) * 4 * HOUR);
    values.push((i < 195 ? 100 : 118) * (1 + ((i * 7919) % 13 - 6) / 1000));
  }
  const pct = trendPct(times, values);
  assert(
    Math.abs(pct - 0.18) < 0.01,
    `an 18% step among 260 samples read as ${(pct * 100).toFixed(1)}%`,
  );
  assertEquals(trendStatus(pct), "warn");
});

Deno.test("benchmark: a steady climb reads as the whole of its rise", () => {
  // No step to find, so the straight line describes the series and reports
  // its rise from the first sample to the last.
  const times: number[] = [], values: number[] = [];
  for (let i = 0; i < 21; i++) {
    times.push(Math.floor(i / 3) * DAY + (i % 3) * HOUR);
    values.push(100 * Math.pow(1.30, i / 20));
  }
  const pct = trendPct(times, values);
  assert(
    Math.abs(pct - 0.30) < 0.02,
    `a 30% climb read as ${(pct * 100).toFixed(1)}%`,
  );
});

Deno.test("benchmark: fewer than a week of days claims no trend", () => {
  assertEquals(trendPct([0, DAY, 2 * DAY], [100, 500, 2_000]), 0);
  assertEquals(
    benchmarkTrend(
      Array.from({ length: 12 }, (_, hour) => hour * HOUR),
      Array.from({ length: 12 }, (_, hour) => 2 ** hour),
    ),
    { pct: 0, status: "unknown", label: "new" },
  );
});

Deno.test("benchmark: an even number of days takes the mean of the two middle slopes", () => {
  // Eight days doubling each day: every pairwise slope is ln 2, so the median of
  // the even-sized list is ln 2 too, and seven days of it is a 128-fold rise.
  const v = [1, 2, 4, 8, 16, 32, 64, 128];
  const pct = trendPct(v.map((_, i) => i * DAY), v);
  assert(Math.abs(pct - 127) < 1e-6, `expected ~127, got ${pct}`);
  assertEquals(trendStatus(pct), "bad");
});

Deno.test("benchmark: formatNs picks a readable unit", () => {
  assertEquals(formatNs(500), "500ns");
  assertEquals(formatNs(1_500), "1.5µs");
  assertEquals(formatNs(50_000), "50µs");
  assertEquals(formatNs(2_000_000), "2.0ms");
  assertEquals(formatNs(50_000_000), "50ms");
  assertEquals(formatNs(2_500_000_000), "2.50s");
  assertEquals(formatNs(NaN), "—");
  assertEquals(formatNs(Infinity), "—");
});

Deno.test("benchmark: the trend thresholds", () => {
  assertEquals(trendStatus(0.05), "good"); // exactly at UP_PCT
  assertEquals(trendStatus(0.051), "warn");
  assertEquals(trendStatus(0.20), "warn"); // exactly at RAPID_PCT
  assertEquals(trendStatus(0.21), "bad");
  assertEquals(trendStatus(-1), "good");
});

Deno.test("benchmark routes serve the Gantt and both progress endpoints", async () => {
  const gantt = new URL("http://x/bench?view=gantt");
  const ganttResponse = await benchmark.routes![0].handler(
    new Request(gantt),
    gantt,
  );
  assertStringIncludes(
    await ganttResponse.text(),
    "<title>CI run Gantt</title>",
  );

  const check = new URL("http://x/bench/check?view=ci");
  assertEquals(
    (await benchmark.routes![1].handler(new Request(check), check)).status,
    200,
  );

  const progress = new URL("http://x/bench/runtime-progress");
  const progressResponse = await benchmark.routes![3].handler(
    new Request(progress),
    progress,
  );
  assertEquals(benchmark.routes![3].path, "/bench/runtime-progress");
  assertEquals(progressResponse.status, 400);
});

Deno.test("benchmark defaults a missing workflow run attempt to one", async () => {
  const runId = 80_001;
  const run = {
    id: runId,
    created_at: new Date(BASE).toISOString(),
    conclusion: "success",
  } as GhRun;
  await withApi({
    pages: { 1: [run] },
    artifacts: { [runId]: [] },
  }, async () => {
    await benchmark.collect(ctx({ GH_TOKEN: "token" }));
    const store = new BenchmarkHistoryStore();
    await store.load();
    assertEquals(store.get(runId, 1)?.runAttempt, 1);
  });
});

Deno.test("runtime benchmark progress removes failed listeners and closes cleanly", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-progress-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  let resolveRuns: (response: Response) => void = () => {};
  const runs = new Promise<Response>((resolve) => resolveRuns = resolve);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    return runs;
  }) as typeof fetch;
  try {
    const isolated = await import(
      `./benchmark.ts?listener=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx({ GH_TOKEN: `listener-${crypto.randomUUID()}` }),
    );
    const html = await response.text();
    const id = html.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    assertEquals(
      isolated.subscribeBenchmarkProgress("missing", () => {}),
      null,
    );
    assertEquals(
      isolated.subscribeBenchmarkProgress(id, () => {
        throw new Error("initial listener failed");
      }),
      null,
    );
    let listenerCalls = 0;
    assert(isolated.subscribeBenchmarkProgress(id, () => {
      listenerCalls++;
      if (listenerCalls > 1) throw new Error("updated listener failed");
    }));

    assertEquals(
      isolated.benchmarkHistoryProgressResponse(
        new URL("http://x/bench/runtime-progress"),
      ).status,
      400,
    );
    const progressUrl = new URL(`http://x/bench/runtime-progress?id=${id}`);
    const completion = isolated.benchmarkHistoryProgressResponse(progressUrl)
      .text();
    const canceled = isolated.benchmarkHistoryProgressResponse(progressUrl);
    const reader = canceled.body!.getReader();
    await reader.read();
    await reader.cancel();

    resolveRuns(Response.json({ workflow_runs: [] }));
    assertStringIncludes(await completion, '"phase":"complete"');
    assertEquals(listenerCalls, 2);
    assertStringIncludes(
      await isolated.benchmarkHistoryProgressResponse(progressUrl).text(),
      '"phase":"complete"',
    );
  } finally {
    resolveRuns(Response.json({ workflow_runs: [] }));
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark progress ignores duplicate terminal updates", async () => {
  const progress: BenchmarkFetchProgress = {
    id: "duplicate-terminal",
    phase: "complete",
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
    updatedAt: BASE,
  };
  let unsubscribed = false;
  const response = benchmarkHistoryProgressResponse(
    new URL("http://x/bench/runtime-progress?id=duplicate-terminal"),
    {
      progress: () => progress,
      subscribe: (_id, listener) => {
        listener(progress);
        listener(progress);
        return () => unsubscribed = true;
      },
    },
  );
  assertStringIncludes(await response.text(), '"phase":"complete"');
  assertEquals(unsubscribed, true);
});

Deno.test("runtime history reconstructs unmanifested cache data before asking for a token", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cache-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const stats = {
    min: 400,
    avg: 500,
    max: 1_500,
    p75: 800,
    p99: 1_000,
    p995: 1_050,
    p999: 1_200,
  };
  try {
    const store = new BenchmarkHistoryStore();
    await store.load();
    store.set({
      runId: 81_001,
      runAttempt: 1,
      at: BASE - DAY,
      cpu: TEST_CPU,
      metrics: new Map([["packages/a/cache.bench.ts > cached", stats]]),
    });
    store.set({
      runId: 81_002,
      runAttempt: 1,
      at: BASE,
      cpu: TEST_CPU,
      metrics: new Map([["packages/a/cache.bench.ts > cached", stats]]),
    });
    await store.save(BASE);
    const isolated = await import(
      `./benchmark.ts?cache=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx(),
    );
    const html = await response.text();
    assertStringIncludes(
      html,
      "Set GH_TOKEN to refresh runtime benchmark history.",
    );
    assertStringIncludes(html, "cache.bench.ts");
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("empty runtime history asks for a token to collect data", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cache-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  try {
    const isolated = await import(
      `./benchmark.ts?empty=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx(),
    );
    assertStringIncludes(
      await response.text(),
      "Set GH_TOKEN to collect runtime benchmark history.",
    );
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a failed drill-down cache write does not gray the tile", async () => {
  // The artifact was read and its metrics held in memory before the cache write
  // failed, so the tile still totals them; only the persistence to disk failed.
  const archive = await benchZip(report([
    bench("packages/a/write.bench.ts", null, "write", timings(1_000)), // avg 500
  ]));
  for (const failedRename of [1, 2]) {
    const directory = await Deno.makeTempDir({ prefix: "benchmark-write-" });
    const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
    const originalFetch = globalThis.fetch;
    const rename = Deno.rename;
    let renames = 0;
    Deno.env.set("DASHBOARD_CACHE_DIR", directory);
    try {
      const isolated = await import(
        `./benchmark.ts?write=${failedRename}-${crypto.randomUUID()}`
      );
      const runId = 82_000 + failedRename;
      const handler = serve({
        pages: { 1: [ghRun(runId, BASE)] },
        artifacts: {
          [runId]: [{
            id: runId * 10,
            name: "bench-results",
            expired: false,
          }],
        },
        zips: { [runId * 10]: archive },
      });
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return Promise.resolve(handler(url));
      }) as typeof fetch;
      Deno.rename = ((oldpath, newpath) => {
        renames++;
        return renames === failedRename
          ? Promise.reject(new Error(`rename ${failedRename} failed`))
          : rename(oldpath, newpath);
      }) as typeof Deno.rename;

      const view = await isolated.benchmark.collect(ctx({ GH_TOKEN: "token" }));
      assertEquals(view.status, "good"); // the in-memory total is unaffected
      assertStringIncludes(view.value ?? "", "new"); // a single run: the trend reads "new"
      assertEquals(renames, failedRename); // the write was attempted and failed

    } finally {
      Deno.rename = rename;
      globalThis.fetch = originalFetch;
      if (previousCacheDirectory === undefined) {
        Deno.env.delete("DASHBOARD_CACHE_DIR");
      } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("a queued runtime history refresh reuses a dashboard refresh that just completed", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-queue-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  let resolveRuns: (response: Response) => void = () => {};
  const runs = new Promise<Response>((resolve) => resolveRuns = resolve);
  let workflowRequests = 0;
  let rateRequests = 0;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") {
      rateRequests++;
      return Promise.resolve(serve({})(url));
    }
    workflowRequests++;
    return runs;
  }) as typeof fetch;
  let dashboard: Promise<TileView> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?queue=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: `queue-${crypto.randomUUID()}` });
    dashboard = isolated.benchmark.collect(tokenContext);
    const page = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const html = await page.text();
    const id = html.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    const completion = isolated.benchmarkHistoryProgressResponse(
      new URL(`http://x/bench/runtime-progress?id=${id}`),
    ).text();

    resolveRuns(Response.json({ workflow_runs: [] }));
    await dashboard;
    assertStringIncludes(await completion, '"phase":"complete"');
    assertEquals(workflowRequests, 1);
    assertEquals(rateRequests, 0);
  } finally {
    resolveRuns(Response.json({ workflow_runs: [] }));
    await dashboard?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a queued dashboard refresh checks that the drill-down covers its runs", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "benchmark-queued-dashboard-",
  });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const oldRun = ghRun(131_001, SAMPLED_BASE - DAY);
  const newRun = ghRun(131_002, SAMPLED_BASE);
  const oldArchive = await totalZip(5e6);
  const newArchive = await totalZip(10e6);
  let releaseOldArtifact!: (response: Response) => void;
  const heldOldArtifact = new Promise<Response>((resolve) => {
    releaseOldArtifact = resolve;
  });
  let markOldArtifactRequested!: () => void;
  const oldArtifactRequested = new Promise<void>((resolve) => {
    markOldArtifactRequested = resolve;
  });
  let markDashboardRunsRequested!: () => void;
  const dashboardRunsRequested = new Promise<void>((resolve) => {
    markDashboardRunsRequested = resolve;
  });
  let workflowRequests = 0;
  let newArtifactRequests = 0;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      workflowRequests++;
      if (workflowRequests === 1) {
        return Promise.resolve(Response.json({ workflow_runs: [oldRun] }));
      }
      if (workflowRequests === 2) {
        markDashboardRunsRequested();
        return Promise.resolve(Response.json({
          workflow_runs: [newRun, oldRun],
        }));
      }
      throw new Error("unexpected third workflow request");
    }
    if (url.pathname.endsWith(`/actions/runs/${oldRun.id}/artifacts`)) {
      markOldArtifactRequested();
      return heldOldArtifact;
    }
    if (url.pathname.endsWith(`/actions/runs/${newRun.id}/artifacts`)) {
      newArtifactRequests++;
      return Promise.resolve(Response.json({
        artifacts: [{
          id: newRun.id * 10,
          name: "bench-results",
          expired: false,
        }],
      }));
    }
    if (url.pathname.endsWith(`/actions/artifacts/${oldRun.id * 10}/zip`)) {
      return Promise.resolve(new Response(oldArchive));
    }
    if (url.pathname.endsWith(`/actions/artifacts/${newRun.id * 10}/zip`)) {
      return Promise.resolve(new Response(newArchive));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  let dashboard: Promise<TileView> | undefined;
  let drillDown: Promise<string> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?queued-dashboard=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({
      GH_TOKEN: `queued-dashboard-${crypto.randomUUID()}`,
    });
    const page = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const html = await page.text();
    const id = html.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    drillDown = isolated.benchmarkHistoryProgressResponse(
      new URL(`http://x/bench/runtime-progress?id=${id}`),
    ).text();
    await oldArtifactRequested;

    dashboard = isolated.benchmark.collect(tokenContext);
    await dashboardRunsRequested;
    releaseOldArtifact(Response.json({
      artifacts: [{
        id: oldRun.id * 10,
        name: "bench-results",
        expired: false,
      }],
    }));

    await dashboard;
    await drillDown;
    expect(workflowRequests).toBe(2);
    expect(newArtifactRequests).toBe(1);
  } finally {
    releaseOldArtifact(Response.json({ artifacts: [] }));
    await dashboard?.catch(() => {});
    await drillDown?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime history reports a recent failed collection without starting another", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-failure-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  let workflowRequests = 0;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    workflowRequests++;
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  }) as typeof fetch;
  try {
    const store = new BenchmarkHistoryStore();
    await store.load();
    store.set({
      runId: 130_001,
      runAttempt: 1,
      at: BASE,
      cpu: TEST_CPU,
      metrics: new Map([[
        "packages/a/failure.bench.ts > cached result",
        {
          min: 10,
          avg: 10,
          max: 10,
          p75: 10,
          p99: 10,
          p995: 10,
          p999: 10,
        },
      ]]),
    });
    await store.save();

    const isolated = await import(
      `./benchmark.ts?failure=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: `failure-${crypto.randomUUID()}` });
    const first = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const firstHtml = await first.text();
    assertStringIncludes(firstHtml, "failure.bench.ts");
    const id = firstHtml.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    assertStringIncludes(
      await isolated.benchmarkHistoryProgressResponse(
        new URL(`http://x/bench/runtime-progress?id=${id}`),
      ).text(),
      '"phase":"error"',
    );

    const check = await isolated.benchmarkHistoryCheckResponse(tokenContext);
    const checkState = await check.json();
    assertEquals(checkState.progress, null);
    assertEquals(checkState.lastRequestError, "temporarily unavailable");

    const originalNow = Date.now;
    Date.now = () => originalNow() + 31 * 60_000;
    try {
      const laterCheck = await isolated.benchmarkHistoryCheckResponse(ctx());
      const laterState = await laterCheck.json();
      assertEquals(laterState.progress, null);
      assertEquals(laterState.lastRequestError, "temporarily unavailable");
    } finally {
      Date.now = originalNow;
    }

    const second = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const secondHtml = await second.text();
    assertStringIncludes(secondHtml, "failure.bench.ts");
    assertStringIncludes(secondHtml, 'class="fetch-progress error"');
    assertStringIncludes(
      secondHtml,
      'data-last-request-error="temporarily unavailable"',
    );
    assertStringIncludes(
      secondHtml,
      '<p id="fetch-detail">Last collection stopped: temporarily unavailable</p>',
    );
    assertEquals(
      secondHtml.match(
        /<p id="fetch-detail">Last collection stopped: temporarily unavailable<\/p>/g,
      )?.length,
      1,
    );
    assertEquals(workflowRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

describe("keyBenchmarks", () => {
  /** Builds ten daily benchmark artifacts ending inside the headline window. */
  async function history(
    idBase: number,
    makeReport: (day: number) => string,
  ): Promise<Api> {
    const artifacts: Api["artifacts"] = {};
    const zips: Api["zips"] = {};
    const runs: GhRun[] = [];
    for (let day = 0; day < 10; day++) {
      const id = idBase + day;
      runs.unshift(ghRun(id, SAMPLED_BASE - (9 - day) * DAY));
      artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
      zips[id * 10] = await benchZip(makeReport(day));
    }
    return { pages: { 1: runs }, artifacts, zips };
  }

  const navigation =
    "packages/patterns/integration/topic-board-navigation.bench.ts";
  const scale = "packages/patterns/integration/topic-board-scale.bench.ts";

  it("balances the selected changes geometrically and removes machine changes", async () => {
    const api = await history(930_000, (day) => {
      const changed = day >= 5;
      const host = changed ? 1.25 : 1;
      return report([
        bench(
          navigation,
          "topic board",
          "journey",
          timings(1e9 * host * (changed ? 2 : 1)),
        ),
        bench(
          scale,
          "topic board scale",
          "100",
          timings(1e9 * host * (changed ? 0.5 : 1)),
        ),
        bench(
          scale,
          "topic board scale",
          "1000",
          timings(1e9 * host * (changed ? 100 : 1)),
        ),
        bench(
          navigation,
          "topic board",
          "load",
          timings(1e9 * host * (changed ? 100 : 1)),
        ),
        bench(
          navigation,
          "other topic board",
          "journey",
          timings(1e9 * host * (changed ? 100 : 1)),
        ),
        bench(
          CALIBRATION_FILE,
          null,
          "integer arithmetic",
          timings(1e6 * host),
        ),
      ]);
    });
    await withApi(api, async (calls) => {
      const [selected, all] = await Promise.all([
        keyBenchmarks.collect(ctx({ GH_TOKEN: "t" })),
        benchmark.collect(ctx({ GH_TOKEN: "t" })),
      ]);
      expect(runListCalls(calls)).toHaveLength(1);
      expect(selected.status).toBe("good");
      expect(selected.value).toBe("flat");
      expect(selected.extra).toContain(">2 benchmarks</div>");
      expect(selected.extra).toContain("<svg");
      expect(selected.duration).toBe(9 * DAY);
      const downloads = artifactCalls(calls).length;

      expect(all.status).toBe("warn");
      expect(all.extra).toContain(">5 benchmarks</div>");
      expect(all.href).toBe("/bench?view=runtime&repo=labs");
      expect(selected.href).toBe("/bench?view=runtime&repo=labs&key=1");
      expect(rows(benchPage("p99", "file", 45)).map((row) => row.name))
        .toContain("topic board scale/1000");
      await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(artifactCalls(calls)).toHaveLength(downloads);
    });
  });

  it("opens the key tile's drilldown with only key rows and preserves the filter", async () => {
    const api = await history(938_000, (day) =>
      report([
        bench(
          navigation,
          "topic board",
          "journey",
          timings(day >= 5 ? 4e9 : 1e9),
        ),
        bench(scale, "topic board scale", "100", timings(1e9)),
        bench(scale, "topic board scale", "1000", timings(1e9)),
        bench("packages/other/other.bench.ts", null, "unrelated", timings(1e6)),
      ]));
    await withApi(api, async () => {
      const tile = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      const url = new URL(tile.href!, "http://x");
      const initial =
        await (await benchmark.routes![0].handler(new Request(url), url))
          .text();
      expect(initial).toContain('id="key-only" name="key" value="1" checked');
      expect(rows(initial).map((row) => row.name).sort()).toEqual([
        "topic board scale/100",
        "topic board/journey",
      ]);
      for (const sort of ["file", "duration", "trend"]) {
        const html = await page(`key=1&sort=${sort}&stat=p75&days=7`);
        expect(rows(html).map((row) => row.name.split(" &gt; ").at(-1)).sort())
          .toEqual([
            "topic board scale/100",
            "topic board/journey",
          ]);
        expect(html).toContain('<span class="cpu-detail">2 benchmarks ·');
        expect(html).not.toContain("packages/other/other.bench.ts");
        const links = [
          ...html.matchAll(/href="(\/bench\?view=runtime[^"]+)"/g),
        ];
        expect(links.length).toBeGreaterThan(1);
        for (const [, href] of links) {
          const target = new URL(href.replaceAll("&amp;", "&"), "http://x");
          expect(target.searchParams.get("key")).toBe("1");
          expect(target.searchParams.get("days")).toBe("7");
        }
        const fragment = await page(
          `key=1&sort=${sort}&stat=p75&days=7&fragment=range`,
        );
        expect(rows(fragment)).toEqual(rows(html));
      }
      const all = await page("");
      expect(all).toContain('id="key-only" name="key" value="1">');
      expect(rows(all)).toHaveLength(4);
      expect(all).toContain('<span class="cpu-detail">4 benchmarks ·');
      expect(rows(await page("key=0"))).toEqual(rows(all));
    });
  });

  it("shows an empty filtered view when only non-key benchmarks were measured", async () => {
    await withTotals(
      [{ id: 939_000, at: SAMPLED_BASE, total: 1e6 }],
      async () => {
        await benchmark.collect(ctx({ GH_TOKEN: "t" }));
        const html = await page("key=1");
        expect(rows(html)).toEqual([]);
        expect(html).toContain(
          "No benchmark samples were found in the selected window.",
        );
        expect(html).not.toContain('class="cpu-key"');
        expect(rows(await page(""))).toHaveLength(1);
      },
    );
  });

  it("reports a selected regression that the full benchmark set dilutes", async () => {
    const api = await history(931_000, (day) =>
      report([
        bench(
          navigation,
          "topic board",
          "journey",
          timings(day >= 5 ? 4e9 : 1e9),
        ),
        bench(scale, "topic board scale", "100", timings(1e9)),
        ...Array.from({ length: 38 }, (_, index) =>
          bench("packages/a/x.bench.ts", null, `flat ${index}`, timings(1e6))),
      ]));
    await withApi(api, async () => {
      const selected = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      const all = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(selected.status).toBe("warn");
      expect(selected.value).toBe("▲100%");
      expect(selected.extra).toContain(">2 benchmarks</div>");
      expect(all.status).toBe("good");
      expect(all.extra).toContain(">40 benchmarks</div>");
    });
    await withApi({ throws: new Error("network offline") }, async () => {
      const selected = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      expect(selected.status).toBe("unknown");
      expect(selected.value).toBe("▲100%");
      expect(selected.sub).toBeTruthy();
      // The reason takes the line the count would have had, rather than
      // standing above it and growing the tile past the row it sits in.
      expect(selected.extra).not.toContain("benchmarks</div>");
    });
  });

  it("keeps the index flat when a selected benchmark is added or removed", async () => {
    const api = await history(932_000, (day) =>
      report([
        bench(navigation, "topic board", "journey", timings(1e9)),
        ...(day >= 3 && day <= 6
          ? [bench(scale, "topic board scale", "100", timings(100e9))]
          : []),
        bench(scale, "topic board scale", "1000", timings(1e9 * (day + 1))),
      ]));
    await withApi(api, async () => {
      const selected = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      expect(selected.status).toBe("good");
      expect(selected.value).toBe("flat");
      expect(selected.extra).toContain(">1 benchmark</div>");
      expect(selected.duration).toBe(9 * DAY);
    });
  });

  it("reports missing selected data even when other benchmarks succeeded", async () => {
    await withApi({ pages: { 1: [] } }, async () => {
      expect(await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" })))
        .toMatchObject({
          status: "unknown",
          value: "—",
          sub: "no benchmark runs",
        });
    });
    await withTotals(
      [{ id: 933_000, at: SAMPLED_BASE, total: 1e6 }],
      async () => {
        expect(await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" })))
          .toMatchObject({
            status: "bad",
            value: "failed",
            sub: "no benchmark data",
          });
        const all = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
        expect(all.status).toBe("good");
        expect(all.extra).toContain(">1 benchmark</div>");
      },
    );
  });

  it("keeps the index flat when consecutive runs share no selected measurement", async () => {
    const api = await history(935_000, (day) => {
      const host = day >= 5 ? 0.8 : 1;
      return report([
        day < 5
          ? bench(navigation, "topic board", "journey", timings(1e9 * host))
          : bench(scale, "topic board scale", "100", timings(1e9 * host)),
        bench(scale, "topic board scale", "1000", timings(1e9 * host)),
        bench(
          CALIBRATION_FILE,
          null,
          "integer arithmetic",
          timings(1e6 * host),
        ),
      ]);
    });
    await withApi(api, async () => {
      const selected = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      const all = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(selected.status).toBe("good");
      expect(selected.value).toBe("flat");
      expect(selected.extra).toContain(">1 benchmark</div>");
      expect(all.value).toBe("flat");
    });
  });

  it("keeps the selected trend behind failure and running status", async () => {
    const api = await history(934_000, (day) =>
      report([
        bench(
          navigation,
          "topic board",
          "journey",
          timings(day >= 5 ? 2e9 : 1e9),
        ),
        bench(scale, "topic board scale", "100", timings(day >= 5 ? 2e9 : 1e9)),
      ]));
    api.pages![1].unshift(
      {
        ...ghRun(934_091, SAMPLED_BASE + 20 * 60_000, null),
        status: "in_progress",
      },
      ghRun(934_090, SAMPLED_BASE + 10 * 60_000, "failure"),
    );
    await withApi(api, async () => {
      const selected = await keyBenchmarks.collect(ctx({ GH_TOKEN: "t" }));
      expect(selected.status).toBe("bad");
      expect(selected.valueLabel).toBe("failed (was ▲100%)");
      expect(selected.sub).toMatch(/^last good .+ ago · 1 run failed$/);
      expect(selected.aside).toContain("running");
      expect(selected.extra).toContain("<svg");
      expect(selected.extra).not.toContain("2 benchmarks");
    });
  });

  it("gives an unreadable collection the count's line rather than a second one", async () => {
    // The tile keeps each run's results by id, so a range another test reads
    // would carry this test's measurements into it.
    const api = await history(936_000, () =>
      report([
        bench(navigation, "topic board", "journey", timings(1e9)),
        bench(scale, "topic board scale", "100", timings(1e9)),
      ]));
    await withApi(api, async () => {
      const measured = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(measured.sub).toBeUndefined();
      expect(measured.extra).toContain(">2 benchmarks</div>");
    });

    // Every tile in a row is as tall as the tallest, so a reason standing
    // above the count rather than in its place grows the whole row.
    await withApi({ throws: new Error("network offline") }, async () => {
      const offline = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
      expect(offline.status).toBe("unknown");
      expect(offline.sub).toBe("source unreachable");
      expect(offline.extra).not.toContain("benchmarks</div>");
      expect(offline.extra).toContain("<svg");
    });
  });
});
