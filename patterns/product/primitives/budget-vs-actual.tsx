/**
 * Sets a month's budgets beside what was actually spent, and says plainly what
 * it could not line up. Budgets and spending are named by different people —
 * a budget carries whatever words its author wrote, a bank row carries
 * whatever the connector wrote — so a join on exact equality returns zeros
 * over a full ledger and looks like an answer. This atom joins on a normalized
 * key, aggregating spelling variants, then falls back to a published alias
 * table and reports every
 * budget and every category it still could not match rather than showing a
 * confident zero.
 *
 * The alias table maps the words a personal budget uses onto Plaid's category
 * primaries. `groceries` and `dining` both fall inside `FOOD_AND_DRINK`, so
 * their budgets are added together and the row says which two made it up: the
 * ledger cannot separate them, and inventing a split would be a number nobody
 * measured. An alias only ever applies where the normalized join found
 * nothing, and the row names the alias it used.
 *
 * @hashtags budget, spending, comparison, variance, finance, categories
 * @keywords budget vs actual, over budget, under budget, spending against
 * budget, variance, budget comparison, category budgets, remaining budget
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

/** One budget, as its author named it. */
export interface BudgetRow {
  category: string;
  budget: number;
}

/** One category's spending, as a totalling atom returned it. */
export interface SpendRow {
  category: string;
  total: number;
}

/** One budget set against the spending it was matched to. */
export interface ComparisonRow {
  /** The spending category this row reports on. */
  category: string;

  /** The budget names that fed it, joined by `+` when more than one did. */
  budgetNames: string;

  budget: number;
  actual: number;

  /** `budget - actual`. Negative is over. */
  delta: number;

  /** `exact`, `normalized`, or `alias` — how the two sides were joined. */
  matchedVia: string;
}

export interface BudgetVsActualInput {
  /** The budgets to report against. */
  budgets?: BudgetRow[] | Default<[]>;

  /** What was actually spent, by category. */
  spend?: SpendRow[] | Default<[]>;

  /** Whether the published alias table may be used. It may by default. */
  useAliases?: boolean | Default<true>;
}

export interface BudgetVsActualOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Every budget that found spending, largest overspend first. */
  rows: ComparisonRow[];

  /** Budget names that matched no spending category. */
  unmatchedBudgets: string[];

  /** Spending categories that matched no budget. */
  unmatchedSpend: string[];

  totalBudget: number;
  totalActual: number;

  /** How many rows are over their budget. */
  overCount: number;
}

/**
 * The alias table, from a budget's own word to the Plaid primary that holds
 * its spending. Published here rather than inferred, so a reader can see what
 * was assumed and a caller can turn it off.
 */
const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  groceries: "FOOD_AND_DRINK",
  dining: "FOOD_AND_DRINK",
  restaurants: "FOOD_AND_DRINK",
  utilities: "RENT_AND_UTILITIES",
  rent: "RENT_AND_UTILITIES",
  transport: "TRANSPORTATION",
  transportation: "TRANSPORTATION",
  entertainment: "ENTERTAINMENT",
  medical: "MEDICAL",
  health: "MEDICAL",
};

/** A category name with case, spaces, underscores and hyphens taken out. */
const normalize = (name: string): string =>
  (name ?? "").toLowerCase().replace(/[\s_-]+/g, "");

/** Where a budget's spending sits, and how that was decided. */
interface Resolution {
  key: string;
  via: string;
}

/** Raw names and normalized spellings stay distinct for match provenance. */
interface SpendKeys {
  raw: Map<string, string>;
  normalized: Map<string, string>;
}

/**
 * The spending category a budget belongs to: its own name when a category
 * carries it, else the alias table's answer, else nothing.
 */
const resolve = (
  budgetName: string,
  spendKeys: SpendKeys,
  useAliases: boolean,
): Resolution | undefined => {
  const exact = spendKeys.raw.get(budgetName);
  if (exact !== undefined) return { key: exact, via: "exact" };
  const normalized = spendKeys.normalized.get(normalize(budgetName));
  if (normalized !== undefined) return { key: normalized, via: "normalized" };
  if (!useAliases) return undefined;
  const aliasKey = normalize(budgetName);
  const alias = Object.hasOwn(CATEGORY_ALIASES, aliasKey)
    ? CATEGORY_ALIASES[aliasKey]
    : undefined;
  if (alias === undefined) return undefined;
  const aliased = spendKeys.normalized.get(normalize(alias));
  return aliased === undefined ? undefined : { key: aliased, via: "alias" };
};

/** Raw and normalized names resolve to the first spelling of each category. */
const spendKeysOf = (spend: readonly SpendRow[]): SpendKeys => {
  const raw = new Map<string, string>();
  const normalized = new Map<string, string>();
  for (const row of spend) {
    const name = row?.category ?? "";
    if (name === "") continue;
    const key = normalize(name);
    const canonical = normalized.get(key) ?? name;
    raw.set(name, canonical);
    normalized.set(key, canonical);
  }
  return { raw, normalized };
};

/** Totals under the same canonical names used to resolve budgets. */
const spendTotals = (
  spend: readonly SpendRow[],
  keys: ReadonlyMap<string, string>,
): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const row of spend) {
    const name = keys.get(row?.category ?? "");
    if (name === undefined) continue;
    totals.set(name, (totals.get(name) ?? 0) + (Number(row?.total) || 0));
  }
  return totals;
};

