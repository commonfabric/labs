# Direct CFC Exchange Rules

This demo is the canonical copyable form for a module-authored direct policy:

1. Export each static `exchangeRule(...)` declaration.
2. Export one `exchangeRules([...])` set that owns each rule exactly once.
3. Apply it with `Confidential<T, [PolicyOf<typeof rules>]>`.

`cfcPattern` constructs match patterns and may contain `v(...)` or
`THIS_POLICY.subject`. `cfcAtom` constructs concrete runtime atoms; the two
surfaces are intentionally separate.

`blessed-computation.tsx` releases the output of one function defined in the
policy's own module. When every write of a transaction comes from one verified
function, the runtime mints a `TransformedBy` atom naming that function's module
and export name onto what it writes, and the rule matches it with
`moduleIdentity: THIS_POLICY.moduleIdentity`, which binds to the defining
module's identity at evaluation time. Another function of the same module, a
handler copying a raw input, or a different version of the module does not
satisfy the rule. `blessed-object.tsx` does the same for a function returning an
object, whose object node is released along with its fields.

A rule like these, with no sink, path or grant scope and guarded only by
integrity bound to the value it releases, is value-intrinsic. Under the
runtime's default posture, policy evaluation at `enforce` with flow labels
persisted, its release carries onto what is computed from the released value: a
`computed()` over it, a `.map()` over a list in it, and a store a handler copies
it into each carry the released label. A value that also reads a sealed input
keeps that input's clause, and so does a value whose first write read one: the
record of when it came to exist is frozen at its creation, and the evidence the
rule needs sits on the released value, not on what was derived from it. A rule
scoped to a sink or guarded on a grant releases only at the boundary it was
evaluated for, and nothing derived carries it.

`custody-answer-room.tsx` is a room whose members seal their stances into the
policy's custody through the host's `cf-custody-seal`, and whose policy releases
only what its projector computes over the sealed box, one of the listed answers,
and only to the seal, when everything confidential the projector read was
written by the seal (`TransformedBy{builtin cfc-custody-seal}` as the rule's
input witness). It shows the pattern side of the
[custody seal](../../../docs/specs/cfc-custody-seal.md): seats named by attested
cells, the policy read from a declaring cell's label, the box link the seal
writes into the room, and the answer the seal publishes once per instance
through `cf-custody-answer`, which the room renders instead of its reactive
projection. The seal publishes only once every seat has sealed, when every rule
of the room's policy requires the seal's witness and releases only to the seal,
and a rule of that policy releases the answer to the seal. No member reads the
projection itself: the seal declassifies it once per instance into the answer
slot, so the answer published for an instance never changes. The component finds
that slot through the room's `terms` and `policy`, which a member's own code can
repoint at another instance; the claims naming `propose` on the room's arguments
are defense in depth, and the spec says what they leave open.

`custody-projector.tsx` is the same room, demo-grade: its rule names the
projector alone rather than requiring the seal's input witness, and it renders
its reactive projection. Under that rule a member's own code can feed the
projector a crafted box and learn another member's entry from the answers, and
the host publishes no answer for it. It is kept as recorded because the rule is
part of the policy its `policy` cell declares, so changing the rule would change
the policy a room of it already sealed under.

`witnessed-chain.tsx` narrows the tally rule with an `inputWitness`: it releases
the tally only when every confidential location the tally read was written by
the module's `commit` step, and every one `commit` read was written by its
`submit` step. Public inputs do not constrain the witness, so it does not prove
that every value the tally read came from `commit`. A relay between the two, a
vote planted beside the committed ones, a vote list written by other code, and a
brief other code added before `commit` ran are refused, though the tally's own
identity would release each of them. The briefs are objects in a list, which the
runtime stores behind references, and a reference `submit` stored carries its
stamp as the object does. `submit` is attributed only when its transaction reads
something labeled: storing a pushed brief reads the document holding the list,
which here holds the committed input's default. Without that default its first
write carries no stamp, and the second level releases nothing.
`docs/specs/cfc-transformed-by-input-witnesses.md` says what the witness covers
and what it does not.

The compiler binds `PolicyOf` to the defining module export and a canonical
manifest digest. At label creation the runtime binds the concrete owning space
as the policy subject and requires that exact manifest to be installed in the
destination. Missing or mismatched manifests fail closed.

The rule can rewrite only the clause containing its exact module-policy
reference. Sibling and input-derived clauses remain conjunctive and untouched.
`imported-policy.tsx` demonstrates that importing the ruleset retains the
identity of `direct-release.tsx`; a pinned `cf:pattern:<identity>` import
follows the same defining-identity rule.

Multiple entries in `Confidential<T, [PolicyOf<A>, PolicyOf<B>]>` are separate
conjunctive clauses: both must release. Spell a deliberate weakening as
`Confidential<T, [AnyOf<[PolicyOf<A>, PolicyOf<B>]>]>`; this creates one
disjunctive clause where either policy is sufficient. `AnyOf` still uses the
runtime's authored-OR validation and cannot contain forbidden expiry or caveat
alternatives.

Run:

```sh
deno task cf check packages/patterns/cfc-exchange-rules/direct-release.tsx --show-transformed --no-run
deno task cf test packages/patterns/cfc-exchange-rules/direct-release.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/blessed-computation.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/blessed-object.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/custody-projector.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/custody-answer-room.test.tsx
deno task cf test packages/patterns/cfc-exchange-rules/witnessed-chain.test.tsx
```
