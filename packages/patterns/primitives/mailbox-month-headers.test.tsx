/**
 * Tests MailboxMonthHeaders: the tombstone rule, the month window, the sender
 * join, a hostile limit, the failure text, and the rendered list. The row
 * ceiling needs a month with more rows than it admits, so it is stated in
 * mailbox-month-headers-ceiling.test.tsx instead.
 *
 * The atom takes no `reactOn`, because a database it only reads has nothing to
 * react to. Its `month` and `limit` inputs are reactive, so a test seeds the
 * rows and then names a month, which is what re-runs the query over them.
 *
 * Run: deno task cf test packages/patterns/primitives/mailbox-month-headers.test.tsx
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
import MailboxMonthHeaders from "./mailbox-month-headers.tsx";

/** The message columns the atom projects, plus the sender it joins on. */
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

const messageSql = (): string =>
  "INSERT INTO messages (id, subject, snippet, received_at, sender_id, " +
  "deleted_at) VALUES (?, ?, ?, ?, ?, ?)";

/**
 * Seeds a sender, three live messages in March, one deleted message in the
 * same month, and one in April. A live message leaves `deleted_at` NULL, which
 * is how this store marks one, and a deleted message carries a stamp.
 */
const seedMailbox = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO participants (id, display_name, email_address) " +
      "VALUES (?, ?, ?)",
    [1, "Pacific Gas", "billing@pge.example"],
  );
  db.exec(messageSql(), [
    1,
    "First",
    "First snippet",
    "2026-03-01T09:00:00Z",
    1,
    null,
  ]);
  db.exec(messageSql(), [
    2,
    "Second",
    "Second snippet",
    "2026-03-02T09:00:00Z",
    1,
    null,
  ]);
  db.exec(messageSql(), [
    3,
    "Third",
    "Third snippet",
    "2026-03-03T09:00:00Z",
    1,
    null,
  ]);
  db.exec(messageSql(), [
    4,
    "Deleted notice",
    "Deleted snippet",
    "2026-03-04T09:00:00Z",
    1,
    "2026-03-05T09:00:00Z",
  ]);
  db.exec(messageSql(), [
    5,
    "Next month",
    "Next snippet",
    "2026-04-01T09:00:00Z",
    1,
    null,
  ]);
});

/**
 * A messages table carrying every column the join, the filter and the ordering
 * need, and missing one the atom projects. That is what makes the diagnostic
 * name the projected column rather than a table the query could not find, so a
 * later unrelated missing-table failure cannot satisfy the assertion.
 */
const narrowMessagesTable = () =>
  table({
    id: "integer primary key",
    snippet: "text",
    received_at: "text",
    sent_at: "text",
    internal_date: "text",
    sender_id: "integer",
    deleted_at: "text",
  });

/** One row, so the query over the narrow table has a reason to run. */
const seedNarrow = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec("INSERT INTO messages (id, received_at) VALUES (?, ?)", [
    1,
    "2026-03-01T09:00:00Z",
  ]);
});

/**
 * A caller that takes a month and a limit of its own and requires neither, and
 * hands both to the atom — the shape the atom meets inside a larger pattern
 * that has those inputs to forward. An input nobody supplied reads
 * `undefined`, and `undefined` is not a value a query can bind.
 */
interface ForwardedInput {
  mail: SqliteDb;
  month?: string;
  limit?: number;
}

interface ForwardedOutput {
  month: string;
  headerCount: number;
  errorMessage: string;
}

const ForwardingCaller = pattern<ForwardedInput, ForwardedOutput>(
  ({ mail, month, limit }) => {
    const mailbox = MailboxMonthHeaders({ mail, month, limit });
    return {
      month: mailbox.month,
      headerCount: mailbox.headerCount,
      errorMessage: mailbox.errorMessage,
    };
  },
);

/**
 * One live message in whatever month the database's own clock is in, dated in
 * SQL because a handler is denied the clock inside the sandbox. It is what the
 * atom answers a caller that named no month, so it sits in a database of its
 * own where it cannot join the month the assertions above read.
 */
