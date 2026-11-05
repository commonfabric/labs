/**
 * Reports month-to-date Google Cloud cost from a BigQuery billing export, and
 * projects it to a full-month total. Every figure is money the account
 * actually pays: the cost of its usage after the credits that come off it. The
 * daily series covers up to 45 finished UTC days, with the rate window
 * highlighted. Early in the month that window reaches into whatever
 * prior-month history is available, up to a 14-day total. Cost from a day the
 * export is still writing contributes only to the month-to-date total.
 *
 * The export lands a day's usage in batches spread over the day or two after
 * it ends, and works on several days at once, so a day it has not finished
 * holds only part of that day's cost and would drag down any rate measured
 * over it. Nothing in the export marks a day as complete, so the tile
 * establishes it two ways at once, each covering where the other is blind.
 *
 * The first is how much of the day the export has accounted for. Alongside
 * cost, the query totals the billable time on a day's usage — the seconds of
 * instance, disk, and other metered life the export has recorded. A running
 * fleet books close to the same amount every day, and unlike cost it does not
 * move when a promotion or a price change lands, so a day holding a small
 * fraction of the day before it is one the export is still filling in.
 *
 * The second is how long the export has had. It reports when it last added a
 * material batch to each day, which the tile turns into how long the export
 * currently takes to finish with a day. That measurement comes from the
 * export's own record over the window rather than a figure assumed here, so it
 * tracks an export that speeds up or slows down. A day is finished once the
 * export has had that long since the day ended.
 *
 * Billable time alone would accept a day the export happens to be most of the
 * way through, and elapsed time alone would accept a day the export has fallen
 * behind on. A day has to satisfy both. The chart and the rate window end at
 * the newest day that does, and an export that has finished no day in several
 * days grays the tile rather than projecting from stale history.
 *
 * The tile uses the BigQuery REST API, without the bq or gcloud command-line
 * tools. It authenticates as the workload's service account in GKE, or with
 * GCP_SA_KEY locally. That account needs BigQuery Job User on the query
 * project and Data Viewer on the dataset.
 */

import type { Tile, TileView } from "../types.ts";
import { bigQuery } from "../gcp.ts";
import { budgetStatus, daysLabel, readBudget, usd } from "../lib.ts";
import { DAY_MS, SPEND_HISTORY_DAYS, spendChart, summarizeDailySpend } from "../spend.ts";

const GCP_COLOR = "#4285f4";
// How far behind the newest finished day may fall before the tile stops
// reporting. The export normally finishes a day within a day or two of it
// ending, so this much silence is a broken export rather than a slow one.
const MAX_EXPORT_LAG_DAYS = 4;
// The share of a day's billable time that makes an export batch a material one.
// The export closes a day with a long tail of tiny corrections, and timing it by
// those would read every day as settling days after it really did.
const SETTLE_SHARE = 0.01;
// The share of the previous day's billable time a day holds once the export has
// filled it in. The export passes through half to two thirds of a day in the
// hours after that day ends, and a fleet that shrinks overnight still books far
// more than this, so the mark separates the two.
const MIN_DAY_COVERAGE = 0.5;

