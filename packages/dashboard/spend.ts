/**
 * Projects and charts daily spend for every one of the dashboard's spend
 * tiles. A monthly estimate uses every settled day in the current month, and
 * until that supplies two weeks it fills the rate window from the end of the
 * prior month. A chart line ends on the newest day its source's reporting lag
 * has settled, even when another source's line runs further. A source can
 * carry rows for a day it has not finished reporting, today included, so a
 * row inside the lag says nothing about the day being complete. A line skips
 * the days its source has no report to draw on, breaking across the hole
 * rather than charting zeros.
 *
 * A settled day with no report counts as a real $0, which holds only while the
 * source is still reporting. A tile establishes that from the newest day its
 * source has a report for, and stops reading a source whose reports have run
 * dry further back than its lag allows.
 */

import { maxOf } from "@commonfabric/utils/math";
import { multiSparkline } from "./lib.ts";
import { themedChartSeries } from "./theme.ts";

export const DAY_MS = 86_400_000;
export const MIN_SPEND_WINDOW_DAYS = 14;
export const SPEND_HISTORY_DAYS = 45;

export interface SpendSummary {
  mtd: number;
  projected: number;
  estimateDays: number;
}

export interface SpendSummaryOptions {
  lagDays: number;
  measuredMtd?: number;
  priorMonthDaily?: number[];
  availableSince?: string;

  /** Days for which this source returned a report, including $0 days. */
  knownDays?: ReadonlySet<string>;
}

interface Projection {
  projected: number;
  days: number;
}

interface ChartSpend {
  byDay: Map<string, number>;
}

export interface SpendChartSource {
  spend: ChartSpend | null;
  color: string;
  label?: string;
  lagDays: number;

  /**
   * The calendar months, as "YYYY-MM", the source has a report for. A day
   * outside them is left out of the source's line. Leave it undefined when the
   * source reports on every month it spans.
   */
  knownMonths?: ReadonlySet<string>;

  /**
   * Individual days for which the source returned a report. A missing day is
   * left out of the line rather than drawn as $0. Leave this undefined when a
   * report covers every day in each known month.
   */
  knownDays?: ReadonlySet<string>;
}

/**
 * The days of `daily` the source's reporting lag has settled, out of the
 * `elapsedDays` the calendar has reached.
 */
export function settled(
  daily: number[],
  elapsedDays: number,
  lagDays: number,
): number[] {
  return daily.slice(0, Math.max(0, elapsedDays - lagDays));
}

/**
 * The newest day a source has a figure for, or undefined when it has none.
 */
export function newestReportedDay(
  byDay: Map<string, number>,
): string | undefined {
  let newest: string | undefined;
  for (const day of byDay.keys()) {
    if (newest === undefined || day > newest) newest = day;
  }
  return newest;
}

/**
 * How many days back the newest day a source has a report for sits. Compare it
 * against the lag the source declares: a report that ends further back than
 * that allows has stopped, and the days after it are unreported rather than
 * days that cost nothing.
 */
export function reportLagDays(reportedThrough: string, now: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return (today - Date.parse(`${reportedThrough}T00:00:00Z`)) / DAY_MS;
}

export function calendarMonth(
  byDay: Map<string, number>,
  year: number,
  month0: number,
): number[] {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const prefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  return Array.from(
    { length: days },
    (_, index) => byDay.get(prefix + String(index + 1).padStart(2, "0")) ?? 0,
  );
}

function monthlyProjection(
  spent: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): Projection {
  const needFromLast = Math.max(
    0,
    MIN_SPEND_WINDOW_DAYS - coveredThis,
  );
  const tail = needFromLast > 0 ? lastMonthDaily.slice(-needFromLast) : [];
  const days = coveredThis + tail.length;
  if (days <= 0) return { projected: spent, days: 0 };
  const windowSpend = spent +
    tail.reduce((sum, daily) => sum + daily, 0);
  return {
    projected: (windowSpend / days) * daysInMonth,
    days,
  };
}

export function projectMonthly(
  spent: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): number {
  return monthlyProjection(
    spent,
    coveredThis,
    daysInMonth,
    lastMonthDaily,
  ).projected;
}

function firstAvailableIndex(
  availableSince: string | undefined,
  year: number,
  month0: number,
  daysInMonth: number,
): number {
  if (!availableSince) return 0;
  const available = Date.parse(`${availableSince}T00:00:00Z`);
  const start = Date.UTC(year, month0, 1);
  const end = Date.UTC(year, month0 + 1, 1);
  if (!Number.isFinite(available) || available <= start) return 0;
  if (available >= end) return daysInMonth;
  return new Date(available).getUTCDate() - 1;
}

