# 07 — Usage examples

These illustrate the intended authoring surface against the as-built `SqliteDb`
cell-variant API: `sqliteDatabase(...)` returns a `SqliteDb` cell on which you
call `.query<Row>(...)` (reactive read) and `.exec(...)` (imperative write, inside
a handler).

## Example 1 — A reactive message log with cell references

A pattern that stores messages in SQLite, references the author as a live cell
via a `_cf_link` column, and renders the 20 most recent messages reactively.

```tsx
import {
  type Cell,
  cfLink,
  handler,
  lift,
  pattern,
  resultOf,
  sqliteDatabase,
  table,
  UI,
} from "commonfabric";

interface User {
  name: string;
  avatarUrl: string;
}

export default pattern<{ me: Cell<User> }>(({ me }) => {
  // Cell-derived, per-space, atomic. Tables are declared once here; the runtime
  // owns creation/migration — no CREATE TABLE in pattern code.
  const db = sqliteDatabase({
    tables: {
      messages: table({
        id: "integer primary key",
        author_cf_link: cfLink<User>(), // TEXT in SQLite, Cell<User> in TS
        body: "text",
        ts: "integer",
      }),
    },
  });

  // Typed read: the <Row> Cell<User> field marks author_cf_link as cell-bearing,
  // so it rehydrates to a live Cell<User> on read. (An untyped db.query would
  // return the raw sigil-link string for that column.)
  const recent = db.query<
    { id: number; body: string; ts: number; author_cf_link: Cell<User> }
  >(
    "SELECT id, body, ts, author_cf_link FROM messages ORDER BY ts DESC LIMIT 20",
    { reactOn: db }, // re-run after any committed write to this db
  );
  const recentResult = resultOf(recent);

  const send = handler<{ body: string }, { author: Cell<User> }>(
    ({ body }, { author }) => {
      // Imperative write inside a handler. Returns void; commits atomically with
      // any surrounding cell writes. `author` (a Cell) targets a _cf_link column
      // and is encoded to a sigil link.
      db.exec(
        "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
        [author, body, Date.now()],
      );
    },
  );

  return {
    [UI]: lift((rows: typeof recentResult.rows) => (
      <cf-vstack>
        {rows.map((m) => (
          // m.author_cf_link is a live Cell<User>; reading it is independently reactive
          <div>
            <b>{lift((u: User | undefined) => u?.name)(m.author_cf_link)}</b>:{" "}
            {m.body}
          </div>
        ))}
      </cf-vstack>
    ))(recentResult.rows),
    send: send.with({ author: me }),
  };
});
```

Key points:

- The database owns the `messages` schema (storage type + `_cf_link` markers);
  binding the `author` cell to a non-link column (e.g. `body`) would throw
  (Section [02](./02-cf-link-encoding.md)).
- `db.exec` bumps the handle's `rev` in the **same commit** as the `INSERT`, so
  `reactOn: db` re-runs `recent` only after the write commits durably (Section
  [05](./05-reactivity.md)) — never phantom rows.
- The typed `<Row>` field `author_cf_link: Cell<User>` is what decodes the stored
  link to a `Cell<User>`; the inner `lift` updates if that user's name changes,
  without re-running the SQL query.

## Example 2 — A projection that needs `<Row>`

When the result shape diverges from a declared table (joins, aliases, computed
columns), the `<Row>` type argument is the single source for both the result
type and which columns are cell-bearing. A `Cell<T>` field marks a decoded link
column even when the alias drops the `_cf_link` suffix.

```tsx
// Shown for illustration only.
import { hasError, isPending, resultOf } from "commonfabric";

const leaderboard = db.query<{ author: Cell<User>; n: number }>(
  `SELECT author_cf_link AS author, count(*) AS n
   FROM messages GROUP BY author_cf_link ORDER BY n DESC LIMIT 10`,
  { reactOn: db },
);

return isPending(leaderboard)
  ? "Loading…"
  : hasError(leaderboard)
  ? `Query failed: ${leaderboard.errorMessage}`
  // `author` decoded back into Cell<User> despite the `AS author` alias.
  : resultOf(leaderboard).rows.map((r) => ({
    name: lift((u: User | undefined) => u?.name)(r.author),
    count: r.n,
  }));
```

