/**
 * Tests for the generic runtime: the ticker, the SSE fan-out, the routes, and
 * the page. Importing server.ts neither serves nor collects, so nothing here
 * binds a port or reaches a source; the tiles are stand-ins with a canned
 * collect(), carrying the labels the real registry uses so their views reach
 * the page.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  broadcast,
  clients,
  handle,
  heartbeat,
  nextFaviconRedSince,
  page,
  resetBoardForTest,
  serveTick,
  start,
  tick,
} from "./server.ts";
import {
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  PORT,
} from "./config.ts";
import { TILES } from "./registry.ts";
import { github } from "./lib.ts";
import type { Ctx, Run, RunSource, Tile, TileView } from "./types.ts";
import { DASHBOARD_MESSAGE_LIFETIME_MS } from "./dashboard-message.ts";
import { dashboardCacheFile } from "./history-files.ts";

const req = (path: string) => new Request(`http://localhost${path}`);

// Registers a test that starts from a board nothing has collected into, so that
// it sees none of the views, run times, and red streak an earlier test left.
// The reset after the test fails the test that left a collection running.
function boardTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test(name, async () => {
    resetBoardForTest();
    await fn();
    resetBoardForTest();
  });
}

// intervalMs 0 keeps a stand-in due on every tick.
function fake(label: string, collect: () => TileView | Promise<TileView>, intervalMs = 0): Tile {
  return { label, intervalMs, collect: () => Promise.resolve(collect()) };
}

function sourceRun(id: number, title: string): Run {
  return {
    id,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: `sha-${id}`,
    display_title: title,
    created_at: new Date(Date.now() - id * 60_000).toISOString(),
    run_started_at: new Date(Date.now() - id * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: title },
  };
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sourceTile(
  label: string,
  runSources: readonly RunSource[],
  wide = false,
): Tile {
  return {
    label,
    intervalMs: 0,
    runSources,
    wide,
    async collect(ctx): Promise<TileView> {
      const snapshots = await Promise.all(runSources.map((source) => ctx.runsFor(source.repo, source.workflow)));
      const titles = snapshots.flat().map((run) => run.display_title);
      return { status: "good", value: titles.join(", ") || "empty" };
    },
  };
}

const dec = new TextDecoder();
async function chunk(r: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await r.read();
  assert(!done, "the event stream ended");
  return dec.decode(value);
}

interface TestUpdate {
  gridHtml: string;
  wideHtml: string;
  ageSeconds: number;
  shellVersion: string;
  faviconStatus: "good" | "warn" | "bad";
  faviconRedSince: number | null;
  faviconRedAgeMs: number | null;
  message: { text: string; updatedAt: number | null; revision: number };
}

function updateFromEvent(event: string): TestUpdate {
  assertStringIncludes(event, "event: update\n");
  return JSON.parse(event.match(/^data: (.*)$/m)?.[1] ?? "") as TestUpdate;
}

// The rendered markup for one tile, found by its label. The returned string
// starts with the tile's status classes.
function tileHtml(label: string, html = page()): string {
  const attribute = `" data-tile-label="${label}"`;
  const parts = html.split(/<(?:div|a) class="tile /);
  const hit = parts.filter((p) => {
    const at = p.indexOf(attribute);
    return at !== -1 && at === p.indexOf('"');
  });
  assertEquals(hit.length, 1, `expected exactly one tile labeled "${label}"`);
  assertStringIncludes(hit[0], `</span> ${label}<span class="spacer">`);
  return hit[0];
}

function faviconRedSinceInPage(): string {
  const match = page().match(/let faviconServerRedSince = ([^;]+);/);
  assert(match, "the page includes the server red timestamp");
  return match[1];
}

// Resolve on a published state, independently of any other pending collection.
function observeUpdate(matches: () => boolean) {
  const observed = deferred<void>();
  const client = {
    enqueue() {
      if (matches()) observed.resolve();
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  return {
    promise: observed.promise,
    [Symbol.dispose]: () => clients.delete(client),
  };
}

boardTest("healthz: not ok until the board has collected something", async () => {
  // Nothing has been collected yet, so the probe an external uptime check reads
  // must not claim the board is up.
  const res = await handle(req("/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: false, at: 0 });

  await tick([fake("ci", () => ({ status: "good", value: "passing" }))]);
  const collected = await (await handle(req("/healthz"))).json();
  assertEquals(collected.ok, true);
  assert(collected.at > 0, "collecting stamps the board's last change");
});

boardTest("registered tiles render before their first collection completes", () => {
  const html = page(new Map());
  for (const tile of TILES) {
    const placeholder = tileHtml(tile.label, html);
    assert(placeholder.startsWith(tile.wide ? `unknown wide"` : `unknown"`), placeholder);
    assert(!placeholder.includes(`class="big`), "a placeholder has no headline");
  }
});

boardTest("favicon: serves distinct status PNGs and defaults unknown requests to green", async () => {
  const signature = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  const encoded: string[] = [];
  for (const status of ["good", "warn", "bad", "bad-crying"]) {
    const res = await handle(req(`/favicon.png?status=${status}`));
    assertEquals(res.headers.get("content-type"), "image/png");
    assertEquals(res.headers.get("cache-control"), "public, max-age=3600");
    const png = new Uint8Array(await res.arrayBuffer());
    assertEquals(png.slice(0, signature.length), signature);
    encoded.push(png.toBase64());
  }
  assertEquals(new Set(encoded).size, 4, "each face has its own raster icon");

  const unknown = new Uint8Array(
    await (await handle(req("/favicon.png?status=unknown"))).arrayBuffer(),
  );
  assertEquals(unknown.toBase64(), encoded[0], "an unsupported status stays green");
});

boardTest("favicon: continuous red keeps its start time and recovery resets it", () => {
  assertEquals(nextFaviconRedSince(null, "good", 1_000), null);
  assertEquals(nextFaviconRedSince(null, "bad", 2_000), 2_000);
  assertEquals(nextFaviconRedSince(2_000, "bad", 3_000), 2_000);
  assertEquals(nextFaviconRedSince(2_000, "warn", 4_000), null);
  assertEquals(nextFaviconRedSince(null, "bad", 5_000), 5_000);
});

boardTest("per-collector updates keep a red handoff's incident age", async () => {
  const modelBad: TileView = {
    status: "bad",
    value: "failed",
  };
  const modelGood: TileView = {
    status: "good",
    value: "passing",
  };
  const gcpGood: TileView = {
    status: "good",
    value: "passing",
  };
  const gcpBad: TileView = {
    status: "bad",
    value: "failed",
  };
  await tick([
    fake("model spend", () => modelBad),
    fake("cloud spend", () => gcpGood),
  ]);
  const redSince = faviconRedSinceInPage();
  assert(redSince !== "null");

  let release = (_: TileView) => {};
  let published = () => {};
  const firstUpdate = new Promise<void>((resolve) => published = resolve);
  const client = {
    enqueue() {
      published();
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const handoff = tick([
    fake("model spend", () => modelGood),
    fake("cloud spend", () => new Promise<TileView>((resolve) => release = resolve)),
  ]);
  try {
    await firstUpdate;
    assert(tileHtml("model spend").startsWith(`good"`));
    assert(tileHtml("cloud spend").startsWith(`good"`));
    assertEquals(faviconRedSinceInPage(), redSince);
  } finally {
    clients.delete(client);
    release(gcpBad);
    await handoff;
  }
  assert(tileHtml("model spend").startsWith(`good"`));
  assert(tileHtml("cloud spend").startsWith(`bad"`));
  assertEquals(faviconRedSinceInPage(), redSince);

  await tick([
    fake("model spend", () => modelGood),
    fake("cloud spend", () => gcpGood),
  ]);
  assertEquals(faviconRedSinceInPage(), "null");
});

boardTest("simultaneous collector completions keep a red handoff's incident age", async () => {
  const realNow = Date.now;
  const startedAt = realNow() + 1_000;
  let now = startedAt;
  Date.now = () => now;
  const modelGood: TileView = {
    status: "good",
    value: "passing",
  };
  const modelBad: TileView = {
    status: "bad",
    value: "failed",
  };
  const gcpGood: TileView = {
    status: "good",
    value: "passing",
  };
  const gcpBad: TileView = {
    status: "bad",
    value: "failed",
  };
  const model = deferred<TileView>();
  const gcp = deferred<TileView>();
  let handoff: Promise<void> | undefined;
  try {
    await tick([
      fake("model spend", () => modelBad),
      fake("cloud spend", () => gcpGood),
    ]);
    const redSince = faviconRedSinceInPage();
    assertEquals(redSince, String(startedAt));

    now = startedAt + 1_000;
    handoff = tick([
      fake("model spend", () => model.promise),
      fake("cloud spend", () => gcp.promise),
    ]);
    model.resolve(modelGood);
    gcp.resolve(gcpBad);
    await handoff;

    assertEquals(faviconRedSinceInPage(), redSince);
  } finally {
    model.resolve(modelGood);
    gcp.resolve(gcpGood);
    await handoff;
    await tick([
      fake("model spend", () => modelGood),
      fake("cloud spend", () => gcpGood),
    ]);
    Date.now = realNow;
  }
});

boardTest("a tile stays wide through failures and keeps its last good view", async () => {
  await tick([fake("recent main runs", () => {
    throw new Error("HTTP 404: Not Found");
  })]);
  const firstFailure = tileHtml("recent main runs");
  assert(firstFailure.startsWith(`unknown wide"`));
  assertStringIncludes(firstFailure, `<p class="big unknown">—</p>`);
  assertStringIncludes(firstFailure, `<p class="sub" title="not found">not found</p>`);

  const good: TileView = { status: "good", value: "passing", sub: "10 runs" };
  await tick([fake("recent main runs", () => good)]);
  assert(tileHtml("recent main runs").startsWith(`good wide"`));

  await tick([fake("recent main runs", () => {
    throw new Error("error sending request for url");
  })]);
  const html = tileHtml("recent main runs");
  assert(html.startsWith(`unknown wide"`));
  assertStringIncludes(
    html,
    `<p class="big unknown">passing</p>`,
  );
  assertStringIncludes(
    html,
    `<p class="sub" title="source unreachable">source unreachable</p>`,
  );
});

boardTest("the ticker leaves a tile alone until its interval has elapsed", async () => {
  let collects = 0;
  const t = fake("interval probe", () => {
    collects++;
    return { status: "good", value: "passing" };
  }, 600_000);
  await tick([t]);
  assertEquals(collects, 1);
  const at = (await (await handle(req("/healthz"))).json()).at;
  assert(at > 0, "collecting stamps the board's last change");

  await tick([t]); // nothing is due this time
  assertEquals(collects, 1, "the tile is not re-collected inside its interval");
  assertEquals((await (await handle(req("/healthz"))).json()).at, at, "and nothing is reported as changed");
});

boardTest("an update still running after one minute stays gray until it completes", async () => {
  const realNow = Date.now;
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  const startedAt = realNow() + 10_000;
  let now = startedAt;
  Date.now = () => now;
  const lastView: TileView = {
    status: "good",
    value: "last value",
    sub: "last detail",
    extra: "<span>last chart</span>",
  };
  const finalView: TileView = {
    status: "good",
    value: "fresh value",
    sub: "fresh detail",
    extra: "<span>fresh chart</span>",
  };
  const final = deferred<TileView>();
  let publishIntermediate = (_view: TileView) => {};
  const tile: Tile = {
    label: "model spend",
    intervalMs: 0,
    async collect(_ctx, publish) {
      publishIntermediate = publish ?? publishIntermediate;
      return await final.promise;
    },
  };
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  let collection: Promise<void> | undefined;
  try {
    await tick([fake("model spend", () => lastView)]);
    now++;
    collection = tick([tile]);
    clients.add(client);

    now += 59_999;
    await tick([tile]);
    assert(tileHtml("model spend").startsWith(`good"`));
    assertEquals(messages.length, 0);

    now++;
    await tick([tile]);
    const stale = tileHtml("model spend");
    assert(stale.startsWith(`unknown"`));
    assertStringIncludes(stale, "last value");
    assertStringIncludes(stale, "refresh still pending");
    assertStringIncludes(stale, "last chart");
    assertEquals(messages.length, 1, "the stale transition is published");
    assertEquals(errors, [
      'dashboard refresh still pending: tiles "model spend" (60000 ms); ' +
      "active run sources none; active GitHub operations none",
    ]);

    now += 15_000;
    await tick([tile]);
    assertEquals(messages.length, 1, "later ticks do not repeat the stale transition");

    publishIntermediate({
      status: "good",
      value: "new cached value",
      sub: "new cached detail",
      extra: "<span>new cached chart</span>",
    });
    const intermediate = tileHtml("model spend");
    assert(intermediate.startsWith(`unknown"`));
    assertStringIncludes(intermediate, "new cached value");
    assertStringIncludes(intermediate, "refresh still pending");
    assertStringIncludes(intermediate, "new cached chart");

    final.resolve(finalView);
    await collection;
    const fresh = tileHtml("model spend");
    assert(fresh.startsWith(`good"`));
    assertStringIncludes(fresh, "fresh value");
    assertStringIncludes(fresh, "fresh detail");
  } finally {
    clients.delete(client);
    final.resolve(finalView);
    try {
      await collection;
    } finally {
      Date.now = realNow;
      console.error = realError;
    }
  }
});

boardTest("an intermediate view with no chart keeps the chart on the tile", async () => {
  const charted: TileView = {
    status: "good",
    value: "last value",
    extra: "<span>last chart</span>",
    duration: 3_600_000,
    alignChartBottom: true,
  };
  const final = deferred<TileView>();
  let publishIntermediate = (_view: TileView) => {};
  const tile: Tile = {
    label: "flaky tests",
    intervalMs: 0,
    collect(_ctx, publish) {
      publishIntermediate = publish ?? publishIntermediate;
      return final.promise;
    },
  };
  await tick([fake("flaky tests", () => charted)]);
  const collection = tick([tile]);
  try {
    publishIntermediate({
      status: "good",
      value: "headline ahead of the chart",
    });
    const intermediate = tileHtml("flaky tests");
    expect(intermediate).toContain("headline ahead of the chart");
    expect(intermediate).toContain("last chart");
    expect(intermediate).toContain("1 hour");

    // A chart the intermediate view brings of its own is the one to show.
    publishIntermediate({
      status: "good",
      value: "headline with a chart",
      extra: "<span>its own chart</span>",
    });
    const carried = tileHtml("flaky tests");
    expect(carried).toContain("its own chart");
    expect(carried).not.toContain("last chart");
  } finally {
    final.resolve({ status: "good", value: "complete" });
    await collection;
  }
  // The completed view has every part, so a tile it leaves chartless is one.
  const complete = tileHtml("flaky tests");
  expect(complete).toContain("complete");
  expect(complete).not.toContain("last chart");
  expect(complete).not.toContain("its own chart");
});

boardTest("a stale source log names its active GitHub operation", async () => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realWarn = console.warn;
  const realToken = Deno.env.get("GH_TOKEN");
  let now = realNow();
  Date.now = () => now;
  const errors: string[] = [];
  const warnings: string[] = [];
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(" "));
  const response = deferred<Response>();
  const requested = deferred<void>();
  globalThis.fetch = () => {
    requested.resolve();
    return response.promise;
  };
  Deno.env.set("GH_TOKEN", "test-token");
  const source = { repo: "test/github-diagnostic", workflow: "ci.yml" };
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    async runsFor() {
      const body = await github<{ workflow_runs: Run[] }>(
        "repos/test/github-diagnostic/actions/runs?branch=main",
      );
      return body.workflow_runs;
    },
    env: () => undefined,
  };
  const tile = sourceTile("GitHub diagnostic", [source]);
  let refresh: Promise<void> | undefined;
  try {
    refresh = tick([tile], sourceCtx);
    await requested.promise;
    now += 60_000;
    await tick([tile], sourceCtx);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0], 'tiles "GitHub diagnostic" (60000 ms)');
    assertStringIncludes(errors[0], "active run sources test/github-diagnostic ci.yml");
    assertStringIncludes(
      errors[0],
      "repos/test/github-diagnostic/actions/runs?branch=main (requesting GitHub, 60000 ms)",
    );
  } finally {
    response.resolve(Response.json({ workflow_runs: [] }));
    try {
      await refresh;
      assertEquals(warnings.length, 1);
      assertStringIncludes(
        warnings[0],
        "for repos/test/github-diagnostic/actions/runs?branch=main completed slowly after 60000 ms",
      );
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
      console.error = realError;
      console.warn = realWarn;
      if (realToken === undefined) Deno.env.delete("GH_TOKEN");
      else Deno.env.set("GH_TOKEN", realToken);
    }
  }
});

boardTest("a completed-views-only tile suppresses intermediate views and keeps its settled color", async () => {
  const realNow = Date.now;
  const startedAt = realNow() - 61_000;
  let now = startedAt;
  Date.now = () => now;
  const lastView: TileView = {
    status: "bad",
    value: "failed",
    sub: "last completed result",
  };
  const finalView: TileView = {
    status: "warn",
    value: "slower",
    sub: "new completed result",
  };
  const final = deferred<TileView>();
  let receivedPublisher = false;
  const tile: Tile = {
    label: "all benchmarks",
    intervalMs: 0,
    showOnlyCompletedViews: true,
    async collect(_ctx, publish) {
      receivedPublisher = publish !== undefined;
      return await final.promise;
    },
  };
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  let collection: Promise<void> | undefined;
  try {
    await tick([fake("all benchmarks", () => lastView)]);
    clients.add(client);
    now++;
    collection = tick([tile]);

    expect(receivedPublisher).toBe(false);
    assert(tileHtml("all benchmarks").startsWith(`bad"`));
    expect(messages).toEqual([]);

    now += 60_000;
    await tick([tile]);
    assert(tileHtml("all benchmarks").startsWith(`bad"`));
    expect(tileHtml("all benchmarks")).toContain("refresh still pending");
    expect(messages).toHaveLength(1);

    final.resolve(finalView);
    await collection;
    assert(tileHtml("all benchmarks").startsWith(`warn"`));
    expect(messages).toHaveLength(2);
  } finally {
    clients.delete(client);
    final.resolve(finalView);
    try {
      await collection;
    } finally {
      Date.now = realNow;
    }
  }
});

boardTest("the board refuses a reset while a collection is still running", async () => {
  await tick([fake("model spend", () => ({ status: "bad", value: "failed" }))]);
  const slow = deferred<TileView>();
  const collection = tick([fake("model spend", () => slow.promise)]);
  try {
    expect(() => resetBoardForTest()).toThrow(
      "the board cannot be reset while a collection is running",
    );
    assert(tileHtml("model spend").startsWith(`bad"`), "the refused reset kept the collected view");
  } finally {
    slow.resolve({ status: "good", value: "passing" });
    await collection;
  }
  assert(tileHtml("model spend").startsWith(`good"`));
  resetBoardForTest();
  assert(tileHtml("model spend").startsWith(`unknown"`), "the reset cleared the collected view");
});

boardTest("overlapping ticks skip a tile already updating and collect other due tiles", async () => {
  const slow = deferred<TileView>();
  let duplicateCollects = 0;
  let otherCollects = 0;
  const first = tick([fake("overlap slow", () => slow.promise)]);
  try {
    await tick([
      fake("overlap slow", () => {
        duplicateCollects++;
        return { status: "good" };
      }),
      fake("overlap fast", () => {
        otherCollects++;
        return { status: "good" };
      }),
    ]);

    assertEquals(duplicateCollects, 0, "the updating tile is not collected twice");
    assertEquals(otherCollects, 1, "another due tile is still collected");
  } finally {
    slow.resolve({ status: "good" });
    await first;
  }
});

boardTest("overlapping ticks skip an updating run source and refresh another source", async () => {
  const slowSource = { repo: "test/overlap-slow", workflow: "ci.yml" };
  const fastSource = { repo: "test/overlap-fast", workflow: "ci.yml" };
  const slowRuns = deferred<Run[]>();
  let slowFetches = 0;
  let fastFetches = 0;
  let slowCollections = 0;
  let fastCollections = 0;
  const sourceCtx: Ctx = {
    runs: () => slowRuns.promise,
    runsFor: (repo) => {
      if (repo === slowSource.repo) {
        slowFetches++;
        return slowRuns.promise;
      }
      fastFetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const slowTile: Tile = {
    label: "overlap source slow",
    intervalMs: 0,
    runSources: [slowSource],
    collect: () => {
      slowCollections++;
      return Promise.resolve({ status: "good" });
    },
  };
  const fastTile: Tile = {
    label: "overlap source fast",
    intervalMs: 0,
    runSources: [fastSource],
    collect: () => {
      fastCollections++;
      return Promise.resolve({ status: "good" });
    },
  };
  const first = tick([slowTile], sourceCtx);

  try {
    await tick([slowTile, fastTile], sourceCtx);
    assertEquals(slowFetches, 1, "the updating source is not fetched twice");
    assertEquals(slowCollections, 0, "the slow source has not completed");
    assertEquals(fastFetches, 1, "another due source is fetched");
    assertEquals(fastCollections, 1, "another source's tile is collected");
  } finally {
    slowRuns.resolve([]);
    await first;
  }
  assertEquals(slowCollections, 1);
});

boardTest("an unexpected standalone collection failure releases the tile for its next refresh", async () => {
  let collections = 0;
  const unreadable: TileView = {
    get status(): TileView["status"] {
      throw new Error("standalone view cannot be copied");
    },
  };
  const tile: Tile = {
    label: "standalone cleanup probe",
    intervalMs: 0,
    collect(_ctx, publish): Promise<TileView> {
      collections++;
      if (collections === 1) {
        publish?.(unreadable);
        throw new Error("standalone collection failed");
      }
      return Promise.resolve({ status: "good" });
    },
  };

  await assertRejects(
    () => tick([tile]),
    Error,
    "standalone view cannot be copied",
  );
  await tick([tile]);
  assertEquals(collections, 2, "the failed update no longer keeps the tile active");
});

boardTest("an unexpected source collection failure releases its source and tiles", async () => {
  const source = { repo: "test/source-cleanup", workflow: "ci.yml" };
  let fetches = 0;
  let collections = 0;
  const unreadable: TileView = {
    get status(): TileView["status"] {
      throw new Error("source view cannot be copied");
    },
  };
  const sourceCtx: Ctx = {
    runs: () => Promise.resolve([]),
    runsFor: () => {
      fetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const tile: Tile = {
    label: "source cleanup probe",
    intervalMs: 0,
    runSources: [source],
    collect(_ctx, publish): Promise<TileView> {
      collections++;
      if (collections === 1) {
        publish?.(unreadable);
        throw new Error("source collection failed");
      }
      return Promise.resolve({ status: "good" });
    },
  };

  await assertRejects(
    () => tick([tile], sourceCtx),
    Error,
    "source view cannot be copied",
  );
  await tick([tile], sourceCtx);
  assertEquals(fetches, 2, "the failed update no longer keeps the source active");
  assertEquals(collections, 2, "the failed update no longer keeps the tile active");
});

boardTest("a multi-source tile stays active until every source update completes", async () => {
  const realNow = Date.now;
  let now = realNow() + 20_000;
  Date.now = () => now;
  const slowSource = { repo: "test/multi-source-slow", workflow: "ci.yml" };
  const fastSource = { repo: "test/multi-source-fast", workflow: "ci.yml" };
  const slowRuns = deferred<Run[]>();
  const fastRuns = deferred<Run[]>();
  let slowFetches = 0;
  let fastFetches = 0;
  let collections = 0;
  const sourceCtx: Ctx = {
    runs: () => slowRuns.promise,
    runsFor: (repo) => {
      if (repo === slowSource.repo) {
        slowFetches++;
        return slowRuns.promise;
      }
      fastFetches++;
      return fastRuns.promise;
    },
    env: () => undefined,
  };
  const tile: Tile = {
    label: "recent main runs",
    intervalMs: 0,
    runSources: [slowSource, fastSource],
    collect: () => {
      collections++;
      return Promise.resolve({
        status: "good",
        value: "fresh source value",
      });
    },
  };
  let first: Promise<void> | undefined;
  let client: ReadableStreamDefaultController<Uint8Array> | undefined;

  try {
    await tick([fake("recent main runs", () => ({
      status: "good",
      value: "last source value",
    }))]);
    now++;
    first = tick([tile], sourceCtx);

    now += 60_000;
    await tick([tile], sourceCtx);
    const stale = tileHtml("recent main runs");
    assert(stale.startsWith(`unknown wide"`));
    assertStringIncludes(stale, "last source value");
    assertStringIncludes(stale, "refresh still pending");

    let published = () => {};
    const firstPublication = new Promise<void>((resolve) => published = resolve);
    client = {
      enqueue() {
        published();
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    clients.add(client);
    fastRuns.resolve([]);
    await firstPublication;
    assertEquals(collections, 1, "the ready source collected the tile");
    const partiallyComplete = tileHtml("recent main runs");
    assert(partiallyComplete.startsWith(`unknown wide"`));
    assertStringIncludes(partiallyComplete, "fresh source value");
    assertStringIncludes(partiallyComplete, "refresh still pending");

    await tick([tile], sourceCtx);
    assertEquals(slowFetches, 1, "the pending source was not fetched again");
    assertEquals(fastFetches, 1, "the completed source still skips the active tile");
  } finally {
    if (client) clients.delete(client);
    slowRuns.resolve([]);
    fastRuns.resolve([]);
    try {
      await first;
    } finally {
      Date.now = realNow;
    }
  }
  assertEquals(collections, 2, "the pending source completes its original collection");
  const complete = tileHtml("recent main runs");
  assert(complete.startsWith(`good wide"`));
  assertStringIncludes(complete, "fresh source value");
});

boardTest("each completed collection is published while slower tiles are still running", async () => {
  const messages: string[] = [];
  let firstPublished = (_message: string) => {};
  const firstUpdate = new Promise<string>((resolve) => firstPublished = resolve);
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      if (messages.length === 1) firstPublished(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const slow = deferred<TileView>();
  clients.add(client);
  const collection = tick([
    fake("ci", () => ({ status: "good", value: "fast" })),
    fake("your metric here", () => slow.promise),
  ]);
  try {
    const first = updateFromEvent(await firstUpdate).gridHtml;
    assertEquals(messages.length, 1);
    assertStringIncludes(tileHtml("ci", first), "fast");
    assert(!tileHtml("your metric here", first).includes("slow"));
    slow.resolve({ status: "good", value: "slow" });
    await collection;
  } finally {
    clients.delete(client);
    slow.resolve({ status: "good", value: "slow" });
    await collection;
  }
  assertEquals(messages.length, 2);
  assertStringIncludes(tileHtml("your metric here", updateFromEvent(messages[1]).gridHtml), "slow");
});

boardTest("each run source publishes its dependent tiles as one batch", async () => {
  const labsSource = { repo: "test/labs-incremental", workflow: "ci.yml" };
  const loomSource = { repo: "test/loom-incremental", workflow: "ci.yml" };
  const labs = deferred<Run[]>();
  const loom = deferred<Run[]>();
  const sourceCtx: Ctx = {
    runs: () => labs.promise,
    runsFor: (repo) => repo === labsSource.repo ? labs.promise : loom.promise,
    env: () => undefined,
  };
  const tiles = [
    sourceTile("ci", [labsSource]),
    sourceTile("labs ci trust", [labsSource]),
    sourceTile("your metric here", [loomSource]),
    sourceTile("loom ci trust", [loomSource]),
    sourceTile("recent main runs", [labsSource, loomSource], true),
  ];

  const messages: string[] = [];
  const waiting: ((message: string) => void)[] = [];
  const nextMessage = () => new Promise<string>((resolve) => waiting.push(resolve));
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      waiting.shift()?.(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const refresh = tick(tiles, sourceCtx);
  try {
    const firstMessage = nextMessage();
    labs.resolve([sourceRun(1, "labs new")]);
    const first = updateFromEvent(await firstMessage);
    assertStringIncludes(tileHtml("ci", first.gridHtml), "labs new");
    assertStringIncludes(tileHtml("labs ci trust", first.gridHtml), "labs new");
    assert(!tileHtml("your metric here", first.gridHtml).includes("loom new"));
    assertStringIncludes(tileHtml("recent main runs", first.wideHtml), "labs new");
    assertStringIncludes(first.wideHtml, "loom-incremental pending");
    assertEquals(messages.length, 1, "one source arrival produces one broadcast");

    const secondMessage = nextMessage();
    loom.resolve([sourceRun(2, "loom new")]);
    const second = updateFromEvent(await secondMessage);
    assertStringIncludes(tileHtml("your metric here", second.gridHtml), "loom new");
    assertStringIncludes(tileHtml("loom ci trust", second.gridHtml), "loom new");
    assertStringIncludes(second.wideHtml, "labs new, loom new");
    assert(!second.wideHtml.includes("pending"));
    assertEquals(messages.length, 2, "the second source produces the second broadcast");
    await refresh;
  } finally {
    clients.delete(client);
    labs.resolve([]);
    loom.resolve([]);
    await refresh;
  }
});

boardTest("a ready source publishes while an older combined collection is still running", async () => {
  const realNow = Date.now;
  let now = realNow() + 30_000;
  const labsSource = { repo: "test/labs-independent", workflow: "ci.yml" };
  const loomSource = { repo: "test/loom-independent", workflow: "ci.yml" };
  const labs = deferred<Run[]>();
  const loom = deferred<Run[]>();
  const oldCollection = deferred<void>();
  let started = () => {};
  const oldCollectionStarted = new Promise<void>((resolve) => started = resolve);
  let publishOld = (_view: TileView) => {};
  const sourceCtx: Ctx = {
    runs: () => labs.promise,
    runsFor: (repo) => repo === labsSource.repo ? labs.promise : loom.promise,
    env: () => undefined,
  };
  const combined: Tile = {
    label: "recent main runs",
    intervalMs: 0,
    runSources: [labsSource, loomSource],
    wide: true,
    async collect(ctx, publish): Promise<TileView> {
      const [labsRuns, loomRuns] = await Promise.all([
        ctx.runsFor(labsSource.repo, labsSource.workflow),
        ctx.runsFor(loomSource.repo, loomSource.workflow),
      ]);
      if (!loomRuns.length) {
        publishOld = publish ?? publishOld;
        started();
        await oldCollection.promise;
      }
      const titles = [...labsRuns, ...loomRuns].map((run) => run.display_title);
      return { status: "good", value: titles.join(", ") };
    },
  };
  const tiles = [
    sourceTile("ci", [labsSource]),
    sourceTile("your metric here", [loomSource]),
    combined,
  ];
  const messages: string[] = [];
  let published = (_message: string) => {};
  const nextMessage = () => new Promise<string>((resolve) => published = resolve);
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      published(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  let refresh: Promise<void> | undefined;
  Date.now = () => now;
  try {
    await tick([fake("recent main runs", () => ({
      status: "good",
      value: "prior combined",
    }))]);
    clients.add(client);
    refresh = tick(tiles, sourceCtx);
    labs.resolve([sourceRun(4, "labs ready")]);
    await oldCollectionStarted;

    now += 60_000;
    await tick(tiles, sourceCtx);
    assertStringIncludes(tileHtml("recent main runs"), "refresh still pending");
    messages.length = 0;

    const loomUpdate = nextMessage();
    loom.resolve([sourceRun(5, "loom ready")]);
    const first = updateFromEvent(await loomUpdate);
    assertStringIncludes(tileHtml("your metric here", first.gridHtml), "loom ready");
    const firstRecent = tileHtml("recent main runs", first.wideHtml);
    assertStringIncludes(firstRecent, "labs ready, loom ready");
    assert(firstRecent.startsWith(`unknown wide"`));
    assert(!tileHtml("ci", first.gridHtml).includes("labs ready"));
    publishOld({ status: "bad", value: "older cached merge" });
    assertEquals(messages.length, 1);
    assertStringIncludes(tileHtml("recent main runs"), "labs ready, loom ready");

    const labsUpdate = nextMessage();
    oldCollection.resolve(undefined);
    const second = updateFromEvent(await labsUpdate);
    assertStringIncludes(tileHtml("ci", second.gridHtml), "labs ready");
    const secondRecent = tileHtml("recent main runs", second.wideHtml);
    assertStringIncludes(secondRecent, "labs ready, loom ready");
    assert(secondRecent.startsWith(`good wide"`));
    assertEquals(messages.length, 2);
    await refresh;
  } finally {
    clients.delete(client);
    labs.resolve([]);
    loom.resolve([]);
    oldCollection.resolve(undefined);
    try {
      await refresh;
    } finally {
      Date.now = realNow;
    }
  }
});

boardTest("a shared run source preserves each dependent tile's per-source interval", async () => {
  const source = { repo: "test/source-cadence", workflow: "ci.yml" };
  let fetches = 0;
  let fastCollections = 0;
  let slowCollections = 0;
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    runsFor: () => {
      fetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const tiles: Tile[] = [
    {
      label: "ci",
      intervalMs: 0,
      runSources: [source],
      collect(): Promise<TileView> {
        fastCollections++;
        return Promise.resolve({ status: "good" });
      },
    },
    {
      label: "labs ci trust",
      intervalMs: 600_000,
      runSources: [source],
      collect(): Promise<TileView> {
        slowCollections++;
        return Promise.resolve({ status: "good" });
      },
    },
  ];

  await tick(tiles, sourceCtx);
  await tick(tiles, sourceCtx);

  assertEquals(fetches, 2);
  assertEquals(fastCollections, 2);
  assertEquals(slowCollections, 1);
});

boardTest("a failed run source keeps its last good snapshot", async () => {
  const source = { repo: "test/stale-source", workflow: "ci.yml" };
  let failing = false;
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    runsFor: () => failing
      ? Promise.reject(new Error("error sending request for url"))
      : Promise.resolve([sourceRun(3, "last good run")]),
    env: () => undefined,
  };
  const tile = sourceTile("ci", [source]);

  await tick([tile], sourceCtx);
  assertStringIncludes(tileHtml("ci"), "last good run");

  failing = true;
  await tick([tile], sourceCtx);
  const stale = tileHtml("ci");
  assert(stale.startsWith(`unknown"`));
  assertStringIncludes(stale, "last good run");
  assertStringIncludes(stale, "stale-source source unreachable");
});

boardTest("a run source that reads backwards in time keeps its last good snapshot", async () => {
  const source = { repo: "test/backwards-source", workflow: "ci.yml" };
  // sourceRun times a run from its id, so run 5000 is weeks behind run 3. A
  // fetch answering with the older one read a stale view of the workflow.
  let stale = false;
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    runsFor: () =>
      Promise.resolve([sourceRun(stale ? 5000 : 3, stale ? "weeks-old run" : "current run")]),
    env: () => undefined,
  };
  const tile = sourceTile("ci", [source]);

  await tick([tile], sourceCtx);
  assertStringIncludes(tileHtml("ci"), "current run");

  stale = true;
  await tick([tile], sourceCtx);
  const held = tileHtml("ci");
  assert(held.startsWith(`unknown"`));
  assertStringIncludes(held, "current run");
  assert(!held.includes("weeks-old run"), held);
  assertStringIncludes(held, "backwards-source");

  stale = false;
  await tick([tile], sourceCtx);
  const recovered = tileHtml("ci");
  assert(recovered.startsWith(`good"`));
  assertStringIncludes(recovered, "current run");
});

boardTest("a tile can publish cached data while its collection is still running", async () => {
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  let releaseCollection!: (view: TileView) => void;
  const finalView = new Promise<TileView>((resolve) => {
    releaseCollection = resolve;
  });
  let cachedPublished!: () => void;
  const sawCached = new Promise<void>((resolve) => {
    cachedPublished = resolve;
  });
  let publishIntermediate = (_view: TileView) => {};
  let collection: Promise<void> | undefined;
  clients.add(client);
  try {
    collection = tick([{
      label: "all benchmarks",
      intervalMs: 0,
      async collect(_ctx, publish) {
        publishIntermediate = publish ?? publishIntermediate;
        publish?.({ status: "good", value: "cached" });
        cachedPublished();
        return await finalView;
      },
    }]);
    await sawCached;
    assertEquals(messages.length, 1);
    assertStringIncludes(updateFromEvent(messages[0]).gridHtml, "cached");

    releaseCollection({
      status: "good",
      value: "refreshed",
    });
    await collection;
    assertEquals(messages.length, 2);
    assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "refreshed");
    publishIntermediate({
      status: "bad",
      value: "late cached value",
    });
    assertEquals(messages.length, 2);
    assertStringIncludes(tileHtml("all benchmarks"), "refreshed");
  } finally {
    releaseCollection({
      status: "unknown",
      value: "stopped",
    });
    await collection;
    clients.delete(client);
  }
});

boardTest("a source-backed tile can publish cached data while its collection is still running", async () => {
  const source = { repo: "test/intermediate-source", workflow: "ci.yml" };
  const sourceCtx: Ctx = {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: () => undefined,
  };
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const finalView = deferred<TileView>();
  let cachedPublished = () => {};
  const sawCached = new Promise<void>((resolve) => cachedPublished = resolve);
  let publishIntermediate = (_view: TileView) => {};
  let collection: Promise<void> | undefined;
  clients.add(client);
  try {
    collection = tick([{
      label: "all benchmarks",
      intervalMs: 0,
      runSources: [source],
      async collect(_ctx, publish) {
        publishIntermediate = publish ?? publishIntermediate;
        publish?.({ status: "good", value: "cached" });
        cachedPublished();
        return await finalView.promise;
      },
    }], sourceCtx);
    await sawCached;
    assertEquals(messages.length, 1);
    assertStringIncludes(updateFromEvent(messages[0]).gridHtml, "cached");

    finalView.resolve({ status: "good", value: "refreshed" });
    await collection;
    assertEquals(messages.length, 2);
    assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "refreshed");
    publishIntermediate({ status: "bad", value: "late cached value" });
    assertEquals(messages.length, 2);
    assertStringIncludes(tileHtml("all benchmarks"), "refreshed");
  } finally {
    finalView.resolve({ status: "unknown", value: "stopped" });
    await collection;
    clients.delete(client);
  }
});

boardTest("sse: /events opens a stream, tick pushes new tile markup, disconnect drops the client", async () => {
  const res = await handle(req("/events"));
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("cache-control"), "no-cache");
  const reader = res.body!.getReader();
  assertEquals(await chunk(reader), ": connected\n\n");
  assertEquals(clients.size, 1);
  const initial = updateFromEvent(await chunk(reader));
  // The page reloads itself when these two disagree, so the version the stream
  // reports has to be the one the page it is feeding was built with.
  const page = await (await handle(req("/"))).text();
  assertStringIncludes(
    page,
    `const SHELL_VERSION = ${JSON.stringify(initial.shellVersion)};`,
  );
  assert(initial.ageSeconds >= 0);
  assert(["good", "warn", "bad"].includes(initial.faviconStatus));
  assert(Object.hasOwn(initial, "faviconRedSince"));
  assert(Object.hasOwn(initial, "faviconRedAgeMs"));

  await tick([fake("ci", () => ({ status: "good", value: "live update" }))]);
  const update = updateFromEvent(await chunk(reader));
  assertStringIncludes(tileHtml("ci", update.gridHtml), "live update");
  assert(update.ageSeconds >= 0);
  assertEquals(update.shellVersion, initial.shellVersion);
  assert(["good", "warn", "bad"].includes(update.faviconStatus));
  assert(Object.hasOwn(update, "faviconRedSince"));
  assert(Object.hasOwn(update, "faviconRedAgeMs"));

  await reader.cancel();
  assertEquals(clients.size, 0, "a disconnected browser is not kept as a client");
});

boardTest("message: an edit is saved and sent to every connected dashboard", async () => {
  const events = await handle(req("/events"));
  const reader = events.body!.getReader();
  await chunk(reader);
  await chunk(reader);
  try {
    const response = await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  Deploying <main>  " }),
    }));
    assertEquals(response.status, 200);
    const saved = await response.json();
    assertEquals(saved.text, "Deploying <main>");
    assertEquals(typeof saved.updatedAt, "number");
    assertEquals(typeof saved.revision, "number");

    const update = updateFromEvent(await chunk(reader));
    assertEquals(update.message, saved);
    const html = await (await handle(req("/"))).text();
    assertStringIncludes(html, `value="Deploying &lt;main&gt;"`);
  } finally {
    await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }));
    await reader.cancel();
  }
});

boardTest("message: malformed edits are rejected without changing the message", async () => {
  const malformedJson = await handle(new Request("http://localhost/message", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  }));
  assertEquals(malformedJson.status, 400);
  assertEquals(await malformedJson.json(), {
    error: "Expected a JSON request body.",
  });

  const missingText = await handle(new Request("http://localhost/message", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "wrong field" }),
  }));
  assertEquals(missingText.status, 400);

  for (const body of ["null", "42", "[]"]) {
    const response = await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    }));
    assertEquals(response.status, 400);
  }

  const tooLong = await handle(new Request("http://localhost/message", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(501) }),
  }));
  assertEquals(tooLong.status, 400);
  assertEquals(await tooLong.json(), {
    error: "Messages are limited to 500 characters.",
  });

  const wrongMethod = await handle(req("/message"));
  assertEquals(wrongMethod.status, 405);
  assertEquals(wrongMethod.headers.get("allow"), "PUT");
});

boardTest("message: a persistence failure returns an error", async () => {
  const temporary = `${dashboardCacheFile("fabric-wall-message.json")}.tmp`;
  await Deno.mkdir(temporary);
  try {
    const response = await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Cannot persist" }),
    }));
    assertEquals(response.status, 500);
    assertEquals(await response.json(), {
      error: "Could not save the dashboard message.",
    });
  } finally {
    await Deno.remove(temporary);
  }
});

boardTest("message: a failed expiry write retains the saved text", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const temporary = `${dashboardCacheFile("fabric-wall-message.json")}.tmp`;
  try {
    const saved = await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Still visible" }),
    }));
    assertEquals(saved.status, 200);
    await Deno.mkdir(temporary);
    now += DASHBOARD_MESSAGE_LIFETIME_MS;

    await serveTick(() => {});
    assertStringIncludes(
      await (await handle(req("/"))).text(),
      `value="Still visible"`,
    );
  } finally {
    Date.now = realNow;
    await Deno.remove(temporary);
    await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }));
  }
});

boardTest("message: the serving clock clears text after its fade completes", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const events = await handle(req("/events"));
  const reader = events.body!.getReader();
  await chunk(reader);
  await chunk(reader);
  try {
    const saved = await (await handle(new Request("http://localhost/message", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Fading announcement" }),
    }))).json();
    assertEquals(updateFromEvent(await chunk(reader)).message.text, "Fading announcement");

    now += DASHBOARD_MESSAGE_LIFETIME_MS;
    await serveTick(() => {});
    assertStringIncludes(await chunk(reader), "event: ping\n");
    assertEquals(updateFromEvent(await chunk(reader)).message, {
      text: "",
      updatedAt: null,
      revision: saved.revision + 1,
    });
  } finally {
    Date.now = realNow;
    await reader.cancel();
  }
});

boardTest("sse: every serving tick sends a heartbeat, so silence means a broken stream", async () => {
  const res = await handle(req("/events"));
  const reader = res.body!.getReader();
  await chunk(reader); // ": connected"
  await chunk(reader); // the snapshot every connection opens with

  let collections = 0;
  await serveTick(() => {
    collections++;
  });
  assertEquals(collections, 1, "the tick still collects what is due");
  const beat = await chunk(reader);
  assertStringIncludes(beat, "event: ping\n");
  // An event with no data is never delivered to the page, so the heartbeat
  // carries its count.
  assertMatch(beat, /^data: \d+$/m);

  await serveTick(() => {});
  const next = await chunk(reader);
  assertStringIncludes(next, "event: ping\n");
  assert(
    Number(next.match(/^data: (\d+)$/m)![1]) >
      Number(beat.match(/^data: (\d+)$/m)![1]),
    "each heartbeat differs from the last",
  );

  await reader.cancel();
});

boardTest("heartbeat: a client whose stream is gone is dropped rather than throwing", async () => {
  const res = await handle(req("/events"));
  const dead = [...clients].at(-1)!;
  await res.body!.cancel();
  clients.add(dead);
  heartbeat();
  assertEquals(clients.size, 0);
});

boardTest("broadcast: a client whose stream is gone is dropped rather than throwing", async () => {
  const res = await handle(req("/events"));
  const dead = [...clients].at(-1)!;
  await res.body!.cancel(); // closes the stream, so enqueueing to it now throws
  clients.add(dead); // back in the set, standing for a disconnect that went unnoticed
  broadcast({
    gridHtml: "",
    wideHtml: "",
    ageSeconds: 0,
    shellVersion: "test-shell",
    faviconStatus: "good",
    faviconRedSince: null,
    faviconRedAgeMs: null,
    message: { text: "", updatedAt: null, revision: 0 },
  });
  assertEquals(clients.size, 0);
});

boardTest("sse: every serving tick reaches the open live pages, and only live pages have a stream", async () => {
  const refused = await handle(req(`/events?page=${encodeURIComponent("/not-a-route")}`));
  assertEquals(refused.status, 404);
  await refused.body?.cancel();

  // The test selection page reads an empty manifest store.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json({ items: [] }));
  try {
    const res = await handle(req(`/events?page=${encodeURIComponent("/test-selection")}`));
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    assertEquals(await chunk(reader), ": connected\n\n");
    const opened = await chunk(reader);
    assertStringIncludes(opened, "event: page\n");
    assertStringIncludes(opened, "No selection manifest has been published yet.");
    assertEquals(clients.size, 0, "a page's stream is not the dashboard's");

    await serveTick(() => {});
    assertStringIncludes(await chunk(reader), "event: ping\n");
    await reader.cancel();
  } finally {
    globalThis.fetch = realFetch;
  }
});

boardTest("routes: a tile's drill-down path wins over the page; anything else is the page", async () => {
  const gantt = await handle(req("/bench?view=gantt&repo=loom"));
  assertEquals(gantt.status, 200);
  const html = await gantt.text();
  assertStringIncludes(html, "<title>CI run Gantt</title>");
  assertStringIncludes(html, `${LOOM_REPO} · ${LOOM_CI_WORKFLOW}`);

  const sha = "c".repeat(40);
  const commitGantt = await handle(
    req(`/ci-gantt?repo=labs&sha=${sha}&limit=1&mainOnly=1&run=901:1`),
  );
  assertEquals(commitGantt.status, 200);
  assertStringIncludes(
    await commitGantt.text(),
    `<title>CI Gantt · ${sha.slice(0, 7)}</title>`,
  );

  const fallback = await handle(req("/not-a-route"));
  assertEquals(fallback.status, 200);
  assertEquals(fallback.headers.get("content-type"), "text/html; charset=utf-8");
  assertStringIncludes(await fallback.text(), "<title>Dashboard — LIVE</title>");
});

boardTest("start: serves the handler on the configured port and keeps collecting", () => {
  const served: { opts: Deno.ServeTcpOptions; handler: unknown }[] = [];
  const logged: string[] = [];
  let collections = 0;
  const log = console.log;
  console.log = (m: string) => logged.push(m);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    timer = start(((opts: Deno.ServeTcpOptions, handler: unknown) => {
      served.push({ opts, handler });
      opts.onListen?.({ transport: "tcp", hostname: "localhost", port: PORT });
      return undefined;
    }) as unknown as typeof Deno.serve, () => {
      collections++;
    }).timer;
  } finally {
    clearInterval(timer);
    console.log = log;
  }
  assertEquals(served.length, 1);
  assertEquals(served[0].opts.port, PORT);
  assertEquals(served[0].handler, handle, "every request goes through the one handler");
  assertStringIncludes(logged[0], `http://localhost:${PORT}`);
  assertStringIncludes(logged[0], `${TILES.length} tiles registered`);
  assertEquals(collections, 1, "startup collects immediately");
});

boardTest("start: the work it schedules on its clock both heartbeats and collects", async () => {
  const res = await handle(req("/events"));
  const reader = res.body!.getReader();
  await chunk(reader); // ": connected"
  await chunk(reader); // the snapshot every connection opens with

  const log = console.log;
  console.log = () => {};
  let collections = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let onTick = () => Promise.resolve();
  try {
    ({ timer, onTick } = start(
      ((opts: Deno.ServeTcpOptions) => {
        opts.onListen?.({ transport: "tcp", hostname: "localhost", port: PORT });
        return undefined;
      }) as unknown as typeof Deno.serve,
      () => {
        collections++;
      },
    ));
  } finally {
    clearInterval(timer);
    console.log = log;
  }
  assertEquals(collections, 1, "the startup collection does not go through the clock");

  // Without this, a browser hears nothing between tile changes and replaces a
  // healthy stream once a minute forever.
  await onTick();
  assertStringIncludes(await chunk(reader), "event: ping\n");
  assertEquals(collections, 2);

  await reader.cancel();
});

describe("workflow activity", () => {
  beforeEach(resetBoardForTest);
  afterEach(resetBoardForTest);

  it("preserves the last badge while measurements keep refreshing", async () => {
    using time = new FakeTime(Date.now() + 86_400_000);
    let value = "50%";
    let reads = 0;
    let activity = Promise.resolve<boolean | undefined>(true);
    const tiles: Tile[] = ["test selection", "flaky tests"].map((label) => ({
      label,
      intervalMs: 30_000,
      collectActivity: () => activity,
      collect: () => {
        reads++;
        return Promise.resolve({
          status: "good",
          value,
          extra: "<span>chart</span>",
        });
      },
    }));
    await tick(tiles);
    for (const tile of tiles) {
      expect(tileHtml(tile.label)).toContain('class="running"');
    }
    const pending = deferred<boolean | undefined>();
    activity = pending.promise;
    time.tick(30_001);
    value = "75%";
    using published = observeUpdate(() =>
      tiles.every((tile) => tileHtml(tile.label).includes("75%"))
    );
    const collecting = tick(tiles);
    try {
      await published.promise;
      time.tick(60_001);
      value = "100%";
      await tick(tiles);
      expect(reads).toBe(6);
      for (const tile of tiles) {
        const html = tileHtml(tile.label);
        assert(html.startsWith('good"'));
        expect(html).toContain("100%");
        expect(html).toContain("chart");
        expect(html).toContain('class="running"');
        assert(!html.includes("refresh still pending"));
      }
    } finally {
      pending.resolve(false);
      await collecting;
    }
    for (const tile of tiles) {
      assert(!tileHtml(tile.label).includes('class="running"'));
    }
  });

  it("publishes activity changes while measurements remain pending", async () => {
    using _time = new FakeTime(Date.now() + 2 * 86_400_000);
    const oldView: TileView = {
      status: "good",
      value: "50%",
    };
    let measurement = Promise.resolve(oldView);
    let running = false;
    const tile: Tile = {
      label: "test selection",
      intervalMs: 0,
      collectActivity: () => Promise.resolve(running),
      collect: () => measurement,
    };
    await tick([tile]);
    const pending = deferred<TileView>();
    measurement = pending.promise;
    running = true;
    using published = observeUpdate(() =>
      tileHtml(tile.label).includes('class="running"')
    );
    const collecting = tick([tile]);
    try {
      await published.promise;
      expect(tileHtml(tile.label)).toContain("50%");
      running = false;
      await tick([tile]);
      assert(!tileHtml(tile.label).includes('class="running"'));
      expect(tileHtml(tile.label)).toContain("50%");
    } finally {
      pending.resolve({ ...oldView, value: "75%" });
      await collecting;
    }
    expect(tileHtml(tile.label)).toContain("75%");
  });

  it("preserves measurements and other header facets when activity reads fail", async () => {
    using _time = new FakeTime(Date.now() + 3 * 86_400_000);
    const view: TileView = {
      status: "warn",
      value: "2 flaky tests",
      aside:
        '<span class="hfacet" title="24h old">24h old</span><span>history warning</span>',
      extra: "<span>chart</span>",
    };
    const tile: Tile = {
      label: "flaky tests",
      intervalMs: 0,
      collect: () => Promise.resolve(view),
      collectActivity: () => Promise.reject(new Error('bad "<script>"')),
    };
    await tick([tile]);
    const html = tileHtml(tile.label);
    assert(html.startsWith('warn"'));
    for (
      const content of [
        "2 flaky tests",
        "chart",
        "24h old",
        "history warning",
        "activity unknown",
        "temporarily unavailable",
      ]
    ) {
      expect(html).toContain(content);
    }
    assert(!html.includes('bad "<script>"'));
    tile.collectActivity = () => Promise.resolve(undefined);
    await tick([tile]);
    assert(!tileHtml(tile.label).includes("activity unknown"));
    expect(tileHtml(tile.label)).toContain("history warning");
  });
});
