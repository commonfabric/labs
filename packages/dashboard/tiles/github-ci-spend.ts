/**
 * Reports month-to-date GitHub cost and projects it to a full-month total. The
 * 45-day daily-spend chart labels the line with month-to-date spend.
 *
 * GitHub's enhanced billing report supplies daily net spend, one row per
 * product, SKU, repository and day. Every one of those rows counts here, so
 * the tile carries the billing account's whole GitHub bill as a single figure:
 * Actions and its storage, Packages, Codespaces, Git LFS, models, sandboxes,
 * and the seat licenses GitHub meters — Copilot, Advanced Security, and
 * Enterprise Cloud. A product the account does not use has no row and
 * adds nothing.
 *
 * A subscription GitHub bills outside that report does not reach the API at
 * all, and is absent from this figure. The package README records which spend
 * that is, under "What the GitHub figure covers".
 *
 * The report carries rows for a day while that day is still under way, and
 * takes a day or two after it ends to finish it. Those days are partial
 * figures, so the chart and the projection's rate stop short of them. A
 * settled day with no row is a day that spent nothing. That reading holds
 * only while the report is still writing rows, so a report whose newest row is
 * too far back is unavailable rather than a run of $0 days.
 *
 * The headline covers every product, while the budget the tile's color comes
 * from covers only the products someone has budgeted at the selected account
 * scope. Those two are held apart rather than compared across: a product with
 * no budget of its own is taken to be spending within one, so it adds to the
 * figure without coloring it. The budget printed beside the headline stands
 * in for those products at their own projection, so the two figures on the
 * tile cover the same products and the headline sits at or under the budget
 * exactly when the tile is green.
 */

import type { Status, Tile, TileView } from "../types.ts";
import {
  budgetStatus,
  daysLabel,
  escapeHtml,
  friendlyError,
  github,
  usd,
} from "../lib.ts";
import { REPO } from "../config.ts";
import {
  calendarMonth,
  reportLagDays,
  settled,
  SPEND_HISTORY_DAYS,
  spendChart,
  summarizeDailySpend,
} from "../spend.ts";
import { themedChartSeries } from "../theme.ts";

interface UsageItem {
  date: string;
  product: string;
  netAmount: number;
}

/** A spending ceiling returned by GitHub's billing API. */
interface Budget {
  /** Whether the budget covers a product, SKU, bundle, or resource. */
  budget_type?: string;

  /** The account or resource level the ceiling applies to. */
  budget_scope?: string;

  /** The older API spelling for the product or SKU the budget covers. */
  budget_product_sku?: string;

  /** The products or SKUs the budget covers. */
  budget_product_skus?: string[];

  /** The ceiling in US dollars. */
  budget_amount?: number;
}

interface ActionsBilling {
  total_minutes_used: number;
  total_paid_minutes_used: number;
  included_minutes: number;
}

interface DailySpend {
  byDay: Map<string, number>;
  mtd: number;
  projected: number;
  estimateDays: number;
}

interface GitHubDollarSpend extends DailySpend {
  kind: "dollars";
  budget: number;

  /**
   * The projected month-end spend of the products the account has budgeted,
   * which is the figure the budget is a ceiling for. The headline
   * covers every product; this covers the ones the budget speaks to.
   */
  projectedBudgeted: number;

  /** Enterprise days whose summary was unavailable in the current month. */
  unavailableDays: number;

  /** Enterprise days that returned a report, including days that cost $0. */
  knownDays?: Set<string>;

  /**
   * The calendar months whose usage report was read, as "YYYY-MM". A month
   * that could not be read is absent, and its days are unknown rather than $0.
   */
  months: Set<string>;
}

interface GitHubMinuteSpend {
  kind: "minutes";
  used: number;
  included: number;
  paid: number;
}

type GitHubSpend = GitHubDollarSpend | GitHubMinuteSpend;

