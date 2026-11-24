/**
 * Tests MailboxMonthHeaders' row ceiling against a month that holds more rows
 * than the ceiling admits, which is the only way to tell a clamped limit from
 * an unclamped one: over a handful of rows the two answer the same.
 *
 * It reads counts and subjects and never `[UI]`. A rendered 500-row result is
 * a load still in flight when the runtime is disposed, which reports a
 * sync-load failure at teardown; the view is stated in the atom's other test,
 * over a month small enough to settle.
 *
 * Run: deno task cf test patterns/product/primitives/mailbox-month-headers-ceiling.test.tsx
 */
import {
  action,
  assert,
  handler,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
  TESTS,
  Writable,
} from "commonfabric";
import MailboxMonthHeaders from "./mailbox-month-headers.tsx";

const messagesTable = () =>
  table({
    id: "integer primary key",
    subject: "text",
    snippet: "text",
    received_at: "text",
    sent_at: "text",
    internal_date: "text",
    sender_id: "integer",
    deleted_at: "text",
  });

const participantsTable = () =>
  table({
    id: "integer primary key",
    display_name: "text",
    email_address: "text",
  });

/**
 * Seeds 600 live messages in June through one recursive-CTE insert, so the
 * ceiling has a hundred more rows to refuse than it admits. `received_at`
 * encodes the row number, so lexicographic order is row order and the newest
 * row is `Bulk 1599`.
 */
const seedBulk = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO messages (id, subject, snippet, received_at, sender_id, " +
      "deleted_at) WITH RECURSIVE c(n) AS (SELECT 1000 UNION ALL " +
      "SELECT n + 1 FROM c WHERE n < 1599) " +
      "SELECT n, 'Bulk ' || n, '', " +
      "'2026-06-01T00:00:00.' || printf('%04d', n) || 'Z', 1, NULL FROM c",
  );
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: { messages: messagesTable(), participants: participantsTable() },
  });
  const seed = seedBulk({ db });

  // Both inputs are reactive, so naming a month is what re-runs the query over
  // rows seeded after the atom was built, and naming a limit re-runs it again.
  const month = new Writable("1970-01");
  const limit = new Writable(100000);
  const mailbox = MailboxMonthHeaders({ mail: db, month, limit });

  return {
    [TESTS]: [
      { assertion: assert(() => mailbox.headerCount === 0) },

      { action: action(() => seed.send()) },
      { action: action(() => month.set("2026-06")) },

      // A limit past the ceiling reads to the ceiling rather than refusing.
      // The 500th row being `Bulk 1100` is the same statement as the 501st
      // being absent: the rows run from 1599 down.
      { assertion: assert(() => mailbox.errorMessage === "") },
      { assertion: assert(() => mailbox.headerCount === 500) },
      { assertion: assert(() => mailbox.headers[0].subject === "Bulk 1599") },
      { assertion: assert(() => mailbox.headers[499].subject === "Bulk 1100") },

      // The ceiling named exactly reads the same 500, so the clamp neither
      // narrows a limit that already sits on it nor lets one past.
      { action: action(() => limit.set(500)) },
      { assertion: assert(() => mailbox.headerCount === 500) },
      { assertion: assert(() => mailbox.headers[0].subject === "Bulk 1599") },
      { assertion: assert(() => mailbox.headers[499].subject === "Bulk 1100") },

      // A limit below the ceiling is the caller's, still newest first.
      { action: action(() => limit.set(3)) },
      { assertion: assert(() => mailbox.headerCount === 3) },
      { assertion: assert(() => mailbox.headers[0].subject === "Bulk 1599") },
      { assertion: assert(() => mailbox.headers[2].subject === "Bulk 1597") },

      // Ends on a month holding nothing, so the last read this run issues is
      // one that settles empty rather than a large one still in flight when
      // the runtime is disposed.
      { action: action(() => month.set("2026-07")) },
      { assertion: assert(() => mailbox.headerCount === 0) },
    ],
  };
});
