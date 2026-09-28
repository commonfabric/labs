---
status: historical
created: 2026-09-27
archived: 2026-09-27
reason: "Record of the deliberate contract break taken when the witnessed-chain demo's release rule began pinning the submit step beneath commit."
---

# Witnessed chain: the rule pins two levels

`cfc-exchange-rules/witnessed-chain.tsx` is the demo the input-witness spec
points at: a tally released only when everything it read was written by the
module's `commit` step. Its rule could not pin a second level, `commit`'s own
inputs written by `submit`, because the briefs `commit` reads are objects in a
list, which the runtime stores as entity documents behind references, and a
reference retained no witness. Once a reference the writer supplied through
anchoring carried the writer's stamp, and a followed reference became an input
location of its own, the second level released the honest chain and refused a
brief other code added. The demo moved to that rule, and gained the
`plantBrief` handler and `plant` stream that exercise the refusal.

The rule is part of the policy the module declares, and that policy is keyed
by the module's identity, a hash of the file's bytes. Its digest changed, and
with it the `ifc` of `argument.briefs[]`, which declares the policy on each
brief. The update proof reads that as an incompatible label change against the
baseline recorded before it, and no pattern change can satisfy it: the new
digest is the change. Any edit to the file would have done the same. A piece
of the old demo keeps its briefs under the old policy, which its own module
still releases.

The demo holds no member data, and nothing but its tests holds a piece of it,
so the break was accepted rather than kept behind a second pattern.
