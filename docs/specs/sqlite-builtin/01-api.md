# 01 — TypeScript API

## Built-in vs. new Cell type — decision (as-built)

**Decision: a new `Cell` *variant*, `SqliteDb`.** The database handle ships as a
**branded cell of kind `"sqlite"`** — alongside the existing `readonly`,
`writeonly`, and `opaque` kinds in `CellKind`
([`packages/api/index.ts`](../../../packages/api/index.ts) — `CellKind` now
includes `"sqlite"`). Instead of the general value-cell mutators (`.set`/`.send`),
it exposes a SQLite method surface — `.exec` (write) and `.query` (reactive
read).

> **Spec evolution.** The original draft proposed two standalone built-ins
> (`sqliteQuery` / `sqliteExecute`) forwarding to an *opaque, empty* handle, and
> explicitly rejected a Cell subtype. The implementation reversed that call: a
> `SqliteDb` cell variant carries the read/write methods directly. The
> read/write capability split that motivated separate built-ins is preserved at
> the *type* level — `SqliteDb` exposes `.query` (read) and `.exec` (write) as
> distinct methods, and CFC can still gate them separately. The reactive
> `sqliteExecute` built-in was removed entirely; `db.exec` is the sole write
> path. A free `sqliteQuery<Row>({ db, sql, ... })` function still exists and is
> equivalent to `db.query<Row>(sql, ...)`.

The runtime's reactive I/O — `fetchJson`, `generateText`, `streamData` — is
expressed as built-ins registered in
[`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts)
and surfaced as builder factories in
[`packages/runner/src/builder/built-in.ts`](../../../packages/runner/src/builder/built-in.ts).
A reactive read returns a `Reactive<{ pending, result, error }>` and re-runs
when its inputs change. `db.query` is the same shape and slots into the same
machinery — read-tracking, scheduler subscription, post-commit effects, request
hashing — but is invoked as a method on the `SqliteDb` cell rather than as a free
factory. Writes do **not** use that machinery at all: `db.exec` records a SQLite
op directly onto the caller's transaction (Section
[04](./04-server-execution-and-transactions.md)).

The "database type" the author cares about is expressed two ways:

- The **handle** is the `SqliteDb` cell variant — see "The handle type" below.
- The **table/row shape** is declared on the database
  (`sqliteDatabase({ tables })`), with `db.query<Row>` declaring divergent result
  shapes — see "Schema ownership" and "TypeScript and table types".

## The handle type

`SqliteDb` is a **branded cell** of kind `"sqlite"`. Its *readable value* is the
database handle reference — a small descriptor `{ id, tables, rev }` — not an
empty object:

- `id` — the database identity, derived from the handle cell's own causal/opaque
  entity id (Section [03](./03-database-sources.md)). Opaque to pattern code;
  never constructed by the pattern.
- `tables` — the declared table schemas (from `sqliteDatabase({ tables })`).
- `rev` — a monotonic write counter bumped by `db.exec` (Section
  [05](./05-reactivity.md)). It exists so `reactOn: db` re-runs after a write and
  so concurrent writes serialize; patterns do not read it directly.

That descriptor is what the compiler emits as the schema of a `SqliteDb`
position (`NativeTypeFormatter`, `packages/schema-generator`), keyed on the
`SQLITE_DB_BRAND` the handle type carries: the brand's own members describe
nothing, so a schema derived from them would shape every read of a handle down
to `{}`. `tables` therefore reads back whole, per-column `ifc` labels included
— a pattern needs the declared columns to write a query against the database,
and the disclosure is the same one `describe_handle` makes deliberately.

```ts
// Shown at module scope.
export declare const SQLITE_DB_BRAND: unique symbol;
/** The SqliteDb cell's readable value: the `{ id, tables, rev }` descriptor
 *  above, behind a nominal brand. Patterns usually just forward the SqliteDb
 *  cell to db.query / db.exec / reactOn. */
export type SqliteDatabase = { readonly [SQLITE_DB_BRAND]: true };

/** Imperative write: records a SQLite write onto the current transaction. */
export interface ISqliteExecutable {
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void;
}

export type SqliteEntryRow<Row> = Array<
  {
    [Key in Extract<keyof Row, string>]: readonly [Key, Row[Key]];
  }[Extract<keyof Row, string>]
>;
export type SqliteQueryRow<Row> = Extract<
  keyof Row,
  "constructor" | "__proto__"
> extends never ? Row : SqliteEntryRow<Row>;

/** Reactive read: builds a sqliteQuery node. `<Row>` is lowered by the
 *  ts-transformer to an injected `rowSchema`. */
export interface ISqliteQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: {
      params?: ReadonlyArray<unknown> | Record<string, unknown>;
      reactOn?: unknown;
    },
  ): Reactive<{
    pending: boolean;
    result?: SqliteQueryRow<Row>[];
    error?: any;
  }>;
}

