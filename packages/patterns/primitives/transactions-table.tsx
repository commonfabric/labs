/**
 * Shows bank transactions as a formatted table whose column headings sort it,
 * with the row count above. It takes the rows as input rather than reading a
 * ledger, so it pairs with the published month reader or any source of the
 * same row shape, and it never writes to them: sorting derives an ordered copy
 * under a per-session sort key, so read-only rows from a reader sort as well as
 * rows a host owns, and each session keeps its own order.
 *
 * Amounts are each row's `signed_amount` in whole currency units, shown with
 * two decimals and the row's currency symbol; a negative amount is money out.
 * Dates show as "Sep 7, 2026". Rows start newest first; clicking a heading
 * sorts by that column, and clicking it again reverses it.
 *
 * @hashtags bank, transactions, finance, table, sortable, ledger, plaid
 * @keywords sortable transactions table, bank transactions table, sort by
 * column, sort by amount, sort by date, transaction list, spending table,
 * ledger table, formatted transactions, this month's transactions
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** One transaction, under the column names a Plaid ledger row carries. */
export interface TransactionRow {
  transaction_id: string;
  date: string;
  signed_amount: number;
  merchant_name: string;
  name?: string | Default<"">;
  category_primary?: string | Default<"">;
  account_id?: string | Default<"">;
  iso_currency_code?: string | Default<"">;
  status?: string | Default<"">;
  pending?: number | Default<0>;
}

/** A column the table can be ordered by. */
export type SortKey =
  | "date"
  | "description"
  | "category"
  | "account"
  | "amount"
  | "status";

export interface TransactionsTableInput {
  /** The transactions to show. Read only; the table never writes to them. */
  rows?: TransactionRow[] | Default<[]>;

  /** Heading above the table. */
  title?: string | Default<"Transactions">;
}

/** A row as displayed: formatted text beside the value it sorts by. */
export interface DisplayedTransaction {
  id: string;
  date: string;
  dateLabel: string;
  description: string;
  category: string;
  account: string;
  amount: number;
  amountLabel: string;
  status: string;
  pending: boolean;
}

export interface TransactionsTableOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The rows in the order the table shows them. */
  sortedRows: DisplayedTransaction[];

  rowCount: number;
  sortBy: SortKey;
  ascending: boolean;

  /** Sorts by a column, reversing when it is already the sort column. */
  sortByColumn: Stream<{ column: SortKey }>;
}

