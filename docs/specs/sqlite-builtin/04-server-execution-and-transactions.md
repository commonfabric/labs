# 04 — Server-side execution & transactions

Queries and writes execute **inside toolshed**, which already hosts the space
and owns its SQLite engine. The runtime reaches them over the **existing
space-scoped websocket** — the same connection used for `transact`, `graph.query`,
and `session.watch.*`.

## Where execution happens

- Each space is a single `@db/sqlite` `Database` opened by the memory engine
  ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts),
  `open()` → `engine.database`), cached one-per-space by the server
  ([`packages/memory/v2/server.ts`](../../../packages/memory/v2/server.ts),
  `Server.#openEngine()`).
- The space websocket is served at `/api/storage/memory?space=<did>`
  ([`packages/toolshed/routes/storage/memory/memory.routes.ts`](../../../packages/toolshed/routes/storage/memory/memory.routes.ts)),
  authorized via UCAN on session open.
- Cell-derived SQLite databases (Section [03](./03-database-sources.md)) are
  **one sibling file per database** in the same storage directory (Q6 → Option
  A). **Writes** are **ATTACHed** to `engine.database` so the folded `sqlite` op
  rides the same commit transaction as the cell ops. **Reads** — cell-derived
  *and* injected on-disk — run on a separate **read-only pooled connection** for
  the file, never attached to the engine connection (see
  [Read path: a pooled read-only connection](#read-path-a-pooled-read-only-connection)).

### Referenced databases and reader authorization

A query opens the storage provider for the resolved database handle's space.
Forwarding that handle through another piece preserves the source space; a
matching database ID in the consumer space does not select a different database.
The query request identity includes that source space. Foreign query results are
at least user scoped, and retain session scope when requested or required by the
database.

Ordinary clients use their authenticated source-space session. A served foreign
query additionally carries the demanding principal and, for session-scoped
results, its session ID. Missing scoped identity refuses the query before result
publication. The memory server accepts this carriage only from a configured
`delegatingDids` principal, checks the carried reader's source-space READ access
alongside the serving session's current authorization, and repeats both checks
before returning rows. Scoped cell databases resolve against the carried identity.

The `sqliteQueryReader` protocol capability advertises this authorization contract.
A client refuses to send carried-reader queries when the server does not advertise
it. The carriage supplies no additional source-space access. Table and row CFC
labels continue to apply as described in Section [06](./06-cfc.md).

## Isolation, namespacing & the statement guard

A pattern's SQL runs on the same connection as the authoritative memory store,
so isolation is load-bearing. The design relies on three things, none of which
needs a full SQL parser:

- **File boundary = namespace.** SQLite's only namespace primitive is the
  attached-database alias, so one file per cell-derived db *is* the namespace.
  On the **read** path the file is opened on its own connection, so its schema is
  plain `main` and an unqualified `messages` resolves to it with no core store to
  shadow. On the **write** path we ATTACH only the handle's own db for that
  commit; an unqualified `messages` resolves to it (SQLite resolves
  `main → temp → attached-in-order`), with **no identifier rewriting**. Because
  reads no longer attach, **the only thing ever attached is the single cell-db
  being written** (≤1 per commit) — so two cell-dbs are never attached at once,
  and unqualified resolution can't be ambiguous between cell-dbs. Qualification
  drops to defense-in-depth rather than a correctness prerequisite.
- **Core-table rename flag.** To remove the risk that an unqualified pattern name
  shadows/leaks a core table (`commit`, `revision`, `head`, `snapshot`,
  `branch`, `scheduler_*`, `blob_store`), rename the engine's core tables to
  include the space DID (e.g. `commit__<did>`), behind a flag. Pre-production we
  may ship unflagged and tolerate shadowing temporarily.
- **Tokenizer-level statement guard.** `@db/sqlite` exposes **no authorizer**
  (`sqlite3_set_authorizer` is not bound — confirmed against the library), so we
  cannot get SQLite to enumerate accessed objects for us. Instead the guard
  rejects: any **schema-qualified** reference (`other.table`), `ATTACH`/`DETACH`/
  `PRAGMA`, and **multiple statements**; `sqliteQuery` additionally requires a
  single `SELECT`/read-only CTE. Function calls such as `replace()` do not make
  a read-only CTE a write. Because we never rewrite identifiers, this is a
  tokenizer-level check, not full resolution. (A future hardening option: bind
  `sqlite3_set_authorizer` ourselves via Deno FFI against the `unsafeHandle`
  pointer — defense-in-depth, not required for v1.)

**Attach limit (write path only).** `@db/sqlite` exposes no `sqlite3_limit`
binding, so `SQLITE_LIMIT_ATTACHED` stays at the compiled default (≈10). Only
**writes** attach, and a single commit touches **at most one** cell-db, so the
limit is effectively never approached. The cell-db is attached before `BEGIN`
and **detached before the post-commit await** (the B1 fix) so the
≤1-attached-at-a-time invariant holds even across concurrent commits to
different cell-dbs on the shared per-space connection. (Reads no longer attach,
so the old LRU attach/detach *read* cache is gone — see the read path below.)

## Read path: a pooled read-only connection

> As-built (follow-up to PR #3776). Supersedes the original "attach the cell-db
> for every read and write, then detach" model, resolves the read-side of
> [08-open-questions.md](./08-open-questions.md) Q8 (connection contention), and
> removes the read-attach churn behind Q8a — only writes attach now.

**All reads — cell-derived and injected on-disk — run on a dedicated read-only
connection opened directly on the db file, never attached to the space engine.**
Only **writes** attach to the engine (required: the folded `sqlite` op must ride
the same commit transaction as the cell ops, and SQLite has no cross-connection
atomicity). The motivation: a single read primitive that does not have to treat
cell-derived and on-disk sources differently, with no per-read ATTACH +
schema-cookie churn on the engine connection and no reliance on a connection-
global `query_only` window for read-only enforcement.

The only per-source difference is **path resolution**, not execution:

- **cell-derived**: `#cellDbPath(engine, space, db.id)`.
- **on-disk (injected)**: the `DiskSourceRegistry` descriptor path for
  `(space, db.id)`.

Execution is identical: open/reuse a read-only connection for that path, apply
the statement guard, run the `SELECT`, return rows.

### The connection pool (`ReadConnectionPool`)

[`packages/memory/v2/sqlite/read-pool.ts`](../../../packages/memory/v2/sqlite/read-pool.ts):

- Keyed by **canonical file path**; opened **read-only** (`new Database(path, {
  readonly: true })`). This is **real per-connection read-only** — replacing the
  `query_only` window — and gives each file its own `main` namespace, so a read
  can never reach a core/cell table by name.
- **LRU** with a cap well under the OS file-descriptor budget; evict → `close()`.
- The statement guard still applies on every `query`, so a read can't use its
  connection to `ATTACH`/`PRAGMA` to another file.
- Closed with the server (`Server.close()` → `#readPool.close()`).

### Create-on-read semantics (cell-dbs)

A never-written cell-db has **no file** yet — its schema is created on the first
*write* (the attach path runs `ensureTables`). A read-only connection cannot
`CREATE TABLE`, so `#readCellDb` preserves the "fresh cell-db reads `[]`"
contract without writing:

1. **Missing file → `[]`** (NotFound only; any other `stat` failure surfaces, so
   a permissions/I/O error is never masked as an empty result).
2. **"no such table" for a DECLARED table → `[]`.** Once the file exists,
   `ensureTables` has created every table declared at that write; a "no such
   table" therefore means either a declared table not yet materialized (the
   schema evolved since the last write — behaves like a fresh, empty table) or
   an **undeclared** table (a typo / mistake). The fallback is scoped to the
   declared schema (`db.tables`): declared → `[]`, undeclared → **rethrow**, so
   genuine query/schema errors are not silently swallowed.

On-disk sources never hit this — their external schema already exists and we
never migrate them.

### Read-after-write visibility (cell-dbs)

A cell-db now has a pooled read connection *and* the write-via-attach. **WAL is
not required** for our access pattern: reads observe only *committed* state
(read-after-write *within* a transaction is unsupported — see
[Ordering within a commit](#ordering-within-a-commit)), writes serialize on the
engine connection, and each query is a *fresh* read transaction (`.all()`), so a
reused pooled connection observes writes committed after it opened (pinned by a
test in `v2-sqlite-protocol.test.ts`). WAL remains a future hardening for
concurrent read-*during*-write, not a correctness prerequisite.

An additive schema migration on the write connection bumps the schema cookie;
the pooled reader reloads schema on its next access automatically.

### `ensureTables` only on the first write

Independently of the pool, `ensureTables` (a `CREATE TABLE IF NOT EXISTS` per
declared table) runs only on the **first write** per `(space, id, schema-JSON)`,
gated by a bounded LRU `#ensuredSchemas` set keyed by the declared `db.tables`.
A changed declaration → new key → re-ensure (additive migration). This removes
the per-write N-DDL cost; reads run no DDL at all. (A restart re-ensures once,
idempotently.)

## Protocol extension

The v2 protocol is a discriminated union of message `type`s
([`packages/memory/v2.ts`](../../../packages/memory/v2.ts), `ClientMessage` /
server messages; parsed in `parseClientMessage`, routed in
`Connection.#receiveOrdered`, correlated by `requestId` in
[`packages/memory/v2/client.ts`](../../../packages/memory/v2/client.ts)). It is
extensible by adding variants. We add **one new read verb** and **fold writes
into the existing `transact` commit**.

### Reads: `sqlite.query` (new verb)

```ts
// Shown at module scope.
interface SqliteQueryRequest {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;            // resolved source descriptor (Section 03)
  sql: string;               // single read-only statement
  params?: unknown[] | Record<string, unknown>;
  // Key-safe entry transport for named parameters. Mutually exclusive with
  // params; the client uses it when a parameter name is a reserved codec key.
  namedParams?: Array<[string, unknown]>;
}

type SqliteRowWire =
  | Record<string, unknown>
  | Array<[string, unknown]>;

interface SqliteQueryWireResult {
  rows: SqliteRowWire[];
  columns?: Array<{
    output: string;
    table: string | null;
    column: string | null;
  }>;
}

// The result rides the existing ResponseMessage envelope as `ok`.
```

Server handling (mirrors `Server.transact` / `Server.queryGraph`):

1. Route the new `type` in `Connection.#receiveOrdered`, guarded by
   `requireSession`.
2. **Apply the statement guard** (above): single `SELECT`/read-only CTE; reject
   DML/DDL, schema-qualified references, `PRAGMA`/`ATTACH`/`DETACH`, and multiple
   statements, with a `read-only-violation` / `guard-violation` error. The guard
   runs **before** any file/short-circuit so a rejected statement is refused even
   against a never-written cell-db.
3. Resolve the db ref to its on-disk file **path**: an injected on-disk source's
   registered path (`DiskSourceRegistry`), else the cell-db path
   (`#cellDbPath(engine, space, db.id)`).
4. Run the query on the **read pool** (`ReadConnectionPool.query(path, sql,
   params)`) — a path-keyed, read-only connection (see below). Cell-db
   create-on-read semantics are preserved by the pool caller (`#readCellDb`):
   a missing file → `[]`, a "no such table" for a **declared** table → `[]`,
   anything else → surface the error.
5. Convert each row with `sqliteRowToWire` and reply with
   `{ type: "response", requestId, ok: { rows, columns? } }`. An ordinary row
   stays an object; a row containing a reserved codec key such as
   `constructor` uses key-value entries. The client reconstructs both forms.

`_cf_link` decoding (Section [02](./02-cf-link-encoding.md)) happens **on the
client** after the rows return, because reconstructing a `Cell` needs the
runtime. The server therefore keeps `_cf_link` values as their encoded strings;
the key-safe row envelope changes field-name transport, not column values.

### Writes: `db.exec`, folded into `transact`

Writes are **not** a separate RPC and **not** a reactive built-in. The author
calls `db.exec(sql, params?)` (a method on the `SqliteDb` cell, Section
[01](./01-api.md#dbexecsql-params--imperative-write)) inside a handler. It
returns `void` and records a `sqlite` op onto the **caller's transaction** — the
same transaction that carries the surrounding cell writes — so they apply in the
**same SQLite transaction**.

The client-side seam is:

```
db.exec(...)                                  // packages/runner/src/cell.ts
  → tx.recordSqliteWrite(space, { op: "sqlite", db, sql, params })
                                              // storage transaction (interface.ts +
                                              //   v2-transaction.ts / extended-storage-transaction.ts)
  → getNativeCommit                           // folds the op into the pending commit
  → ClientCommit { operations: [...cellOps, sqliteOp] }
                                              // packages/memory/v2.ts
  → engine applies all operations atomically  // applyCommitTransaction
```

The client commit (`ClientCommit` in
[`packages/memory/v2.ts`](../../../packages/memory/v2.ts)) carries an
`operations: Operation[]` list applied inside
`engine.database.transaction(applyCommitTransaction).immediate(...)`
([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
`applyCommit` → `applyCommitTransaction`, which iterates operations through
`writeOperation`). The `sqlite` operation kind:

```ts
// Shown at module scope.
interface SqliteOperation {
  op: "sqlite";
  db: SqliteDbRef;       // which attached database
  sql: string;           // write statement(s)
  params?: unknown[] | Record<string, unknown>; // _cf_link params pre-encoded by client
}
```

`writeOperation` handles `case "sqlite"` that, for a cell-derived db:

1. Ensures the db is ATTACHed to `engine.database` (the connection already
   inside the open transaction).
2. Executes the statement via the same connection — so it is part of the very
   `.immediate()` transaction that writes cell revisions. Either everything
   commits or everything rolls back.

**Abort-only on failure.** `db.exec` returns `void` and exposes no result cell:
there is no `pending`/`success`/`error` state. If the SQL statement fails, the
`.immediate()` transaction throws and the **whole commit aborts** — the cell
writes that rode the same transaction roll back too. The author surfaces failure
through the commit failing, not through a per-write result. (`db.exec` also
**throws on the client** before the commit if a param is `undefined` — a value
that isn't ready yet — or if a cell is bound to a non-`_cf_link` column; Sections
[01](./01-api.md) and [02](./02-cf-link-encoding.md).)

`_cf_link` parameters are **encoded on the client** (Section
[02](./02-cf-link-encoding.md)) before the operation is placed in the commit, so
the server stores ready-made link strings and never needs runtime cell access.

The same commit also carries the `rev`-bumped handle-cell value that drives
`reactOn: db` re-query and write serialization (Section
[05](./05-reactivity.md)).

This keeps the atomicity property the runtime already relies on: a commit is one
SQLite transaction with a single global `seq`. Cell writes and SQLite writes
land together.

> **Spec evolution.** The engine/server/protocol layers already supported a
> `sqlite` op inside a commit; the implementation added only the client seam
> (`recordSqliteWrite` → `getNativeCommit`) that lets `db.exec` append that op to
> the caller's transaction. There is no reactive write RPC.

## Ordering within a commit

Per the goals, **writes are executed after** the rest of the commit's cell
operations, and **read-after-write within the same transaction fails**:

- `sqlite` operations are ordered last among the commit's operations (the
  `sqlite` op is appended after the cell ops).
- A `sqlite.query` issued from inside the same transaction that has pending
  (uncommitted) `sqlite` writes is rejected with a `read-after-write-unsupported`
  error. v1 does not simulate the pending write: a query against a db with
  pending writes in the same transaction throws rather than reading stale state.

## Atomicity across cells and SQLite (and WAL caveat)

Goal: transactions are **atomic across cells and the attached SQLite database**.

- **Normal operation.** Because the attached db shares the engine connection,
  `BEGIN … COMMIT` spans the main space db and the attached db. SQLite commits
  attached databases atomically when they share a connection and journal
  coordination — so in the no-crash path, cells and rows commit together.
- **WAL caveat.** The engine runs `PRAGMA journal_mode = WAL`
  ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
  `PRAGMAS`). With WAL, cross-file atomic commit is **not guaranteed across a
  crash** mid-commit: one file's WAL frame may be durable while the other's is
  not. In normal (no-crash) operation the commit is atomic.
- **Post-crash safety (V1: detect + quarantine).** Each attached db carries a
  small `_cf_commit_watermark(seq)` row, written **inside** the commit txn and
  advanced on commit; the commit also **persists its `sqlite` ops** in the commit
  record. On open, the engine compares the space's committed `seq` (the `commit`
  table, [`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
  `insertCommit`) against each attached db's watermark. If they **disagree** —
  the only thing the WAL crash window can cause — the engine **quarantines** that
  pattern db: it fails the db's queries with a clear error and logs loudly,
  rather than serving divergent data. It does **not** silently proceed.
- **Auto-repair is deferred** (fast-follow): replay the persisted ops for a db
  that is *behind*, truncate orphaned in-doubt writes for one that is *ahead*,
  then lift the quarantine. Persisting ops + the watermark in V1 means this needs
  no later schema migration.

> Implementation reality check: `@db/sqlite` exposes a single synchronous
> connection per `Database`; ATTACH + shared-connection transactions buy
> normal-operation atomicity. Per-commit checkpoint+fsync of both files was
> rejected — it doesn't close the crash window and kills WAL throughput. See
> [08-open-questions.md](./08-open-questions.md) Q7.

## Concurrency

- `transact`-folded **writes** serialize on the single-threaded/synchronous
  engine connection like all other engine work. **Reads no longer run on the
  engine connection** — they run on the read pool's per-path read-only
  connections (see [Read path](#read-path-a-pooled-read-only-connection)), so a
  long query no longer blocks the space's writes. (A statement timeout remains a
  worthwhile guard against a single runaway read.)
- Multi-tab / multi-client coordination for the *write* side is inherited from
  the existing commit model (seq-based validation, optimistic local commit,
  server confirmation), so no new mutex is needed for writes. Concretely, because
  `db.exec` does a read-modify-write of the handle cell's `rev` in the same
  commit, two concurrent `db.exec` commits conflict on that cell's
  optimistic-concurrency revision and serialize — one retries (Section
  [05](./05-reactivity.md)). (Contrast `fetchJson`, which needs `tryClaimMutex`
  because it has no transactional backstop.)

> **As-built proof.** Atomic cells + the `sqlite` op in one commit is proven
> engine → server → protocol → runner and end-to-end through `cf check` plus the
> real server (`integration/sqlite-db-query-decode.test.ts`), with rollback and
> two-connection isolation pinned in `packages/memory/test/v2-sqlite-*-test.ts`.
