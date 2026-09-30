/**
 * Reports month-to-date GitHub cost and projects it to a full-month total. The
 * 45-day daily-spend chart labels the line with month-to-date spend.
 *
 * GitHub's enhanced billing report supplies daily net spend, one row per
 * product, SKU, repository and day. Every one of those rows counts here, so
 * the tile carries the organization's whole GitHub bill as a single figure:
 * Actions and its storage, Packages, Codespaces, Git LFS, models, sandboxes,
 * and the seat licenses GitHub meters — Copilot, Advanced Security, and
 * Enterprise Cloud. A product the organization does not use has no row and
 * adds nothing.
 *
 * A subscription GitHub bills outside that report does not reach the API at
 * all, and is absent from this figure. The package README records which spend
 * that is, under "What the GitHub figure covers".
 *
 * A day reaches the report a day or two after it ends, and a settled day with
 * no row is a day that spent nothing. That reading holds only while the report
 * is still writing rows, so a report whose newest row is too far back is
 * unavailable rather than a run of $0 days.
 *
 * The headline covers every product, while the budget the tile's color comes
 * from covers only the products someone has budgeted. Those two are held apart
 * rather than compared across: a product with no budget of its own is taken to
 * be spending within one, so it adds to the figure without coloring it. The
 * budget printed beside the headline stands in for those products at their own
 * projection, so the two figures on the tile cover the same products and the
 * headline sits at or under the budget exactly when the tile is green.
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

interface Budget {
  budget_type?: string;
  budget_scope?: string;
  budget_product_sku?: string;
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
   * The projected month-end spend of the products the organization has
   * budgeted, which is the figure the budget is a ceiling for. The headline
   * covers every product; this covers the ones the budget speaks to.
   */
  projectedBudgeted: number;

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

