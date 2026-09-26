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
- **A refresh keeps the previous answer readable.** `reactOn` says when to ask
  again; everything else the request carries — the database, statement,
  parameters, reader and ceilings — is the question. The request hash records
  the two apart, as the question's digest and `reactOn`'s joined by `.`. A
  re-issue whose question matches the one the stored rows answer is a refresh:
  its claim writes `pending` and the request hash and nothing else, so
  `result` and `withheld` stay readable beside `pending: true` until the
  refreshed rows replace them. Any other re-issue claims the whole result cell
  and clears them, so rows never stand beside `pending` under a question they
  do not answer. A refresh that fails replaces the rows with its `error`, as a
  first issue's failure does.
- **A row keeps its document across re-runs.** The write-back stores each
  result row as an entity document of its own under the query's result cell,
  keyed so that a row which did not change keeps its document and writes
  nothing to it, and so that the id, which any reader of the result's
  unlabeled row links can see and recompute, is drawn only from what such a
  reader may already see. A row carrying no confidentiality is keyed on its
  content: equal rows share one document, and content the result cell has
  stored before, in the previous run or any earlier one, reuses that
  document. A row carrying a per-column label is keyed on its position, and a
  row under a row label on its position and its label: a document's
  confidentiality can never weaken, so a document may only ever hold rows of
  one label, and the label is metadata every document carries in the open, so
  the id gives away nothing the document does not. Position rather than a
  declared primary key, because the declaration is the handle's claim and not
  a verified constraint of the table, and two rows sharing a declared key
  would share a document. The positional keys also carry the selected
  database, its space and id, since a query's `db` input can move to another
  database whose rows would otherwise land on the same documents; the
  projection, each output column and its origin, since a query's `sql` input
  can move to a projection whose columns carry other labels; and the handle's
  `tables` declaration, because a commit attaches label metadata only to the
  documents it writes: a stricter re-declaration of a label moves every row
  to a new document that the commit writes and labels, rather than leaving a
  row with unchanged content under the label its old document carries, and
  any re-declaration of the handle re-keys every labeled row the same way.
  What a re-run writes is the result cell (its `pending` flag, request hash,
  and the array of row links) plus one document per row whose key is new to
  this result cell or whose content changed at its key — not one document per
  row per run.

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
