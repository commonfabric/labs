---
status: historical
created: 2026-09-27
archived: 2026-09-27
reason: "Record of the deliberate contract break taken when the custody projector example moved its release rule to the seal's input witness and began publishing its answer once per instance."
---

# Custody projector: the witnessed rule and the published answer

`cfc-exchange-rules/custody-projector.tsx` is the example room for sealed
custody. Its release rule named the projector by identity alone, which let a
member's own code point the room's box at a record of its own and learn
another member's stance one released answer at a time. Two changes made the
witnessed form of the rule work from a pattern: the seal writes the room's box
link itself, and a reference the projector follows to confidential content is
an input of the witness. With those in place the example moved to the rule it
was always meant to take, requiring `TransformedBy{builtin cfc-custody-seal}`
as the projector's input witness.

The rule is part of the policy the room's `policy` cell declares, so the
policy's digest changed, and with it the `ifc` of `argument.policy` and
`result.policy`. The update proof reads that as an incompatible label change
against the baseline recorded before it, and no pattern change can satisfy it:
the new digest is the change. A piece of the old room keeps its sealed values
under the old policy, which its own module still releases.

The same change moved what the room shows from its reactive projection to
`cf-custody-answer`, which shows the answer the seal publishes once per
instance into a create-only slot. That changes the room's view, not its
argument or result.

The example is demo code, and nothing but the integration test holds a room of
it, so the break was accepted rather than kept behind a second policy.