/** A DB handle cell exposing the SQLite method surface (.exec/.query) instead of
 *  the general value-cell mutators. Reads back the handle ref and carries the
 *  toCell back-pointer, but is NOT writable (you cannot .set() a DB handle). */
export interface SqliteDb<T = SqliteDatabase>
  extends BrandedCell<T, "sqlite">, IAnyCell<T>, IReadable<T>,
    ISqliteExecutable, ISqliteQueryable {}
```

The brand symbol is exported. Nothing reads it — it exists to keep
`SqliteDatabase` nominal — but a pattern that names `SqliteDb` in an exported
signature emits a declaration that refers to it, and a symbol the pattern's
module cannot name is one the compiler refuses to emit past. Every brand in the
pattern API is exported for that reason.

Why a cell variant rather than `Cell<SqliteDatabase>` or an opaque empty value:

- The handle must carry **methods that create graph nodes** (`.query`) and
  **methods that record transactional ops** (`.exec`). A branded cell variant is
  the natural home: `.query` builds a `sqliteQuery` node the same way other
  reactive reads do; `.exec` reaches the caller's transaction the same way
  `.set` does — but neither is a general value mutator, so the brand restricts
  who can call them.
- It still travels as a **reference**: like every cell it carries a `toCell`
  back-pointer
  ([`packages/runner/src/back-to-cell.ts`](../../../packages/runner/src/back-to-cell.ts)),
  so the runtime can recover the handle cell — to name the database from its
  entity id, to resolve its source server-side, and to subscribe for reactivity.
- The handle's **id is opaque** to the pattern: it is the handle cell's own
  entity id. Pattern code forwards the `SqliteDb` cell; it never names a file or
  attach alias.

## `sqliteDatabase(options?, source?)`

Builder factory returning a `SqliteDb` cell. The **table schema and DDL are owned
here** (see "Schema ownership") — passed first because they are the common case.
The optional **source** comes second because it is rarely non-default; with no
source the handle binds to a cell the runtime allocates in the current pattern
context (the default, cell-derived source).

```ts
// Shown at module scope.
export type SqliteDatabaseFunction = (
  options?: { tables?: SqliteTableSchemas },
  source?: SqliteDatabaseSource,
) => Reactive<SqliteDb>;

/** Non-default database source. Cell-derived (default) needs no source; on-disk
 *  databases are injected as a pattern input, not selected here. */
export type SqliteDatabaseSource = {
  vm: Reactive<unknown>; // VM file (stub, Section 03.2)
  path: string;
};
// NOTE: there is no way to point a database at an arbitrary cell. The
// cell-derived handle is always the one the runtime allocates for this call —
// targeting some other cell would re-introduce ambient authority. There is also
// no `{ disk }` variant: on-disk databases are *injected* as a pattern input via
// `cf piece link <piece> <field> sqlite:<path>` (Section 03.3), not selected by
// the pattern.
```

The underlying database identity (file name / attach alias) is **opaque to the
pattern** — derived from the handle cell's entity id (Section
[03](./03-database-sources.md)) and never constructed by pattern code.

## Schema ownership — the database owns its tables

The table/column schema is a property of the **database**, not of an individual
query, so it is declared once on `sqliteDatabase({ tables })` rather than
re-stated per call. The runtime **owns table creation and migration** from this
declaration, validating that `_cf_link` columns are `TEXT` and (later) attaching
per-column CFC labels in one place.

```tsx
// Shown at module scope.
import { table, cfLink, sqliteDatabase } from "commonfabric";

