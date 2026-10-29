/**
 * Reads one month of bank transactions out of a loom connector ledger — the
 * Plaid `rows_plaid_transaction` table a finance connector writes — newest
 * first, bounded to the month and to 500 rows, with a list `[UI]` over them.
 * Live rows are `deleted = 0`: the shared connector store writes its text
 * columns never-NULL and marks a tombstone with that integer flag, so a
 * `deleted_at IS NULL` filter matches no row at all and reports an empty
 * ledger over a full table. `month` picks the window as `YYYY-MM`, and
 * defaults to the calendar month the database's own clock is in.
 *
 * The projection carries `status` because the connector store's row-label rule
 * reads it, and a query that does not project every column its table's rule
 * reads is refused rather than returned unlabeled — the refusal names the
 * missing column in `error`, unlike the wrong tombstone filter, which reports
 * an empty ledger and no reason at all. `describe_handle` names the columns a
 * handle's rules read.
 *
 * @hashtags plaid, bank, transactions, ledger, finance, month, connector
 * @keywords bank transactions, plaid ledger, this month's transactions,
 * bill payments, spending, deleted flag, tombstone, connector store,
 * SqliteDb handle
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  type SqliteDb,
  UI,
  type VNode,
} from "commonfabric";

/** One row of `rows_plaid_transaction`, under the column names it carries. */
export interface LedgerTransaction {
  transaction_id: string;
  date: string;
  amount: number;
  signed_amount: number;
  merchant_name: string;
  name: string;
  account_id: string;
  pending: number;
  category_primary: string;
  iso_currency_code: string;

  /**
   * What the connector says became of the transaction. Projected because the
   * table's row-label rule reads it, not because the view shows it.
   */
  status: string;
}

export interface LedgerMonthTransactionsInput {
  /** The connector ledger to read. Whoever wired the input chose which. */
  bank: SqliteDb;

  /** The month to read, as `YYYY-MM`. Empty means the current month. */
  month?: string | Default<"">;
}

export interface LedgerMonthTransactionsOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The month the rows were read from, as `YYYY-MM`. */
  month: string;

  rows: LedgerTransaction[];
  rowCount: number;
  pending: boolean;

  /** Why the read failed, empty while it has not. */
  errorMessage: string;
}

/**
 * The month the caller asked for, else the one the database's clock is in.
 *
 * The clock is read in SQL rather than in the pattern because a pattern body
 * and a `computed` are both denied the clock inside the sandbox.
 */
const resolvedMonthSql = (): string =>
  "COALESCE(NULLIF(?, ''), strftime('%Y-%m', 'now', 'localtime'))";

/** One row naming the month the rows below were read from. */
const monthSql = (): string => `SELECT ${resolvedMonthSql()} AS month`;

/**
 * The month as a half-open range over `date` rather than a `substr` of it, so
 * an index on the column can be walked to the bound instead of scanned past
 * it.
 */
const rowsSql = (): string =>
  [
    `WITH bounds AS (SELECT ${resolvedMonthSql()} || '-01' AS start)`,
    "SELECT t.transaction_id, t.date, t.amount, t.signed_amount,",
    "  t.merchant_name, t.name, t.account_id, t.pending,",
    "  t.category_primary, t.iso_currency_code, t.status",
    "FROM bounds, rows_plaid_transaction t",
    "WHERE t.deleted = 0",
    "  AND t.date >= bounds.start",
    "  AND t.date < date(bounds.start, '+1 month')",
    "ORDER BY t.date DESC",
    "LIMIT 500",
  ].join("\n");

/**
 * What a query reports about a failure, empty when it has not failed.
 *
 * The same narrowing the sqlite builtin applies before it writes one, so a
 * value that reaches here already a message passes through unchanged.
 */
const errorText = (error: unknown): string =>
  error === undefined || error === null
    ? ""
    : error instanceof Error
    ? error.message
    : String(error);

/** `amount` as a signed figure in `code`, to the cent. */
const money = (amount: number, code: string): string =>
  `${(amount || 0).toFixed(2)} ${code || "USD"}`;

export const LedgerMonthTransactions = pattern<
  LedgerMonthTransactionsInput,
  LedgerMonthTransactionsOutput
>(({ bank, month }) => {
  // The param is a value READ out of `month`, not `month` itself. A query
  // binds the reference it is handed and resolves it without the declared
  // default, so a month a caller forwarded and nobody supplied reaches the
  // query as `undefined`, and an undefined param fails the whole read rather
  // than resolving to the month the SQL above answers an empty string with.
  const monthParam = computed(() => month);

  const monthRead = bank.query<{ month: string }>(monthSql(), {
    params: [monthParam],
    scope: "session",
  });
  const rowsRead = bank.query<LedgerTransaction>(rowsSql(), {
    params: [monthParam],
    scope: "session",
  });

  const resolvedMonth = computed(() => monthRead.result?.[0]?.month ?? "");
  const rows = computed(() => rowsRead.result ?? []);
  const rowCount = computed(() => (rowsRead.result ?? []).length);
  const pending = computed(() => rowsRead.pending === true);
  const errorMessage = computed(() => errorText(rowsRead.error));
  const hasError = computed(() => errorMessage !== "");
  const isEmpty = computed(() =>
    !pending && !hasError && (rowsRead.result ?? []).length === 0
  );

  const listRows = rows.map((row: LedgerTransaction) => (
    <cf-hstack gap="2" align="center" justify="between">
      <cf-text style="flex: 1;">
        {computed(() =>
          row.merchant_name || row.name || "Unnamed"
        )}
      </cf-text>
      <cf-text tone="muted">{row.date}</cf-text>
      <cf-text style="font-variant-numeric: tabular-nums;">
        {computed(() =>
          money(row.signed_amount, row.iso_currency_code)
        )}
      </cf-text>
    </cf-hstack>
  ));

  return {
    [NAME]: computed(() => `Transactions ${resolvedMonth} (${rowCount})`),
    [UI]: (
      <cf-vstack gap="3" padding="3">
        <cf-hstack justify="between" align="center">
          <cf-heading level={5}>Bank transactions</cf-heading>
          <cf-text tone="muted">{resolvedMonth}</cf-text>
        </cf-hstack>

        {ifElse(
          hasError,
          <cf-alert status="error">{errorMessage}</cf-alert>,
          null,
        )}

        <cf-vstack gap="2">
          {listRows}
        </cf-vstack>

        {ifElse(
          isEmpty,
          <cf-empty-state message="No transactions this month." />,
          null,
        )}
      </cf-vstack>
    ),
    month: resolvedMonth,
    rows,
    rowCount,
    pending,
    errorMessage,
  };
});

export default LedgerMonthTransactions;
