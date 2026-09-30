/**
 * Tests LedgerMonthTransactions: the tombstone rule, the month window, the
 * default month, the rendered list and empty state, and the failure text.
 *
 * The atom takes no `reactOn`, because a database it only reads has nothing to
 * react to. Its `month` input is reactive, so a test seeds the rows and then
 * names the month, which is what re-runs the query over them.
 *
 * Run: deno task cf test packages/patterns/primitives/ledger-month-transactions.test.tsx
 */
import {
  action,
  assert,
  handler,
  NAME,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  findElementByText,
  findNodeByProp,
  textContent,
} from "../test/vnode-helpers.ts";
import LedgerMonthTransactions from "./ledger-month-transactions.tsx";

/** The ledger columns the atom projects, as the connector store declares them. */
const ledgerTable = () =>
  table({
    record_id: "text primary key",
    transaction_id: "text",
    account_id: "text",
    date: "text",
    amount: "real",
    signed_amount: "real",
    merchant_name: "text",
    name: "text",
    pending: "integer",
    category_primary: "text",
    iso_currency_code: "text",
    status: "text",
    deleted: "integer",
    deleted_at: "text",
  });

const insertSql = (): string =>
  "INSERT INTO rows_plaid_transaction (record_id, transaction_id, " +
  "account_id, date, amount, signed_amount, merchant_name, name, pending, " +
  "category_primary, iso_currency_code, status, deleted, deleted_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Seeds one live row, one tombstone and one row in the next month. The
 * tombstone carries `deleted = 1` with `deleted_at` set and the live row
 * carries `deleted = 0` with `deleted_at` the empty string, which is how the
 * connector store writes both: the text column is never NULL either way.
 */
const seedLedger = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(insertSql(), [
    "live",
    "txn-live",
    "acct-1",
    "2026-03-04",
    84.2,
    -84.2,
    "Pacific Gas",
    "Pacific Gas autopay",
    0,
    "GENERAL_SERVICES",
    "USD",
    "posted",
    0,
    "",
  ]);
  db.exec(insertSql(), [
    "gone",
    "txn-gone",
    "acct-1",
    "2026-03-06",
    12,
    -12,
    "Refunded Co",
    "Refunded Co charge",
    0,
    "GENERAL_MERCHANDISE",
    "USD",
    "posted",
    1,
    "2026-03-07T12:00:00Z",
  ]);
  db.exec(insertSql(), [
    "later",
    "txn-later",
    "acct-1",
    "2026-04-02",
    9,
    -9,
    "Next Month Co",
    "Next Month Co charge",
    0,
    "GENERAL_SERVICES",
    "USD",
    "posted",
    0,
    "",
  ]);
});

/**
 * A ledger table missing the columns the atom projects, which is what a handle
 * wired to a store of another shape looks like from inside the query.
 */
const narrowLedgerTable = () =>
  table({ record_id: "text primary key", date: "text" });

/** One row, so the query over the narrow table has a reason to run. */
const seedNarrow = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO rows_plaid_transaction (record_id, date) VALUES (?, ?)",
    ["narrow", "2026-03-04"],
  );
});

/**
 * A caller that takes a month of its own and does not require it, and hands it
 * to the atom — the shape the atom meets inside a larger pattern that has a
 * month input to forward. An input nobody supplied reads `undefined`, and
 * `undefined` is not a value a query can bind.
 */
interface ForwardedMonthInput {
  bank: SqliteDb;
  month?: string;
}

interface ForwardedMonthOutput {
  month: string;
  rowCount: number;
  errorMessage: string;
}

const ForwardedMonthCaller = pattern<
  ForwardedMonthInput,
  ForwardedMonthOutput
>(({ bank, month }) => {
  const ledger = LedgerMonthTransactions({ bank, month });
  return {
    month: ledger.month,
    rowCount: ledger.rowCount,
    errorMessage: ledger.errorMessage,
  };
});

/**
 * One live row in the month the database's own clock is in, and one in the
 * month after it, both dated in SQL because a handler is denied the clock
 * inside the sandbox. It is what the atom answers a caller that named no
 * month, so it sits in a database of its own where it cannot join the month
 * the rows above are read from.
 *
 * TWO rows, because the seed reads the clock and the atom reads it again: a
 * month boundary crossed between them resolves the read to the month after
 * the one seeded. With a row in each, exactly one of them is inside whichever
 * month the read resolves, so the count the assertions make is the same on
 * both sides of the boundary rather than right for all but an instant.
 */