const db = sqliteDatabase({
  tables: {
    messages: table({
      id: "integer primary key",
      body: "text",
      ts: "integer",
      author_cf_link: cfLink<User>(), // TEXT in SQLite, Cell<User> in TS
    }),
  },
}); // -> Reactive<SqliteDb>
```

This is the single source of truth: there is no per-query `rows` argument.
Because result columns map back to declared columns by name, the runtime already
knows which columns are `_cf_link` for a straightforward
`SELECT … FROM messages` — but note that decode-to-`Cell` on read is driven by a
typed `db.query<Row>` schema, not by the table declaration alone (Section
[02](./02-cf-link-encoding.md)).

Leaving DDL to the database (rather than the old manual `CREATE TABLE IF NOT
EXISTS` in pattern code) avoids silent drift: `CREATE TABLE IF NOT EXISTS`
no-ops when a table already exists with a *different* shape, hiding mismatches.
Runtime-owned migration reconciles the declared schema instead. **V1 migration
is additive-only:** create missing tables and `ADD COLUMN` for new
nullable/defaulted columns; any destructive or ambiguous change (drop/rename/
retype, constraint/PK change) **refuses to open the db** with an explicit error,
because a declarative diff can't tell a rename from a drop+add. A post-V1 opt-in
**migration callback** will let a database supply explicit reshape logic for
older on-disk versions while still erroring by default. (See
[08-open-questions.md](./08-open-questions.md) Q9.)

## `db.query<Row>(sql, options?)` — reactive read

```ts
// Shown for illustration only.
type QueryRow<Row> = Extract<
  keyof Row,
  "constructor" | "__proto__"
> extends never ? Row : Array<
  {
    [Key in Extract<keyof Row, string>]: readonly [Key, Row[Key]];
  }[Extract<keyof Row, string>]
>;
db.query<Row = Record<string, unknown>>(
  sql: string,
  options?: {
    /** Positional (`?`) or named (`:name`) bindings. */
    params?: ReadonlyArray<unknown> | Record<string, unknown>;
    /** Reactivity input. When its committed value changes, the query re-runs.
     *  Pass the whole `db` for "any committed write to this database re-runs".
     *  See Section 05. */
    reactOn?: unknown;
  },
): Reactive<{ pending: boolean; result?: QueryRow<Row>[]; error?: any }>;
```

`db.query` is **read-only**. The server rejects any statement that is not a
single `SELECT` (or read-only CTE).

A free function is equivalent:

```ts
// Shown at module scope.
type QueryRow<Row> = Extract<
  keyof Row,
  "constructor" | "__proto__"
> extends never ? Row : Array<
  {
    [Key in Extract<keyof Row, string>]: readonly [Key, Row[Key]];
  }[Extract<keyof Row, string>]
