/**
 * Tests TransactionsTable: the default newest-first order, sorting by a
 * column and reversing it, the formatting, and that sorting orders a derived
 * copy while leaving the input rows as they were given.
 *
 * Run: deno task cf test packages/patterns/primitives/transactions-table.test.tsx
 */
import { action, assert, computed, pattern, TESTS } from "commonfabric";
import TransactionsTable from "./transactions-table.tsx";

const ROWS = [
  {
    transaction_id: "t1",
    date: "2026-09-02",
    signed_amount: -6.75,
    merchant_name: "Coffee Roasters",
    category_primary: "FOOD_AND_DRINK",
    iso_currency_code: "USD",
    status: "posted",
  },
  {
    transaction_id: "t2",
    date: "2026-09-07",
    signed_amount: -1176.3,
    merchant_name: "Insurance Group",
    category_primary: "GENERAL_SERVICES",
    iso_currency_code: "USD",
    status: "pending",
  },
  {
    transaction_id: "t3",
    date: "2026-09-04",
    signed_amount: 250,
    merchant_name: "",
    name: "Refund",
    iso_currency_code: "EUR",
  },
];

// A row with no status, whose pending flag decides what the table shows.
const PENDING_ROW = [{
  transaction_id: "p1",
  date: "2026-09-08",
  signed_amount: -12,
  merchant_name: "Parking",
  pending: 1,
}];

// Rows that carry only what a ledger row must, in forms the table has no
// special case for: the fallbacks decide every label these show.
const SPARSE_ROWS = [
  {
    transaction_id: "s1",
    date: "2026-09-03",
    signed_amount: 1234.5,
    merchant_name: "",
    iso_currency_code: "GBP",
    account_id: "acct-1",
  },
  {
    transaction_id: "s2",
    date: "2026-13-01",
    signed_amount: -3,
    merchant_name: "Kiosk",
    iso_currency_code: "CAD",
  },
  {
    transaction_id: "s3",
    date: "sometime",
    signed_amount: 1,
    merchant_name: "Vending",
  },
];

export default pattern(() => {
  const sparse = TransactionsTable({ rows: SPARSE_ROWS });
  const table = TransactionsTable({ rows: ROWS });
  const empty = TransactionsTable({ rows: [] });
  const pendingOnly = TransactionsTable({ rows: PENDING_ROW });
  // Rows derived by a computed, as a reader hands them over: read only, so a
  // table that sorted by rewriting its rows could not order them at all.
  const derived = TransactionsTable({
    rows: computed(() => ROWS.map((row) => ({ ...row }))),
  });

  const byAmount = action(() => table.sortByColumn.send({ column: "amount" }));
  const byDescription = action(() =>
    table.sortByColumn.send({ column: "description" })
  );
  const derivedByAmount = action(() =>
    derived.sortByColumn.send({ column: "amount" })
  );

  return {
    [TESTS]: [
      { assertion: assert(() => table.rowCount === 3) },
      { assertion: assert(() => empty.rowCount === 0) },

      // Newest first before anything is clicked.
      { assertion: assert(() => table.sortBy === "date") },
      { assertion: assert(() => table.sortedRows[0].id === "t2") },
      { assertion: assert(() => table.sortedRows[2].id === "t1") },

      // Formatting: whole currency units, grouped, signed, with the symbol.
      {
        assertion: assert(() =>
          table.sortedRows[0].amountLabel === "−$1,176.30"
        ),
      },
      {
        assertion: assert(() =>
          table.sortedRows[0].dateLabel === "Sep 7, 2026"
        ),
      },
      {
        assertion: assert(() => table.sortedRows[1].amountLabel === "€250.00"),
      },
      // A row with no merchant name falls back to its transaction name.
      { assertion: assert(() => table.sortedRows[1].description === "Refund") },
      // A row with neither a status nor a pending flag defaults to posted.
      { assertion: assert(() => table.sortedRows[1].status === "Posted") },
      // A row with no status but a pending flag shows as pending.
      {
        assertion: assert(() => pendingOnly.sortedRows[0].status === "Pending"),
      },

      // Sparse rows, newest first as text: "sometime", then month 13, then s1.
      { assertion: assert(() => sparse.sortedRows[0].id === "s3") },
      // A date that is not year-month-day, or names no month, shows as given.
      {
        assertion: assert(() => sparse.sortedRows[0].dateLabel === "sometime"),
      },
      {
        assertion: assert(() =>
          sparse.sortedRows[1].dateLabel === "2026-13-01"
        ),
      },
      // No currency code reads as dollars; an unlisted one shows its code.
      { assertion: assert(() => sparse.sortedRows[0].amountLabel === "$1.00") },
      {
        assertion: assert(() =>
          sparse.sortedRows[1].amountLabel === "−CAD 3.00"
        ),
      },
      {
        assertion: assert(() =>
          sparse.sortedRows[2].amountLabel === "£1,234.50"
        ),
      },
      // A row with neither a merchant name nor a transaction name.
      {
        assertion: assert(() =>
          sparse.sortedRows[2].description === "Unlabeled transaction"
        ),
      },
      // No category and no account each show a placeholder; an account shows.
      {
        assertion: assert(() =>
          sparse.sortedRows[2].category === "Uncategorized"
        ),
      },
      { assertion: assert(() => sparse.sortedRows[2].account === "acct-1") },
      { assertion: assert(() => sparse.sortedRows[1].account === "—") },
      // A category's underscores read as spaces.
      {
        assertion: assert(() =>
          table.sortedRows[0].category === "GENERAL SERVICES"
        ),
      },

      // A first click on a non-date column sorts it ascending, as numbers.
      { action: byAmount },
      { assertion: assert(() => table.sortBy === "amount") },
      { assertion: assert(() => table.ascending === true) },
      { assertion: assert(() => table.sortedRows[0].id === "t2") },
      { assertion: assert(() => table.sortedRows[2].id === "t3") },

      // The same column again reverses it.
      { action: byAmount },
      { assertion: assert(() => table.ascending === false) },
      { assertion: assert(() => table.sortedRows[0].id === "t3") },

      // Another column sorts by that one, as text.
      { action: byDescription },
      {
        assertion: assert(() =>
          table.sortedRows[0].description === "Coffee Roasters"
        ),
      },

      // Read-only rows derived by a computed sort all the same.
      { action: derivedByAmount },
      { assertion: assert(() => derived.sortBy === "amount") },
      { assertion: assert(() => derived.sortedRows[0].id === "t2") },
      { assertion: assert(() => derived.sortedRows[2].id === "t3") },
    ],
  };
});
