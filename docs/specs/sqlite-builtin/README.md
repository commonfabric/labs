# SQLite Builtins for Patterns

## Status (as-built)

These docs describe the **shipped** API. Phases 0–5 are done: the `SqliteDb` cell
variant (`db.query<Row>` reactive read + `db.exec` atomic write), `_cf_link`
encode/decode, `sqliteQuery<Row>` transformer typing, and reactive `reactOn: db`
re-query (delivered via the in-commit `rev`-bump model). CFC (Contextual Flow
Control) and the non-default database sources are deferred:

- **Phase 6** — WAL crash detect/quarantine: deferred (Q7 V1 cut).
- **Phase 7** — on-disk source injected via `cf`: not yet built (next up).
- **Phase 8** — VM-file source: stub.
- **Phase 9** — per-column and per-row CFC labels: implemented, along with
  the policy a query's own control state carries (Section
  [06](./06-cfc.md)).

> The original spec described **standalone built-ins** (`sqliteQuery` /
> `sqliteExecute`) over an opaque, empty handle. The implementation evolved to a
> **`SqliteDb` cell variant** carrying `.query`/`.exec` methods, and removed the
> reactive `sqliteExecute` built-in. These docs have been rewritten to the
> as-built API; per-section "Spec evolution" notes flag where the design moved.

## Overview

This spec introduces SQLite access for patterns against databases hosted
alongside the space. The database handle is a **`SqliteDb` cell variant** — a
branded cell of kind `"sqlite"` (added to `CellKind` alongside readonly/
writeonly/opaque). Instead of value mutators it exposes a SQLite method surface;
its readable value is the handle ref `{ id, tables, rev }`.

Two capabilities are exposed as methods on that cell, so read and write stay
distinct (and CFC can gate them independently):

- **`db.query<Row>(sql, { params?, reactOn? })`** — read-only `SELECT`. Reactive:
  re-runs when its `reactOn` input changes. Returns
  `Reactive<{ pending, result?: Row[], error? }>`, the same shape as
  `fetchJson`/`generateText`
  (see [`packages/runner/src/builtins/fetch.ts`](../../../packages/runner/src/builtins/fetch.ts)).
  A free `sqliteQuery<Row>({ db, sql, ... })` function is equivalent.
- **`db.exec(sql, params?)`** — writes (`INSERT`/`UPDATE`/`DELETE`). Imperative,
  called inside a handler; returns `void`. It records a `sqlite` op onto the
  caller's transaction so the write commits **atomically** with surrounding cell
  writes (abort-only on failure). There is **no reactive `sqliteExecute`
  built-in** — it was removed.

The handle is produced by a `sqliteDatabase(...)` builder (cell-derived default;
VM source stubbed), or **injected as a pattern input** for on-disk databases
linked via `cf` (stubbed; Section [03](./03-database-sources.md)). The handle's
table schema and DDL are owned by the database, declared once.

Two cross-cutting rules make cell references first-class inside SQLite:

- Writing a cell reference into a column whose name ends in `_cf_link` (and is
  declared `string`) **opaquely encodes it as a full sigil link**. Any other
  attempt to write a cell reference throws. (Section [02](./02-cf-link-encoding.md))
- Reading a `_cf_link` column **transparently decodes** the stored string back
  into a live `Cell`.

## Design goals

1. **Reuse the existing reactive-builtin machinery.** Scheduler integration,
   post-commit effects, request hashing/deduplication, and the CFC write-policy
   sink are all already solved for `fetchJson`/`llm`. SQLite access plugs into
   the same seams rather than inventing parallel infrastructure.
2. **Server-side execution.** Queries run inside toolshed, which already hosts
   the space and owns the SQLite engine
   ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)).
   The runtime reaches them over the **existing space-scoped websocket** — no
   new connection, no new auth path.
3. **Atomic writes across cells and SQLite.** SQLite writes ride the *same*
   commit transaction that applies cell writes, so a commit either lands fully
   (cells + rows) or not at all, in normal operation. (Section
   [04](./04-server-execution-and-transactions.md))
