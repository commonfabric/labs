/**
 * Counts how many distinct identities were active per day, from the memory
 * spans SigNoz already holds. The tile only runs when SIGNOZ_URL and
 * SIGNOZ_API_KEY are both set.
 *
 * A memory session's principal is the signature-checked session.open issuer,
 * and the server exports it as the user.did attribute on the memory.transact
 * and memory.subscriber.sync spans. Counting the distinct values per UTC day
 * therefore needs no new instrumentation.
 * docs/features/active-user-counting.md records what the number means: an
 * identity is a keypair rather than a person, so this counts active identities
 * and leans on the assumption that one identity stands for one human. That
 * assumption is the tile's, not the system's.
 *
 * Four properties of the signal decide what the number is worth:
 *   - Opening a session emits no span of its own, so someone who only reads is
 *     never attributed, and a day of purely read-only traffic reports zero.
 *   - Service principals — the server's own identity, MEMORY_SERVICE_DIDS,
 *     background services — are principals in the same way a person is.
 *     DAU_EXCLUDE_DIDS removes them by hand; until it is set the count is an
 *     upper bound.
 *   - Trace retention bounds the lookback to roughly a fortnight, and that
 *     retention is a live setting on the database rather than anything a
 *     repository holds.
 *   - Head sampling below 1.0 does not scale a distinct count down, it drops
 *     identities out of it, and no arithmetic afterwards puts them back.
 *
 * The tile names its service explicitly, through PROD_SERVICE, rather than
 * counting whatever reports. A service that sends nothing comes back with no
 * aggregations at all, which reads here as gray, so this can sit on the
 * dashboard against a deployment whose tracing is still switched off and light
 * up on its own when it is turned on.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { serviceName, sparkline } from "../lib.ts";
import { CHART_LINE } from "../theme.ts";

const TIMEOUT = 15_000;
const DAY_MS = 86_400_000;
const STEP_S = 86_400; // one bucket per UTC day
const LOOKBACK_DAYS = 14; // trace retention runs to about 15 days
// The spans that carry the session principal. Filtering on `user.did EXISTS` alone
// would be a superset: other spans carry the attribute too, and the count would stop
// meaning "used the memory service".
const SPANS = ["memory.transact", "memory.subscriber.sync"];
interface Label {
  key?: { name?: string };
  value?: string;
}
interface Series {
  labels?: Label[];
  values?: { timestamp: number; value: number }[];
}
interface QueryResult {
  aggregations?: ({ series?: Series[] } | null)[] | null;
}

const didOf = (s: Series): string | undefined => s.labels?.find((l) => l.key?.name === "user.did")?.value;

// Comma-separated DIDs to leave out of the count.
export function parseExcludes(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0));
}

// The identities seen in each UTC-day bucket. SigNoz answers with one series per
// user.did, carrying only the buckets that had spans, so a quiet day is absent from
// the response rather than present as a zero.
export function foldSeries(series: Series[], exclude: Set<string>): Map<number, Set<string>> {
  const byDay = new Map<number, Set<string>>();
  for (const s of series) {
    const did = didOf(s);
    if (!did || exclude.has(did)) continue;
    for (const v of s.values ?? []) {
      if (!Number.isFinite(v.value) || v.value <= 0) continue;
      const day = byDay.get(v.timestamp) ?? new Set<string>();
      day.add(did);
      byDay.set(v.timestamp, day);
    }
  }
  return byDay;
}

async function activeByDay(
  base: string,
  key: string,
  service: string,
  exclude: Set<string>,
): Promise<Map<number, Set<string>>> {
  // Align the window to UTC midnight so a bucket is a calendar day rather than a
  // rolling 24 hours ending whenever the tile happened to run.
  const end = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
  const start = end - (LOOKBACK_DAYS + 1) * DAY_MS;
  const names = SPANS.map((s) => `'${s}'`).join(", ");
  const body = {
    schemaVersion: "v1",
    start,
    end,
    requestType: "time_series",
    compositeQuery: {
      queries: [{
        type: "builder_query",
        spec: {
          name: "A",
          signal: "traces",
          disabled: false,
          stepInterval: STEP_S,
          aggregations: [{ expression: "count()" }],
          filter: { expression: `service.name = '${service}' AND name IN (${names}) AND user.did EXISTS` },
          groupBy: [{ name: "user.did", fieldDataType: "string", fieldContext: "attribute" }],
        },
      }],
    },
  };
  const res = await fetch(`${base.replace(/\/$/, "")}/api/v5/query_range`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "SIGNOZ-API-KEY": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const results = ((await res.json()) as { data?: { data?: { results?: QueryResult[] } } })
    .data?.data?.results ?? [];
  return foldSeries(results[0]?.aggregations?.[0]?.series ?? [], exclude);
}

export const dau: Tile = {
  label: "dau",
  intervalMs: 300_000,
  async collect(ctx): Promise<TileView> {
    const base = ctx.env("SIGNOZ_URL");
    const key = ctx.env("SIGNOZ_API_KEY");
    if (!base || !key) {
      return { status: "unknown", value: "—", sub: "set SIGNOZ_URL + SIGNOZ_API_KEY" };
    }
    const service = serviceName(ctx.env);
    const uiBase = ctx.env("SIGNOZ_UI_URL") ?? (base.startsWith("https://") ? base : undefined);
    const drill = uiBase ? { href: `${uiBase.replace(/\/$/, "")}/traces-explorer`, hint: "traces ↗" } : {};

    let byDay: Map<number, Set<string>>;
    try {
      byDay = await activeByDay(base, key, service, parseExcludes(ctx.env("DAU_EXCLUDE_DIDS")));
    } catch (e) {
      // SigNoz being unreachable says nothing about how many people were here.
      const msg = e instanceof Error ? e.message : "";
      return { ...drill, status: "unknown", value: "—", sub: msg.startsWith("HTTP") ? `SigNoz ${msg}` : "SigNoz unavailable" };
    }

    // Today's bucket is still filling, and a part-day always reads as a drop, so the
    // headline is the last day that ran to the end.
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const days = [...byDay.keys()].filter((t) => t < today).sort((a, b) => a - b);
    if (days.length === 0) {
      // Two different nothings, and they read differently on the dashboard. A service
      // that has sent identity-bearing spans only today has just started exporting,
      // and has a number tomorrow; one that has sent none at all is not exporting.
      const seen = byDay.size > 0;
      return {
        ...drill,
        status: "unknown",
        value: "—",
        sub: seen ? "insufficient data" : `no ${service} spans`,
      };
    }

    // A day nobody was active is missing from the response rather than zero, so fill
    // the gaps between the first and last day seen. The grid stops at the observed
    // range: before the first day there is no evidence of a quiet day, only an absence
    // of instrumentation, and drawing that as zero would invent a flat empty week.
    const first = days[0], last = days[days.length - 1];
    const grid: number[] = [];
    for (let t = first; t <= last; t += DAY_MS) grid.push(t);
    const series = grid.map((t) => byDay.get(t)?.size ?? 0);
    const value = series[series.length - 1];
    // One day is a number, not a trend, so there is no line to draw and no span to
    // report: the span describes the chart.
    const chart = sparkline(series, CHART_LINE, undefined, true);

    return {
      ...drill,
      status: "good" as Status,
      value: String(value),
      // "identities", not "users": the tile counts keypairs and the sub-line should not
      // claim more than that.
      sub: `active identities · ${service}`,
      extra: chart,
      duration: chart ? last - first + DAY_MS : undefined,
    };
  },
};