/** An account level whose usage and budgets cover the same resources. */
type BillingScope = "enterprise" | "organization";

/** The API and web locations for one billing account. */
interface BillingTarget {
  /** The account level used to filter its budgets. */
  kind: BillingScope;

  /** The account's unescaped GitHub login or enterprise slug. */
  slug: string;

  /** The REST path prefix for the account. */
  apiPath: string;

  /** The account's billing settings page. */
  href: string;
}

const BILLING_API_VERSION = "2026-03-10";
const BILLING_REQUEST = {
  apiVersion: BILLING_API_VERSION,
  ignoreStatuses: [404],
};

/** Names the REST and web locations for a billing account. */
function targetFor(kind: BillingScope, slug: string): BillingTarget {
  const escaped = encodeURIComponent(slug);
  return kind === "enterprise"
    ? {
      kind,
      slug,
      apiPath: `enterprises/${escaped}`,
      href: `https://github.com/enterprises/${escaped}/settings/billing`,
    }
    : {
      kind,
      slug,
      apiPath: `organizations/${escaped}`,
      href: `https://github.com/organizations/${escaped}/settings/billing`,
    };
}

/** Names an organization's daily-item report for one month. */
function usagePath(
  target: BillingTarget,
  year: number,
  month: number,
): string {
  const query = new URLSearchParams({
    year: String(year),
    month: String(month),
  });
  return `${target.apiPath}/settings/billing/usage?${query}`;
}

/** Names an enterprise's all-cost-center summary for one day. */
function usageSummaryPath(
  target: BillingTarget,
  year: number,
  month: number,
  day: number,
): string {
  const query = new URLSearchParams({
    year: String(year),
    month: String(month),
    day: String(day),
  });
  return `${target.apiPath}/settings/billing/usage/summary?${query}`;
}

const budgetsPath = (target: BillingTarget, page: number) =>
  `${target.apiPath}/settings/billing/budgets?` +
  `per_page=100&scope=${target.kind}&page=${page}`;

const monthKey = (year: number, month0: number) =>
  `${year}-${String(month0 + 1).padStart(2, "0")}`;

export const GITHUB_LAG_DAYS = 2;
// How far back a source's newest row may sit before the tile stops reading the
// source. GitHub reports within a day or two of a day ending, so four days
// without a row is a feed that has stopped rather than one running late. A
// stretch where the account bills nothing at all leaves the same gap, and a
// weekend of it stays inside this.
const MAX_REPORT_LAG_DAYS = 4;
const GITHUB_COLOR = "#58a6ff";
const GITHUB_SWATCH = `<span class="swatch" style="background:${
  themedChartSeries(GITHUB_COLOR).color
}"></span>`;

function dayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === day ? day : null;
}

function addDaily(
  target: Map<string, number>,
  day: string,
  amount: number,
): void {
  if (amount === 0) return;
  target.set(day, (target.get(day) ?? 0) + amount);
}

/**
 * Adds the report's rows to the whole-account series, and the rows whose
 * product carries a budget to the budgeted series beside it.
 */
function addGitHubDays(
  target: Map<string, number>,
  budgetedTarget: Map<string, number>,
  budgetedProducts: ReadonlySet<string>,
  items: UsageItem[],
): void {
  for (const item of items) {
    const day = dayKey(item.date);
    if (!day) continue;
    const amount = Number(item.netAmount) || 0;
    addDaily(target, day, amount);
    if (budgetedProducts.has(String(item.product).toLowerCase())) {
      addDaily(budgetedTarget, day, amount);
    }
  }
}

class GitHubUsageShapeError extends Error {}

/**
 * The error a source raises when its newest row is too far back to read the
 * days after it. The message names the source and how far behind it has
 * fallen.
 */
class StalledReportError extends Error {}

/**
 * Throws when the source's newest row sits further back than a source that is
 * still reporting would leave it. A source with no row at all dates nothing and
 * charts nothing, so there is no reading of it to protect.
 */
