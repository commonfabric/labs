# Input-witnessed `TransformedBy`

An exchange rule can release a value because endorsed code produced it: the
rule's integrity guard names the `TransformedBy` atom the flow stage mints when
every write in a transaction came from one verified implementation identity.
That atom says which code wrote the value and nothing about what the code was
given. Any caller can therefore choose what the endorsed code computes over. An
unendorsed derivation reshapes a secret into input the endorsed code accepts,
the endorsed code writes, and the rule releases the result. The worked case is a
sealed ballot whose release rule names the tally. A member's own code computes
"bit _k_ of Alice's sealed note" as a one-vote ballot, the endorsed tally counts
it, and the rule releases the count, one bit per run.

This document specifies the input witnesses the runtime retains on
`TransformedBy`, so that a rule can require that the endorsed code was fed by
specific code, and says what they do not cover. The mint lives in
`deriveFlowJoinImpl` and `observationInputWitnesses`
(`packages/runner/src/cfc/prepare.ts`) over the helpers in
`packages/runner/src/cfc/input-witness.ts`. The cases are in
`packages/runner/test/cfc-transformed-by-input-witness.test.ts`.

## What the specification asks for

Spec §8.9.3 gives the default transition's integrity as "`TransformedBy` with
handler code hash, input references, and any concrete input-integrity witnesses
the runtime elects to retain", and the §15 registry row reads
`inputs: Array<{ ref: Reference, witnesses?: Atom[] }>`. §4.5.1.1 names the
role: a witness-bearing computation atom records which trusted implementation
ran and which input evidence it verified, without claiming the output inherits
that evidence. §8.9.3 also permits a runtime to "summarize retained witnesses
conservatively … so long as they do not overstate what is true of the whole
output".

## What is minted

When the flow stage attributes a transaction to an identity, it mints:

- `TransformedBy{identity}`, the identity-only atom, as before; and
- one `TransformedBy{identity, inputWitness: W}` for each retained witness `W`.

A witness `W` is retained when every confidential input location the
transaction consumed carried it. It is a conservative summary in the sense
§8.9.3 permits: it states a universal fact about the inputs and nothing about
any single one. Each witness-bearing atom is a complete claim on its own —
"`identity` wrote this, and every confidential input it read carried `W`" — so
two of them conjoin soundly, and a rule matches one with the calculus's ordinary
subset record patterns.

Only the `TransformedBy` family is retained. It is the provenance family the
default transition never carries forward, so without a witness it says nothing
past the value it was minted on, and it is what a chain of endorsed transformers
needs. Hereditary atoms already survive through the meet, and another family
joins the retained set when a rule needs it.

A retained witness may itself carry an `inputWitness`, which is how a chain is
recorded: each endorsed step adds one level of nesting. Nesting stops at
`INPUT_WITNESS_MAX_DEPTH` (three); a deeper witness is dropped, which
under-claims.

### Confidential input locations

The inputs are the observations the flow join itself consumes
(`forEachFlowObservation`), so the witnesses quantify over the same reads whose
confidentiality the output carries. That includes trigger reads, and it
includes `followRef` observations: which reference sits at a slot is
information the transformation consumed, so a pointer counts as an input like
the value it points at. A label-metadata observation carries confidentiality
and no evidence, so it empties the witnesses. An external-content observation
contributes its flow integrity.

An observation that carries no confidentiality is a public input. It bears on
no release and does not constrain the witnesses, so an endorsed transformer may
read public configuration beside its committed inputs.

Within one observation the witnesses are what holds of the whole value read.
The read's effective label is a union: a recursive read joins every entry below
its path, so its integrity is evidence found somewhere in the value. Taking the
witness from that union would let a value written by one party vouch for a
neighbor written by another. The witnesses instead take the meet over the
read's confidential locations:

- A location is the read's own path and, for a recursive read, the path of each
  consumed entry below it. Any other position resolves exactly as its nearest
  enclosing location does, so these locations cover every position of the value.
- A location's integrity is its own resolution: per origin component, the most
  specific entry at or above it, joined across components. That is a claim
  about the value at that location.
- An entry's `*` segment applies at every location beneath it. A location's `*`
  stands for the children that have no entry of their own, so a concrete
  sibling's entry does not resolve there.
- A runtime-minted `*` template contributes no integrity. A template labels
  membership and slots rather than a written value; it still takes its place in
  replace-down, so the ancestor it shadows does not show through.

The redundant-entry collapse cannot hide an unattributed write from this. The
collapse removes a derived entry only when the resolution without it gains no
integrity (`isRedundantWithDeclared` in `prepare.ts`), so a location whose
writer was not the endorsed code never resolves to an endorsed ancestor's
witness.

## How a rule uses it

A rule that should release only what the tally computed over committed stances
names both steps:

```ts
// Shown for illustration only.
const releaseBallot = {
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: TRANSFORMED_BY,
      identity: { kind: "verified", moduleIdentity: M, symbol: "tallyBallot" },
      inputWitness: {
        type: TRANSFORMED_BY,
        identity: { kind: "verified", moduleIdentity: M, symbol: "commit" },
      },
    }],
  },
  post: { dropClause: true },
};
```

A rule pins as deep as the code it trusts. The commit step is endorsed code
too, and every value it writes carries its identity-only atom whatever it was
fed, so the one-level guard above trusts the commit step's inputs. A guard
that nests one more `inputWitness` (the commit step's own witness, such as the
submit step that wrote each stance) refuses a commit step fed crafted input.
The absence form `inputWitness: undefined` does not pin a chain: the
identity-only atom is always minted and satisfies it.