// Daily cost, credit, and export progress for the trailing UTC days and today.
// A usage row carries its credits as a repeated field of negative amounts,
// covering promotions, committed- and sustained-use discounts, and the free tier,
// so what the account pays for that row is the two added together.
//
// `metered` is the billable time on the day's usage, which is what tells a day
// the export has filled in from one it is still writing. `settled` is when the
// export last added a material batch to the day. Both read only `regular` rows:
// invoice adjustments and rounding corrections arrive weeks later, carry no
// usage, and would otherwise make a long-closed day look freshly written.
// Grouping in BigQuery keeps the response small even when the export has many
// rows per service.
const sqlFor = (table: string) => {
  const window = `DATE(usage_start_time) >= ` +
    `DATE_SUB(CURRENT_DATE(), INTERVAL ${SPEND_HISTORY_DAYS} DAY) ` +
    `AND DATE(usage_start_time) <= CURRENT_DATE()`;
  return `WITH batches AS (` +
    `SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, export_time, ` +
    `SUM(IF(usage.unit = 'seconds', usage.amount, 0)) AS metered ` +
    `FROM \`${table}\` WHERE ${window} AND cost_type = 'regular' ` +
    `GROUP BY day, export_time), ` +
    `shares AS (SELECT day, export_time, metered, ` +
    `SUM(metered) OVER (PARTITION BY day) AS day_metered FROM batches), ` +
    `progress AS (SELECT day, ANY_VALUE(day_metered) AS metered, ` +
    `UNIX_SECONDS(MAX(IF(metered >= ${SETTLE_SHARE} * day_metered, ` +
    `export_time, NULL))) AS settled FROM shares GROUP BY day), ` +
    `money AS (SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, ` +
    `SUM(cost) AS cost, ` +
    `IFNULL(SUM((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit)), 0) ` +
    `AS credits FROM \`${table}\` WHERE ${window} GROUP BY day) ` +
    `SELECT money.day, money.cost, money.credits, ` +
    `IFNULL(progress.metered, 0) AS metered, ` +
    `IFNULL(progress.settled, 0) AS settled ` +
    `FROM money LEFT JOIN progress USING (day) ORDER BY money.day`;
};

// The billing table is `project.dataset.table`; the query runs in that project,
// where the service account holds Job User.
const projectOf = (table: string) => table.split(".")[0];

function dayTime(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === day ? parsed : null;
}

function amount(cell: string | undefined): number {
  const raw = cell ?? "";
  return raw.trim() === "" ? NaN : Number(raw);
}

interface DailyCost {
  paid: number; // cost after credits
  metered: number; // billable time the export has recorded for this day
  settled: number; // when the export last added a material batch, in seconds
}

interface DailyCostHistory {
  paid: Map<string, number>; // finished days, cost after credits
  paidMtd: number; // this month so far, unfinished days included
  availableSince: string;
  lagDays: number; // days from the newest finished day to today
}

function dailyCosts(
  rows: string[][],
  now: Date,
): DailyCostHistory | null {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const first = today - SPEND_HISTORY_DAYS * DAY_MS;
  const parsed = new Map<string, DailyCost>();
  let oldest = today;
  for (const row of rows) {
    const day = row[0] ?? "";
    const time = dayTime(day);
    const cost = amount(row[1]);
    const credit = amount(row[2]);
    const metered = amount(row[3]);
    const settled = amount(row[4]);
    if (
      time === null ||
      time < first ||
      time > today ||
      !Number.isFinite(cost) ||
      !Number.isFinite(credit) ||
      !Number.isFinite(metered) ||
      !Number.isFinite(settled)
    ) {
      throw new Error("billing history has an unexpected shape");
    }
    parsed.set(day, { paid: cost + credit, metered, settled });
    oldest = Math.min(oldest, time);
  }

  // Days the export has accounted for, by the billable time on them. The day
  // before is the comparison because it is the older of the two, so it is the
  // one the export has had longer to finish. The oldest day in the window has
  // nothing before it and is far enough back to take as filled in.
  const days = [...parsed.keys()].sort();
  const filled = new Set<string>();
  for (const [index, day] of days.entries()) {
    const before = index === 0 ? undefined : parsed.get(days[index - 1]);
    if (
      before === undefined ||
      parsed.get(day)!.metered >= MIN_DAY_COVERAGE * before.metered
    ) {
      filled.add(day);
    }
  }

  // How long the export is currently taking to finish with a day, from its own
  // record of when it last added a material batch to each day it has accounted
  // for. Days it is still filling in are left out: their last batch says how far
  // the export has got with them, not how long it needs. A stretch where the
  // export ran late holds this up for as long as it stays in the window, which
  // is the honest reading of an export that has been running late.
  let settlingMs = 0;
  for (const day of filled) {
    settlingMs = Math.max(
      settlingMs,
      parsed.get(day)!.settled * 1000 - (dayTime(day)! + DAY_MS),
    );
  }

  // The newest day the export has accounted for and has had that long with.
  // The last day in the window is never it: the export has written nothing
  // after that day, so there is no sign it has moved past it, and a window
  // holding one day says nothing about how long the export takes.
  let last: number | undefined;
  for (let index = days.length - 2; index >= 0; index--) {
    const time = dayTime(days[index])!;
    if (
      filled.has(days[index]) &&
      now.getTime() - (time + DAY_MS) >= settlingMs
    ) {
      last = time;
      break;
    }
  }
  if (last === undefined) return null;

  // Missing dates after the first exported date are real quiet days: the export
  // has moved past them, so there was nothing to bill.
  const paid = new Map<string, number>();
  for (let time = oldest; time <= last; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    paid.set(day, parsed.get(day)?.paid ?? 0);
  }
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
  const paidMtd = [...parsed]
    .filter(([day]) => day.startsWith(monthPrefix))
    .reduce((sum, [, cost]) => sum + cost.paid, 0);
  return {
    paid,
    paidMtd,
    availableSince: new Date(oldest).toISOString().slice(0, 10),
    lagDays: (today - last) / DAY_MS,
  };
}