const usagePath = (org: string, year: number, month: number) =>
  `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;

const monthKey = (year: number, month0: number) =>
  `${year}-${String(month0 + 1).padStart(2, "0")}`;

export const GITHUB_LAG_DAYS = 2;
// How far back a source's newest row may sit before the tile stops reading the
// source. GitHub reports within a day or two of a day ending, so four days
// without a row is a feed that has stopped rather than one running late. A
// stretch where the org bills nothing at all leaves the same gap, and a
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
 * Adds the report's rows to the whole-organization series, and the rows whose
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

interface OrgBudget {
  /** The product budgets added up, or NaN when none is set. */
  total: number;

  /** The products those budgets cover, lowercased. */
  products: Set<string>;
}

const NO_BUDGET: OrgBudget = { total: NaN, products: new Set() };

/**
 * What the organization has budgeted across GitHub: its product budgets added
 * up, and which products they speak for. A product budget caps one product's
 * whole spend, so the products' budgets add up without overlapping. A
 * single-SKU budget sits inside its own product's budget, and a bundle budget
 * covers the AI credit SKUs of the products beside it, so adding either would
 * count the same spend twice. A budget scoped to a repository or a user caps
 * part of the organization's spend rather than adding to it. An organization
 * with no product budget is uncompared, as NaN.
 *
 * Which products the budgets cover matters as much as the total, because the
 * ceiling is held against those products' spend alone.
 */
function readBudgets(budgets: Budget[]): OrgBudget {
  // Keyed by product, so a product the endpoint names more than once sets one
  // ceiling rather than a multiple of it.
  const byProduct = new Map<string, number>();
  for (const entry of budgets) {
    if (String(entry.budget_type).toLowerCase() !== "productpricing") continue;
    if (String(entry.budget_scope).toLowerCase() !== "organization") continue;
    const product = entry.budget_product_sku;
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

async function githubDollarSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubDollarSpend> {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  // Read first, because which products carry a budget decides how the report's
  // rows are split as they are read.
  let budgets = NO_BUDGET;
  try {
    const response = await github<{ budgets?: Budget[] }>(
      `organizations/${org}/settings/billing/budgets`,
      token,
      { ignoreStatuses: [404] },
    );
    budgets = readBudgets(response.budgets ?? []);
  } catch {
    // An unset GitHub budget leaves the spend projection uncompared.
  }
  const report = await github<{ usageItems?: UsageItem[] }>(
    usagePath(org, year, month0 + 1),
    token,
    { ignoreStatuses: [404] },
  );
  if (!Array.isArray(report.usageItems)) {
    throw new GitHubUsageShapeError("billing usage unavailable");
  }

  // One billing pipeline writes the report, a row at a time, for every product
  // the org used on a day. Its newest row, whatever product that row belongs
  // to, is how far the pipeline has been written.
  let reportedThrough: string | undefined;
  const noteReport = (items: UsageItem[]): void => {
    for (const entry of items) {
      const day = dayKey(entry.date);
      if (day && (reportedThrough === undefined || day > reportedThrough)) {
        reportedThrough = day;
      }
    }
  };

  const current = report.usageItems;
  noteReport(current);
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
  // organization actually set a limit for.
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
      const previous = await github<{ usageItems?: UsageItem[] }>(
        usagePath(org, previousYear, previousMonth + 1),
        token,
        { ignoreStatuses: [404] },
      );
      if (Array.isArray(previous.usageItems)) {
        noteReport(previous.usageItems);
        addGitHubDays(
          byDay,
          budgetedByDay,
          budgets.products,
          previous.usageItems,
        );
        months.add(monthKey(previousYear, previousMonth));
        if (immediatePrior) {
          const settleMonth = (days: Map<string, number>) => {
            const series = calendarMonth(days, previousYear, previousMonth);
            return settled(
              series,
              series.length + dayOfMonth,
              GITHUB_LAG_DAYS,
            );
          };
          priorMonthDaily = settleMonth(byDay);
          priorMonthBudgetedDaily = settleMonth(budgetedByDay);
        }
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
      },
    ),
    projectedBudgeted: summarizeDailySpend(
      budgetedByDay,
      now,
      {
        lagDays: GITHUB_LAG_DAYS,
        measuredMtd: budgetedMtd,
        priorMonthDaily: priorMonthBudgetedDaily,
      },
    ).projected,
    budget: budgets.total,
    months,
  };
}

async function githubSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubSpend> {
  try {
    return await githubDollarSpend(token, org, now);
  } catch (error) {
    // The classic endpoint answers for an org without the enhanced billing
    // platform. A report that is there but unreadable, or there but no longer
    // being written, is not that org.
    if (
      error instanceof GitHubUsageShapeError ||
      error instanceof StalledReportError
    ) {
      throw error;
    }
    const billing = await github<ActionsBilling>(
      `orgs/${org}/settings/billing/actions`,
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
  org: string,
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
    href: `https://github.com/organizations/${org}/settings/billing`,
    hint: "billing ↗",
  };
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
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    if (!token) {
      return {
        status: "unknown",
        value: "—",
        sub: "set GH_TOKEN (needs org billing read)",
      };
    }

    const org = ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0];
    const drill = {
      href: `https://github.com/organizations/${org}/settings/billing`,
      hint: "billing ↗",
    };
    const now = new Date();
    try {
      const spend = await githubSpend(token, org, now);
      if (spend.kind === "minutes") return minutesView(org, spend);

      const budget = spend.budget;
      // Against the budgeted products' projection, not the headline's. The
      // headline covers products the budget never spoke for, and holding those
      // against it would turn the light on spend nobody set a limit for.
      const status = budgetStatus(spend.projectedBudgeted, budget);
      const chart = spendChart(
        [{
          spend,
          color: GITHUB_COLOR,
          label: usd(spend.mtd),
          lagDays: GITHUB_LAG_DAYS,
          knownMonths: spend.months,
        }],
        now,
        spend.estimateDays,
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
      const mtd = `${usd(spend.mtd)} MTD`;

      return {
        ...drill,
        status,
        value,
        valueLabel: value,
        aside: `<span class="hfacet" title="${mtd}">${mtd}</span>`,
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
