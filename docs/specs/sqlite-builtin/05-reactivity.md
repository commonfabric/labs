# 05 — Reactivity

SQLite is not itself reactive: nothing in the runtime's read-tracking observes a
`SELECT`. v1 makes queries reactive with an explicit, coarse mechanism — **the
handle cell itself stands in for "this database changed"** — which gets us a
long way without a query-dependency analyzer.

## The model

- `db.query` (or the equivalent `sqliteQuery`) takes a `reactOn` input. The
  built-in reads it **wholesale under an `any` schema**, so the scheduler records
  a dependency on that value and everything it transitively links to. When
  `reactOn`'s **committed** value changes, the scheduler re-runs the query
  action, which re-issues `sqlite.query` and writes fresh rows into its result
  cell.
- Pass **the whole `db` handle** as `reactOn`. The query subscribes to the
  handle cell. **`db.exec` bumps a monotonic `rev` counter on that same handle
  cell as part of its own write commit** (see "The rev bump, in-commit"), so the
  handle value changes when (and only when) a write commits — `reactOn: db` means
  "any committed write to this database re-runs the query."
- `reactOn` also accepts **any other value or cell**. Authors who want tighter
  invalidation pass a narrower cell (e.g. a per-table or per-topic cell they bump
  themselves from the same handler that writes), trading precision for manual
  bookkeeping. v1 does not parse SQL to compute fine-grained read sets.
- **A row document is immutable.** The write-back stores each result row as
  an entity document of its own under the query's result cell, keyed on the
  row's content and on the label that content is written under (CFC spec
  §8.17.6, rule 4), and on the space's row salt, a runtime secret that makes
  the id say nothing about the row (Section [06](./06-cfc.md)). A document
  therefore holds one content under one label for as long as it exists. A row whose data changed is another document, and
  the document it had stays as it was, so a reference retained to a row is a
  snapshot: it reads the same content whatever the query selects later, and a
  reader who wants the current rows reads the result. A row carrying no
  confidentiality is keyed on the salt and its content: equal rows share one
  document, and content the result cell has stored before, in the previous
  run or any earlier one, reuses that document. A row carrying a per-column
  label or a row label is keyed on the salt, its content, its row label, the selected
  database (its space and id), the projection (each output column and its
  origin), and the handle's `tables` declaration. The projection and the
  declaration are what decide a column's label, and a commit attaches label
  metadata only to the documents it writes, so a row whose label changed
  under unchanged content lands on a document of its own that the commit
  writes and labels. Any re-declaration of the handle re-keys every labeled
  row the same way. What a re-run writes is the runtime's internal request
  state (its `pending` flag, request hash, and the array of row links), the
  direct availability-aware value channel, plus one document per row
  whose key is new to this result cell. Documents no result references any
  longer are not collected: a result cell accumulates one document per
  distinct row it has ever held.

The public query request is `AsyncResult<SqliteQueryResult<Row>>`, not the
internal state record. `isPending(request)` and `isSyncing(request)` observe
waiting; `hasError(request)` observes terminal failure and exposes
`errorKind`/`errorMessage`. Ordinary consumers read `resultOf(request).rows`.
Unaccepted unavailable states propagate through dependent computations rather
than becoming a successful empty row array.

This is deliberately the same shape the runtime uses elsewhere: reactivity is
driven by observing cells, and the handle cell's changing `rev` stands in for
"the query's underlying data may have changed."

## The rev bump, in-commit

The query must re-run against **fully-committed** data, never optimistic
in-flight writes. The implementation gets this for free by folding the rev bump
into the write's own commit:

- `db.exec` records the `sqlite` op onto the caller's transaction **and** does a
  read-modify-write of `rev` on the handle cell **in the same commit** (one
  commit = cell ops + the `sqlite` op + the `rev`-incremented handle value). See
  [`packages/runner/src/cell.ts`](../../../packages/runner/src/cell.ts) and
  Section [04](./04-server-execution-and-transactions.md).
- The scheduler lets an action see its *own* uncommitted writes within a
  transaction and propagates to other readers only after commit (per the
  scheduler's transaction model and own-commit-source skip in
  [`packages/runner/src/scheduler/`](../../../packages/runner/src/scheduler/)).
  Because the `rev` change rides the write commit, a query depending on the
  handle is notified only once that commit lands — exactly when the SQLite write
  is durable. There is no window where the query re-runs before the write is
  visible to `sqlite.query`.

> **Spec evolution.** An earlier design dirtied the handle cell from a *separate*
> post-commit effect / server hook (an extra RPC-style bump after the write
> committed). The implementation folds the bump into the write's own commit
> instead, so no separate post-commit signal is needed in the cell-derived case.
> The cross-space wrinkle for injected service-space handles (below) is the one
> case that would still need an out-of-band signal — and injected sources are
> stubbed in v1.

There is **no readable `version` field** for code to depend on out of band; the
handle cell's `rev` is internal to this mechanism, and patterns forward the
handle rather than reading it.

## Write serialization (the multi-tab write mutex)

Because the `rev` bump is a **read-modify-write on the handle cell**, two
concurrent `db.exec` commits both read the same `rev` and try to write `rev + 1`.
They therefore **conflict on the handle cell's optimistic-concurrency revision**
and serialize: one commit wins, the other is rejected on the seq/revision check
and retries against the new value. This is the "multi-tab write mutex" — folding
`exec` into the cell commit provides it **for free**, with no separate mutex
primitive (contrast `fetchJson`, which needs `tryClaimMutex` because it has no
transactional backstop).

## What does *not* trigger re-run

- Changes to the **contents of cells referenced by `_cf_link` columns** do not,
  by themselves, re-run the query — the query only re-reads rows. A decoded
  `Cell` in a result row (from a typed `db.query<Row>`, Section
  [02](./02-cf-link-encoding.md)) is, however, a normal reactive cell: a
  `derive` that reads it will update when *it* changes, independent of the query.
  This keeps query re-execution coarse while still letting per-cell reactivity
  flow through normally.
- Writes to *other* databases bump *their* handle cells' `rev`, not this one.

## Injected service-space handles (cross-space wrinkle)

For a `cf`-injected on-disk database (Section [03.3](./03-database-sources.md)),
the handle cell lives in an operator/service space while the SQLite write rides
the *pattern's* space commit — so the same-commit rev bump cannot apply directly
(the handle cell is in a different space than the commit). That source is stubbed
in v1; when it lands it will need an explicit cross-space dirty signal. Injected
datasets are usually read-mostly (`reactOn` omitted), so this does not block v1.
Tracked in [08-open-questions.md](./08-open-questions.md).
