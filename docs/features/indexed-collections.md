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
  column is stored under.
- `relations` names member fields that hold references to other cells.
- `indexes` declares secondary indexes over the mirrored columns.

The result is a database handle with two more methods. `add(member)` and
`remove(member)` change membership, and are called inside a handler like
`exec()`. `query()` is the database's own, so a typed row lowers to a schema
the same way, and a row field typed `Cell<T>` reads a `_cf_link` column back
as a live cell.

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
boolean as `0` or `1`, and anything else as `NULL`. A relation field that does
not hold a list of cell references reads as empty.

A table schema can declare secondary indexes, which is what the relation
tables and `indexes` use. The memory server creates them with the table,
additively, in `ensureTables()`.

## Keeping the tables current

`add()` reads the member's mirrored fields in the caller's transaction and
writes its rows there, so a member and its rows commit together.

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

Three properties follow from the design, and each is a thing to preserve:

- **The mirror follows stored state.** A field computed by a derivation is
  re-read when the derivation's result is written. A derivation nothing
  demands does not run, so its stored result, and with it the mirror, stays
  as it was until something demands it.
- **A member added by the handler that creates it is re-read once that commit
  is durable.** Inside the creating transaction a new piece's result is not
  written yet, and its reference has not resolved to the cell other members
  will link to. The re-read fills its columns and moves its rows to the
  resolved reference.
- **Only a runtime that executes what it stores maintains.** A client under
  server execution maintains nothing. A serving runtime commits writes only
  from scheduler runs, which is why maintenance is an event handler rather
  than a direct edit.

Each space lists its collections in a registry cell, so a serving runtime
that never loaded the declaring piece still maintains them. The maintainer
reads the registry the first time it hears of a write to that space.

## Queries

A query over an indexed collection follows the collection without being asked
to: it re-runs whenever the collection's database is written. `reactOn` is
still honored, in addition.

Such a re-run is quiet. The request's identity leaves out the collection's
write revision, so a re-run writes no pending claim and no new request hash,
and the result cell is written only where the returned rows differ. A reader
of a result whose rows did not change sees no change at all. The revision each
request last asked under is held in the query node's memory, so a runtime that
restarts asks once more and, finding the same rows, writes nothing.

This is the difference from `reactOn: db` on an ordinary database, where the
revision is part of the request and every write to the database rewrites the
result's control state.

## Contextual flow control

The feature adds no rule and changes no decision. What existing rules do with
it:

- **Reads are ordinary reads.** `add()` and the maintenance handler read
  member fields through their transaction, so the transaction's flow join
  covers what the rows were derived from. The rows are written by `exec()`,
  whose write ceiling applies to a labeled column as it does for any database.
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

## Limits

- A collection's database is one file in one space, and a commit carries
  writes to at most one database.
- Every commit to a space costs one `member_deps` lookup per collection in
  that space, coalesced while a lookup is in flight.
- Result rows are stored as documents, as for any query, so a query bounds its
  rows with `LIMIT`.
- Removing a member deletes the rows it is the source of. Relation rows that
  point at it from other members stay until those members stop referring to
  it, and a query that wants only current members joins against `members`.
- Nothing rebuilds a collection whose database was lost, or re-reads members
  written while no runtime was serving their space and whose commits the
  serving runtime never saw.
