# 02 — `_cf_link` column encoding

Cell references are first-class values in patterns, but SQLite only stores
scalars. This section defines how a cell crosses that boundary losslessly.

## The rule

A column (or bound parameter) is a **link column** iff its name ends with the
suffix `_cf_link`. In SQLite it is stored as `TEXT`. The database's table schema
(`cfLink<T>()`, Section [01](./01-api.md)) declares it and validates it is
`TEXT`.

For a link column:

- **On write** (`db.exec`), a bound `Cell` is opaquely encoded to a **full sigil
  link string** before the `INSERT`/`UPDATE`. (A `Cell` bound to a *non*-link
  column throws.)
- A `Cell` nested inside a JSON bind value is lowered to its sigil-link object
  before the value crosses the storage boundary. It remains JSON data; only a
  direct bind to a `_cf_link` column receives the link-column string encoding.
- **On read** the behavior depends on whether the query is **typed**:
  - A **typed `db.query<{ col_cf_link: Cell<T> }>`** surfaces the column as a
    live `Cell`. (Mechanically: the runtime decodes the stored sigil **string**
    into a sigil **object**, and the consumer's `<Row>` `asCell` schema
    rehydrates that object into a `Cell<T>` on read.)
  - An **untyped `db.query`** returns the raw stored **sigil-link string** — the
    consumer can decode it on demand via `decodeCfLinkValue` (Section
    "Decode path").
- `NULL` → `null` in both cases.

> **Spec evolution.** The original draft said reads *transparently* decode
> `_cf_link` columns to `Cell`s for every query, driven by the table schema or
> the column-name suffix. As built, decode-to-`Cell` is driven by the **typed
> `db.query<Row>`** result schema (a `Cell<T>` field → `asCell`), not by the
> table declaration or the suffix alone. An untyped query returns the raw string.
> This keeps the per-query `<Row>` the single source of truth for which result
> columns are cell-bearing.

The write encoding is **opaque to the pattern**: pattern code binds a cell and
(for a typed read) reads a cell; the string form is exposed only to an untyped
read.

## Throw conditions

The system fails loudly rather than silently mis-storing data:

| Condition | Result |
| --- | --- |
| Binding a cell reference to a **non-`_cf_link`** column/parameter (write) | **throw** — cells may only be persisted via link columns. |
| A column named `*_cf_link` that is **not** declared/affined as `string` | **throw** — link columns must be a single string field. |
| Binding a **non-cell** value to a `_cf_link` column (write) | **throw** — link columns store cells only (`encodeCfLinkValue`). |
| Decoding a `_cf_link` value (via `decodeCfLinkValue`) that is non-null and **not a parseable sigil link** | **throw** — not valid JSON, or JSON that is not a single `link@1` sigil. |

`NULL`/`undefined` in a link column decodes to `null` (an absent cell).

## Encoding format

The stored string is a **fully-qualified, absolute** serialization of the
runtime's sigil link — absolute so the row is portable and resolvable
independent of any base document or space.

The runtime already produces this shape. `Cell.getAsLink()` returns a `SigilLink`
(see [`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts) and
[`packages/runner/src/link-utils.ts`](../../../packages/runner/src/link-utils.ts)
`createSigilLinkFromParsedLink`). For storage we serialize it with **no `base`**
so `id`, `space`, and `scope` are always present:

```jsonc
// JSON.stringify of the SigilLink, stored as TEXT in the _cf_link column:
{
  "/": {
    "link@1": {
      "id":    "of:fid1:abc…",                    // entity id, always present
      "space": "did:key:z6Mk…",                   // owning space DID, always present
      "scope": "space",                            // resolved scope, always present
      "path":  ["author", "name"]                  // optional value-relative path
      // NOTE: `schema` and any asCell flags are stripped before storage.
    }
  }
}
```

Rationale for absolute links:

- A database may be ATTACHed by transactions originating in different documents;
  a base-relative link would be ambiguous.
- The VM-file and on-disk sources (Section [03](./03-database-sources.md)) may
  outlive or be shared beyond the originating space; absolute links keep stored
  references meaningful.

## Encode path (write)

Executed during `db.exec`, before the `sqlite` op is recorded onto the commit
(Section [04](./04-server-execution-and-transactions.md)). The codec is
`encodeCfLinkValue`
([`packages/runner/src/builtins/sqlite/cf-link.ts`](../../../packages/runner/src/builtins/sqlite/cf-link.ts)):

1. Determine which parameters target link columns by mapping each parameter to
   its column (from the statement's named columns) and the `*_cf_link` suffix /
   the database's table schema (`cfLink` marker).
2. For each link parameter:
   - If the value is not a cell reference (or `toCell`-bearing) → **throw**.
   - Resolve it to a `NormalizedFullLink`, build an absolute `SigilLink` via
     `createSigilLinkFromParsedLink(link, { includeSchema: false })` (no base),
     and `JSON.stringify` it.
3. For each non-link parameter: if the value is a cell reference → **throw**;
   otherwise pass through as a SQLite scalar.

Because the cell's `space`/`id` are captured at encode time on the client, the
encoded string is stable regardless of where the row is later read.

## Decode path (read)

The server returns raw stored strings; decoding happens **on the client** in the
query built-in after rows return
([`packages/runner/src/builtins/sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts)),
and is **driven by the typed `db.query<Row>` schema**:

1. From the transformer-injected `rowSchema`, identify which result columns are
   marked `asCell` (a `Cell<T>` field in `Row`). An **untyped** query injects no
   `rowSchema` → no columns are decoded.
2. For each `asCell` column, replace the stored sigil-link **string** with the
   parsed sigil-link **object** (`parseCfLinkToSigil`). `null`/`undefined` →
   `null`. A value that is not a decodable link is left as-is (the `asCell` read
   then yields `undefined` rather than crashing the whole query). This step
   converts the string to the link **object** that the runtime's link resolution
   recognizes — link resolution does not recognize a JSON string.
3. When the consumer reads `resultOf(q).rows[i].<col>` under its own `<Row>`
   schema, the
   `asCell` marker rehydrates that sigil object into a live `Cell<T>`, carrying
   the column's declared element schema so downstream `.get()`/`.key()` are
   typed.
4. Untyped reads return the raw sigil-link **string** unchanged; a consumer can
   decode it on demand with `decodeCfLinkValue` (which `JSON.parse`s and
   reconstructs a `Cell` via `runtime.getCellFromLink`). Non-link columns pass
   through unchanged either way.

The decoded `Cell` is a normal reactive cell: reading it later subscribes to
*its* contents independently of the SQL query's own reactivity (Section
[05](./05-reactivity.md)).

## Why a naming convention rather than schema-only

The `*_cf_link` suffix makes the contract legible directly in SQL and in raw
table dumps, and drives the **write** encode rule and the storage type
(`cfLink<T>()` declares the column `TEXT`). The suffix is the load-bearing,
self-documenting marker for storage. **Decode-to-`Cell` on read, however, is
driven by the typed `db.query<Row>` schema** (a `Cell<T>` field → `asCell`), not
by the suffix alone: an untyped query returns the raw string regardless of the
column name. The `Row` schema also carries the element type and, later, CFC
labels. This keeps the per-query `<Row>` the single source of truth for which
result columns rehydrate to live cells, while the suffix keeps the storage
contract self-documenting.
