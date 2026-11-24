/**
 * prod-errors tile tests: collect(ctx) against a stubbed SigNoz v5 query_range.
 * No real network — globalThis.fetch is swapped for the duration of each collect
 * and restored afterwards.
 */

import { assert, assertEquals } from "@std/assert";
import type { Ctx } from "../types.ts";
import { prodErrors } from "./prod-errors.ts";

const HOUR = 3_600_000;
const ENV = { SIGNOZ_URL: "https://signoz.example", SIGNOZ_API_KEY: "k" };

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// Bucket timestamps, hourly, counting back from a minute ago: hours 0..11 sit
// inside the 12-hour headline window and hour 12 and older sit outside it. The
// base is taken once so the buckets stay an exact hour apart.
function hourStamps(): (i: number) => number {
  const base = Date.now() - 60_000;
  return (i) => base - i * HOUR;
}

// One query's result: a name and its hourly (timestamp, count) pairs. The tile
// reads query A as all spans and query B as errored spans.
const q = (name: string, pts: [number, number | null][]) => ({
  queryName: name,
  aggregations: [{ series: [{ values: pts.map(([timestamp, value]) => ({ timestamp, value })) }] }],
});

const ok = (results: unknown[]) =>
  Promise.resolve(new Response(JSON.stringify({ data: { data: { results } } }), { status: 200 }));

async function withFetch<T>(handler: (req: Request) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// The points of the base (first) sparkline polyline.
const basePoints = (extra: string) => extra.match(/<polyline points="([^"]*)"/)![1].trim().split(" ");
const yOf = (pt: string) => parseFloat(pt.split(",")[1]);

Deno.test("prod errors: the headline is the last 12h error rate — <1% good, <5% warn, else bad", async () => {
  const at = hourStamps();
  const recent: [number, number | null][] = Array.from({ length: 12 }, (_, i) => [at(i), 100]);
  // 1200 spans over the window; every error lands in the newest hour.
  const view = (errs: number) =>
    withFetch(() => ok([q("A", recent), q("B", [[at(0), errs]])]), () => prodErrors.collect(ctx(ENV)));

  const good = await view(6);
  assertEquals(good.value, "0.50%");
  assertEquals(good.status, "good");
  assertEquals(good.sub, "6 err / 1200 spans · last 12h");

  const boundary = await view(12); // exactly 1.00% — "under 1" is exclusive
  assertEquals(boundary.value, "1.00%");
  assertEquals(boundary.status, "warn");

  assertEquals((await view(59)).status, "warn"); // 4.92%
  const bad = await view(60);
  assertEquals(bad.value, "5.00%"); // exactly 5.00% is already bad
  assertEquals(bad.status, "bad");
});

Deno.test("prod errors: hours with no traces count as zero, keeping the axis linear in time", async () => {
  const at = hourStamps();
  // A 50%-error hour 23 hours back, twelve clean hours now, and a ten-hour hole
  // between them that the response simply omits.
  const totals: [number, number | null][] = [[at(23), 100], ...Array.from(
    { length: 12 },
    (_, i) => [at(i), 100] as [number, number | null],
  )];
  const v = await withFetch(
    () => ok([q("A", totals), q("B", [[at(23), 50]])]),
    () => prodErrors.collect(ctx(ENV)),
  );
  // Recent hours carry no errors, so the headline is clean despite the old spike.
  assertEquals(v.value, "0.00%");
  assertEquals(v.status, "good");
  assertEquals(v.sub, "0 err / 1200 spans · last 12h");
  assertEquals(v.duration, 23 * HOUR); // the caption spans the whole retained range

  const pts = basePoints(v.extra ?? "");
  assertEquals(pts.length, 24); // the omitted hours are drawn, not skipped
  const ys = pts.map(yOf);
  assertEquals(ys[1], ys[12], "a missing hour sits at the same height as an observed zero-error hour");
  assert(ys[0] < ys[1], "the 50% hour is the peak (smaller y is higher)");
  assert(ys[0] >= 0, "the old spike stays in view rather than clipping past the top");
});

Deno.test("prod errors: no traces in the last 12h -> unknown, never a green zero", async () => {
  const at = hourStamps();
  // Two hours of traffic two days ago and nothing since.
  const v = await withFetch(
    () => ok([q("A", [[at(48), 100], [at(47), 100]]), q("B", [[at(48), 90]])]),
    () => prodErrors.collect(ctx(ENV)),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "no traces · last 12h");
  // Nothing recent to brighten, so the sparkline is a single unhighlighted line.
  assertEquals([...(v.extra ?? "").matchAll(/<polyline/g)].length, 1);
});

Deno.test("prod errors: an empty result set -> unknown, and non-finite counts are dropped", async () => {
  const at = hourStamps();
  const none = await withFetch(() => ok([]), () => prodErrors.collect(ctx(ENV)));
  assertEquals(none.status, "unknown");
  assertEquals(none.value, "—");
  assertEquals(none.sub, "no toolshed-production spans");
  assertEquals(none.href, "https://signoz.example/logs/logs-explorer"); // still drills through

  // A bucket whose count is not a number is no bucket at all.
  const junk = await withFetch(
    () => ok([q("A", [[at(0), null]]), q("B", [])]),
    () => prodErrors.collect(ctx(ENV)),
  );
  assertEquals(junk.sub, "no toolshed-production spans");
});