interface SortState {
  key: SortKey;
  ascending: boolean;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-07" as "Sep 7, 2026"; anything else as given. */
const formatDate = (value: string): string => {
  const parts = value.slice(0, 10).split("-");
  if (parts.length !== 3) return value;
  const month = MONTHS[Number(parts[1]) - 1];
  return month === undefined
    ? value
    : `${month} ${Number(parts[2])}, ${parts[0]}`;
};

/** Whole currency units with two decimals, a symbol, and a minus for money out. */
const formatCurrency = (value: number, code: string): string => {
  const currency = code || "USD";
  const symbol = currency === "USD"
    ? "$"
    : currency === "EUR"
    ? "€"
    : currency === "GBP"
    ? "£"
    : `${currency} `;
  const [whole, cents] = Math.abs(value).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "−" : ""}${symbol}${grouped}.${cents}`;
};

/** The order a first click on `key` gives: newest date first, the rest ascending. */
const firstDirection = (key: SortKey): boolean => key !== "date";

const displayed = (row: TransactionRow): DisplayedTransaction => ({
  id: row.transaction_id,
  date: row.date,
  dateLabel: formatDate(row.date),
  description: row.merchant_name || row.name || "Unlabeled transaction",
  category: (row.category_primary || "Uncategorized").replaceAll("_", " "),
  account: row.account_id || "—",
  amount: row.signed_amount,
  amountLabel: formatCurrency(row.signed_amount, row.iso_currency_code ?? ""),
  status: row.status || (row.pending ? "Pending" : "Posted"),
  pending: Boolean(row.pending),
});

const compare = (
  a: DisplayedTransaction,
  b: DisplayedTransaction,
  key: SortKey,
): number =>
  key === "amount"
    ? a.amount - b.amount
    : String(a[key]).localeCompare(String(b[key]));

const HEADINGS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "date", label: "Date", numeric: false },
  { key: "description", label: "Description", numeric: false },
  { key: "category", label: "Category", numeric: false },
  { key: "account", label: "Account", numeric: false },
  { key: "amount", label: "Amount", numeric: true },
  { key: "status", label: "Status", numeric: false },
];

const heading = {
  padding: "0",
  borderBottom: "1px solid #d9e2e8",
  whiteSpace: "nowrap",
};
const headingButton = {
  width: "100%",
  padding: "0.9rem 1rem",
  border: "0",
  background: "transparent",
  color: "#41525d",
  font: "inherit",
  fontSize: "0.72rem",
  fontWeight: "750",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
};
const cell = { padding: "0.9rem 1rem", borderBottom: "1px solid #edf2f1" };

export const TransactionsTable = pattern<
  TransactionsTableInput,
  TransactionsTableOutput
>(({ rows, title }) => {
  const state = new Writable.perSession<SortState>({
    key: "date",
    ascending: false,
  });

  const sortedRows = computed(() => {
    const { key, ascending } = state.get();
    return (rows ?? []).map(displayed).sort((a, b) =>
      ascending ? compare(a, b, key) : -compare(a, b, key)
    );
  });
  const rowCount = computed(() => (rows ?? []).length);
  const sortBy = computed(() => state.get().key);
  const ascending = computed(() => state.get().ascending);

  const sortByColumn = action(({ column }: { column: SortKey }) => {
    const current = state.get();
    state.set({
      key: column,
      ascending: current.key === column
        ? !current.ascending
        : firstDirection(column),
    });
  });

  const headings = HEADINGS.map(({ key, label, numeric }) => (
    <th style={{ ...heading, textAlign: numeric ? "right" : "left" }}>
      <button
        type="button"
        style={{ ...headingButton, textAlign: numeric ? "right" : "left" }}
        onClick={() =>
          sortByColumn.send({ column: key })}
      >
        {label}
        {computed(() =>
          state.get().key === key ? (state.get().ascending ? " ▲" : " ▼") : " ↕"
        )}
      </button>
    </th>
  ));

  const body = sortedRows.map((row: DisplayedTransaction) => (
    <tr>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{row.dateLabel}</td>
      <td style={{ ...cell, fontWeight: "650" }}>{row.description}</td>
      <td style={{ ...cell, textTransform: "capitalize" }}>
        {computed(() => row.category.toLowerCase())}
      </td>
      <td style={{ ...cell, fontFamily: "monospace", fontSize: "0.78rem" }}>
        {row.account}
      </td>
      <td
        style={{
          ...cell,
          textAlign: "right",
          whiteSpace: "nowrap",
          fontWeight: "750",
          color: computed(() => (row.amount < 0 ? "#a24232" : "#14614f")),
        }}
      >
        {row.amountLabel}
      </td>
      <td
        style={{ ...cell, whiteSpace: "nowrap", textTransform: "capitalize" }}
      >
        {computed(() => row.status.toLowerCase())}
      </td>
    </tr>
  ));

  return {
    [NAME]: computed(() => `${title} (${rowCount})`),
    [UI]: (
      <cf-vstack gap="4" padding="4">
        <header
          style={{
            display: "flex",
            gap: "1rem",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: "0", fontFamily: "Georgia, serif" }}>{title}</h2>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "1.8rem", fontWeight: "750" }}>
              {rowCount}
            </div>
            <div style={{ fontSize: "0.76rem" }}>transactions</div>
          </div>
        </header>
        <cf-card>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr>{headings}</tr>
              </thead>
              <tbody>{body}</tbody>
            </table>
          </div>
        </cf-card>
      </cf-vstack>
    ),
    sortedRows,
    rowCount,
    sortBy,
    ascending,
    sortByColumn,
  };
});

export default TransactionsTable;