A rule guarded on the identity alone keeps matching the identity-only atom, so
existing rules release what they released before, laundered values included.
Moving a rule to the witnessed form is the rule author's change.

## What fails closed

Each of these refuses an honest release rather than admitting a crafted one:

- **An unattributed input.** `TransformedBy` is minted only when every write in
  the transaction came from one identity and the transaction's join is
  nonempty. A value written by a transaction that read nothing labeled carries
  no `TransformedBy`, so a transformation over it retains no witness. An
  endorsed writer whose inputs should be witnessed reads something labeled —
  for a collection, a root that carries its own clause — so its writes are
  attributed.
- **References.** A reference slot's label is the link's own (`LinkReference`
  provenance and the carried confidentiality), with no `TransformedBy`, so a
  transformation that reads a list of references retains no witness, whoever
  wrote the list. An endorsed transformer's committed input is a value, not a
  collection of references.
- **Structure-only stamps.** A written location whose only derived stamp is a
  membership or shape entry has no value evidence.

## What this does not cover

The first three items below release a secret under a witnessed guard, and each
was demonstrated against the runtime. A rule author relying on the witness has
to close them some other way. The first and third are closed by writer policies
on the witnessed inputs and on the endorsed output, and a release rule should
not rely on the witness without them.

- **Removals and membership changes by another writer.** The witness is about
  values written. Removing a path that never had an entry of its own leaves the
  label map unchanged, which lets a secret choose what the endorsed transformer
  counts. Declaring the committed documents `writeAuthorizedBy` the commit step
  confines every write to them, removals included, to that code. Emptying a
  container is the case structure stamps cover: since #8029 they carry the
  writing transaction's `TransformedBy`, so the emptied location resolves to the
  remover's stamp rather than to the committed value above it, and a remover
  other than the committed writer leaves no witness there.
- **The bottom of a chain trusts its caller.** Every endorsed step mints its
  identity-only atom whatever it was fed, so the innermost level a rule pins is
  satisfied by crafted input to that step. Retaining only `TransformedBy`
  witnesses means nothing below the innermost step can be pinned. What grounds
  a chain is evidence minted where data enters — a user's gesture on a trusted
  surface — which is proof-of-gesture work, and a family this design can
  retain once it exists.
- **Composition at the release gate.** The gate evaluates a rule once per
  consumed read over that read's effective label, whose integrity is the union
  described above. A document that holds the endorsed output at one path and a
  value written by other code at another satisfies the guard through the first
  and releases both, verbatim. The identity-only guard has the same exposure;
  the witness does not change it. An endorsed transformer whose output document
  nobody else can write (a writer policy again) is not exposed; a gate that
  evaluates integrity guards per consumed entry is the general fix.
- **Stance stuffing through an endorsed entry point.** Implementation identity
  is content-addressed, so any program that imports the endorsed module runs the
  same identity. A member can bind the submit step to a crafted event and
  commit a stance computed from another member's note. The stance is then
  witnessed exactly like an honest one. What separates the two is the event's
  provenance, which is the proof-of-gesture work, not this.
- **Selection among committed values.** A transformation fed a subset of
  honestly committed inputs computes over a choice. References are refused
  above; a selection made by endorsed code is that code's semantics.
- **Public parameters.** A public input does not constrain the witness, so a
  caller-chosen public parameter to the endorsed code (a filter, an index of
  whom to count) chooses what it computes over committed inputs. The witness
  attests where confidential inputs came from, not which function of them was
  computed; endorsed code must not take parameters that select among
  confidential values.
- **Addressing inputs by document.** The witnesses name the code that wrote an
  input, never the input's address. A rule is static module code and cannot
  name the documents a room creates at run time, and an address list would put
  every read path — data-dependent, and so itself a channel — into the label.
  The space an input lives in is not a discriminator either: a member writes in
  the room's space.

## Representation choices

The spec's `inputs: [{ ref, witnesses }]` would need a quantifier in the rule
calculus ("every input's witnesses contain one matching …"), which the atom
pattern calculus does not have: an array pattern matches elementwise at equal
length. It would also persist input references, the channel described above.
The summary form needs neither. It records exactly the universal claim a rule
asks about, as atoms the existing subset matching reads, and the label-field
classification's walk applies to a nested witness as it does to any atom, so a
cross-space persist commits its `identity.sourceFile` and `bindingPath` like the
outer atom's.

Minting the witnesses as separate atoms rather than a set-valued field on one
atom keeps rule matching unchanged. The identity-only atom stays byte-identical,
so the stored label of a transformation whose confidential inputs carried no
`TransformedBy` does not change.

Any other attributed transformation stores more than before: one atom per
retained witness beside the identity-only atom, platform-wide and not only where
a rule asks for a witness. `INPUT_WITNESS_MAX_DEPTH` bounds the nesting, so a
chain of endorsed steps, a handler that reads its own output, or a ring of
handlers each reading the previous one's output settles at four `TransformedBy`
atoms per stamp (nesting depths zero to three). Measured on the test harness,
that stamp's label map grows from 582 to 2,049 bytes and stops there, within
five runs of each handler. The count grows past four only when one input
location's resolution joins several entries that each carry `TransformedBy`
(entries from several components, or tied entries). When no location joins more
than _s_ of them, a stamp carries at most 1 + _s_ + _s_² + _s_³ `TransformedBy`
atoms.