Deno.test("prod errors: SigNoz unreachable -> gray, not red", async () => {
  const down = await withFetch(
    () => Promise.reject(new TypeError("error sending request for url")),
    () => prodErrors.collect(ctx(ENV)),
  );
  assertEquals(down.status, "unknown"); // red is reserved for an actual error rate
  assertEquals(down.value, "—");
  assertEquals(down.sub, "SigNoz unavailable");

  // Whatever the failure was thrown as, the tile says the same calm thing.
  const odd = await withFetch(() => Promise.reject("boom"), () => prodErrors.collect(ctx(ENV)));
  assertEquals(odd.status, "unknown");
  assertEquals(odd.sub, "SigNoz unavailable");
});

Deno.test("prod errors: an HTTP error names the status and stays gray", async () => {
  const v = await withFetch(
    () => Promise.resolve(new Response("nope", { status: 502 })),
    () => prodErrors.collect(ctx(ENV)),
  );
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "SigNoz HTTP 502");
});

Deno.test("prod errors: no SIGNOZ_URL / SIGNOZ_API_KEY -> gray, and nothing is fetched", async () => {
  let calls = 0;
  const collect = (env: Record<string, string>) =>
    withFetch(() => {
      calls++;
      return ok([]);
    }, () => prodErrors.collect(ctx(env)));

  const partial: Record<string, string>[] = [{}, { SIGNOZ_URL: "https://signoz.example" }, { SIGNOZ_API_KEY: "k" }];
  for (const env of partial) {
    const v = await collect(env);
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "set SIGNOZ_URL + SIGNOZ_API_KEY");
    assertEquals(v.href, undefined); // no source, nothing to drill into
  }
  assertEquals(calls, 0);
});

Deno.test("prod errors: the drill link prefers SIGNOZ_UI_URL over an in-cluster SIGNOZ_URL", async () => {
  const collect = (env: Record<string, string>) =>
    withFetch(() => ok([]), () => prodErrors.collect(ctx(env)));

  const ui = await collect({ ...ENV, SIGNOZ_UI_URL: "https://ui.example/" });
  assertEquals(ui.href, "https://ui.example/logs/logs-explorer"); // trailing slash trimmed
  assertEquals(ui.hint, "logs ↗");

  // No UI url, but the query url is public https -> the browser can use it too.
  assertEquals((await collect(ENV)).href, "https://signoz.example/logs/logs-explorer");

  // An in-cluster url the browser can't reach, and no UI url -> no link at all.
  const inCluster = await collect({ SIGNOZ_URL: "http://signoz.svc:8080", SIGNOZ_API_KEY: "k" });
  assertEquals(inCluster.href, undefined);
  assertEquals(inCluster.hint, undefined);
});

Deno.test("prod errors: asks SigNoz for one service's hourly all-span and errored-span counts over 14 days", async () => {
  let req: Request | undefined;
  let sent: {
    start: number;
    end: number;
    requestType: string;
    compositeQuery: { queries: { spec: { name: string; signal: string; stepInterval: number; filter?: { expression: string } } }[] };
  };
  await withFetch(async (r) => {
    req = r;
    sent = await r.json();
    return await ok([]);
  }, () => prodErrors.collect(ctx({ ...ENV, SIGNOZ_URL: "https://signoz.example/" })));

  assertEquals(req!.method, "POST");
  assertEquals(req!.url, "https://signoz.example/api/v5/query_range"); // trailing slash trimmed
  assertEquals(req!.headers.get("SIGNOZ-API-KEY"), "k");
  assertEquals(req!.headers.get("Content-Type"), "application/json");

  assertEquals(sent!.requestType, "time_series");
  assertEquals(sent!.end - sent!.start, 14 * 24 * HOUR);
  const specs = sent!.compositeQuery.queries.map((x) => x.spec);
  assertEquals(specs.map((s) => s.name), ["A", "B"]);
  assertEquals(specs.map((s) => s.signal), ["traces", "traces"]);
  assertEquals(specs.map((s) => s.stepInterval), [3600, 3600]); // hourly buckets
  // Both counts are scoped to production. Unscoped, the ratio would blend in staging
  // and the one-off perf runs that share this SigNoz, which is not production's rate.
  assertEquals(specs[0].filter?.expression, "service.name = 'toolshed-production'");
  assertEquals(specs[1].filter?.expression, "service.name = 'toolshed-production' AND has_error = true");
});

Deno.test("prod errors: PROD_SERVICE names the service, and an unsafe name cannot reach the query", async () => {
  const specFor = async (env: Record<string, string>): Promise<string> => {
    let sent: { compositeQuery: { queries: { spec: { filter?: { expression: string } } }[] } };
    await withFetch(async (r) => {
      sent = await r.json();
      return await ok([]);
    }, () => prodErrors.collect(ctx({ ...ENV, ...env })));
    return sent!.compositeQuery.queries[0].spec.filter!.expression;
  };
  assertEquals(await specFor({ PROD_SERVICE: "toolshed-staging" }), "service.name = 'toolshed-staging'");
  // The name lands inside a query expression, so anything that could close the quote
  // falls back to the configured default rather than being interpolated.
  assertEquals(await specFor({ PROD_SERVICE: "x' OR '1'='1" }), "service.name = 'toolshed-production'");
  assertEquals(await specFor({ PROD_SERVICE: "" }), "service.name = 'toolshed-production'");
});