const seedCurrentMonth = handler<void, { db: SqliteDb }>((_, { db }) => {
  const insert = (months: string): string =>
    "INSERT INTO rows_plaid_transaction (record_id, transaction_id, " +
    "account_id, date, amount, signed_amount, merchant_name, name, " +
    "pending, category_primary, iso_currency_code, status, deleted, " +
    "deleted_at) VALUES (?, ?, ?, " +
    `date(strftime('%Y-%m', 'now', 'localtime') || '-15', '${months}'), ` +
    "?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const row = (id: string) => [
    id,
    `txn-${id}`,
    "acct-1",
    31.5,
    -31.5,
    "This Month Co",
    "This Month Co charge",
    0,
    "GENERAL_SERVICES",
    "USD",
    "posted",
    0,
    "",
  ];
  db.exec(insert("+0 month"), row("current"));
  db.exec(insert("+1 month"), row("next"));
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: { rows_plaid_transaction: ledgerTable() },
  });
  const seed = seedLedger({ db });

  // Both months start on one the seed puts nothing in. `month` is the atom's
  // one reactive input, so naming a month is what re-runs the query over rows
  // seeded after the atom was built.
  const month = new Writable("1970-01");
  // Session-scoped, because the atom's rows come from session-scoped queries
  // and a space-scoped slot holding a link to one resolves per reader.
  const ledger = LedgerMonthTransactions.asScope("session")({
    bank: db,
    month,
  });

  // A store whose ledger table does not carry the columns the atom projects,
  // which is what a handle wired to a store of another shape looks like from
  // inside the query.
  const narrow = sqliteDatabase({
    tables: { rows_plaid_transaction: narrowLedgerTable() },
  });
  const seedNarrowRow = seedNarrow({ db: narrow });
  const brokenMonth = new Writable("1970-01");
  const broken = LedgerMonthTransactions({ bank: narrow, month: brokenMonth });

  // A database of its own, so the row dated by the clock cannot land in the
  // month the assertions above read.
  const current = sqliteDatabase({
    tables: { rows_plaid_transaction: ledgerTable() },
  });
  const seedCurrent = seedCurrentMonth({ db: current });
  const forwarded = ForwardedMonthCaller({ bank: current });

  return {
    // The one warning this allows is normalizeAndDiff's "Storing a
    // session-scoped link in space-scoped data", raised when reading `[UI]`
    // puts a link to the atom's session-scoped query result into the vnode
    // tree. Per-reader resolution is what a session-scoped result is for, and
    // the slot holding the link is a view-node child the atom does not
    // declare. The flag is a boolean, so it cannot be pinned to that text.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert(() => ledger.rowCount === 0) },
      { assertion: assert(() => broken.rowCount === 0) },

      { action: action(() => seed.send()) },
      { action: action(() => seedNarrowRow.send()) },
      { action: action(() => seedCurrent.send()) },
      { action: action(() => brokenMonth.set("2026-03")) },

      // A store of another shape reports why rather than an empty month, and
      // the view says so.
      { assertion: assert(() => broken.errorMessage !== "") },
      {
        assertion: assert(() => broken.errorMessage.includes("no such column")),
      },
      { assertion: assert(() => broken.rowCount === 0) },
      {
        assertion: assert(() =>
          findElementByText(broken[UI], "cf-alert", broken.errorMessage) !==
            undefined
        ),
      },
      { action: action(() => month.set("2026-03")) },

      // The live row survives; the tombstone does not, and neither does the
      // row a month later.
      { assertion: assert(() => ledger.rowCount === 1) },
      {
        assertion: assert(() => ledger.rows[0].merchant_name === "Pacific Gas"),
      },
      { assertion: assert(() => ledger.rows[0].date === "2026-03-04") },
      { assertion: assert(() => ledger.rows[0].signed_amount === -84.2) },
      { assertion: assert(() => ledger.rows[0].pending === 0) },
      // Projected because the connector store's row-label rule reads it: a
      // query that drops it is refused there and reports an empty ledger.
      { assertion: assert(() => ledger.rows[0].status === "posted") },
      { assertion: assert(() => ledger.month === "2026-03") },
      { assertion: assert(() => ledger.errorMessage === "") },
      { assertion: assert(() => ledger[NAME] === "Transactions 2026-03 (1)") },

      // A read that did not fail renders no alert, which is the other half of
      // the failing-store case: without this, an alert shown over empty text
      // would satisfy that one.
      {
        assertion: assert(() =>
          findElement(ledger[UI], "cf-alert") === undefined
        ),
      },

      // The rendered list states the same row: its merchant, and the amount
      // formatted under the row's own currency.
      {
        assertion: assert(() =>
          findElementByText(ledger[UI], "cf-text", "Pacific Gas") !== undefined
        ),
      },
      {
        assertion: assert(() => textContent(ledger[UI]).includes("-84.20 USD")),
      },
      {
        assertion: assert(() =>
          !textContent(ledger[UI]).includes("Refunded Co")
        ),
      },
      {
        assertion: assert(() =>
          findNodeByProp(
            ledger[UI],
            "message",
            "No transactions this month.",
          ) === undefined
        ),
      },

      // A month the seed left empty reads back empty rather than stale, and
      // the view says so.
      { action: action(() => month.set("2026-05")) },
      { assertion: assert(() => ledger.rowCount === 0) },
      { assertion: assert(() => ledger.month === "2026-05") },
      { assertion: assert(() => ledger.pending === false) },
      {
        assertion: assert(() =>
          findNodeByProp(
            ledger[UI],
            "message",
            "No transactions this month.",
          ) !== undefined
        ),
      },

      // Naming no month resolves one from the database's own clock rather
      // than leaving the window unbounded.
      { action: action(() => month.set("")) },
      { assertion: assert(() => ledger.month.length === 7) },
      { assertion: assert(() => ledger.month.charAt(4) === "-") },
      { assertion: assert(() => ledger.errorMessage === "") },

      // A caller forwarding a month input nobody supplied gets the same
      // month from the clock, and the row the seed dated in it. Forwarding
      // reads `undefined` rather than leaving the key out, so the input's own
      // default is not what makes this hold.
      //
      // The seed writes a row in this month and one in the next, so the row
      // the read finds is one whichever side of a month boundary the read's
      // own clock lands on.
      //
      // Read for the first time HERE, after the seed, and that is what makes
      // the row visible: the atom takes no `reactOn`, so a read that already
      // settled over an empty table would not run again for a write. An
      // assertion over `forwarded` placed before the seed would settle that
      // read and take the row away from these.
      { assertion: assert(() => forwarded.errorMessage === "") },
      { assertion: assert(() => forwarded.month.length === 7) },
      { assertion: assert(() => forwarded.rowCount === 1) },
    ],
  };
});
