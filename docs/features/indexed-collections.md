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

`indexedCollection<T>(options)` declares a collection of cells that hold a
`T`. The declaration is plain data read when the pattern is built.

```tsx
import {
  handler,
  indexedCollection,
  type IndexedCollection,
  pattern,
  type Stream,
} from "commonfabric";

interface Donut {
  name: string;
  price: number;
  pairsWith: Donut[];
}

const stock = handler<
  { donut: Donut },
  { donuts: IndexedCollection<Donut> }
>(({ donut }, { donuts }) => donuts.add(donut));

export default pattern<Record<string, never>, {
  cheapest: { pending: boolean; result?: { name: string }[] };
  stock: Stream<{ donut: Donut }>;
}>(() => {
  const donuts = indexedCollection<Donut>({
    columns: { name: "text", price: "real" },
    relations: ["pairsWith"],
    indexes: [["price"]],
  });
  return {
    cheapest: donuts.query<{ name: string }>(
      "SELECT name FROM members ORDER BY price LIMIT 3",
    ),
    stock: stock({ donuts }),
  };
});
```

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

The result is a database handle with two more methods. `add(member)` and
`remove(member)` change membership, and are called inside a handler like
`exec()`. `query()` is the database's own, so a typed row lowers to a schema
the same way.

A collection lives at the scope of its space, and holds cells of that space.
`add()` refuses a cell of another space.

## The tables

`defineIndexedCollection()` in
`runtime/runner/src/builtins/indexed-collection/definition.ts` derives the
tables from the declaration:

| Table | Columns | Holds |
| --- | --- | --- |
| `members` | `member_cf_link` as primary key, then one column per mirrored field | one row per member |
| one per relation, named for the field | `source_cf_link`, `target_cf_link`, each indexed | one row per distinct reference a member holds |
| `member_deps` | `member_cf_link`, `doc`, each indexed | the documents each member's rows were read from |

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
additively, in `ensureTables()`.

## Keeping the tables current

`add()` reads the member's mirrored fields in the caller's transaction and
writes its rows there, so a member and its rows commit together. It also
records the member's reference on the handle, as the member added last. A
piece the calling handler has just made is set up only when something the
handler writes refers to it, and a row is not such a write; the handle is
written by every database write already.

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

A cell bound as a parameter of such a query is bound as the reference its
member is stored under, so any link to a member looks it up.

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

The feature adds no rule and changes no decision. What existing rules do with
it:

- **Reads are ordinary reads.** `add()` and the maintenance handler read
  member fields through their transaction, so the transaction's flow join
  covers what the rows were derived from.
- **Rows carry no label of their own.** A collection's columns declare no
  `ifc`, and a mirrored value is bound as a bare scalar, so the write ceiling
  `exec()` applies to a labeled column has nothing to act on here. This is
  what a pattern mirroring a field by hand with `exec()` gets as well; the
  difference is that the runtime does it for every member, and for up to
  fifty members in one transaction.
- **The handle carries the join.** Every write to the database advances the
  handle's revision in the same commit, so the handle is written under the
  maintenance transaction's flow join.
- **A result's shape carries the request's label.** A re-run reads the handle,
  so the label of what triggered it joins the result's membership label, as
  the SQLite read rules already require of any request.

The quiet re-run narrows what a reader can observe: a write that leaves a
result's rows as they were produces no write to that result. It does not make
a confidential write unobservable in general. The handle's revision still
advances, and a result whose rows do change is written under a label that
includes the trigger's.

Hiding the trigger entirely would take a rule this repository cannot make on
its own: a declaration that a result written by a trusted re-run carries the
labels of its rows and not the label of the write that caused the re-run. That
is a change to what Contextual Flow Control decides, and belongs to the
specification first, as
[the correspondence procedure](../development/cfc-spec-correspondence.md)
requires.

## Changing a declaration

A database's tables are created additively: a table or an index the
declaration gains is created the next time the database is written. Nothing
else about a changed declaration is carried over, so today:

- **A relation added** gets its table, and each member's rows the next time
  that member is re-read. Members that are not written afterward have none.
- **A column added** is not added to the existing `members` table, so every
  later write to the collection fails, and with it the handler that made it.
- **A column or relation removed** stops being written. Its column or table
  stays, holding what it held.
- **A path or a type changed** takes effect for a member when it is next
  re-read; a changed type does not alter the existing column.

Changing what an existing collection mirrors therefore means declaring a new
collection and adding the members to it. Carrying a declaration change over
needs two things the feature does not have: adding a column to an existing
table, and re-reading every member when the stored declaration differs from
the one the tables were written under.

## Limits

- A collection's database is one file in one space, and a commit carries
  writes to at most one database. Two collections are two databases, and a
  statement reads one database, so no statement joins two collections.
- Every commit to a space costs one `member_deps` lookup per collection in
  that space, coalesced while a lookup is in flight. The registry of
  collections only grows, so a collection whose declaring piece is gone still
  costs that lookup.
- Adding a member costs several database writes, each of which pays the
  per-statement cost of `exec()`.
- A field read at a narrower scope than the collection's, such as a `PerUser`
  field of a member, is mirrored as whichever instance the maintaining
  runtime reads, into a database every reader of the space shares. Mirror
  only fields stored at the scope of the space.
- A document in another space that a member's field is read through is not
  followed: writes are heard per space.
- Result rows are stored as documents, as for any query, so a query bounds its
  rows with `LIMIT`.
- Removing a member deletes the rows it is the source of. Relation rows that
  point at it from other members stay until those members stop referring to
  it, and a query that wants only current members joins against `members`.
- Nothing rebuilds a collection whose database was lost, or re-reads members
  written while no runtime was serving their space and whose commits the
  serving runtime never saw.