function requireCurrentReport(
  source: string,
  reportedThrough: string | undefined,
  now: Date,
): void {
  if (reportedThrough === undefined) return;
  const lag = reportLagDays(reportedThrough, now);
  if (lag > MAX_REPORT_LAG_DAYS) {
    throw new StalledReportError(`${source} ${daysLabel(lag)} behind`);
  }
}

/** Product ceilings at one billing scope and the products they cover. */
interface AccountBudget {
  /** The product budgets added up, or NaN when none is set. */
  total: number;

  /** The products those budgets cover, lowercased. */
  products: Set<string>;
}

const NO_BUDGET: AccountBudget = { total: NaN, products: new Set() };

/**
 * What the selected billing account has budgeted across GitHub: its product
 * budgets at that account's scope, added up, and which products they speak for.
 * A product budget caps one product's whole spend, so the products' budgets add
 * up without overlapping. A single-SKU budget sits inside its own product's
 * budget, and a bundle budget covers the AI credit SKUs of the products beside
 * it, so adding either would count the same spend twice. A budget scoped below
 * the account caps part of its spend rather than adding to it. An account with
 * no product budget is uncompared, as NaN.
 *
 * Which products the budgets cover matters as much as the total, because the
 * ceiling is held against those products' spend alone.
 */
function readBudgets(
  budgets: Budget[],
  scope: BillingScope,
): AccountBudget {
  // Keyed by product, so a product the endpoint names more than once sets one
  // ceiling rather than a multiple of it.
  const byProduct = new Map<string, number>();
  for (const entry of budgets) {
    if (String(entry.budget_type).toLowerCase() !== "productpricing") continue;
    if (String(entry.budget_scope).toLowerCase() !== scope) continue;
    const products = Array.isArray(entry.budget_product_skus)
      ? entry.budget_product_skus
      : [entry.budget_product_sku];
    if (products.length !== 1) continue;
    const product = products[0];
    if (typeof product !== "string" || product === "") continue;
    // An amount that is absent, null, or a string is not a ceiling. Reading it
    // through Number() would turn each of those into a $0 budget, which every
    // amount of spend overruns.
    const amount = entry.budget_amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    const key = product.toLowerCase();
    byProduct.set(key, Math.max(byProduct.get(key) ?? amount, amount));
  }
  if (byProduct.size === 0) return NO_BUDGET;
  let total = 0;
  for (const amount of byProduct.values()) total += amount;
  return { total, products: new Set(byProduct.keys()) };
}

/** Reads every page of product budgets at the selected account scope. */
async function accountBudgets(
  target: BillingTarget,
  token: string,
): Promise<AccountBudget> {
  const budgets: Budget[] = [];
  let page = 1;
  let hasNextPage: boolean;
  do {
    const response = await github<{
      budgets?: Budget[];
      has_next_page?: boolean;
    }>(budgetsPath(target, page), token, BILLING_REQUEST);
    if (Array.isArray(response.budgets)) {
      for (const budget of response.budgets) budgets.push(budget);
    }
    hasNextPage = response.has_next_page === true;
    page++;
  } while (hasNextPage);
  return readBudgets(budgets, target.kind);
}

/**
 * Reads one month at the target account scope. Enterprise summary requests
 * include every cost center by default; one request per day preserves the
 * daily series while bounding concurrent requests to the days in a month. A
 * day that fails or has no usable array is absent from knownDays, so it becomes
 * a hole rather than either discarding the month or reading as $0.
 */
