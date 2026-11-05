---
status: historical
created: 2026-10-02
archived: 2026-10-02
reason: "Record of the deliberate contract break taken when the Loom root's Panel addedBy became the runtime-attested adder, written only by admitPanel from the principal its event acted for, which the pattern-update gate reads as a narrowed union branch and a removed event field."
---

# Loom: a panel's `addedBy` becomes the attested adder

`loom/schemas.tsx` changed the type of each `Panel` kind's optional `addedBy`
from a string to `PanelAdderDid`, defined in `loom/admission.tsx` as
`AuthoredByCurrentUser<WriteAuthorizedBy<string, typeof admitPanel>>`.
`admitPanel` writes it on every occurrence it creates without `as`: the value is
the principal its event acted for, as `currentPrincipal()` returns it, and the
runtime stores an `authored-by` entry for the same principal at
`["addedBy"]`. The admission event lost its `addedBy`, so no caller names the
adder any more, and only `admitPanel` may write the field once the root has
written it. `addPanel` without `as` refuses an occurrence whose `addedBy` label
names a principal other than the one its event acts for, as it already refused
one that names a profile.

The adder was a claim until then, and its only writer outside the daemons was
whoever sent the event: Common Fabric's piece registration sent `{ piece }`
alone, so every panel it registered named no adder. Loom's reconciler treats
such a panel as anyone's to retract for everyone
([loom's socialized-panels proposal](https://github.com/commonfabric/loom/blob/main/docs/development/proposals/socialized-loom-panels.md),
§4). commonfabric/labs
#8428 proposed having the registering host put `addedBy` in the event. Its
review found three runtime primitives, all newer than the root's attribution
design, that let the root record the adder itself: `currentPrincipal()`
(commonfabric/labs #8279), `authored-by` labels from a declared writer without
a gesture (commonfabric/labs #8336), and `principalOf()` (commonfabric/labs
#8310). With them, every path that adds a panel, a pattern's own handler
included, is attributed without anything in the event, and the record is the
runtime's label rather than a claim. Gideon chose that design on 2026-10-02.

## What the gate reports

Against `20260924T085224Z-oEtBQ4AVdy1fMTAB`, the baseline that carries
`addedByProfile`, the pattern-update proof reports
`argument.panels[]: a schema alternative accepted previously is not accepted by
the candidate` and `result.addPanel.addedBy: existing result field was
removed`. Against `20260923T232217Z-9unt7nppL26FihSK` it reports the same
`argument.panels[]` finding and
`result.addPanel.before: a schema alternative accepted previously is not
accepted by the candidate`.

The `argument.panels[]` finding is the one `addedBy` and `addedByProfile` each
produced when they were added: `Panel` compiles to an `anyOf` of three open
objects, the proof does not apply its evolution allowance inside a union
branch, and a branch whose `addedBy` gained a write contract and a label reads
as narrowed. The result role names `before` over the older baseline because the
narrowed `Panel` is also the type of `before` in `addPanel`'s event, and names
the removed `addedBy` over the newer one. The proof reports at most one issue
per role, so both result-role causes are present against both baselines; each
entry names the one the proof reports.

Over `20260923T232217Z-9unt7nppL26FihSK` the pair already failed on
`argument.panels[]` for `addedByProfile`, which an earlier entry forgave. That
entry named no result path, so it forgave nothing once this change added one,
and the gate required it removed. The entry for this change names both paths
over that baseline and so covers the earlier break as well.

## Why this could not be done compatibly

The type is the mechanism, as it is for `addedByProfile`: the write contract
and the label live in the field's schema, and a field the gate accepts would
carry neither. Recording the adder in a new field instead of `addedBy` would
leave `addedBy` a claim that callers and older daemons write, beside an
attested field that says the same thing, and readers would have two adders to
reconcile. Keeping `addedBy` in the event, unread, would not avoid the
result-role finding, which the narrowed `Panel` causes on its own, and would
describe an input the root ignores.

## What the break costs

A stored panel that holds an `addedBy` string validates against the candidate,
where the field stays optional and a string. What changes for it is who may
write it next: a write from any handler but `admitPanel` is refused once the
root has written the panel. An occurrence a caller made keeps whatever `addedBy`
it holds when `addPanel` links it, and the label entry there, if the run that
wrote it minted one, names that writer rather than whomever the value names.

A caller that sent `addedBy` in an admission event is no longer refused for a
malformed one; the field is not part of the event, and the root records the
principal the event acted for in its place. A shared Loom's root records its
origin as `system:loom/main.tsx` and follows it when the Loom is opened, so a
root on the older source changes behavior once someone opens it after the host
serves this one. Loom was internal and pre-launch when this shipped, and Gideon
judged that acceptable.

The two entries in `tasks/pattern-compat-accepted-breaks.ts` forgive exactly the
`(loom/main.tsx, baseline)` pairs and paths above. The contract recorded once
this ships is a new baseline no entry names, so the next change to the Loom root
is gated again against the shape this break leaves behind.