export function summarizeDailySpend(
  byDay: Map<string, number>,
  now: Date,
  options: SpendSummaryOptions,
): SpendSummary {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const thisMonth = calendarMonth(byDay, year, month0);
  const dailyMtd = thisMonth.reduce((sum, amount) => sum + amount, 0);
  const mtd = options.measuredMtd ?? dailyMtd;
  const settledThis = settled(
    thisMonth,
    dayOfMonth,
    options.lagDays,
  );
  const currentStart = firstAvailableIndex(
    options.availableSince,
    year,
    month0,
    thisMonth.length,
  );
  const currentPrefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  const coveredDays = settledThis.slice(currentStart).filter((_, index) =>
    !options.knownDays ||
    options.knownDays.has(
      currentPrefix + String(index + currentStart + 1).padStart(2, "0"),
    )
  );
  const previousMonth = month0 === 0 ? 11 : month0 - 1;
  const previousYear = month0 === 0 ? year - 1 : year;
  const previous = calendarMonth(byDay, previousYear, previousMonth);
  const settledPrevious = settled(
    previous,
    previous.length + dayOfMonth,
    options.lagDays,
  );
  const previousStart = firstAvailableIndex(
    options.availableSince,
    previousYear,
    previousMonth,
    previous.length,
  );
  const lastMonthDaily = options.priorMonthDaily ??
    settledPrevious.slice(
      Math.min(previousStart, settledPrevious.length),
    );
  const daysInMonth = new Date(
    Date.UTC(year, month0 + 1, 0),
  ).getUTCDate();
  // Rated over the settled days, plus whatever the measured total carries that
  // no day does. Spend on the days still being reported is part of the month
  // to date, but it is a partial figure for those days.
  const projection = monthlyProjection(
    coveredDays.reduce((sum, amount) => sum + amount, mtd - dailyMtd),
    coveredDays.length,
    daysInMonth,
    lastMonthDaily,
  );
  return {
    mtd,
    // With no settled day to rate, the month to date is the only figure.
    projected: projection.days > 0 ? projection.projected : mtd,
    estimateDays: projection.days,
  };
}

export function spendChart(
  sources: SpendChartSource[],
  now: Date,
  estimateDays?: number,
  estimateSince?: string,
): { chart: string; duration: number } {
  const allDays = new Set<string>();
  for (const source of sources) {
    if (source.spend) {
      for (const day of source.spend.byDay.keys()) allDays.add(day);
      for (const day of source.knownDays ?? []) allDays.add(day);
      if (source.spend.byDay.size > 0 && source.knownMonths) {
        for (const month of source.knownMonths) allDays.add(`${month}-01`);
      }
    }
  }
  if (allDays.size < 2) return { chart: "", duration: 0 };
  const sorted = [...allDays].sort();
  const timeOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const dayAt = (time: number) => new Date(time).toISOString().slice(0, 10);
  // A month the source has no report for tells us nothing about its days, so
  // those days are left out of the line entirely.
  const reports = (source: SpendChartSource, day: string) =>
    (!source.knownMonths || source.knownMonths.has(day.slice(0, 7))) &&
    (!source.knownDays || source.knownDays.has(day));
  // A source is known through the newest day its reporting lag has settled. A
  // settled day with no report is a real $0. A day past that horizon has no
  // complete figure yet, even when the source already carries rows for it, so
  // the source's line stops there rather than drawing a partial day.
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const earliest = timeOf(sorted[0]);
  const knownThrough = new Map<SpendChartSource, number>();
  for (const source of sources) {
    if (!source.spend) continue;
    // A settled day in an unreported month has no figure to settle, so the
    // horizon falls back to the newest day the source does report on.
    let known = today - source.lagDays * DAY_MS;
    while (known >= earliest && !reports(source, dayAt(known))) {
      known -= DAY_MS;
    }
    knownThrough.set(source, known);
  }
  const end = maxOf(knownThrough.values());
  if (end < earliest) return { chart: "", duration: 0 };
  const start = Math.max(
    earliest,
    end - (SPEND_HISTORY_DAYS - 1) * DAY_MS,
  );
  const grid: string[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    grid.push(new Date(time).toISOString().slice(0, 10));
  }
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const currentDays = grid.filter((day) => day >= monthStart).length;
  const highlightDays = Math.min(
    grid.length,
    estimateDays ??
      Math.max(currentDays, MIN_SPEND_WINDOW_DAYS),
  );
  let highlightFrom = grid.length - highlightDays;
  if (estimateSince) {
    const estimateStart = grid.findIndex((day) => day >= estimateSince);
    highlightFrom = estimateStart < 0 ? grid.length : estimateStart;
  }
  const highlightCount = grid.length - highlightFrom;
  const lines = sources.flatMap((source) => {
    const known = knownThrough.get(source);
    if (known === undefined) return [];
    const covered = Math.min(
      grid.length,
      Math.max(0, Math.round((known - start) / DAY_MS) + 1),
    );
    if (covered === 0) return [];
    const columns = grid.slice(0, covered)
      .map((day, index) => ({ day, index }))
      .filter(({ day }) => reports(source, day));
    return [{
      vals: columns.map(({ day }) => source.spend!.byDay.get(day) ?? 0),
      // A line that skips days, or that the grid outlives, keeps its points on
      // the shared day axis and its highlight aligned to the shared trailing
      // window.
      xs: columns.length === grid.length
        ? undefined
        : columns.map(({ index }) => index / (grid.length - 1)),
      ...themedChartSeries(source.color),
      label: source.label,
      highlightCount: columns.filter(({ index }) => index >= highlightFrom)
        .length,
      // Two day columns apart is a day with no figure, so the path breaks
      // there instead of drawing a straight run across the missing days.
      maxXGap: 1.5 / (grid.length - 1),
      showSinglePoint: true,
    }];
  });
  return {
    chart: multiSparkline(lines, {
      fade: true,
      highlight: { count: highlightCount },
      scale: { highlighted: true },
    }),
    duration: end - start + DAY_MS,
  };
}