async function usageForMonth(
  target: BillingTarget,
  token: string,
  year: number,
  month: number,
  throughDay = new Date(Date.UTC(year, month, 0)).getUTCDate(),
): Promise<{ items: UsageItem[]; knownDays?: Set<string> }> {
  if (target.kind === "organization") {
    const report = await github<{ usageItems?: UsageItem[] }>(
      usagePath(target, year, month),
      token,
      BILLING_REQUEST,
    );
    if (!Array.isArray(report.usageItems)) {
      throw new GitHubUsageShapeError("billing usage unavailable");
    }
    return { items: report.usageItems };
  }

  const reports = await Promise.all(
    Array.from({ length: throughDay }, (_, index) => index + 1).map(
      async (day) => {
        try {
          const report = await github<{
            usageItems?: Omit<UsageItem, "date">[];
          }>(
            usageSummaryPath(target, year, month, day),
            token,
            BILLING_REQUEST,
          );
          return {
            day,
            items: Array.isArray(report.usageItems)
              ? report.usageItems
              : undefined,
          };
        } catch {
          return { day, items: undefined };
        }
      },
    ),
  );
  let items: UsageItem[] = [];
  const knownDays = new Set<string>();
  for (const { day, items: dailyItems } of reports) {
    if (!dailyItems) continue;
    const date = `${year}-${String(month).padStart(2, "0")}-${
      String(day).padStart(2, "0")
    }`;
    knownDays.add(date);
    items = items.concat(dailyItems.map((item) => ({ ...item, date })));
  }
  if (knownDays.size === 0) {
    throw new GitHubUsageShapeError("billing usage unavailable");
  }
  return { items, knownDays };
}

async function githubDollarSpend(
  token: string,
  target: BillingTarget,
  now: Date,
): Promise<GitHubDollarSpend> {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  // Read first, because which products carry a budget decides how the report's
  // rows are split as they are read.
  let budgets = NO_BUDGET;
  try {
    budgets = await accountBudgets(target, token);
  } catch {
    // An unset GitHub budget leaves the spend projection uncompared.
  }
  const currentReport = await usageForMonth(
    target,
    token,
    year,
    month0 + 1,
    dayOfMonth,
  );
  const current = currentReport.items;

  // One billing pipeline writes the report, a row at a time, for every product
  // the account used on a day. Its newest row, whatever product that row
  // belongs to, is how far the pipeline has been written.
  let reportedThrough: string | undefined;
  const knownDays = currentReport.knownDays ? new Set<string>() : undefined;
  const noteReport = (
    report: { items: UsageItem[]; knownDays?: ReadonlySet<string> },
  ): void => {
    for (const day of report.knownDays ?? []) {
      knownDays?.add(day);
      if (reportedThrough === undefined || day > reportedThrough) {
        reportedThrough = day;
      }
    }
    const items = report.items;
    for (const entry of items) {
      const day = dayKey(entry.date);
      if (day && (reportedThrough === undefined || day > reportedThrough)) {
        reportedThrough = day;
      }
    }
  };

  noteReport(currentReport);
  const mtd = current.reduce(
    (sum, item) => sum + (Number(item.netAmount) || 0),
    0,
  );
  // The budgeted products' share of that total, counted from the rows rather
  // than from the days, so a row whose date is unreadable weighs on the
  // comparison as it already weighs on the headline. It has no day to chart,
  // so it stays out of the series below.
  const budgetedMtd = current.reduce(
    (sum, item) =>
      budgets.products.has(String(item.product).toLowerCase())
        ? sum + (Number(item.netAmount) || 0)
        : sum,
    0,
  );
  const byDay = new Map<string, number>();
  // The same days over the budgeted products alone. A product with no budget
  // of its own is taken to be spending within one, so it is left out of the
  // figure the ceiling is compared with, and the light turns on what the
  // account actually set a limit for.
  const budgetedByDay = new Map<string, number>();
  addGitHubDays(byDay, budgetedByDay, budgets.products, current);
  const months = new Set<string>([monthKey(year, month0)]);
  let priorMonthDaily: number[] = [];
  let priorMonthBudgetedDaily: number[] = [];
  let immediatePrior = true;
  let remaining = SPEND_HISTORY_DAYS - dayOfMonth;
  let previousYear = year;
  let previousMonth = month0;
  while (remaining > 0) {
    previousMonth--;
    if (previousMonth < 0) {
      previousMonth = 11;
      previousYear--;
    }
    try {
      const previous = await usageForMonth(
        target,
        token,
        previousYear,
        previousMonth + 1,
      );
      noteReport(previous);
      addGitHubDays(
        byDay,
        budgetedByDay,
        budgets.products,
        previous.items,
      );
      months.add(monthKey(previousYear, previousMonth));
      if (immediatePrior) {
        const settleMonth = (days: Map<string, number>) => {
          const series = calendarMonth(days, previousYear, previousMonth);
          const complete = settled(
            series,
            series.length + dayOfMonth,
            GITHUB_LAG_DAYS,
          );
          if (!previous.knownDays) return complete;
          const prefix = String(previousYear) + "-" +
            String(previousMonth + 1).padStart(2, "0") + "-";
          return complete.filter((_, index) =>
            previous.knownDays?.has(
              prefix + String(index + 1).padStart(2, "0"),
            )
          );
        };
        priorMonthDaily = settleMonth(byDay);
        priorMonthBudgetedDaily = settleMonth(budgetedByDay);
      }
    } catch {
      // A missing prior month shortens the chart and leaves current billing usable.
    }
    remaining -= new Date(
      Date.UTC(previousYear, previousMonth + 1, 0),
    ).getUTCDate();
    immediatePrior = false;
  }
  requireCurrentReport("GitHub billing report", reportedThrough, now);
  const unavailableDays = currentReport.knownDays
    ? dayOfMonth - currentReport.knownDays.size
    : 0;

  return {
    kind: "dollars",
    byDay,
    ...summarizeDailySpend(
      byDay,
      now,
      {
        lagDays: GITHUB_LAG_DAYS,
        measuredMtd: mtd,
        priorMonthDaily,
        knownDays,
      },
    ),
    projectedBudgeted: summarizeDailySpend(
      budgetedByDay,
      now,
      {
        lagDays: GITHUB_LAG_DAYS,
        measuredMtd: budgetedMtd,
        priorMonthDaily: priorMonthBudgetedDaily,
        knownDays,
      },
    ).projected,
    budget: budgets.total,
    months,
    unavailableDays,
    knownDays,
  };
}

