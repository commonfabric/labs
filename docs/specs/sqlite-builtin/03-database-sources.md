# 03 — Database sources

A handle resolves to one of three physical databases. They split by **who
chooses the source**:

- **Pattern-chosen** sources come from the `sqliteDatabase(...)` builder — the
  pattern owns the database (cell-derived default, or VM file).
- **Injected** sources are wired into a pattern *input* from outside; the
  pattern is source-agnostic and an operator connects a database via `cf`
  (on-disk).

Only the cell-derived source is fully specified for v1; the others are stubbed
so the API is stable when their backends land.

In all cases the **physical identity of the database is opaque to the pattern**.
The handle (a `SqliteDb` cell, Section [01](./01-api.md#the-handle-type)) reads
back a small descriptor `{ id, tables, rev }`, where `id` is the handle cell's
own entity id — patterns forward the handle to `db.query`/`db.exec`/`reactOn`,
not name a file or attach alias. For non-default sources the resolved source
descriptor lives as server-side state keyed by the handle cell's id.

## 03.1 Cell-derived (default)

```ts
// Shown inside a pattern body.
const db = sqliteDatabase({ tables }); // -> Reactive<SqliteDb>, bound to a cell the runtime allocates here
```

**Status: implemented.** This is the source used by everything specified in this
directory. The database is tied to a cell the runtime allocates for this call,
and its **name is derived from that cell's entity id** — which is itself causal
to creation and opaque to the pattern. The handle cell reads back
`{ id, tables, rev }` where `id` is that entity id (see
[`packages/runner/src/builtins/sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts)
`sqliteDatabase`).

- The handle value is stored **self-contained** (one raw inline write, no
  linked sub-documents). A rowLabel rule's term lists are arrays of objects,
  which an ordinary cell write would split into per-element linked docs that no
  schema-driven sync loads — a second runtime would deep-resolve them to
  `null`, hash a DIFFERENT request for the same shared query result cell, and
  the two runtimes would re-issue against each other's hashes forever.
  Self-containment keeps the request identity equal across every client of a
  shared db; `db.exec`'s rev bump is a leaf write for the same reason (a
  whole-value rewrite from a handler frame would re-split the term lists).
- There is **no way to point the database at an arbitrary cell**. A pattern
  cannot pass "some other cell" as the database's identity; doing so would
  re-introduce ambient authority (a pattern naming a cell it was never granted).
  The handle is always the one the runtime allocates for the call (cell-derived)
  or one injected into an input from outside (Section 03.3).
- Cell ids are content-addressed and causally derived
  ([`packages/runner/src/create-ref.ts`](../../../packages/runner/src/create-ref.ts)).
  The runtime allocates (or reuses) the handle cell in the current frame the same
  way other built-ins allocate their result cells, so the identity is stable
  across re-runs and rehydration but never chosen by the pattern.
- **One file per database** (Q6 → Option A). The physical file lives in the
  **same space's storage directory** as the cell. Spaces are already stored
  one-SQLite-file-per-space under `engine-v3/`
  (`{encodeURIComponent(spaceDid)}.sqlite`, see
  [`packages/memory/v2/storage-path.ts`](../../../packages/memory/v2/storage-path.ts)).
  A cell-derived database is a **sibling file** in that directory, named from
  the cell id, e.g. `cell-<entityhash>.sqlite`. Per-file gives the cleanest
  isolation, lets the file boundary act as the SQL namespace (no identifier
  rewriting), and makes GC/export a file operation (`backup()` / delete).
- It is **ATTACHed** to the space engine's connection (via an attach/detach LRU
  cache) for the duration of any transaction that touches it — which is what
  makes cells-plus-rows atomic. Isolation against the core store relies on the
  file boundary, the core-table-rename flag, and a tokenizer-level statement
  guard, all detailed in Section
  [04](./04-server-execution-and-transactions.md#isolation-namespacing--the-statement-guard).

Lifecycle:

- **Create/migrate from the declared schema (additive-only in V1).** The runtime
  creates the file and reconciles tables from `sqliteDatabase({ tables })`
  (Section [01](./01-api.md#schema-ownership--the-database-owns-its-tables)) —
  patterns do not run `CREATE TABLE`. V1 creates missing tables and adds new
  columns; destructive/ambiguous changes refuse to open the db (post-V1 opt-in
  migration callback). See [08-open-questions.md](./08-open-questions.md) Q9.
- **GC.** Because the file is keyed to a cell, its lifetime can later be tied to
  that cell's lifetime. v1 does not garbage-collect; this is noted in
  [08-open-questions.md](./08-open-questions.md).

This is the recommended source for almost all pattern use: durable, per-space,
and atomic with the pattern's cells.

## 03.2 VM file (stub)

```ts
// Shown inside a pattern body.
const db = sqliteDatabase({}, { vm: vmHandle, path: "/data/app.db" });
```

**Status: stub (not implemented).** A database that is a **file inside a VM**. Today VM files are reached through
toolshed `/api` calls, which we intend to improve regardless. For this spec the
source is **stubbed**: it assumes

- an **opaque, cell-based handle to a VM** (`vmHandle: Reactive<VmHandle>`),
  resolved server-side to a concrete VM the same way other opaque
  capability handles are, and
- a **file path within that VM** (`path: string`).

v1 contract: the handle type and call shape are fixed now; the server rejects VM
sources with a `not-implemented` error until the improved VM file API exists.
Atomicity guarantees (Section [04](./04-server-execution-and-transactions.md))
are **not** offered for VM sources in v1 — a VM file cannot be ATTACHed to the
space engine's connection, so writes to it cannot join the space commit
transaction. When implemented, VM-file writes will run as a post-commit effect
(like `fetchJson`) with at-least-once semantics, not as part of the atomic
commit. This limitation is intentional and called out so callers don't assume
cross-store atomicity they won't get.

## 03.3 On-disk file, injected via `cf` (read-only v1)

**Status: implemented (read-only v1).** A database that is a **plain file on
disk**, opaque to the pattern. The pattern does **not** select it with the
builder; instead it declares a database **input** (typed `SqliteDb`) and an
operator connects a file to it via `cf`:

```tsx
// Shown inside a pattern body.
// The pattern is source-agnostic — it just consumes whatever is wired into `db`.
pattern<{ db: SqliteDb }>(({ db }) => {
  const request = db.query<{ name: string }>("SELECT name FROM lookup");
  // Until connected, `isPending(request)` is true and `resultOf(request)`
  // waits (Section 05 / Example 07-#5).
  // `reactOn` is omitted for injected sources in v1 (deferred — Q12).
});
```

```bash
# Operator wires an on-disk SQLite file into the piece's `db` input.
# Source first (the sqlite: file), target second (the piece field).
cf piece link sqlite:/abs/path/reference-data.db <piece-id>/db
```

How the `sqlite:` scheme works
([`parseSqliteSource`/`deriveDiskHandleId`](../../../packages/cli/lib/sqlite-source.ts),
[`linkSqliteDiskSource`](../../../packages/cli/lib/piece.ts); the `cf piece link`
action detects the scheme before its normal `parseLink`):

1. `cf` recognizes the `sqlite:` scheme and **create-if-absents a handle cell**
   whose id is **content-derived from `(space DID, absolute path)`** via
   [`createRef`](../../../packages/runner/src/create-ref.ts). As built the handle
   cell lives **in the piece's own space** at that derived id (so its entity id,
   its `value.id`, and the server registry key are the same string); the source
   descriptor (`{ disk: { path } }`) is **server-side registration state keyed by
   `(space, id)`** (`DiskSourceRegistry`), never the cell's readable value.
   Create-if-absent is literal: a re-link leaves a handle that already carries
   an `id` exactly as it stands, and reports on stderr how many tables it kept.
   `tables[].ifc` holds the per-column read labels, which are monotone (§8.12.1)
   — re-seeding the empty contract over a declared one would lower every
   column's label, and a contract-less query returns its rows unlabeled rather
   than refusing, so the downgrade would be silent. `owner` (which resolves
   `dbOwner()` row admission), `scope`, and `rev` are preserved with it.
2. `cf` registers the source over the session
   (`sqlite.register-disk-source` → the server canonicalizes the path and
   rejects any path inside the engine store directory), then writes a **normal
   sigil link** from the piece's `db` input field to the handle cell
   (`manager.link`). Because the id is deterministic, this is a genuine
   cell-to-cell link, and linking the same path twice resolves to the same
   handle, so multiple pieces share one handle cell.

**Pending-until-connected** falls out of reactivity: an unpopulated `db` input
is an empty cell, so `sqliteQuery` publishes a pending marker; when `cf` writes
the link, the input cell changes, the query action re-runs, and it connects. (A
populated-but-unreachable database publishes `error` instead.)

v1 behavior: the server attaches the registered file **read-only** (PRAGMA
`query_only` for the synchronous attach→op→detach window) instead of the
cell-derived db, and **skips migration** (the on-disk db owns its schema).
**Writes are rejected:** a folded `sqlite` op against a registered injected
source is refused before any attach — on-disk write/atomicity is gated on
co-location (Q13/Q14), and `reactOn` for injected handles carries a cross-space
dirty-signal wrinkle (Q12). Injected datasets are read-mostly, so this does not
block v1. Authorization of the registration verb (operator vs. pattern) and
confining injected paths to an allowlist await CFC labels
([08-open-questions.md](./08-open-questions.md) Q18).

## Source comparison

| | Cell-derived (03.1) | VM file (03.2) | On-disk via `cf` (03.3) |
| --- | --- | --- | --- |
| v1 status | **Implemented** | Stub (builder) | **Implemented (read-only)** |
| Chosen by | Pattern (`sqliteDatabase()`) | Pattern (`sqliteDatabase({ vm })`) | Operator (`cf piece link sqlite:`) |
| Identity | Handle cell entity id | VM handle + path | Handle cell id from `(space, path)` |
| Co-located with space | Yes | No | Maybe |
| Atomic with cell writes | **Yes** (ATTACH) | No (post-commit effect) | TBD |
| Typical use | Pattern-owned data | Sandboxed app data | Operator-provided datasets |