>;
export type SqliteQueryParams = {
  db: Opaque<SqliteDatabase | SqliteDb>;
  sql: string;
  params?: ReadonlyArray<unknown> | Record<string, unknown>;
  reactOn?: unknown;
};
export declare const sqliteQuery: <Row = Record<string, unknown>>(
  params: Opaque<SqliteQueryParams>,
) => Reactive<{
  pending: boolean;
  result?: QueryRow<Row>[];
  error?: any;
}>;
```

`db.query<Row>(sql, opts)` and `sqliteQuery<Row>({ db, sql, ...opts })` lower to
the same `sqliteQuery` node; choose whichever reads better.

SQLite permits result aliases that Fabric records reserve against prototype
pollution. A reactive query carries a row containing `constructor` or
`__proto__` as an ordered array of `[column, value]` entries so the result
remains a valid durable Fabric value. Ordinary rows remain objects.
`SqliteQueryRow<Row>` exposes that distinction: when `Row` explicitly declares
either reserved name, the result row is `SqliteEntryRow<Row>`; otherwise it is
`Row`. Code that intentionally selects one of those aliases must handle the
entry-list form directly; reconstruct an object only at a native boundary that
will not write the object back into Fabric state.

The **`Row` type argument** carries the author-facing column types and the
runtime decode schema. `SqliteQueryRow<Row>` selects the durable container shape
described above. The ts-transformer lowers `<Row>` into an injected `rowSchema`
property on the call — method-call lowering keyed on the `"sqlite"` receiver
brand for the `db.query<Row>` form, and the free-function form keyed on the
`sqliteQuery` export
([`packages/ts-transformers/src/transformers/schema-injection.ts`](../../../packages/ts-transformers/src/transformers/schema-injection.ts);
brand recognition in
[`packages/ts-transformers/src/transformers/cell-type.ts`](../../../packages/ts-transformers/src/transformers/cell-type.ts)).
A `Cell<T>` field in `Row` lowers to `asCell`, which is what drives `_cf_link`
decode-to-`Cell` (Section [02](./02-cf-link-encoding.md)). The column schema and
the runtime's durable object-or-entry-list representation therefore stay
aligned.

A TEXT column reaches the row as a string, including the text SQLite's JSON
functions build: `json_object(...)`, `json_group_array(...)`, `json(...)`, the
`->` operator, and `json_extract` of an object or array path all yield a string
holding JSON, which the pattern parses itself. The read connection does not
parse it, because whether SQLite marks such a column as JSON depends on the
query plan (a sort or a materialized subquery unmarks it), and a column's type
under `Row` has to hold under every plan. Declare the column `string` in `Row`.

An INTEGER column reaches the row as the integer SQLite holds. A value within
±(2^53 − 1) arrives as a `number`, so an epoch-millisecond timestamp, a rowid,
and a count are ordinary numbers. A value beyond that range arrives as a
`bigint`, because no `number` names it. No typed column declaration reads a
`bigint`: `bigint` lowers to `{ type: "integer" }`
([schema mapping](../schema-generator/ts_to_json_schema_mapping.md)),
which a reader satisfies with a JS `number` only, so under `number`, `bigint`,
or their union that field reads as `undefined`. An untyped query reads the
`bigint` itself. A column that holds such values (a 64-bit id, a nanosecond
timestamp) is selected as text, `CAST(n AS TEXT)`, and declared `string`, which
reads it exactly under every declaration.

This handles projections the table schema can't: because `Cell<T>` lowers to
`asCell`, declaring a result field as `Cell<User>` tells the runtime that column
is cell-bearing **even when an alias hides the `_cf_link` suffix**:

```tsx
// Shown for illustration only.
db.query<{ who: Cell<User>; n: number }>(
  "SELECT author_cf_link AS who, count(*) AS n FROM messages GROUP BY author_cf_link",
  { reactOn: db },
);
// `who` carries asCell -> the stored sigil link is decoded into Cell<User>,
// even though the projection aliased away the _cf_link suffix.
```

An **untyped** `db.query(sql)` injects no `rowSchema`; `_cf_link` columns then
read back as the raw sigil-link **string** (Section
[02](./02-cf-link-encoding.md)). Reach for `<Row>` whenever you want columns
surfaced as live `Cell`s, or when the projection diverges (joins, aliases,
computed columns).

> **Transformer note.** `<Row>` lowering rides the same machinery that lowers
> type arguments for `toSchema<T>`, `generateObject`, and `lift`. Both the
> `sqliteQuery` free function and the `db.query` method are registered; the
> method form is recognized via the `"sqlite"` cell brand. See
> [`packages/ts-transformers/docs/adding-type-arg-schema-lowering.md`](../../../packages/ts-transformers/docs/adding-type-arg-schema-lowering.md).

## `db.exec(sql, params?)` — imperative write

```ts
// Shown for illustration only.
db.exec(
  sql: string,
  /** A cell bound to a `_cf_link` column is encoded to a sigil link (Section 02);
   *  a cell bound anywhere else throws. */
  params?: ReadonlyArray<unknown> | Record<string, unknown>,
): void;
```

`db.exec` is **imperative and synchronous from the author's point of view** — it
returns `void`, not a `Reactive`. It must be called **inside a handler/action**
(it needs a transaction; calling it outside one throws).

It records a `sqlite` op onto the **caller's transaction**, so the write commits
**atomically** with the surrounding cell writes: one commit = the cell ops plus a
single `sqlite` op (the `sqlite` op ordered last). On SQL failure the **whole
commit aborts** — there is no result cell and no `pending`/`success`/`error`
state to inspect (abort-only). It **throws** on an `undefined` param (which may be
a value that isn't ready yet — pass a resolved value, or `null` for SQL NULL).

Because `db.exec` returns `void`, there is **no `changes` / `lastInsertRowid`**
(folding the write into the commit drops the per-call write result the old
standalone RPC returned). A pattern that needs to reference an inserted row in a
follow-up write must use a **deterministic id** (e.g. a `_cf_link` to a cell, or
an explicit `id` column it computes) rather than reading back an auto-increment
rowid.

There is **no reactive `sqliteExecute` built-in** — it was removed; `db.exec` is
the sole write path. DDL is owned by the database (Section "Schema ownership"),
not issued here.

`db.exec` also bumps the `rev` counter on the handle cell **in the same commit**,
which (a) makes `reactOn: db` queries re-run after the write and (b) serializes
concurrent writers (two in-flight `db.exec` commits conflict on the handle cell's
revision and one retries). See Section [05](./05-reactivity.md).

There is **no per-call `bind` schema**: the database's table schema already
declares which columns are `_cf_link`, so for
`INSERT INTO messages (author_cf_link, …)` the runtime maps each parameter to its
column and encodes link parameters accordingly. A cell bound to a parameter is
encoded to a sigil link **only** when that parameter targets a `_cf_link` column;
otherwise binding a cell throws (Section [02](./02-cf-link-encoding.md)).

(Runtime: `.exec` is implemented on the cell
([`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts)) and
records the op through the storage seam `recordSqliteWrite` → `getNativeCommit` →
`ClientCommit`, which the engine applies inside the commit transaction — Section
[04](./04-server-execution-and-transactions.md).)