async function githubSpend(
  token: string,
  target: BillingTarget,
  now: Date,
): Promise<GitHubSpend> {
  try {
    return await githubDollarSpend(token, target, now);
  } catch (error) {
    // The classic endpoint answers for an org without the enhanced billing
    // platform. A report that is there but unreadable, or there but no longer
    // being written, is not that org.
    if (
      error instanceof GitHubUsageShapeError ||
      error instanceof StalledReportError ||
      target.kind === "enterprise"
    ) {
      throw error;
    }
    const billing = await github<ActionsBilling>(
      `orgs/${encodeURIComponent(target.slug)}/settings/billing/actions`,
      token,
    );
    return {
      kind: "minutes",
      used: Number(billing.total_minutes_used) || 0,
      included: Number(billing.included_minutes) || 0,
      paid: Number(billing.total_paid_minutes_used) || 0,
    };
  }
}

function minutesView(
  target: BillingTarget,
  spend: GitHubMinuteSpend,
): TileView {
  const fraction = spend.included > 0 ? spend.used / spend.included : 0;
  const status: Status = spend.paid > 0 || fraction >= 1
    ? "bad"
    : fraction >= 0.8
    ? "warn"
    : "good";
  return {
    status,
    value: `${spend.paid} paid min`,
    sub: `${spend.used} / ${spend.included} min · MTD`,
    href: target.href,
    hint: "billing ↗",
  };
}

/** The first reported day whose value contributes to the projection rate. */
function projectionStartDay(
  knownDays: ReadonlySet<string> | undefined,
  now: Date,
  lagDays: number,
  estimateDays: number,
): string | undefined {
  if (!knownDays || estimateDays <= 0) return undefined;
  const settledThrough = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - lagDays,
  )).toISOString().slice(0, 10);
  const days = [...knownDays].filter((day) => day <= settledThrough).sort();
  return days[Math.max(0, days.length - estimateDays)];
}

