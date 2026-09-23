---
status: historical
created: 2026-09-23
archived: 2026-09-23
reason: "Record of the deliberate contract break taken when the Loom root's Panel gained an optional addedBy DID, which the pattern-update gate reads as a narrowed union branch."
---

# Loom: a panel's `addedBy` is an optional field the update gate cannot prove

`loom/schemas.tsx` gave each kind of `Panel` (`piece`, `document`, `url`) an
optional `addedBy?: string`: the DID of the person who added the occurrence.
It is plan item 2 of loom's socialized-Loom-panels proposal
(commonfabric/loom#6458, §2 and §7): each participant's daemon writes its own
principal there when it publishes a panel, and the loom reconciler reads it to
attribute synchronized changes and to decide whether a removal retracts the
panel for everyone or hides it for one person. A panel without the field is
attributed to the Loom's owner. `addPanel`, `addPiece`, and `duplicatePanel`
refuse an `addedBy` that is not a DID, and `addPiece` and `duplicatePanel` take
one in their events. The root's own buttons pass no `addedBy` yet, so the panels they
add or duplicate are attributed to the owner until a follow-up has the root's
handlers link the profile under which the person is acting.

Against both recorded baselines of `loom/main.tsx` the pattern-update proof
reports `argument.panels[]: a schema alternative accepted previously is not
accepted by the candidate`. `Panel` compiles to an `anyOf` of three open
objects. Outside a union the proof admits a new optional property on an open
argument object under its evolution allowance; each union branch is proved as
a conjunction, where that allowance is off, so the branch reads as narrowed:
the baseline's open branch admitted `addedBy` of any type, and the candidate's
admits only a string.

## Why this could not be done compatibly

The string-typed `addedBy` is the only change in this item that the gate
refuses. Typed `addedBy?: unknown` on every branch instead, it produces no
finding over either baseline; that shape was rejected on its merits. The field would lose its type in every consumer
of `Panel`, and the schema would no longer say what the handlers enforce and
what the reconciler relies on. Extending the proof's evolution allowance to
union branches is a change to the gate, not to this pattern.

## What the break costs

Nothing deployed holds state under the old shape that the new one refuses. No
writer has ever stored `addedBy` on a panel: the root's own handlers built
panels without it, and loom's `publishProjection` writes only `kind`,
`titleOverride`, `url`, `piece`, and `content`. A stored panel without the
field validates against the candidate, where the property is optional. The
break is a statement about the proof, not about a deployed piece.

A shared Loom's root is not one of the patterns that update automatically,
so existing roots keep their source until someone replaces it; replacing it
with `cf piece setsrc` meets the same refusal and needs
`--dangerously-allow-incompatible-schema`. A root on the old source does not
validate `addedBy`.

The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives exactly the
two `(loom/main.tsx, baseline)` pairs on the one path the proof names, and the
contract recorded once this ships is a new baseline no entry names, so the
next change to the Loom root is gated again against the shape the break left
behind.
