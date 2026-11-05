/**
 * dau tile tests: collect(ctx) -> TileView against a stubbed SigNoz. No network:
 * globalThis.fetch is swapped for the duration of a test and put back afterwards.
 * The pure helpers (foldSeries, parseExcludes) are pinned in
 * ../tiles.test.ts; what is pinned here is the tile's own reading of a response.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../types.ts";
import { dau } from "./dau.ts";

const DAY_MS = 86_400_000;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
// A UTC-midnight timestamp n complete days back. day(0) is the bucket still filling.
const day = (n: number) => TODAY - n * DAY_MS;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

const ser = (did: string, pts: [number, number][]) => ({
  labels: [{ key: { name: "user.did" }, value: did }],
  values: pts.map(([timestamp, value]) => ({ timestamp, value })),
});

// The v5 query_range envelope SigNoz answers with, down to the series.
const envelope = (aggregations: unknown) => ({
  data: { data: { results: [{ aggregations }] } },
});

// Runs `body` with fetch replaced by `stub`, and hands back every request the
// tile made so a test can assert on what was asked for.
async function withFetch<T>(
  stub: (req: Request) => Response | Promise<Response> | never,
  body: () => Promise<T>,
): Promise<{ result: T; requests: Request[] }> {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (input: URL | RequestInfo, init?: RequestInit) => {
    const req = new Request(input as URL | Request | string, init);
    requests.push(req);
    return Promise.resolve(stub(req));
  };
  try {
    return { result: await body(), requests };
  } finally {
    globalThis.fetch = original;
  }
}

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });

const ok = (aggregations: unknown) => () => json(envelope(aggregations));

Deno.test("dau: the headline is the last complete UTC day, not the part-day in progress", async () => {
  const series = [
    ser("did:key:alice", [[day(2), 10], [day(1), 10], [day(0), 4]]),
    ser("did:key:bob", [[day(1), 7], [day(0), 2]]),
    ser("did:key:carol", [[day(1), 1]]),
  ];
  const { result: v } = await withFetch(
    ok([{ series }]),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "good");
  // Yesterday saw three identities; today's two are ignored while the bucket fills.
  assertEquals(v.value, "3");
  assertEquals(v.sub, "active identities · toolshed-production");
  assert((v.extra ?? "").startsWith("<svg"), "a sparkline is drawn for the observed days");
});

Deno.test("dau: named service names itself in the query and in the sub line", async () => {
  const { result: v, requests } = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(1), 5]])] }]),
    () =>
      dau.collect(ctx({
        SIGNOZ_URL: "https://signoz.example/",
        SIGNOZ_API_KEY: "secret",
        PROD_SERVICE: "toolshed-staging",
      })),
  );
  assertEquals(v.sub, "active identities · toolshed-staging");
  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, "https://signoz.example/api/v5/query_range");
  assertEquals(requests[0].headers.get("SIGNOZ-API-KEY"), "secret");
  const body = await requests[0].json();
  const spec = body.compositeQuery.queries[0].spec;
  assertEquals(
    spec.filter.expression,
    "service.name = 'toolshed-staging' AND name IN ('memory.transact', 'memory.subscriber.sync') AND user.did EXISTS",
  );
  assertEquals(spec.groupBy[0].name, "user.did");
  assertEquals(spec.stepInterval, 86_400);
  // The window is aligned to UTC midnight and reaches back over the retained fortnight.
  assertEquals(body.end, TODAY + DAY_MS);
  assertEquals(body.end - body.start, 15 * DAY_MS);
});

Deno.test("dau: an unsafe PROD_SERVICE cannot reach the query expression", async () => {
  const { result: v, requests } = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(1), 5]])] }]),
    () =>
      dau.collect(ctx({
        SIGNOZ_URL: "https://signoz.example",
        SIGNOZ_API_KEY: "k",
        PROD_SERVICE: "x' OR '1'='1",
      })),
  );
  const body = await requests[0].json();
  assertStringIncludes(body.compositeQuery.queries[0].spec.filter.expression, "service.name = 'toolshed-production'");
  assertEquals(v.sub, "active identities · toolshed-production");
});

Deno.test("dau: DAU_EXCLUDE_DIDS takes service principals out of the count", async () => {
  const series = [
    ser("did:key:alice", [[day(1), 10]]),
    ser("did:key:server", [[day(1), 900]]),
  ];
  const env = { SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" };
  const both = await withFetch(ok([{ series }]), () => dau.collect(ctx(env)));
  assertEquals(both.result.value, "2");
  const humans = await withFetch(
    ok([{ series }]),
    () => dau.collect(ctx({ ...env, DAU_EXCLUDE_DIDS: "did:key:server" })),
  );
  assertEquals(humans.result.value, "1");
});

Deno.test("dau: a service that exports nothing -> gray, not zero", async () => {
  // SigNoz answers a query that matched no spans with no aggregations at all. Reading
  // that as a count would put a false green zero on the dashboard for a deployment whose
  // tracing is simply switched off.
  const { result: v } = await withFetch(
    ok(null),
    () =>
      dau.collect(ctx({
        SIGNOZ_URL: "https://signoz.example",
        SIGNOZ_API_KEY: "k",
        PROD_SERVICE: "toolshed-staging",
      })),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "no toolshed-staging spans");
  assertEquals(v.extra, undefined);
});

Deno.test("dau: only a part-day so far -> gray, and says so rather than claiming no spans", async () => {
  // A service that started exporting today has sent plenty of spans; it just has no
  // day that ran to the end. Reporting the part-day would read as a drop, and saying
  // there are no spans would be false — this is the state of a deployment whose
  // tracing was switched on today, and it has a number tomorrow.
  const { result: v } = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(0), 3]])] }]),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "insufficient data");
});

Deno.test("dau: without SIGNOZ_URL + SIGNOZ_API_KEY the tile grays out and asks nothing", async () => {
  const { result: v, requests } = await withFetch(
    () => {
      throw new Error("the tile must not call out without its env");
    },
    () => dau.collect(ctx({ SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "set SIGNOZ_URL + SIGNOZ_API_KEY");
  assertEquals(requests.length, 0);
  assertEquals(v.href, undefined); // no drill-down without a base to drill into
});

Deno.test("dau: SigNoz unreachable -> gray carrying the reason, never a count", async () => {
  const refused = await withFetch(
    () => {
      throw new TypeError("connection refused");
    },
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(refused.result.status, "unknown");
  assertEquals(refused.result.value, "—");
  assertEquals(refused.result.sub, "SigNoz unavailable");
  // The drill link survives the failure, so the reason can be chased from the dashboard.
  assertEquals(refused.result.href, "https://signoz.example/traces-explorer");

  const rejected = await withFetch(
    () => new Response("nope", { status: 401 }),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "wrong" })),
  );
  assertEquals(rejected.result.status, "unknown");
  assertEquals(rejected.result.sub, "SigNoz HTTP 401");
});

Deno.test("dau: a thrown non-Error still reads as SigNoz being unavailable", async () => {
  const { result: v } = await withFetch(
    () => {
      throw "kaput";
    },
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.sub, "SigNoz unavailable");
});

Deno.test("dau: a quiet day inside the observed range is a zero, and the grid starts at the first day seen", async () => {
  // Activity on day-4 and day-1 only. The days between are absent from the response
  // rather than zero, and the 14-day lookback stretches well before day-4. Alice's
  // day-3 bucket is present but carries no spans, which is not alice being active.
  const series = [
    ser("did:key:alice", [[day(4), 10], [day(3), 0], [day(1), 10]]),
    ser("did:key:bob", [[day(1), 3]]),
  ];
  const { result: v } = await withFetch(
    ok([{ series }]),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.value, "2");
  // day-4 through day-1 inclusive: four points, not fourteen. The days before the
  // first one seen are an absence of instrumentation, not quiet days.
  const pts = (v.extra ?? "").match(/points="([^"]+)"/)?.[1].split(" ") ?? [];
  assertEquals(pts.length, 4);
  assertEquals(v.duration, 4 * DAY_MS);
  // The gaps are drawn at the floor of the range and the ends above it, so the
  // filled zeros are real zeros rather than the line skipping them.
  const y = pts.map((p) => Number(p.split(",")[1]));
  assertEquals(y[1], y[2]); // the two quiet days sit at the same height
  assert(y[1] > y[0] && y[1] > y[3], "a quiet day is drawn below the days either side");
});

Deno.test("dau: the drill link comes from SIGNOZ_UI_URL, and a non-https base gets no link", async () => {
  const named = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(1), 5]])] }]),
    () =>
      dau.collect(ctx({
        SIGNOZ_URL: "https://ingest.signoz.example",
        SIGNOZ_API_KEY: "k",
        SIGNOZ_UI_URL: "https://ui.signoz.example/",
      })),
  );
  assertEquals(named.result.href, "https://ui.signoz.example/traces-explorer");
  assertEquals(named.result.hint, "traces ↗");

  // An internal http:// endpoint is not somewhere a browser on the dashboard can follow.
  const internal = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(1), 5]])] }]),
    () => dau.collect(ctx({ SIGNOZ_URL: "http://signoz.internal:8080", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(internal.result.href, undefined);
  assertEquals(internal.result.hint, undefined);
  assertEquals(internal.result.value, "1"); // the count still lands
});

Deno.test("dau: a response with no results at all -> gray", async () => {
  const { result: v } = await withFetch(
    () => json({}),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.sub, "no toolshed-production spans");
});

Deno.test("dau: a single complete day is a number with no chart and no span", async () => {
  // The first day after a deployment starts exporting. One point cannot be a line, so
  // there is no chart — and then there is no chart corner for a span to label either.
  const { result: v } = await withFetch(
    ok([{ series: [ser("did:key:alice", [[day(1), 4]]), ser("did:key:bob", [[day(1), 9]])] }]),
    () => dau.collect(ctx({ SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" })),
  );
  assertEquals(v.status, "good");
  assertEquals(v.value, "2"); // the two identities seen on that day
  assertEquals(v.extra, "");
  assertEquals(v.duration, undefined);
});