function unavailableMessage(error: unknown): string {
  if (error instanceof GitHubUsageShapeError) return error.message;
  if (error instanceof StalledReportError) return error.message;
  if (!(error instanceof Error)) return "GitHub spend unavailable";
  return friendlyError(error.message);
}

export const githubCiSpend: Tile = {
  label: "github spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const token = ctx.env("GH_BILLING_TOKEN") ?? ctx.env("GH_TOKEN") ??
      ctx.env("GITHUB_TOKEN");
    if (!token) {
      return {
        status: "unknown",
        value: "—",
        sub: "set GH_BILLING_TOKEN or GH_TOKEN",
      };
    }

    const enterprise = ctx.env("GH_BILLING_ENTERPRISE")?.trim();
    const target = enterprise
      ? targetFor("enterprise", enterprise)
      : targetFor(
        "organization",
        ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0],
      );
    const drill = {
      href: target.href,
      hint: "billing ↗",
    };
    const now = new Date();
    try {
      const spend = await githubSpend(token, target, now);
      if (spend.kind === "minutes") return minutesView(target, spend);

      const budget = spend.budget;
      // Against the budgeted products' projection, not the headline's. The
      // headline covers products the budget never spoke for, and holding those
      // against it would turn the light on spend nobody set a limit for.
      const status = spend.unavailableDays > 0
        ? "unknown"
        : budgetStatus(spend.projectedBudgeted, budget);
      const chart = spendChart(
        [{
          spend,
          color: GITHUB_COLOR,
          label: usd(spend.mtd),
          lagDays: GITHUB_LAG_DAYS,
          knownMonths: spend.months,
          knownDays: spend.knownDays,
        }],
        now,
        spend.estimateDays,
        projectionStartDay(
          spend.knownDays,
          now,
          GITHUB_LAG_DAYS,
          spend.estimateDays,
        ),
      );
      const amount = chart.chart ? "" : ` ${usd(spend.mtd)}`;
      // The ceiling shown beside the headline covers the products the headline
      // covers: the budgets that exist, plus each unbudgeted product's own
      // projection standing in for the budget nobody set for it. Showing the
      // configured total alone would put a headline carrying unbudgeted spend
      // above its own budget while the tile stayed green. Adding the difference
      // between the two projections keeps the pair reading the same way the
      // color does — at or under the ceiling exactly when the tile is green.
      const shownBudget = budget + (spend.projected - spend.projectedBudgeted);
      const budgetLabel = Number.isFinite(shownBudget)
        ? ` • Budget ${usd(shownBudget)}`
        : "";
      const legendText = `GitHub${amount}${budgetLabel}`;
      const legend =
        `<p class="sub" title="${escapeHtml(legendText)}">${GITHUB_SWATCH} ${legendText}</p>`;
      const value = `~${usd(spend.projected)}/mo`;
      const mtd = `${usd(spend.mtd)}${
        spend.unavailableDays > 0 ? " partial" : ""
      } MTD`;

      return {
        ...drill,
        status,
        value,
        valueLabel: value,
        aside: `<span class="hfacet" title="${mtd}">${mtd}</span>`,
        sub: spend.unavailableDays > 0
          ? `${spend.unavailableDays} billing ${
            spend.unavailableDays === 1 ? "day" : "days"
          } unavailable`
          : undefined,
        extra: `${legend}${chart.chart}`,
        duration: chart.duration,
      };
    } catch (error) {
      return {
        ...drill,
        status: "unknown",
        value: "—",
        sub: unavailableMessage(error),
        extra:
          `<p class="sub" title="GitHub $???">${GITHUB_SWATCH} GitHub $???</p>`,
      };
    }
  },
};
