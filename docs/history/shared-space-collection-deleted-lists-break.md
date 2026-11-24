---
status: historical
created: 2026-11-03
archived: 2026-11-03
reason: "Record of the deliberate contract break taken when Home's shared-space collection view gained optional deleted lists, which the pattern-update gate reads as a narrowed union branch."
---

# Home: the collection view's `deleted` lists are optional fields the update gate cannot prove

`shared-space-interface.ts` gave the collection view, and each kind's view
inside it, a `deleted` list beside `saved`, `archived` and `other`: the entries
whose space is deleted, which `markDeleted` moves to the `deleted` state
([`shared-space-catalog.md`](../features/shared-space-catalog.md#deleted-spaces)).
The list is optional in both views, because a view a Home older than the list
produced has none, and the host projections in `@commonfabric/home-schemas`
say the same. A reader takes its absence as empty; the collection renders
`view.deleted ?? []` under its **Deleted** choice.

Against the one recorded baseline of `shared-space/shared-space-collection.tsx`
the pattern-update proof reports `argument.view: a schema alternative accepted
previously is not accepted by the candidate`. The view compiles to an `anyOf`
of the unavailable object and the ready object. Outside a union the proof
admits a new optional property on an open argument object under its evolution
allowance; each union branch is proved as a conjunction, where that allowance
is off, so the ready branch reads as narrowed: the baseline's open branch
admitted `deleted` of any type, and the candidate's admits only a list of
entries. The Loom root's `addedBy` met the same refusal
([`loom-panel-added-by-break.md`](loom-panel-added-by-break.md)).

## Why this could not be done compatibly

The typed list is the only change in the view the gate refuses. Typed
`deleted?: unknown`, it produces no finding, and that shape was rejected on
its merits: every reader of the view would lose the list's type, and the
schema would no longer say what the collection renders. Extending the proof's
evolution allowance to union branches is a change to the gate, not to this
pattern.

## What the break costs

Nothing deployed holds a view under the old shape that the new one refuses.
The view is what Home computes, and Home and its collection update together;
no writer has ever stored a `deleted` of another type, and a view without the
list validates against the candidate, where the property is optional. The
break is a statement about the proof, not about a deployed piece.

The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives exactly the
one `(shared-space-collection.tsx, baseline)` pair on the one path the proof
names, and the contract recorded once this ships is a new baseline no entry
names, so the next change to the collection is gated again against the shape
the break left behind.
