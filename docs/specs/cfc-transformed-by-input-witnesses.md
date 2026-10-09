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
`packages/runner/test/cfc-transformed-by-input-witness.test.ts`, and, run as
compiled patterns, in
`packages/runner/test/cfc-transformed-by-input-witness-compiled.test.ts`,
`packages/runner/test/cfc-transformed-by-input-witness-references.test.ts` and
`packages/patterns/cfc-exchange-rules/witnessed-chain.test.tsx`.

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
- A shallow read resolves its location's integrity over the entries a value
  read of that location consumes, less the runtime's concrete existence stamps.
  Which locations are confidential still comes from the entries the read itself
  consumed. A shallow read observes a function of the value stored at its path
  (presence, type, and for a container its keys or length), and the value stamp
  records who wrote that value. The shape class a shallow read consumes holds
  only existence stamps, which never carry integrity. Compiled code reads its
  arguments through the schema traversal, which makes one shallow read per node,
  scalar leaves included. Without this rule no such read would carry a witness.
  A recursive read drops the existence stamps too. An existence stamp is carried through every overwrite of its path, so left in
  it would shadow the value stamp of a later whole write above it.
- A reference probe (`followRef`) keeps its own entries. A pointer's link
  entry is the link write's, with no `TransformedBy`, so a probe that observes
  which reference sits at a slot without reading the slot retains no witness.
  A probe of a slot that holds no reference finds the value stored there, so
  it resolves its location as a shallow read of the slot does, unless the
  transaction wrote at, above or beneath the slot.
  A read of the slot itself resolves the slot's value stamp, which is where a
  reference the writer supplied carries its writer (see "References the
  writer supplied" below). A reference followed
  to confidential content is a location of its own, below, and so is a
  followed reference whose own slot is confidential: the probe of a followed
  slot contributes its confidentiality to the join and leaves its witnesses
  to that location.

### References a transformation follows

Which reference sits at a slot decides which document a reader reads, so a
transformation that follows a reference to confidential content consumed the
reference as an input, whatever the slot holding it is labeled. Such a slot is
a location of its own: its integrity is resolved over the value stamps at the
slot, as a shallow read of it is, and it counts even when nothing labels the
slot. So is a slot whose reference leads to another such slot. A reference
counts when the transformation read the slot, or read recursively above it,
and read the document it names at or below its target with confidentiality. A
reference also counts when the transformation followed it and the label of
its slot is confidential, whatever the document it names carries: a secret
choice among public documents is a confidential input. Such a slot that no
content read observed has no value stamp to resolve, and empties the
witnesses. A
write redirect counts like any other reference: pattern code can store one as
data, and a read follows it as it follows any other. A transformation that read
nothing confidential has no such location to account for.

A reference a link write put in place carries no value stamp of its own, so a
slot holding one retains no witness unless its writer's stamp covers it. A
destination whose value holds a reference is stamped whole only when the
runtime recorded that reference as the writer's, at that path
(`CfcAssertedValueRoot.reference`). Anchoring records the references it stores
for a list of objects this way ("References the writer supplied", below), and
the custody seal records the link it writes into a room's box cell this way
([sealed custody](cfc-custody-seal.md)).

Without this, a document a transformation read only to find its inputs would
constrain nothing when unlabeled. A member's code could hand an endorsed
transformer a record of its own whose entries are references to real, witnessed
values, one of them repeated, and the witness, taken over the values alone,
would hold.

### What the endorsed writer's stamp covers

Pattern code writes through the diff, which writes only the paths whose stored
value changed, and writes a new container empty before it fills it. Stamped
path by path, a container a `Default` put in place keeps no writer at all, and a
container the diff created empty reads as pure link structure, which takes
membership stamps and `*` templates rather than the value stamp. The witness
needs the endorsed writer's stamp at every location its output occupies, so the
destination of a `Cell.set` is stamped as written (`CfcTxState.assertedValueRoots`,
recorded only under the runtime's authorization). The per-value entries beneath
it are replaced and any overlapping stamp's attribution is withdrawn, as for
any write at that path. After the write every position beneath the destination
holds the value the writer supplied, a container a `Default` put there
included. A destination qualifies only when all of these hold:

- the `set` wrote, and wrote beneath it, so a set that wrote nothing or threw
  part way asserts nothing;
- its join mints `TransformedBy` for the identity that made the `set`;
- no reference sits anywhere in its final value, because a pointer the diff
  found in place, such as a write redirect it writes through, is not one the
  writer supplied;
- the join fits every ceiling declared at or beneath it;
- the transaction created the destination, or read no content at or beneath
  it, nor recursively above it. A writer that read its destination can carry a
  value it found there into what it sets, and the diff leaves that value in
  place. The diff's own reads of the destination, and the reference probe that
  resolves it, do not count, nor does a shallow read above it, which observes
  keys rather than the value. Only a direct read of the destination counts: a
  value that reaches the set through a copy of the destination in another
  document is the writer's input like any other (see "A one-level guard trusts
  every input the endorsed step read" below).

A peer that adds a member beneath the destination after the writer read its
replica makes the writer's commit a conflict, so the retry sets over the
member rather than stamping it.

Other destinations keep the stamps the diff's own writes get. Collection
operations (`push`, `addUnique`, `removeByValue`, `increment`) record no
destination of their own: they carry existing members through without the
writer's code consuming them. An object they add is anchored like any other,
below.

The redundant-entry collapse cannot hide an unattributed write from this. The
collapse removes a derived entry only when the resolution without it gains no
integrity (`isRedundantWithDeclared` in `prepare.ts`), so a location whose
writer was not the endorsed code never resolves to an endorsed ancestor's
witness.

## References the writer supplied

Pattern code that puts a plain object in an array does not store it inline.
The diff anchors it: it writes the object into an entity document of its own,
at an id the runtime derives, and stores a reference to that document at the
object's slot (`anchorValueAsEntity` in
`packages/runner/src/data-updating.ts`). A list of objects is a list of
references, and a reader reaches each object in two steps: it reads the slot,
then the entity the reference names.

Anchoring records both halves as whole-value destinations: the entity's root,
and the slot, with the entity as its reference. Each is stamped as written
under the conditions above, and a destination's final value may hold a
reference only where anchoring stored it: at that exact slot, naming that
entity's root, and not a write redirect. So:

- the entity's root carries the writer's stamp, as the object's own position
  would had it been stored inline;
- the slot carries it too, as a value stamp beside its link entry, so a read
  of the slot resolves the writer that chose that object for that position;
  and
- a `Cell.set` destination whose value holds such references, a record
  holding a list of objects, say, is stamped whole.

A slot's stamp says who stored the reference there and nothing about what it
refers to. A reader that follows it reads the entity as well, and each
location it reads there is a confidential input location of its own, resolved
over the entity's own stamps. A witness holds only when the slot and every
location read behind it carried it, which is what refuses each of these:

- an element whose entity another writer rewrote after the reference was
  stored: the rewritten location resolves to that writer's stamp;
- a slot other code pointed elsewhere, at a document it wrote or at an object
  the endorsed step stored in another list: the link write replaces the slot's
  stamp, and a reference anchoring did not store earns none, so the slot
  resolves to no writer; and
- an object other code pushed into the list, or a list it wrote whole: those
  slots and entities carry that code's stamp; and
- a list other code truncated, dropping members from its end so that every
  member left keeps its slot and its stamp: a read that stops at a container
  observes its membership, and a list's `length` is a value stamped by
  whoever last changed it, so the value stamps at `length` are a location of
  that read (a record's key named `length` is read the same way, which can
  only withhold a witness).

A step that copies references rather than values, setting its output to the
list it was handed, stores references to entities another step wrote. Those
references are not ones anchoring stored, so the step's output carries no
stamp at them, and a guard pinning the step refuses. An endorsed step whose
output a rule pins copies the objects' values, which anchoring stores afresh.

The id an anchored entity takes depends on how far arrays enclose its slot:
the element of an array takes the array's position as its context rather
than its index. Within what the diff writes, that is read from the value
written (`DiffWalkState.writtenKinds`), not from what the position held
before; only an ancestor above the write is read from storage. A step that
sets a list of objects would otherwise read the list it replaces, a
confidential input its previous writer stamped, and no chain through it could
carry a witness. It also gives a fresh array's elements the ids a stored
array's elements take.

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
  endorsed writer whose inputs should be witnessed reads something labeled,
  so its writes are attributed. For the first member of a list whose clause is
  on its members (below), the empty list is not that.
- **References the writer did not supply.** A reference stored any way other
  than by anchoring an object the writer put in an array — a cell set into a
  slot, a reference copied from another list — earns its slot no value stamp,
  and its link entry (`LinkReference` provenance and the carried
  confidentiality) has no `TransformedBy`. A transformation that reads such a
  slot retains no witness, whoever wrote it. So does a standalone reference
  probe, which consumes the link entry alone.
- **A list whose own node is confidential, grown by collection operations.** A
  `push` adds a member without writing the list as a whole, so the list's node
  keeps whatever labeled it before. A list the runtime's setup wrote from a
  `Default` has no writer there, and one other writers have pushed to has
  theirs; either way a witness over what reads the list is empty, since
  reading the list reads its node. Declaring the clause on the members,
  `Confidential<T, …>[]` rather than `Confidential<T[], …>`, leaves the node
  itself unlabeled, so it constrains no witness, while each member carries its
  clause and its writer's stamp. A list an endorsed step sets whole is
  stamped whole, as above.
- **An entity made of references alone, under a clause declared above its
  array.** An entity holding only references, the object of a list of objects
  that sits in a list of objects, has no scalar the diff stamps, so only its
  whole-value stamp gives its root a writer. That stamp needs the writer's
  join to fit the entity's declared ceiling, and a clause declared above the
  array the entity was anchored from does not reach the entity's own schema.
  Declaring the clause on the members of each list of objects gives each
  entity its ceiling.
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
- **A one-level guard trusts every input the endorsed step read.** The
  innermost step a rule pins stamps whatever it writes as its own, so a value it
  took from an input another writer crafted passes as its output, whether it
  read that input directly or through any copy derived from it. The skip for a
  step that read its own destination catches only a direct read of that
  destination, at or beneath it or recursively above it; it is not a
  protection against crafted input. Where other code copies the committed
  document into a mirror and the step appends to what it reads from the
  mirror, the crafted vote arrives through a set whose destination the step
  never read, the destination is stamped whole, and a one-level guard
  releases it (pinned in `cfc-transformed-by-input-witness.test.ts`). A rule
  that must not trust the step's inputs pins one more level, which needs the
  step's inputs to carry their writer's stamp too. A list of objects does,
  through its references
  (`cfc-transformed-by-input-witness-references.test.ts`).
- **An output that does not change.** A stamp is replaced when its value is
  written. When an endorsed transformer runs again over inputs other code
  chose and computes the value it had already written, it writes nothing, and
  the value keeps the stamp its earlier run earned. Whoever chose the inputs
  learns whether they yield the value already released, one comparison per
  run.
- **Selection among committed values.** A transformation fed a subset of
  honestly committed inputs computes over a choice. A reference other code
  stored is refused above; a selection made by endorsed code is that code's
  semantics.
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