const seedCurrentMonth = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO participants (id, display_name, email_address) " +
      "VALUES (?, ?, ?)",
    [1, "Pacific Gas", "billing@pge.example"],
  );
  db.exec(
    "INSERT INTO messages (id, subject, snippet, received_at, sender_id, " +
      "deleted_at) VALUES (?, ?, ?, " +
      "strftime('%Y-%m', 'now', 'localtime') || '-15T09:00:00Z', ?, ?)",
    [1, "This month", "This month snippet", 1, null],
  );
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: { messages: messagesTable(), participants: participantsTable() },
  });
  const seed = seedMailbox({ db });

  // Both inputs are reactive, so naming a month is what re-runs the query over
  // rows seeded after the atom was built, and naming a limit re-runs it again.
  const month = new Writable("1970-01");
  const limit = new Writable(200);
  const mailbox = MailboxMonthHeaders({ mail: db, month, limit });

  // A store whose messages table is missing a column the atom projects,
  // everything the join and the window need being present.
  const narrow = sqliteDatabase({
    tables: {
      messages: narrowMessagesTable(),
      participants: participantsTable(),
    },
  });
  const seedNarrowRow = seedNarrow({ db: narrow });
  const brokenMonth = new Writable("1970-01");
  const broken = MailboxMonthHeaders({ mail: narrow, month: brokenMonth });

  // A database of its own, so the message dated by the clock cannot land in
  // the month the assertions above read.
  const current = sqliteDatabase({
    tables: { messages: messagesTable(), participants: participantsTable() },
  });
  const seedCurrent = seedCurrentMonth({ db: current });
  const forwarded = ForwardingCaller({ mail: current });

  return {
    // The one warning this allows is normalizeAndDiff's "Storing a
    // session-scoped link in space-scoped data", raised when reading `[UI]`
    // puts a link to the atom's session-scoped query result into the vnode
    // tree. Per-reader resolution is what a session-scoped result is for, and
    // the slot holding the link is a view-node child the atom does not
    // declare. The flag is a boolean, so it cannot be pinned to that text.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert(() => mailbox.headerCount === 0) },
      { assertion: assert(() => broken.headerCount === 0) },

      { action: action(() => seed.send()) },
      { action: action(() => seedNarrowRow.send()) },
      { action: action(() => seedCurrent.send()) },
      { action: action(() => month.set("2026-03")) },
      { action: action(() => brokenMonth.set("2026-03")) },

      // A store of another shape reports why rather than an empty month, and
      // the view says so.
      { assertion: assert(() => broken.errorMessage !== "") },
      {
        assertion: assert(() =>
          broken.errorMessage.includes("no such column: m.subject")
        ),
      },
      { assertion: assert(() => broken.headerCount === 0) },
      {
        assertion: assert(() =>
          findElementByText(broken[UI], "cf-alert", broken.errorMessage) !==
            undefined
        ),
      },

      // The three live March messages, newest first. The deleted one is gone
      // and so is the one in April.
      { assertion: assert(() => mailbox.headerCount === 3) },
      { assertion: assert(() => mailbox.headers[0].subject === "Third") },
      { assertion: assert(() => mailbox.headers[2].subject === "First") },
      { assertion: assert(() => mailbox.month === "2026-03") },
      { assertion: assert(() => mailbox.errorMessage === "") },
      { assertion: assert(() => mailbox[NAME] === "Mail 2026-03 (3)") },

      // A read that did not fail renders no alert, which is the other half of
      // the failing-store case: without this, an alert shown over empty text
      // would satisfy that one.
      {
        assertion: assert(() =>
          findElement(mailbox[UI], "cf-alert") === undefined
        ),
      },

      // The sender comes from the joined participant, and the snippet from
      // the message; no body column is projected to carry one.
      { assertion: assert(() => mailbox.headers[0].sender === "Pacific Gas") },
      {
        assertion: assert(() => mailbox.headers[0].snippet === "Third snippet"),
      },

      // The rendered list states the newest subject and its sender, and
      // carries neither the deleted message nor April's.
      {
        assertion: assert(() =>
          findElementByText(mailbox[UI], "cf-text", "Third") !== undefined
        ),
      },
      {
        assertion: assert(() =>
          textContent(mailbox[UI]).includes("Pacific Gas")
        ),
      },
      {
        assertion: assert(() =>
          !textContent(mailbox[UI]).includes("Deleted notice")
        ),
      },
      {
        assertion: assert(() =>
          !textContent(mailbox[UI]).includes("Next month")
        ),
      },

      // A limit the caller names bounds the rows, and takes the newest ones
      // in order rather than any two of them.
      { action: action(() => limit.set(2)) },
      { assertion: assert(() => mailbox.headerCount === 2) },
      { assertion: assert(() => mailbox.headers[0].subject === "Third") },
      { assertion: assert(() => mailbox.headers[1].subject === "Second") },

      // A negative limit is SQLite's spelling for "no limit at all", so the
      // atom's own floor is what the query gets instead.
      { action: action(() => limit.set(-1)) },
      { assertion: assert(() => mailbox.headerCount === 1) },
      { assertion: assert(() => mailbox.errorMessage === "") },

      // The ceiling a limit past it reads to is stated in
      // mailbox-month-headers-ceiling.test.tsx, where the month holds more
      // rows than the ceiling admits.

      // A month the seed left empty reads back empty rather than stale, and
      // the view says so.
      { action: action(() => month.set("2026-05")) },
      { assertion: assert(() => mailbox.headerCount === 0) },
      {
        assertion: assert(() =>
          findNodeByProp(mailbox[UI], "message", "No mail this month.") !==
            undefined
        ),
      },

      // Naming no month resolves one from the database's own clock rather
      // than leaving the window unbounded.
      { action: action(() => month.set("")) },
      { assertion: assert(() => mailbox.month.length === 7) },
      { assertion: assert(() => mailbox.month.charAt(4) === "-") },
      { assertion: assert(() => mailbox.errorMessage === "") },

      // A caller forwarding a month and a limit nobody supplied gets the same
      // month from the clock, and the message the seed dated in it.
      // Forwarding reads `undefined` rather than leaving the keys out, so the
      // inputs' own defaults are not what makes this hold.
      { assertion: assert(() => forwarded.errorMessage === "") },
      { assertion: assert(() => forwarded.month.length === 7) },
      { assertion: assert(() => forwarded.headerCount === 1) },
    ],
  };
});
