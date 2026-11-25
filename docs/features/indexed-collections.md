# Indexed collections

An indexed collection is a set of cells whose membership, and a chosen
projection of each member, live in a SQLite database that the runtime keeps
current. A pattern reads the collection with SQL and with nothing else: there
is no list of members, so nothing reads every member to answer a question
about a few of them.

The member cells stay the source of truth. The database is a mirror of the
fields a declaration names, and a query that needs more than those fields
selects the member's reference and reads the cell.

For authoring, see
[the SQLite capability guide](../common/capabilities/sqlite.md#indexed-collections).
This document covers how the feature behaves and what to know before changing
it.

## Declaring one

`indexedCollections<Kinds>(kinds)` declares a collection whose members come
in the kinds it names, each kind a set of cells that hold the type `Kinds`
gives it. The declaration is plain data read when the pattern is built.

```tsx
import {
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
} from "commonfabric";

interface Donut {
  name: string;
  price: number;
  pairsWith: Donut[];
}

type Shop = IndexedCollections<{ donuts: Donut }>;

const stock = handler<{ donut: Donut }, { shop: Shop }>(
  ({ donut }, { shop }) => shop.add("donuts", donut),
);

export default pattern<Record<string, never>, {
  cheapest: { pending: boolean; result?: { name: string }[] };
  stock: Stream<{ donut: Donut }>;
}>(() => {
  const shop = indexedCollections<{ donuts: Donut }>({
    donuts: {
      columns: { name: "text", price: "real" },
      relations: ["pairsWith"],
      indexes: [["price"]],
    },
  });
  return {
    cheapest: shop.query<{ name: string }>(
      "SELECT name FROM donuts ORDER BY price LIMIT 3",
    ),
    stock: stock({ shop }),
  };
});
```

Each kind declares:

- `columns` names member fields to mirror, each with the SQLite type its
  column is stored under. A column that mirrors a nested value is given a
  type and a path instead:
  `bakerName: { type: "text", path: ["baker", "name"] }`.
- `relations` names member fields that hold one reference to another cell, or
  a list of them. Written as a map, it gives each relation the path of a
  nested field: `relations: { pairsWith: ["menu", "pairsWith"] }`.
- `indexes` declares secondary indexes over the mirrored columns.

A field that is absent, on the member or anywhere along a path, is stored as
`NULL` or as no reference, so an optional field needs nothing more than its
name.

A kind's table is named for the kind, here `donuts`, and a relation's table
for the kind and the relation joined by an underscore, here
`donuts_pairsWith`.

The result is a database handle with two more methods. `add(kind, member)`
and `remove(kind, member)` change membership, and are called inside a handler
like `exec()`. A member is a cell, or a value a handler read from one, as
`donut` is above; a value written out in the handler is no cell, and `add()`
throws on it. `query()` is the database's own, so a typed row lowers to a schema
the same way.

A collection lives at the scope of its space, and holds cells of that space.
`add()` refuses a cell of another space.

A piece the calling handler has just made is set up as the handler's
transaction ends, after `add()` has read it. Its row is therefore stored with
its columns unset, and names none of the documents the piece is made of. The
runtime re-reads every member a handler added once that handler's transaction
has committed, which fills the row and records what it was read from.

### Who may write a collection

A handle is passed around so that its holders can ask it questions: a member
that wants to know which members refer to it holds the collection's. Holding
it also lets them write. A collection that names a guard says which handlers
may.

```tsx
import {
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

interface Donut {
  name: string;
}

type Shop = IndexedCollections<{ donuts: Donut }>;

const stock = handler<{ donut: Donut }, { shop: Shop }>(
  ({ donut }, { shop }) => shop.add("donuts", donut),
);

/** A count that `stock` alone may write. */
type ShopGuard = WriteAuthorizedBy<number, typeof stock>;

export default pattern<Record<string, never>, {
  stock: Stream<{ donut: Donut }>;
}>(() => {
  const guard = new Writable<ShopGuard>(0);
  const shop = indexedCollections<{ donuts: Donut }>(
    { donuts: { columns: { name: "text" } } },
    { guard },
  );
  return { stock: stock({ shop }) };
});
```

The guard is an ordinary cell of the pattern's, declared with a writer policy
as any protected cell is. The handle carries a reference to it, and `add()`,
`remove()` and `exec()` each advance it in the transaction that carries their
database write. A handler the policy does not name is refused that write, and
its transaction, the database write included, does not commit. Several
handlers are named with `WritePolicyAnyOf`. Maintenance writes the tables and
neither the handle nor the guard, so it follows a member whoever wrote it.

The guard governs writes made through the handle. The handle's own document
carries no policy, and the database is named by an identifier the handle
holds, so the guard is a rule for the code that is handed a handle and uses
it as one. It is not a boundary against code written to go around it.

### Several kinds of member

A collection that declares several kinds holds them in one database, so that
one statement can join them.

```tsx
import {
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
} from "commonfabric";

interface Donut {
  name: string;
}

interface Order {
  placedAt: number;
  donut: Donut;
}

type Shop = IndexedCollections<{ donuts: Donut; orders: Order }>;

const place = handler<{ order: Order }, { shop: Shop }>(
  ({ order }, { shop }) => shop.add("orders", order),
);

export default pattern<Record<string, never>, {
  lastOrdered: {
    pending: boolean;
    result?: { name: string; last: number | null }[];
  };
  place: Stream<{ order: Order }>;
}>(() => {
  const shop = indexedCollections<{ donuts: Donut; orders: Order }>({
    donuts: { columns: { name: "text" } },
    orders: { columns: { placedAt: "integer" }, relations: ["donut"] },
  });
  return {
    lastOrdered: shop.query<{ name: string; last: number | null }>(
      "SELECT d.name AS name, max(o.placedAt) AS last FROM donuts d " +
        "LEFT JOIN orders_donut e ON e.target_cf_link = d.member_cf_link " +
        "LEFT JOIN orders o ON o.member_cf_link = e.source_cf_link " +
        "GROUP BY d.member_cf_link ORDER BY last DESC LIMIT 50",
    ),
    place: place({ shop }),
  };
});
```

The relation `donut` of the kind `orders` is the table `orders_donut`.

## The tables

`defineIndexedCollections()` in
`runtime/runner/src/builtins/indexed-collection/definition.ts` derives the
tables from the declaration:

| Table | Columns | Holds |
| --- | --- | --- |
| one per kind | `member_cf_link` as primary key, then one column per mirrored field | one row per member |
| one per relation | `source_cf_link`, `target_cf_link`, each indexed | one row per distinct reference a member holds |
| `member_deps` | `kind`, `member_cf_link`, `doc`, indexed by `doc` and by member | the documents each member's rows were read from |
| `collection_meta` | `key`, `value` | the declaration the tables were last brought up to |

A member is stored under its cell reference, in the encoding every `_cf_link`
column uses, taken from the cell the reference resolves to. Two links to one
cell therefore agree, and a relation row's `target_cf_link` equals the
`member_cf_link` of the member it points at. No table holds an identifier of
its own.

A column mirrors a scalar. A string or a finite number is stored as it is, a
boolean as `0` or `1`, and anything else as `NULL`. A relation field that
holds a list contributes a row per distinct element, and one that holds
anything else contributes one row for that value's own cell. The declaration
is trusted to name fields that hold references.

A table schema can declare secondary indexes, which is what the relation
tables and `indexes` use. The memory server creates them with the table,
additively, in `ensureTables()`, which also adds to an existing table the
columns its declaration has gained.

## Keeping the tables current

`add()` reads the member's mirrored fields in the caller's transaction and
writes its rows there, so a member and its rows commit together. It also
records the member's reference on the handle, as the member added last. A
piece the calling handler has just made is set up only when something the
handler writes refers to it, and a row is not such a write; the handle is
written by every `add()` already.

After that the member is followed by the `IndexedCollectionMaintainer` in
`runtime/runner/src/builtins/indexed-collection/maintainer.ts`:

1. It hears of every committed write: from the runtime's storage
   notifications, and in a serving runtime also from the space server's commit
   feed, which reports writes to documents that runtime never loaded.
2. It asks `member_deps` which members were read from the written documents,
   and selects the rows those members have now.
3. It queues an event whose handler re-reads those members in a scheduler-run
   transaction and writes the rows that differ.

A member none of whose rows differ is written nowhere. A write to an unmirrored
field of a member leaves the database, and every query over it, untouched.

`member_deps` is what makes this proportional to the change. Reading a
member's field usually crosses several documents, since a piece's result links
to the cells that hold its values, and the re-read records the documents it
touched. A write is matched against that record, so no member is read to learn
that it was unaffected.

Every statement a re-read writes applies only while the member's own row is
there when the statement commits. The rows it compares against were read
before its transaction began, and a member removed in between stays removed.
`remove()` deletes the rows stored under the reference the member resolves to
and under its own.

These properties follow from the design, and each is a thing to preserve:

- **The mirror follows stored state.** A field computed by a derivation is
  re-read when the derivation's result is written. A derivation nothing
  demands does not run, so its stored result, and with it the mirror, stays
  as it was until something demands it.
- **A member added by the handler that creates it is re-read once that commit
  is durable.** Inside the creating transaction a new piece's result is not
  written yet, and its reference has not resolved to the cell other members
  will link to. The re-read fills its columns and moves its rows to the
  resolved reference.
- **A member is stored under an address and nothing else.** The reference
  holds the space, id, scope and path of the cell a link resolves to. A link's
  other parts, which differ with where the link came from, stay out of it, so
  a reference read out of a query row finds the same member as the cell
  itself.
- **A value stored per user or per session is refused.** The database is
  shared by every reader of the space, and such a value differs by who reads
  it. `add()` throws when a mirrored field is read through one, and a re-read
  that reaches one leaves the member's rows as they were and logs it.
- **Only a runtime that executes what it stores maintains.** A client under
  server execution maintains nothing. A serving runtime commits writes only
  from scheduler runs, which is why maintenance is an event handler and not a
  direct edit.

Each space lists its collections in a registry cell, so a serving runtime
that never loaded the declaring piece still maintains them. The first
time a serving runtime's maintainer hears of a write to a space, it asks
whether that space has a registry, without loading the document, and reads it
only if it does. A
space that holds no collection therefore takes on no watch of one.

## Queries

A query over an indexed collection follows the collection without being asked
to: it re-runs once the collection's database has been written. `reactOn` is
still honored, in addition.

Such a re-run is quiet. The request's identity leaves out the collection's
write revision, so a re-run writes no pending claim and no new request hash,
and the result cell is written only where the returned rows differ. A reader
of a result whose rows did not change sees no change at all.

One request per query is out at a time. A run that finds one in flight
records the revision it observed and sends nothing; when the request
completes, the query's action is run again if the revision has moved, and that
run sends the next request. A result therefore settles on the rows of the
last write, however many writes land while a request is out. The revision
each request was sent under is held in the query node's memory, so a runtime
that restarts asks once more and, finding the same rows, writes nothing.

This is the difference from `reactOn: db` on an ordinary database, where the
revision is part of the request and every write to the database rewrites the
result's control state.

The revision has two parts. `add()` and `remove()` advance a count on the
collection's handle, as `exec()` does on any database. Maintenance marks each
of its writes in a document of the collection's own, with a value no write has
carried before, and leaves the handle alone. A handler that adds to the
collection reads the handle, so maintenance writing it would cost that
handler its commit whenever the two ran side by side. The value is fresh
rather than counted because a maintenance transaction can be run again, and a
count would then repeat: a query that asked at that count, before the rows
were there, would take itself to be current.

A serving runtime commits in waves: the transactions that ended together go
to storage as one commit. A commit may write one database only, and a wave
that is refused takes every transaction in it along. So the maintenance
events of a space run one at a time, each after the wave of the one before
has settled, whichever collection they belong to. A maintenance transaction
that a wave withdraws after it ended well is owed again: its members through
the documents they were read from, so the next drain asks the database what
it holds for them. Three withdrawals in a row are each answered that way; a
fourth leaves what is owed for the drain the next write to the space starts.

A handler that writes one collection in the same wave as maintenance writing
another is refused with it, and a served event is not run again.

A cell bound to a named `_cf_link` parameter of such a query is bound as the
reference its member is stored under, so any link to a member looks it up. A
cell bound anywhere else, positionally included, is refused as it is for any
database.

### Getting the member back

A query returns a member's reference by selecting `member_cf_link`, or a
relation's `source_cf_link` or `target_cf_link`, into a row field typed as a
cell. `OpaqueCell<T>` gives a reference to pass along without reading, to a
handler or into another query. `Cell<T>` gives a cell to read or write, for
the fields the collection does not mirror.

The type a row gives its reference is checked against the member when the row
is read, and a row that fails the check drops the result that holds it. Name
there only what every member holds at all times: a field that is absent until
something demands it, such as the result of a query the member itself
declares, is marked optional.

## Contextual flow control

The feature adds no rule and changes no decision. It applies the ones the
SQLite built-in already has, and refuses what they cannot express.

- **Who may write is a writer policy on a cell.** A collection's guard is a
  cell of the pattern's with a writer policy of the pattern's own choosing,
  and a write through the handle writes it. The policy decides that write as
  it decides any write to the cell; the collection adds only the write.

- **Reads are ordinary reads.** `add()` and the maintenance handler read
  member fields through their transaction, so the transaction's flow join
  covers what the rows were derived from.
- **A column declares its label.** A column declared with `ifc` passes it to
  the table the database is created with, so a query that reads the column
  carries the label, as for any database:
  `title: { type: "text", ifc: { confidentiality: ["secret"] } }`.
- **A labeled value is mirrored only where its label is kept.** A mirrored
  value is bound as a bare scalar, which carries no label into the database,
  and the write ceiling `exec()` applies sees labels only on cells. So the
  label a field's value carries is measured when the field is read: the
  column's declared `confidentiality` has to cover it, and it has to fit the
  column's `maxConfidentiality` where one is declared. A value that fails
  either is not written. `add()` throws, and a re-read leaves the member's
  rows as they were and logs it. A relation declares no label, so a relation
  field that carries one is refused.
- **The revision carries the join.** Every maintenance write to the database
  marks the collection's revision document in the same commit, so that
  document is written under the maintenance transaction's flow join.
- **A result's shape carries the request's label.** A re-run reads the handle
  and the revision document, so the label of what triggered it joins the result's membership label, as
  the SQLite read rules already require of any request.

A column's label is static: every row of the column carries the same one. A
label that differs per member needs a per-row rule, which the collection's
tables do not declare. The statements a collection writes, an upsert and an
`INSERT … SELECT` among them, are ones the row-label gate cannot attribute,
so a rule would refuse every labeled write.

The quiet re-run narrows what a reader can observe: a write that leaves a
result's rows as they were produces no write to that result. It does not make
a confidential write unobservable in general. The collection's revision still
moves, and a result whose rows do change is written under a label that
includes the trigger's.

Hiding the trigger entirely would take a rule this repository cannot make on
its own: a declaration that a result written by a trusted re-run carries the
labels of its rows and not the label of the write that caused the re-run. That
is a change to what Contextual Flow Control decides, and belongs to the
specification first, as
[the correspondence procedure](../development/cfc-spec-correspondence.md)
requires.

## Changing a declaration

A collection's handle, and so its database, is keyed on where the pattern
declares the collection rather than on what the declaration says
([03.1](../specs/sqlite-builtin/03-database-sources.md#031-cell-derived-default)).
An update of the pattern's source keeps both, whether or not it changes the
declaration. An update that gives the declaration another place, by
renumbering it among the pattern's anonymous cells, gives the collection a new
database, which holds no members.

A collection's database records the declaration its tables were last brought
up to, in `collection_meta`. When a runtime first learns of a collection, by
declaring it, writing it, or reading it from the registry, it compares that
record with the collection's declaration, and where they differ it brings the
tables up to date:

1. A first write creates whatever table or index the declaration has gained,
   and adds the columns an existing table has gained.
2. Every member is re-read, a batch per transaction, so a column or a
   relation the declaration gained is filled in for members that are never
   written again. A member whose rows do not change is not written.
3. The declaration is recorded. An interrupted pass leaves the old record, so
   the next runtime to learn of the collection makes the pass again.

What this covers:

- **A column, a relation, an index, or a kind added.**
- **A path changed.** The re-read takes the value from the new path.

What it does not:

- **A column or relation removed** stops being written. Its column or table
  stays, holding what it held.
- **A column's type changed** does not alter the existing column.
- **A column that cannot be added to a table holding rows**, one declared
  `not null` with no default, is refused, and writes to the collection fail
  until the declaration is corrected.

A query that names a column the declaration has just gained returns an error
until the first step has run, and then re-runs.

## Limits

- A collection's database is one file in one space, and a commit carries
  writes to at most one database. Two collections are two databases, and a
  statement reads one database, so members that are to be joined are declared
  as kinds of one collection.
- Every commit to a space costs one `member_deps` lookup per collection in
  that space, coalesced while a lookup is in flight. The registry of
  collections only grows, so a collection whose declaring piece is gone, or
  whose declaration moved to another place in its pattern, still costs that
  lookup.
- Adding a member costs several database writes, each of which pays the
  per-statement cost of `exec()`.
- Reading a reference resolves the cell it names, so a member's rows depend
  on the documents of the cells it refers to. A write to a cell is therefore
  followed by a re-read of every member that refers to it, which writes
  nothing when their rows are unchanged but costs time in proportion to how
  many members refer to that cell.
- A document in another space that a member's field is read through is not
  followed: writes are heard per space.
- Result rows are stored as documents, as for any query, so a query bounds its
  rows with `LIMIT`.
- Removing a member deletes the rows it is the source of. Relation rows that
  point at it from other members stay until those members stop referring to
  it, and a query that wants only current members joins against the kind's table.
- Nothing rebuilds a collection whose database was lost: the database is the
  only record of which cells are members. Nothing re-reads members written
  while no runtime was serving their space and whose commits the serving
  runtime never saw, short of a change to the declaration.