/** Two decimal places, the way money is compared. */
const cents = (amount: number): number => Math.round(amount * 100) / 100;

/** The comparison, plus what neither side could be joined to. */
interface Comparison {
  rows: ComparisonRow[];
  unmatchedBudgets: string[];
  unmatchedSpend: string[];
}

/**
 * Budgets against spending, one row per spending category that a budget
 * reached. Several budgets reaching one category are added together, because
 * the ledger holds no split between them to report.
 */
const compare = (
  budgets: readonly BudgetRow[],
  spend: readonly SpendRow[],
  useAliases: boolean,
): Comparison => {
  const keys = spendKeysOf(spend);
  const totals = spendTotals(spend, keys.raw);
  const grouped = new Map<string, ComparisonRow>();
  const unmatchedBudgets: string[] = [];

  for (const entry of budgets) {
    const name = entry?.category ?? "";
    if (name === "") continue;
    const resolution = resolve(name, keys, useAliases);
    if (resolution === undefined) {
      unmatchedBudgets.push(name);
      continue;
    }
    const running = grouped.get(resolution.key);
    const amount = Number(entry?.budget) || 0;
    if (running === undefined) {
      grouped.set(resolution.key, {
        category: resolution.key,
        budgetNames: name,
        budget: amount,
        actual: cents(totals.get(resolution.key) ?? 0),
        delta: 0,
        matchedVia: resolution.via,
      });
      continue;
    }
    running.budget += amount;
    running.budgetNames = `${running.budgetNames} + ${name}`;
    // An aggregate names the least direct match it used.
    if (
      resolution.via === "alias" ||
      (resolution.via === "normalized" && running.matchedVia === "exact")
    ) running.matchedVia = resolution.via;
  }

  const rows = [...grouped.values()]
    .map((row) => ({
      ...row,
      budget: cents(row.budget),
      delta: cents(row.budget - row.actual),
    }))
    .sort((left, right) => left.delta - right.delta);

  const matched = new Set(rows.map((row) => row.category));
  const unmatchedSpend = [...totals.keys()].filter((name) =>
    !matched.has(name)
  );
  return { rows, unmatchedBudgets, unmatchedSpend };
};

/** `amount` to the cent. */
const money = (amount: number): string => (amount || 0).toFixed(2);

export const BudgetVsActual = pattern<
  BudgetVsActualInput,
  BudgetVsActualOutput
>(({ budgets, spend, useAliases }) => {
  const comparison = computed(() =>
    compare(budgets ?? [], spend ?? [], useAliases !== false)
  );
  const rows = computed(() => comparison.rows);
  const unmatchedBudgets = computed(() => comparison.unmatchedBudgets);
  const unmatchedSpend = computed(() => comparison.unmatchedSpend);
  const totalBudget = computed(() =>
    cents(rows.reduce((sum: number, row: ComparisonRow) => sum + row.budget, 0))
  );
  const totalActual = computed(() =>
    cents(rows.reduce((sum: number, row: ComparisonRow) => sum + row.actual, 0))
  );
  const overCount = computed(() =>
    rows.filter((row: ComparisonRow) => row.delta < 0).length
  );
  const isEmpty = computed(() => rows.length === 0);
  const hasUnmatched = computed(() =>
    unmatchedBudgets.length > 0 || unmatchedSpend.length > 0
  );

  const listRows = rows.map((row: ComparisonRow) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-vstack gap="0" style="flex: 1;">
        <cf-text>{row.category}</cf-text>
        <cf-text tone="muted">
          {computed(() =>
            row.matchedVia === "alias"
              ? `${row.budgetNames} (alias)`
              : row.budgetNames
          )}
        </cf-text>
      </cf-vstack>
      <cf-text tone="muted" style="font-variant-numeric: tabular-nums;">
        {computed(() =>
          `${money(row.actual)} / ${money(row.budget)}`
        )}
      </cf-text>
      <cf-text style="font-variant-numeric: tabular-nums;">
        {computed(() =>
          row.delta < 0
            ? `over ${money(-row.delta)}`
            : `left ${money(row.delta)}`
        )}
      </cf-text>
    </cf-hstack>
  ));

  return {
    [NAME]: computed(() => `Budget vs actual (${overCount} over)`),
    [UI]: (
      <cf-vstack gap="3" padding="3">
        <cf-hstack justify="between" align="center">
          <cf-heading level={5}>Budget vs actual</cf-heading>
          <cf-text style="font-variant-numeric: tabular-nums;">
            {computed(() => `${money(totalActual)} / ${money(totalBudget)}`)}
          </cf-text>
        </cf-hstack>

        <cf-vstack gap="2">
          {listRows}
        </cf-vstack>

        {ifElse(
          isEmpty,
          <cf-empty-state message="No budget matched any spending." />,
          null,
        )}

        {ifElse(
          hasUnmatched,
          <cf-alert status="info">
            {computed(() =>
              `Unmatched budgets: ${
                unmatchedBudgets.join(", ") || "none"
              }. Unmatched spending: ${unmatchedSpend.join(", ") || "none"}.`
            )}
          </cf-alert>,
          null,
        )}
      </cf-vstack>
    ),
    rows,
    unmatchedBudgets,
    unmatchedSpend,
    totalBudget,
    totalActual,
    overCount,
  };
});

export default BudgetVsActual;
