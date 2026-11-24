/**
 * Counts how many distinct people were active per day, from the memory spans
 * SigNoz holds. The tile only runs when SIGNOZ_URL and SIGNOZ_API_KEY are both
 * set.
 *
 * The memory server records the person each session stands for as the
 * enduser.id attribute on its memory.session.open, memory.transact and
 * memory.subscriber.sync spans: the first person's identity on the session's
 * delegation chain, or else its signature-checked principal, and nothing for a
 * session that stands for no person, such as a serving loop's own, a service
 * principal's, or a new space's own key. docs/features/active-user-counting.md
 * records what the number means.
 *
 * Three properties of the signal decide what the number is worth:
 *   - Keys that nobody linked by delegation stay separate people: someone who
 *     minted a browser identity and an unrelated command-line identity counts
 *     twice, and an automation key the server is not told about counts as a
 *     person.
 *   - Trace retention bounds the lookback to roughly a fortnight, and that
 *     retention is a live setting on the database rather than anything a
 *     repository holds.
 *   - Head sampling below 1.0 does not scale a distinct count down, it drops
 *     people out of it, and no arithmetic afterwards puts them back.
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
// The spans that carry the person a memory session stands for. Filtering on
// `enduser.id EXISTS` alone would count any span that comes to carry the attribute,
// and the count would stop meaning "used the memory service".
const SPANS = ["memory.session.open", "memory.transact", "memory.subscriber.sync"];
const PERSON = "enduser.id";
interface Label {
  key?: { name?: string };
  value?: string;
}
interface Series {
  labels?: Label[];
  values?: { timestamp: number; value: number }[];
}
interface QueryResult {
  queryName?: string;
  aggregations?: ({ series?: Series[] } | null)[] | null;
}

const personOf = (s: Series): string | undefined => s.labels?.find((l) => l.key?.name === PERSON)?.value;

// The people seen in each UTC-day bucket. SigNoz answers with one series per
// person, carrying only the buckets that had spans, so a quiet day is absent from
// the response rather than present as a zero.
export function foldSeries(series: Series[]): Map<number, Set<string>> {
  const byDay = new Map<number, Set<string>>();
  for (const s of series) {
    const person = personOf(s);
    if (!person) continue;
    for (const v of s.values ?? []) {
      if (!Number.isFinite(v.value) || v.value <= 0) continue;
      const day = byDay.get(v.timestamp) ?? new Set<string>();
      day.add(person);
      byDay.set(v.timestamp, day);
    }
  }
  return byDay;
}

// What one request returns: the people seen on each UTC day, and the UTC days on which
// the service sent any span at all, attributed or not.
interface Activity {
  people: Map<number, Set<string>>;
  exported: Set<number>;
}

async function activityByDay(
  base: string,
  key: string,
  service: string,
  today: number,
): Promise<Activity> {
  // Align the window to UTC midnight so a bucket is a calendar day rather than a
  // rolling 24 hours ending whenever the tile happened to run.
  const end = today + DAY_MS;
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
          filter: { expression: `service.name = '${service}' AND name IN (${names}) AND ${PERSON} EXISTS` },
          groupBy: [{ name: PERSON, fieldDataType: "string", fieldContext: "attribute" }],
        },
      }, {
        type: "builder_query",
        spec: {
          name: "B",
          signal: "traces",
          disabled: false,
          stepInterval: STEP_S,
          aggregations: [{ expression: "count()" }],
          filter: { expression: `service.name = '${service}'` },
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
  const series = (name: string) => results.find((q) => q.queryName === name)?.aggregations?.[0]?.series ?? [];
  const exported = new Set<number>();
  for (const v of series("B")[0]?.values ?? []) {
    if (Number.isFinite(v.value) && v.value > 0) exported.add(v.timestamp);
  }
  return { people: foldSeries(series("A")), exported };
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

    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    let activity: Activity;
    try {
      activity = await activityByDay(base, key, service, today);
    } catch (e) {
      // SigNoz being unreachable says nothing about how many people were here.
      const msg = e instanceof Error ? e.message : "";
      return { ...drill, status: "unknown", value: "—", sub: msg.startsWith("HTTP") ? `SigNoz ${msg}` : "SigNoz unavailable" };
    }
    const { people, exported } = activity;

    // Today's bucket is still filling, and a part-day always reads as a drop, so the
    // headline is yesterday, the last day that ran to the end.
    const yesterday = today - DAY_MS;
    const exportedDays = [...exported].filter((t) => t < today).sort((a, b) => a - b);
    if (exportedDays.length === 0) {
      // Two different nothings, and they read differently on the dashboard. A service
      // that has sent spans only today has just started exporting, and has a number
      // tomorrow; one that has sent none at all is not exporting.
      return {
        ...drill,
        status: "unknown",
        value: "—",
        sub: exported.has(today) ? "insufficient data" : `no ${service} spans`,
      };
    }

    // A day nobody was active is missing from the people rather than zero, so fill the
    // gaps between the first day anyone was seen and the last day the service sent
    // spans. The grid starts at the first person: before that there is no evidence of
    // a quiet day, only an absence of instrumentation, and drawing that as zero would
    // invent a flat empty week.
    const last = exportedDays[exportedDays.length - 1];
    const first = [...people.keys()].filter((t) => t <= last).sort((a, b) => a - b)[0] ?? last;
    const grid: number[] = [];
    for (let t = first; t <= last; t += DAY_MS) grid.push(t);
    const series = grid.map((t) => people.get(t)?.size ?? 0);
    // One day is a number, not a trend, so there is no line to draw and no span to
    // report: the span describes the chart.
    const chart = sparkline(series, CHART_LINE, undefined, true);
    const history = { ...drill, extra: chart, duration: chart ? last - first + DAY_MS : undefined };

    // A service that sent nothing yesterday has stopped exporting, whatever it sent
    // since, and the newest day it did send is not yesterday's count.
    if (last !== yesterday) {
      const since = new Date(last).toISOString().slice(0, 10);
      return { ...history, status: "unknown", value: "—", sub: `no ${service} spans since ${since}` };
    }
    return {
      ...history,
      status: "good" as Status,
      value: String(series[series.length - 1]),
      sub: `active users · ${service}`,
    };
  },
};
