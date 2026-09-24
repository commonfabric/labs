/**
 * Reports month-to-date API cost across the language-model providers we use,
 * projected to a full-month total against an optional monthly budget. Each
 * provider's authoritative billing API is read in real US dollars: OpenAI and
 * Anthropic through organization Admin keys, which expose per-day cost, and
 * OpenRouter through a key, which exposes only a running monthly total.
 *
 * The two providers with a daily series are charted as one line each over the
 * trailing 45 days or so, dimmed except for the daily-rate window that feeds
 * the headline, in the same way the ci-spend sparkline is drawn, with each
 * line's month-to-date total in the right gutter. The headline is the
 * projected full-month spend, extrapolated from the recent daily rate and
 * spilling into last month's tail when this month is under two weeks old,
 * summed across every provider we could read. The subtitle is the key, saying
 * which color is which provider and carrying OpenRouter's total since it has
 * no line of its own. The combined month-to-date total sits in the header
 * aside, and the span the chart covers goes to the tile's duration slot.
 *
 * Any provider we cannot read shows "$???" and drops the tile to gray, but the
 * rest still chart and total. A provider whose cost report has stopped being
 * written is one of those: a day past the end of its report has no figure, and
 * charting it at $0 would claim a quiet day the provider never reported. All
 * traffic to these models routes through the AI gateway, and the gateway
 * exposes tokens rather than dollars, so these provider APIs are the
 * authoritative source of spend.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { budgetStatus, escapeHtml, readBudget, usd } from "../lib.ts";
import {
  DAY_MS,
  newestReportedDay,
  reportLagDays,
  SPEND_HISTORY_DAYS,
  spendChart,
  summarizeDailySpend,
} from "../spend.ts";
import { themedChartSeries } from "../theme.ts";

// The provider billing APIs are slow — OpenAI's costs endpoint alone takes ~12-16s
// for a 46-day query and slows further under repeated calls — and this tile pages
// over ~45 days, so give each request generous headroom. A request that would have
// returned shouldn't be cut off, stranding the whole provider as "$???".
const TIMEOUT = 30000;
const PROVIDER_LAG_DAYS = 1;
// How far back a provider's newest bucket may sit before the tile stops reading
// the provider. Both cost endpoints answer a date range with a bucket per day,
// carrying a day the org spent nothing as a bucket with no figures in it, so a
// day the provider is still reporting on has a bucket whether or not it cost
// anything. A report that ends further back than a few days has stopped, and
// the days after it are unreported rather than quiet.
const MAX_REPORT_LAG_DAYS = 4;
const OPENAI_COLOR = "#10a37f";
const ANTHROPIC_COLOR = "#d97757";

// The provider's days, or null when its report ends too far back to read the
// days after it. A provider with no bucket at all has dated nothing, so there
// is nothing to hold against the limit.
function stillReporting(byDay: Map<string, number> | null, now: Date): Map<string, number> | null {
  const newest = byDay === null ? undefined : newestReportedDay(byDay);
  if (newest !== undefined && reportLagDays(newest, now) > MAX_REPORT_LAG_DAYS) return null;
  return byDay;
}

// One provider's line. A provider with no bucket at all has no day of its own,
// and the day axis the other provider supplies says nothing about this one, so
// it draws no line rather than a run of $0 across days it never reported on.
const chartSource = (byDay: Map<string, number> | null, color: string, label?: string) => ({
  spend: byDay && byDay.size > 0 ? { byDay } : null,
  color,
  label,
  lagDays: PROVIDER_LAG_DAYS,
});

// Daily billable USD, keyed by "YYYY-MM-DD", from OpenAI's org cost buckets.
async function openaiDaily(key: string, startSec: number): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(startSec));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "62");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`OpenAI costs HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ start_time?: number; results?: Array<{ amount?: { value?: number | string } }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("OpenAI costs: unexpected shape");
    for (const bucket of data.data) {
      if (typeof bucket.start_time !== "number") continue;
      const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      let sum = 0;
      for (const r of bucket.results ?? []) sum += Number(r.amount?.value) || 0;
      byDay.set(day, (byDay.get(day) ?? 0) + sum);
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return byDay;
}

// Daily billable USD, keyed by "YYYY-MM-DD", from Anthropic's cost report (whose
// amounts are USD cents).
async function anthropicDaily(key: string, startISO: string): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", startISO);
    url.searchParams.set("limit", "31"); // Anthropic's cost_report rejects limit > 31; it pages instead
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Anthropic cost_report HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ starting_at?: string; results?: Array<{ amount?: string | number }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("Anthropic cost_report: unexpected shape");
    for (const bucket of data.data) {
      if (typeof bucket.starting_at !== "string") continue;
      const day = bucket.starting_at.slice(0, 10);
      let sum = 0;
      for (const r of bucket.results ?? []) sum += (Number(r.amount) || 0) / 100;
      byDay.set(day, (byDay.get(day) ?? 0) + sum);
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return byDay;
}

// OpenRouter exposes only a running month-to-date total, no daily series.
async function openrouterMonthly(key: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`OpenRouter key HTTP ${res.status}`);
  const data = await res.json() as { data?: { usage_monthly?: number } };
  if (typeof data.data?.usage_monthly !== "number") throw new Error("OpenRouter: no usage_monthly");
  return data.data.usage_monthly;
}

export const modelSpend: Tile = {
  label: "model spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const oaKey = ctx.env("OPENAI_ADMIN_KEY");
    const anKey = ctx.env("ANTHROPIC_ADMIN_KEY");
    const orKey = ctx.env("OPENROUTER_KEY");
    if (!oaKey && !anKey && !orKey) {
      return { status: "unknown", value: "—", sub: "set OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / OPENROUTER_KEY" };
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month0 = now.getUTCMonth();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    const startMs = now.getTime() - (SPEND_HISTORY_DAYS + 1) * DAY_MS;
    const startSec = Math.floor(startMs / 1000);
    const startISO = `${new Date(startMs).toISOString().slice(0, 10)}T00:00:00Z`;

    // Read each provider concurrently. null = key absent, the billing API
    // errored, or the report it returned has stopped being written.
    const [oaRead, anRead, orMonthly] = await Promise.all([
      oaKey ? openaiDaily(oaKey, startSec).catch(() => null) : Promise.resolve(null),
      anKey ? anthropicDaily(anKey, startISO).catch(() => null) : Promise.resolve(null),
      orKey ? openrouterMonthly(orKey).catch(() => null) : Promise.resolve(null),
    ]);
    const oaMap = stillReporting(oaRead, now);
    const anMap = stillReporting(anRead, now);

    const oa = oaMap
      ? summarizeDailySpend(oaMap, now, { lagDays: PROVIDER_LAG_DAYS })
      : null;
    const an = anMap
      ? summarizeDailySpend(anMap, now, { lagDays: PROVIDER_LAG_DAYS })
      : null;
    const or = orMonthly !== null
      ? { mtd: orMonthly, projected: dayOfMonth > 0 ? (orMonthly / dayOfMonth) * daysInMonth : orMonthly }
      : null;

    const present = [oa, an, or].filter((p): p is { mtd: number; projected: number } => p !== null);
    if (present.length === 0) {
      return { status: "unknown", value: "—", sub: "model spend unavailable" };
    }
    const totalMtd = present.reduce((s, p) => s + p.mtd, 0);
    const totalProjected = present.reduce((s, p) => s + p.projected, 0);
    // Gray only when a CONFIGURED provider couldn't be read. A provider whose key
    // isn't set simply isn't part of this deployment and must not gate the budget
    // (otherwise a one- or two-key deployment would never turn warn/bad).
    const complete = !((oaKey && !oa) || (anKey && !an) || (orKey && !or));
    const status: Status = complete
      ? budgetStatus(totalProjected, readBudget(ctx.env("MODEL_MONTHLY_BUDGET")))
      : "unknown";

    const chart = spendChart(
      [
        chartSource(oaMap, OPENAI_COLOR, oa ? usd(oa.mtd) : undefined),
        chartSource(anMap, ANTHROPIC_COLOR, an ? usd(an.mtd) : undefined),
      ],
      now,
    );

    // The key line. Charted providers show a swatch (their own MTD sits at the line
    // end on the chart, or inline when there's no chart yet); OpenRouter (no line,
    // abbreviated "OR") and any provider we couldn't read show their value inline
    // ("$???" when missing). Items are bullet-separated. The combined MTD is in the
    // header aside; the span the chart covers goes to the tile's duration slot.
    const swatch = (c: string) =>
      `<span class="swatch" style="background:${themedChartSeries(c).color}"></span>`;
    const charted = (p: { mtd: number } | null, name: string, color: string) =>
      p ? (chart.chart ? `${swatch(color)} ${name}` : `${swatch(color)} ${name} ${usd(p.mtd)}`) : `${name} $???`;
    const seg: string[] = [];
    if (oaKey) seg.push(charted(oa, "OpenAI", OPENAI_COLOR));
    if (anKey) seg.push(charted(an, "Anthropic", ANTHROPIC_COLOR));
    if (orKey) seg.push(or ? `OR ${usd(or.mtd)}` : "OR $???");
    const legendText = seg.join(" • ").replaceAll(/<[^>]+>/g, "").replaceAll(
      /\s+/g,
      " ",
    ).trim();
    const legend = `<p class="sub" title="${escapeHtml(legendText)}">${
      seg.join(" • ")
    }</p>`;
    const value = `${complete ? "~" : "≥"}${usd(totalProjected)}/mo`;
    const mtd = `${usd(totalMtd)} MTD`;

    return {
      status,
      // Complete -> a projection (~); missing a provider -> the total is only a
      // lower bound, since the absent provider would add to it (≥).
      value,
      valueLabel: value,
      aside: `<span class="hfacet" title="${mtd}">${mtd}</span>`,
      extra: legend + chart.chart,
      duration: chart.duration,
    };
  },
};
