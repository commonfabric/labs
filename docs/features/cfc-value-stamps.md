# Value stamps — what `ifc.addIntegrity` puts on a written value

A schema node carrying `ifc.addIntegrity` stamps integrity atoms onto the value
a write leaves at that node's position. This document says where a stamp is
stored, how long it holds, and how one schema position stands for many values.
The reconciliation is `packages/runner/src/cfc/minted-integrity.ts`; the commit
preparation that calls it is `packages/runner/src/cfc/prepare.ts`.

## A stamp is one write's, about one value

Three `ifc` keys put integrity in a label, and they say different things:

- `integrity` is a claim about the position: whatever sits there carries the
  atoms. It is stored in the label map's `declared` component, which is store
  policy.
- `addIntegrity` naming a principal claim (`represents-principal`,
  `authored-by`) is also store policy, and is stored in the `declared`
  component too. Owner adoption and writer authorization read it there.
- `addIntegrity` naming any other atom is a **value stamp**: the write through
  that schema vouches for the value it wrote, and for no other.

A value stamp is stored in the label map's `minted` component, in an entry at
the value's path:

```json
{ "path": ["glaze"], "label": { "integrity": ["tasted"] }, "origin": "minted" }
```

The runtime-minted gate applies to it as to any integrity a schema adds: an
atom of a runtime-minted family is stamped only by a write a builtin authored.

## How long a stamp holds

A stamp labels the value its write left. It holds while that value stands:

- A transaction that replaces the value, by a change at the stamp's path or
  above it, withdraws the stamp unless that transaction's own schema stamps the
  same atoms there again. A writer through a schema naming no stamp therefore
  leaves the value it wrote unstamped, which is what a reader is then shown.
- A transaction that changes part of the value, beneath the stamp's path,
  withdraws the stamp unless it stamps what it wrote with the same atoms. A
  value whose changed part carries the stamp still carries it whole; one with
  an unstamped part does not. A writer that updates one field of a document it
  stamped earlier therefore writes that field through a schema position that
  stamps it.
- A transaction that writes the value back unchanged withdraws nothing.
- A transaction that changes some other part of the document withdraws
  nothing.

The schema that stamps is one the writer brought itself. A writer that brings
no label-bearing schema answers to the schema the document stores, so that the
claims stored there bind it, and is stamped nothing by that schema: a stamp the
stored schema names is some earlier write's. Two writers may stamp the same
position with different atoms, each on its own write, and a schema naming
fewer stamps than the stored one merges with it without weakening anything.

A transaction that changes a stamped value and carries no schema at all still
has the document's labels reconciled: the stamp goes with the value.

## One schema position, many values

A schema's `items` and `additionalProperties` are one position standing for
every element or entry, written `*` in a label path. A stamp minted through
such a position is stored in whichever form says exactly which values carry it:

- While every value the `*` path matches carries the stamp, the label map holds
  one entry at the `*` path. A list of a thousand stamped toppings stores one
  entry, not a thousand.
- The first write that leaves a matching value without the stamp replaces the
  `*` entry with one entry per value that still carries it. Appending an
  unstamped topping to a stamped list is such a write; so is replacing one
  topping through a schema that names no stamp.
- A stamp minted onto one element of a list that already holds unstamped
  elements is stored at that element's index from the start.
- A `*` entry left matching no value, by a write that empties the list or
  removes it, is dropped.

A read of one element resolves the entry at its index or the `*` entry, so the
two forms read the same.

A record behaves as a list does, with its keys in place of indices: one `*`
entry while every entry carries the stamp, and one entry per key once writers
stamp entries differently, each holding the atoms of the write that left it. A
key does not move when another is added or removed, so a record's entries keep
their stamps where a list's inline elements would lose them.

The `*` path stands for a record's entries only where the schema names no
property of its own. A schema declaring both named `properties` and
`additionalProperties` gives the latter no label path, so a stamp named there
is not minted.

## A reference carries no stamp

A position holding a reference is not stamped. The value behind a reference is
another document's, and that document's own label map says what it carries.
An object pushed onto a list is stored in a document of its own, so its stamp
is that document's, at the root, and the list holds none for it.

This is what lets a stamp follow an element. An entry at a list index labels
whatever sits at that index, so a write that moves an inline value to another
index changes both positions and withdraws the stamp. An element that has to
keep its stamp wherever it moves is stored as a document of its own, which a
reordered list still refers to.

## The write floor

A `requiredIntegrity` floor is checked against the integrity the written value
carries, and the stamps the writing transaction mints at the floor's path are
part of that. They credit the floor whichever schema declares it, the writer's
or the document's stored one. A writer that stamps nothing does not pass a
floor on the strength of an earlier writer's stamp.

Commit preparation decides a document's stamps once: which schema branches the
written values take, and which atoms the write's author may mint. The floor
check and the stored `minted` entries are both read from that decision, so a
floor is never credited by a stamp the decision does not name at its path, nor
by one the write's author may not mint.

In a union, the floor applies whichever branch the written value takes, and a
branch's stamp lands only on a value that takes the branch. So a stamp credits
the floor in two cases: it lands on the written value, or the floor's own
branch names it, as a branch that both requires and stamps an atom does. A
stamp named by some other branch, which the value does not take, credits
nothing.

## A stamp held in a declared entry

An envelope can hold a stamp's atoms in a `declared` entry. Nothing tells such
an entry apart from a claim, so it keeps the declared component's discipline.
The runtime writes a stamp to the `minted` component only.