4. **Reactivity that waits for durable writes.** A query re-runs only against
   fully-committed state, never in-flight/optimistic writes. (Section
   [05](./05-reactivity.md))
5. **Cell references survive the round-trip.** A cell written into a `_cf_link`
   column reads back as the same cell, across spaces.
6. **A path to per-column and per-row CFC.** The schema surface is designed so
   confidentiality/integrity labels can be attached per column, and per-row
   labels can be derived from field values, without reworking the API. (Section
   [06](./06-cfc.md))

## Non-goals for v1

- **Read-after-write within a single transaction.** A `db.query` issued in
  the same transaction as a not-yet-committed `db.exec` is defined to
  fail (Section [04](./04-server-execution-and-transactions.md)). Simulating
  the pending write is out of scope.
- **Full VM-file and on-disk source implementations.** Both are stubbed behind
  opaque handles (Section [03](./03-database-sources.md)); only the
  cell-derived default source is fully specified for v1.
- **Auto-derived TypeScript types from the SQL string.** Tables are declared on
  the database and result rows via the `db.query<Row>` type argument; we do
  not parse SQL to infer parameter/result types (Section
  [01](./01-api.md#typescript-and-table-types--why-these-boundaries)).

## Document map

| File | Contents |
| --- | --- |
| [01-api.md](./01-api.md) | TypeScript-facing API: `sqliteDatabase`, the `SqliteDb` cell variant (`db.query<Row>` / `db.exec`), the equivalent `sqliteQuery` free function; the new-Cell-variant decision; table-type helpers. |
| [02-cf-link-encoding.md](./02-cf-link-encoding.md) | `_cf_link` column encode/decode rules (decode-to-Cell driven by typed `db.query<Row>`) and the throw conditions. |
| [03-database-sources.md](./03-database-sources.md) | The three database sources: cell-derived (default, **implemented**), VM file (stub), on-disk via `cf` (stub). |
| [04-server-execution-and-transactions.md](./04-server-execution-and-transactions.md) | Protocol extension, server-side execution, ATTACH, `db.exec` commit-fold + abort-only, atomic cells+SQLite commits, WAL crash recovery. |
| [05-reactivity.md](./05-reactivity.md) | Reactive `reactOn: db` re-query via the in-commit handle `rev` bump; the write-serialization mutex. |
| [06-cfc.md](./06-cfc.md) | Per-column and per-row CFC labels, and the policy a query's own control state and result membership carry. |
| [07-examples.md](./07-examples.md) | End-to-end usage examples. |
| [08-open-questions.md](./08-open-questions.md) | Unresolved design questions for review. |
| [implementation-plan.md](../../history/specs/sqlite-builtin/implementation-plan.md) | Archived as-built workstream record: milestones and dependency/gating map from building the feature. |

## At a glance

```tsx
// Shown for illustration only.
import { sqliteDatabase, table, cfLink, handler, derive, type Cell } from "commonfabric";

// A database tied to this pattern's own cell (default source). Tables (and the
// _cf_link columns) are declared once, here; the runtime owns DDL/migration.
const db = sqliteDatabase({
  tables: {
    messages: table({
      id: "integer primary key",
      author_cf_link: cfLink<User>(),
      body: "text",
      ts: "integer",
    }),
  },
}); // -> Reactive<SqliteDb>

// Reactive read. Passing the whole `db` as reactOn means "any committed write
// re-runs". The typed <Row> Cell<User> field surfaces author_cf_link as a Cell.
const recent = db.query<{ id: number; author_cf_link: Cell<User>; body: string }>(
  "SELECT id, author_cf_link, body FROM messages ORDER BY ts DESC LIMIT 20",
  { reactOn: db },
);

// Imperative write inside a handler, atomic with any surrounding cell writes.
const post = handler<{ body: string }, { author: Cell<User> }>(
  ({ body }, { author }) => {
    db.exec(
      "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
      [author, body, Date.now()], // `author` (a Cell) → full sigil link
    );
  },
);

return derive(recent.result, (rows) => rows ?? []);
```