The free-function form is equivalent if you prefer it:

```tsx
// Shown at module scope.
import { sqliteQuery } from "commonfabric";

const leaderboard = sqliteQuery<{ author: Cell<User>; n: number }>({
  db,
  sql: `SELECT author_cf_link AS author, count(*) AS n
        FROM messages GROUP BY author_cf_link ORDER BY n DESC LIMIT 10`,
  reactOn: db,
});
```

## Example 3 — Atomic cell + SQLite write in one handler

The handler mutates a cell and inserts a row. Both land in the same commit, so an
observer never sees the counter incremented without the row (or vice versa). If
the `INSERT` fails, the whole commit aborts and the counter write rolls back too
(abort-only — `db.exec` has no result/error cell; Section
[04](./04-server-execution-and-transactions.md)).

```tsx
// Shown inside a pattern body.
const bump = handler<{ body: string }, { count: Cell<number>; db: SqliteDb }>(
  ({ body }, { count, db }) => {
    count.set(count.get() + 1); // cell write
    db.exec( // SQLite write, same transaction
      "INSERT INTO events (body, ts) VALUES (?, ?)",
      [body, Date.now()],
    );
  },
);
```

If the commit is rejected (seq conflict) it retries; if the process crashes
mid-commit, the post-crash reconciliation (Section
[04](./04-server-execution-and-transactions.md)) ensures the row and the counter
agree.

> Pass a **resolved** value to `db.exec` params. An `undefined` param (e.g. a
> value that isn't ready yet) **throws**; use `null` for an intentional SQL NULL.
> `db.exec` returns `void` — there is no `lastInsertRowid`; use a deterministic id
> if a follow-up write must reference the inserted row (Section
> [01](./01-api.md)).

## Example 4 — VM-file source (stubbed)

```tsx
// Shown inside a pattern body.
// vmHandle is an opaque capability handle to a VM; path is inside that VM.
const db = sqliteDatabase({}, { vm: vmHandle, path: "/var/lib/app/data.db" });

// In v1 this resolves but the server returns `not-implemented` for VM sources.
const rows = db.query("SELECT * FROM kv", { reactOn: db });
```

## Example 5 — On-disk source injected via `cf` (read-only v1)

The pattern is **source-agnostic**: it declares a `db` *input* (typed `SqliteDb`)
and consumes it. It never names a file or picks a source — an operator connects
one.

```tsx
// Shown at module scope.
import { hasError, isPending, resultOf } from "commonfabric";

export default pattern<{ db: SqliteDb; key: string }>(({ db, key }) => {
  const lookup = db.query<{ value: string }>(
    "SELECT value FROM lookup WHERE key = ?",
    { params: [key] },
    // No reactOn: a static reference dataset the operator manages out of band
    // (reactivity for injected sources is deferred — Section 08, Q12).
  );

  return isPending(lookup)
    ? "Waiting for a database to be connected…" // until cf wires it
    : hasError(lookup)
    ? `Database error: ${lookup.errorMessage}`
    : resultOf(lookup).rows[0]?.value;
});
```

```bash
# Operator wires an on-disk SQLite file into the piece's `db` input — source
# first (the sqlite: file), target second (the piece field). The sqlite: scheme
# create-if-absents a handle cell (id derived from space DID + abs path), registers
# the file read-only, and writes a normal sigil link to the input. (Read-only v1;
# see Section 03.3.)
cf piece link sqlite:/abs/path/reference-data.db <piece-id>/db
# Before this runs, the pattern renders "Waiting for a database to be connected…".
```
