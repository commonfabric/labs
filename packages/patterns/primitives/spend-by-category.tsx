/**
 * Totals a month of bank transactions by the category the connector already
 * wrote on each row, newest category first by size. It takes the rows rather
 * than the database, so it composes with whatever read them — the month bound
 * and the tombstone filter stay in the reader that owns them, and this atom
 * never grows a second copy of either.
 *
 * Income is excluded by default. A Plaid ledger carries deposits in the same
 * table under `INCOME`, and a spending total that quietly nets them off is
 * wrong in a way nobody sees; `includeIncome` turns them back on for a caller
 * that wants the whole ledger.
 *
 * Totals come from `amount` rather than `signed_amount`, so a spend figure is
 * positive and comparable against a budget. The sign lives in the ledger for a
 * caller that needs it.
 *
 * @hashtags spending, categories, totals, budget, finance, plaid, month
 * @keywords spend by category, category totals, how much did I spend,
 * spending breakdown, per-category total, monthly spending, bank categories
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

/**
 * The part of a ledger row this atom reads. A reader's richer row satisfies
 * it, which is what lets the two compose without either naming the other.
 */
export interface SpendTransaction {
  amount: number;
  category_primary: string;
  iso_currency_code?: string | Default<"">;
}

/** One category's spending for the month. */
export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

export interface SpendByCategoryInput {
  /** The month's transactions, as a reader returned them. */
  rows?: SpendTransaction[] | Default<[]>;

  /** Whether deposits count toward the totals. They do not by default. */
  includeIncome?: boolean | Default<false>;
}

export interface SpendByCategoryOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Every category with spending, largest total first. */
  categories: CategoryTotal[];

  categoryCount: number;

  /** What every category below comes to. */
  grandTotal: number;

  /** The currency the rows carried, empty when they carried none. */
  currency: string;
}

/** The category name a row with none still has to be counted under. */
const UNCATEGORIZED = "UNCATEGORIZED";

/** What a Plaid ledger calls a deposit. */
const INCOME_CATEGORY = "INCOME";

/**
 * Every category in `rows`, with what it came to and how many rows made it,
 * largest first and ties broken by name so the order is stable across reads.
 *
 * Module scope rather than a pattern-owned callback, which is where imperative
 * iteration belongs.
 */
const totalsByCategory = (
  rows: readonly SpendTransaction[],
  includeIncome: boolean,
): CategoryTotal[] => {
  const totals = new Map<string, CategoryTotal>();
  for (const row of rows) {
    const category = row?.category_primary || UNCATEGORIZED;
    if (!includeIncome && category === INCOME_CATEGORY) continue;
    const running = totals.get(category);
    const amount = Number(row?.amount) || 0;
    if (running === undefined) {
      totals.set(category, { category, total: amount, count: 1 });
      continue;
    }
    running.total += amount;
    running.count += 1;
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, total: Math.round(entry.total * 100) / 100 }))
    .sort((left, right) =>
      right.total - left.total || (left.category < right.category ? -1 : 1)
    );
};

/** The first currency the rows name, empty when none of them names one. */
const currencyOf = (rows: readonly SpendTransaction[]): string =>
  rows.find((row) => (row?.iso_currency_code ?? "") !== "")
    ?.iso_currency_code ?? "";

/** `amount` to the cent, under `code` when there is one. */
const money = (amount: number, code: string): string =>
  `${(amount || 0).toFixed(2)}${code === "" ? "" : ` ${code}`}`;

export const SpendByCategory = pattern<
  SpendByCategoryInput,
  SpendByCategoryOutput
>(({ rows, includeIncome }) => {
  const categories = computed(() =>
    totalsByCategory(rows ?? [], includeIncome === true)
  );
  const categoryCount = computed(() => categories.length);
  const grandTotal = computed(() =>
    Math.round(
      categories.reduce(
        (sum: number, entry: CategoryTotal) => sum + entry.total,
        0,
      ) * 100,
    ) / 100
  );
  const currency = computed(() => currencyOf(rows ?? []));
  const isEmpty = computed(() => categories.length === 0);

  const listRows = categories.map((entry: CategoryTotal) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-text style="flex: 1;">{entry.category}</cf-text>
      <cf-text tone="muted">
        {computed(() =>
          `${entry.count}`
        )}
      </cf-text>
      <cf-text style="font-variant-numeric: tabular-nums;">
        {computed(() =>
          money(entry.total, currency)
        )}
      </cf-text>
    </cf-hstack>
  ));

  return {
    [NAME]: computed(() => `Spending by category (${categoryCount})`),
    [UI]: (
      <cf-vstack gap="3" padding="3">
        <cf-hstack justify="between" align="center">
          <cf-heading level={5}>Spending by category</cf-heading>
          <cf-text style="font-variant-numeric: tabular-nums;">
            {computed(() => money(grandTotal, currency))}
          </cf-text>
        </cf-hstack>

        <cf-vstack gap="2">
          {listRows}
        </cf-vstack>

        {ifElse(
          isEmpty,
          <cf-empty-state message="No spending to total." />,
          null,
        )}
      </cf-vstack>
    ),
    categories,
    categoryCount,
    grandTotal,
    currency,
  };
});

export default SpendByCategory;