## TypeScript and table types — why these boundaries

- **Table/column declaration** lives on the database (`table(...)`,
  `cfLink<T>()`), because it is a property of the database and is the natural
  home for `_cf_link` markers and future per-column CFC labels (the same `ifc`
  mechanism schemas already support —
  [`packages/api/index.ts`](../../../packages/api/index.ts) `ifc` field).
- **Result-row typing** is the `db.query<Row>` (or `sqliteQuery<Row>`) type
  argument, lowered to a runtime schema by the transformer — needed both to type
  the result and to surface `_cf_link` columns as live `Cell`s.
- **We do not infer types from the SQL string.** An in-type SQL parser
  (dialect, expressions, joins, aliases) is brittle and out of proportion to the
  value. Parameter tuples remain author-annotated.

```ts
// Shown at module scope.
export interface SqliteColumnSchema {
  type: JSONSchemaTypes;
  sqlType?: string;
  cfLink?: true;
  [keyword: string]: FabricValue;
}
export type SqliteColumnSpec = string | SqliteColumnSchema;
export type SqliteTableFunction = (
  columns: Record<string, SqliteColumnSpec>,
) => JSONSchema;
export type SqliteCfLinkFunction = <_T = unknown>() => SqliteColumnSchema;
```

`table(...)` and `cfLink<T>()` compile to plain JSON Schema; `cfLink<T>()` emits
`{ type: "string" }` plus an internal marker the runtime uses to drive
encode/decode and to enforce the "single string field ending in `_cf_link`" rule
(Section [02](./02-cf-link-encoding.md)).

## Registration & wiring (implementation note)

As built:

1. Built-in implementations in
   [`packages/runner/src/builtins/sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts)
   (`sqliteDatabase`, `sqliteQuery`), registered in
   [`packages/runner/src/builtins/index.ts`](../../../packages/runner/src/builtins/index.ts).
2. The `SqliteDb` cell variant and its `.exec`/`.query` methods live on the cell
   ([`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts)); the
   write op flows through the storage seam `recordSqliteWrite`
   ([`packages/runner/src/storage/interface.ts`](../../../packages/runner/src/storage/interface.ts)
   and the v2/extended transaction implementations).
3. Public types — `CellKind` (`"sqlite"`), `ISqliteDb`/`SqliteDb`,
   `ISqliteExecutable`, `ISqliteQueryable`, `SqliteDatabaseFunction`,
   `SqliteQueryParams`/`SqliteQueryFunction`, `table`/`cfLink` — in
   [`packages/api/index.ts`](../../../packages/api/index.ts). There is **no**
   `sqliteExecute` export.
4. The ts-transformer lowers the `<Row>` type argument for both `sqliteQuery` and
   `db.query` to an injected `rowSchema`
   ([`packages/ts-transformers/src/transformers/schema-injection.ts`](../../../packages/ts-transformers/src/transformers/schema-injection.ts)).
