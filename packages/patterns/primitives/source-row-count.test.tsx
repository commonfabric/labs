/**
 * Tests SourceRowCount: the two numbers over a full table and an empty one, a
 * predicate that matches no row of a table that holds rows, the rendered
 * figure, and the failure text a table or column the store does not carry
 * produces.
 *
 * The atom takes no `reactOn`, because a database it only reads has nothing to
 * react to. Its `table` and `predicate` inputs are reactive, so a test seeds
 * the rows and then names a predicate, which is what re-runs the aggregate
 * over them.
 *
 * Run: deno task cf test packages/patterns/primitives/source-row-count.test.tsx
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
  textContent,
} from "../test/vnode-helpers.ts";
import SourceRowCount from "./source-row-count.tsx";

/** The ledger columns a connector store declares, tombstone flag included. */
const ledgerTable = () =>
  table({
    record_id: "text primary key",
    date: "text",
    amount: "real",
    deleted: "integer",
    deleted_at: "text",
  });

const insertSql = (): string =>
  "INSERT INTO rows_plaid_transaction (record_id, date, amount, deleted, " +
  "deleted_at) VALUES (?, ?, ?, ?, ?)";

/**
 * Seeds two live rows and one tombstone. The tombstone carries `deleted = 1`
 * with `deleted_at` set and a live row carries `deleted = 0` with `deleted_at`
 * the empty string, which is how the connector store writes both: the text
 * column is never NULL either way, so a predicate on it matches every row.
 */
const seedLedger = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(insertSql(), ["live-one", "2026-03-04", 84.2, 0, ""]);
  db.exec(insertSql(), ["live-two", "2026-03-05", 12, 0, ""]);
  db.exec(insertSql(), ["gone", "2026-03-06", 9, 1, "2026-03-07T12:00:00Z"]);
});

/**
 * A caller that takes a predicate of its own and does not require it, and
 * hands it to the atom — the shape the atom meets inside a larger pattern that
 * has a predicate input to forward. An input nobody supplied reads
 * `undefined`, and `undefined` is not a predicate.
 */
interface ForwardedInput {
  source: SqliteDb;
  table: string;
  predicate?: string;
}

interface ForwardedOutput {
  total: number;
  matching: number;
  errorMessage: string;
}

const ForwardingCaller = pattern<ForwardedInput, ForwardedOutput>(
  ({ source, table: name, predicate }) => {
    const count = SourceRowCount({ source, table: name, predicate });
    return {
      total: count.total,
      matching: count.matching,
      errorMessage: count.errorMessage,
    };
  },
);

export default pattern(() => {
  const db = sqliteDatabase({
    tables: { rows_plaid_transaction: ledgerTable() },
  });
  const seed = seedLedger({ db });

  // Both inputs are reactive, so naming a predicate is what re-runs the
  // aggregate over rows seeded after the atom was built.
  const predicate = new Writable("");
  // Session-scoped, because the atom's numbers come from a session-scoped
  // query and a space-scoped slot holding a link to one resolves per reader.
  const count = SourceRowCount.asScope("session")({
    source: db,
    table: "rows_plaid_transaction",
    predicate,
  });

  const forwarded = ForwardingCaller({
    source: db,
    table: "rows_plaid_transaction",
  });

  const missingTable = new Writable("rows_plaid_transaction");
  const broken = SourceRowCount({
    source: db,
    table: missingTable,
    predicate: "deleted = 0",
  });

  return {
    // The one warning this allows is normalizeAndDiff's "Storing a
    // session-scoped link in space-scoped data", raised when reading `[UI]`
    // puts a link to the atom's session-scoped query result into the vnode
    // tree. Per-reader resolution is what a session-scoped result is for, and
    // the slot holding the link is a view-node child the atom does not
    // declare. The flag is a boolean, so it cannot be pinned to that text.
    allowConsoleWarnings: true,
    [TESTS]: [
      // A table the seed has not written to counts zero without failing.
      { assertion: assert(() => count.total === 0) },
      { assertion: assert(() => count.matching === 0) },
      { assertion: assert(() => count.errorMessage === "") },
      { assertion: assert(() => count.pending === false) },

      { action: action(() => seed.send()) },
      { action: action(() => predicate.set("deleted = 0")) },

      // The live rows match the tombstone rule the store writes; the total
      // counts the tombstone too.
      { assertion: assert(() => count.total === 3) },
      { assertion: assert(() => count.matching === 2) },
      { assertion: assert(() => count.predicate === "deleted = 0") },
      { assertion: assert(() => count.table === "rows_plaid_transaction") },
      { assertion: assert(() => count.errorMessage === "") },
      {
        assertion: assert(() =>
          count[NAME] === "2 of 3 rows in rows_plaid_transaction"
        ),
      },

      // The rendered figure states both numbers, and a read that did not fail
      // renders no alert.
      { assertion: assert(() => textContent(count[UI]).includes("2 of 3")) },
      {
        assertion: assert(() =>
          findElementByText(count[UI], "cf-text", "rows_plaid_transaction") !==
            undefined
        ),
      },
      {
        assertion: assert(() =>
          findElement(count[UI], "cf-alert") === undefined
        ),
      },

      // The other tombstone spelling over the same rows: a predicate that
      // matches nothing while the table holds rows, which is the difference
      // the two numbers state and one number could not.
      { action: action(() => predicate.set("deleted_at IS NULL")) },
      { assertion: assert(() => count.total === 3) },
      { assertion: assert(() => count.matching === 0) },
      { assertion: assert(() => count.errorMessage === "") },

      // Naming no predicate counts every row.
      { action: action(() => predicate.set("")) },
      { assertion: assert(() => count.total === 3) },
      { assertion: assert(() => count.matching === 3) },

      // A caller forwarding a predicate nobody supplied counts every row too.
      //
      // A TRIPWIRE rather than a proof. This atom interpolates its predicate
      // into the SQL text and binds no params at all, so the undefined-param
      // failure the other two readers were fixed for cannot reach it, and
      // nothing that can be done to the atom today makes these three fail.
      // What they hold is the property a rewrite would break: one that binds
      // the predicate as a param has to read it out of its input, the way
      // those readers now do, or these stop passing.
      { assertion: assert(() => forwarded.errorMessage === "") },
      { assertion: assert(() => forwarded.total === 3) },
      { assertion: assert(() => forwarded.matching === 3) },

      // A table the store does not carry reports why rather than a zero, and
      // the view says so.
      { action: action(() => missingTable.set("rows_plaid_account")) },
      { assertion: assert(() => broken.errorMessage !== "") },
      {
        assertion: assert(() => broken.errorMessage.includes("no such table")),
      },
      { assertion: assert(() => broken.total === 0) },
      {
        assertion: assert(() =>
          findElementByText(broken[UI], "cf-alert", broken.errorMessage) !==
            undefined
        ),
      },

      // A predicate over a column the table does not declare reports why for
      // the same reason, and the total goes with it: one statement answers
      // both numbers.
      { action: action(() => predicate.set("archived = 0")) },
      {
        assertion: assert(() => count.errorMessage.includes("no such column")),
      },
      { assertion: assert(() => count.total === 0) },
    ],
  };
});