export const gcpSpend: Tile = {
  label: "cloud spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const table = ctx.env("GCP_BILLING_TABLE");
    if (!table) {
      return {
        status: "unknown",
        value: "—",
        sub: "set GCP_BILLING_TABLE",
      };
    }
    // The table id is interpolated into the query, so keep it to a plain
    // BigQuery identifier, optionally with a partition decorator.
    if (!/^[A-Za-z0-9_.$-]+$/.test(table)) {
      return {
        status: "unknown",
        value: "—",
        sub: "invalid GCP_BILLING_TABLE",
      };
    }

    const now = new Date();
    let history: DailyCostHistory | null;
    try {
      const rows = await bigQuery(
        projectOf(table),
        sqlFor(table),
        ctx.env,
      );
      if (rows.length === 0) {
        return {
          status: "unknown",
          value: "—",
          sub: "no billing data yet",
        };
      }
      history = dailyCosts(rows, now);
    } catch {
      return {
        status: "unknown",
        value: "—",
        sub: "unavailable — check credentials",
      };
    }
    if (!history) {
      return {
        status: "unknown",
        value: "—",
        sub: "no billing data yet",
      };
    }
    if (history.lagDays > MAX_EXPORT_LAG_DAYS) {
      return {
        status: "unknown",
        value: "—",
        sub: `billing export ${daysLabel(history.lagDays)} behind`,
      };
    }

    // The rate window stops at the newest finished day, which the export leaves
    // this many days back, so the days it is still writing are left out of the
    // rate rather than counted as days that spent nothing.
    const summary = summarizeDailySpend(
      history.paid,
      now,
      {
        lagDays: history.lagDays,
        availableSince: history.availableSince,
      },
    );
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const dailyBudget = readBudget(ctx.env("GCP_DAILY_BUDGET"));
    const monthlyBudget = dailyBudget * daysInMonth;
    const status = budgetStatus(summary.projected, monthlyBudget);
    // The history holds finished days only, so its newest day is exactly the
    // lag behind today and the line already ends on it.
    const chart = spendChart(
      [{
        spend: { byDay: history.paid },
        color: GCP_COLOR,
        lagDays: history.lagDays,
      }],
      now,
      summary.estimateDays,
    );

    const value = `~${usd(summary.projected)}/mo`;
    const mtd = `${usd(history.paidMtd)} MTD`;
    return {
      status,
      value,
      valueLabel: value,
      aside: `<span class="hfacet" title="${mtd}">${mtd}</span>`,
      sub: "billing account spend",
      extra: chart.chart,
      duration: chart.duration,
    };
  },
};
