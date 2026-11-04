/**
 * Reports the production trace error rate from SigNoz. The headline number is
 * the rate over the last 12 hours, errored spans as a share of all spans. The
 * sparkline is the per-hour rate over the full retained trace history on a
 * linear time axis, where an hour with no traces counts as zero errors, with
 * the trailing 12-hour slice that feeds the headline drawn brighter. That is
 * the same split between the recent figure and the trend, and the same
 * highlight, that the ci-duration tile uses. The tile only runs when
 * SIGNOZ_URL and SIGNOZ_API_KEY are both set.
 *
 * Both counts are scoped to one service, PROD_SERVICE. The same SigNoz holds
 * staging and one-off performance runs, and a rate taken across all of them is
 * not production's: staging alone has run an order of magnitude hotter than
 * production on the same day, which is enough to hold this tile red over a
 * healthy production and teach everyone to ignore it.
 *
 * The instance has no generic rate of HTTP 5xx responses. Spans carry SigNoz's
 * own error flag, set for any errored span whether it is a memory operation or
 * an HTTP handler, so has_error is the portable signal for errors. It is
 * queried through the v5 query_range API with hourly buckets. The window asks
 * for 14 days but SigNoz keeps around 15 days of traces, so the sparkline
 * covers however much is retained. When SigNoz itself is unreachable the tile
 * goes gray rather than red: red is reserved for an error rate that really is
 * high.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { serviceName, sparkline } from "../lib.ts";
import { CHART_HIGHLIGHT, CHART_LINE } from "../theme.ts";

const RECENT_MS = 12 * 60 * 60 * 1000; // headline number: last 12 hours
const TREND_MS = 14 * 24 * 60 * 60 * 1000; // sparkline reach (capped by ~15-day trace retention)
const STEP_S = 3600; // hourly buckets

// One v5 builder query: count() over one service's traces, bucketed by stepS, with
// an optional extra condition.
const countQuery = (name: string, stepS: number, service: string, extra?: string) => ({
  type: "builder_query",
  spec: {
    name,
    signal: "traces",
    aggregations: [{ expression: "count()" }],
    stepInterval: stepS,
    filter: { expression: `service.name = '${service}'${extra ? ` AND ${extra}` : ""}` },
    disabled: false,
  },
});

interface QueryResult {
  queryName?: string;
  aggregations?: { series?: { values?: { timestamp: number; value: number }[] }[] }[];
}

// timestamp (ms) -> value for one query's first series (empty buckets are absent).
function seriesMap(results: QueryResult[], name: string): Map<number, number> {
  const values = results.find((q) => q.queryName === name)?.aggregations?.[0]?.series?.[0]?.values ?? [];
  const m = new Map<number, number>();
  for (const v of values) if (Number.isFinite(v.value)) m.set(v.timestamp, v.value);
  return m;
}

// Two bucketed trace counts (all spans A, errored spans B) over [now-ms, now].
async function traceCounts(
  base: string,
  key: string,
  service: string,
  ms: number,
  stepS: number,
): Promise<{ total: Map<number, number>; err: Map<number, number> }> {
  const now = Date.now();
  const body = {
    schemaVersion: "v1",
    start: now - ms,
    end: now,
    requestType: "time_series",
    compositeQuery: {
      queries: [countQuery("A", stepS, service), countQuery("B", stepS, service, "has_error = true")],
    },
  };
  const res = await fetch(`${base.replace(/\/$/, "")}/api/v5/query_range`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "SIGNOZ-API-KEY": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const results = ((await res.json()) as { data?: { data?: { results?: QueryResult[] } } })
    .data?.data?.results ?? [];
  return { total: seriesMap(results, "A"), err: seriesMap(results, "B") };
}

export const prodErrors: Tile = {
  label: "prod errors",
  intervalMs: 60_000,
  async collect(ctx): Promise<TileView> {
    const base = ctx.env("SIGNOZ_URL");
    const key = ctx.env("SIGNOZ_API_KEY");
    if (!base || !key) {
      return { status: "unknown", value: "—", sub: "set SIGNOZ_URL + SIGNOZ_API_KEY" };
    }
    // Pop out to the SigNoz logs explorer, where the actual error logs live. The
    // server may reach SigNoz over an in-cluster URL the browser can't, so the link
    // prefers SIGNOZ_UI_URL and only falls back to SIGNOZ_URL when it's public https.
    const service = serviceName(ctx.env);
    const uiBase = ctx.env("SIGNOZ_UI_URL") ?? (base.startsWith("https://") ? base : undefined);
    const drill = uiBase ? { href: `${uiBase.replace(/\/$/, "")}/logs/logs-explorer`, hint: "logs ↗" } : {};

    let trend: { total: Map<number, number>; err: Map<number, number> };
    try {
      trend = await traceCounts(base, key, service, TREND_MS, STEP_S);
    } catch (e) {
      // SigNoz being down/unreachable is a gap in our own instrumentation, not a
      // production error — gray, never red.
      const msg = e instanceof Error ? e.message : "";
      return { ...drill, status: "unknown", value: "—", sub: msg.startsWith("HTTP") ? `SigNoz ${msg}` : "SigNoz unavailable" };
    }

    // Hourly buckets, oldest -> newest; empty hours are absent from the response,
    // so rebuild a dense hourly grid over the observed range and treat each gap as
    // a zero-error hour. The sparkline's x-axis is then linear in time rather than
    // skipping quiet hours.
    const stamps = [...trend.total.keys()].sort((a, b) => a - b);
    if (stamps.length === 0) {
      return { ...drill, status: "unknown", value: "—", sub: `no ${service} spans` };
    }
    const stepMs = STEP_S * 1000;
    const first = stamps[0], last = stamps[stamps.length - 1];
    const grid: number[] = [];
    for (let t = first; t <= last; t += stepMs) grid.push(t);
    const rateAt = (t: number) => {
      const tot = trend.total.get(t) ?? 0;
      return tot > 0 ? ((trend.err.get(t) ?? 0) / tot) * 100 : 0;
    };
    const series = grid.map(rateAt);
    const span = last - first;

    // Headline: aggregate error rate over the trailing 12 hours (the grid hours
    // the highlight brightens); empty hours contribute nothing to the ratio.
    const cutoff = Date.now() - RECENT_MS;
    const recent = grid.filter((t) => t >= cutoff);
    const recentTotal = recent.reduce((s, t) => s + (trend.total.get(t) ?? 0), 0);
    const recentErr = recent.reduce((s, t) => s + (trend.err.get(t) ?? 0), 0);
    const rate = recentTotal > 0 ? (recentErr / recentTotal) * 100 : undefined;

    const status: Status = rate === undefined ? "unknown" : rate < 1 ? "good" : rate < 5 ? "warn" : "bad";
    // Brighten the trailing last-12h hours, but keep the whole retained range in
    // view (scaleAll) — the recent window can sit near zero while history spikes.
    const highlight = recent.length >= 2
      ? { count: recent.length, color: CHART_HIGHLIGHT, scaleAll: true }
      : undefined;
    return {
      ...drill,
      status,
      value: rate === undefined ? "—" : `${rate.toFixed(2)}%`,
      sub: rate === undefined ? "no traces · last 12h" : `${recentErr} err / ${recentTotal} spans · last 12h`,
      extra: sparkline(series, CHART_LINE, highlight, true),
      duration: span,
    };
  },
};
