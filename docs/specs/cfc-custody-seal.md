# Sealed custody

A person can release something derived from their own data without releasing
the data itself, if they trust the code that does the deriving. The custody seal
is the host operation that makes that concrete. The actor reviews a value that
is entirely their own, and the host copies it into the custody of a policy
module `P` that the actor's trust configuration names as a trusted declassifier.
After the seal, the only way anything derived from the value leaves is through
`P`'s own release rules. Those rules can require, through the input witness on
`TransformedBy` ([input witnesses](cfc-transformed-by-input-witnesses.md)), that
everything confidential the releasing code read was written by the seal.

This is the spec's multi-party consent release through an endorsed transformer
(§5.3.4, §13.3), with consent given once per value at a trusted gesture. The
host module is `packages/runner/src/cfc/custody-seal.ts`, exported to hosts as
`@commonfabric/runner/cfc/custody-seal` and absent from pattern imports, the
same arrangement as [reviewed snapshot copies](cfc-persisted-declassification.md#31-reviewed-snapshot-copies).
The cases are in `packages/runner/test/cfc-custody-seal.test.ts`.

## The operation

`prepareCustodySeal(draft, room, options)` inspects the draft and the room and
returns a preview together with a one-use consent. `commitCustodySeal(consent,
event)` performs the seal. It accepts only a renderer-trusted DOM event whose
`provenance.ui.pattern` is `CustodySeal`, and it inspects everything again
before writing.

A room is its terms document and its policy. The terms document's space is the
room space `S`. The terms are a JSON object that names `seats`, the DIDs that may
seal, and `stanceSchema`, the schema every sealed value satisfies. Everything
else in the terms is shown to the actor and sealed with the value. One instance
of a room is `(P, D)`, where `D` is the digest of the terms.

## What the seal checks

Each check runs at prepare and runs again at commit. At commit, the reads that
established the checks are compared against the committing transaction.

- **Every clause of the draft's label is the actor's own.** Each alternative of
  each clause must be one of six shapes: a bare DID equal to the actor;
  `User{subject}`; `Context{name, subject}`; `Resource{class, subject}`;
  `Space{id}`; or `PersonalSpace{owner}`. The subject, `id`, or `owner` must
  equal the acting principal exactly, and each shape is matched on its exact
  key set. The two space shapes admit only the actor's home space, the space
  whose DID is the actor's own, which is where a draft written at home is
  labeled; a `Space` naming any other DID is refused, whether it is the room
  or another member's home. A `Context` that carries a `hash` is a named policy
  reference, and an atom with any other extra field (a `scope`, a `role`) also
  belongs to someone else's policy, so neither counts as the actor's. The seal
  refuses:
  - a clause holding any other alternative;
  - an empty clause, which no one can read and which sealing would open;
  - a clause carrying a `Caveat`. The caveat has to be discharged before the
    seal, for example by instruction-inert structured generation.

  When an owner-shaped alternative names another DID, the refusal names both
  DIDs. That makes a stance labeled under a rotated key diagnosable: the seal
  never accepts an alternate or mapped DID.
- **The sources are allowed.** The host must supply `allowedSources`, which it
  reads from the actor's private settings, and every `Context` and `Resource`
  the draft draws on must be among them. An empty list admits only a value
  labeled for the actor alone, as a value the actor typed in is. The preview
  lists these sources.
- **The value is instruction-inert.** `stanceSchema` may admit only booleans,
  `null`, numbers with a finite `minimum` and `maximum`, `const` and `enum`
  primitives, and closed objects of these, at most eight levels deep. It admits
  no free strings and no arrays, including in a property the value leaves out.
  The value must satisfy the schema.
- **The actor holds a seat** in the terms.
- **The terms carry nothing the room's readers lack.** Every clause of the
  terms document's label must admit `Space(S)` or `P`, because the terms are
  copied into each entry.
- **The policy is the room's.** `P` must be an exact module policy reference
  whose subject is `S`, and its manifest must be installed in `S`.
- **The actor trusts `P`.** Under the actor's trust closure, `P` must satisfy
  the concept `https://commonfabric.org/cfc/concepts/trusted-declassifier`. The
  closure is built from `RuntimeOptions.cfcTrustConfig`, and only from the
  statements whose pattern names `P`'s exact `policyDigest`. A manifest's
  `moduleIdentity` and `symbol` are written by its author, so a statement that
  leaves the digest open would be met by any manifest that copies them.
- **The actor has not sealed this instance.**

## What the seal writes

A transaction writes one space, so the seal commits more than once. First, if
the instance has no anchor yet (see [Attribution](#attribution)), the seal
creates it, so a seal that cannot establish one has written nothing durable.
Then:

1. **A receipt in the actor's home space.** It is labeled `User(actor)` and
   records the event, `P`, `D`, the entry key, the sources, and the stance's
   digest. The receipt is written first, so every entry has one. A receipt
   whose entry is absent records a seal that did not commit, or an entry lost
   afterwards, as when the box is replaced (see below).
2. **An entry in the instance's box.** The box is one document in `S` at the
   address `{custodyBox: {policy: P, instance: D}}`. The entry is
   `{instance: D, terms, stance}`. `terms` is the terms serialized as JSON with
   sorted keys, so that a consumer can compare entries byte for byte. Every
   seal of an instance writes this one document, so concurrent seals by
   different actors conflict. The entry transaction retries a conflict,
   running every check again against the state that won, including whether
   this actor's entry now exists.

Each entry declares the confidentiality `[P]`. The box root's own label is the
anchor's clause, `P ∨ Space(S)`, which the seal's read carries there when it
creates the box; so the box's key set, and with it the number of seals, is
readable by the room's readers. The box is `writeAuthorizedBy` the builtin
identity `cfc-custody-seal`, and each entry repeats that claim with no `type`. A
claim whose schema names a type governs only writes of values of that type, and
a claim on the root alone does not reach writes below it.

### Attribution

`TransformedBy` is minted only over a nonempty flow join. The sealing
transaction reads the draft and the terms through verifier reads, so their
clauses do not reach the entry. Its one labeled read is the instance's
**anchor**: a seal-written constant at `{custodyAnchor: {policy: P, instance:
D}}`, labeled `P ∨ Space(S)`. The anchor is created in a transaction of its own
the first time it is needed, written only where absent. It carries no
create-only mark: two first seals that race to create it write the same
constant, and the loser's retry finds the winner's anchor. The read makes every
location the seal writes carry `TransformedBy{builtin cfc-custody-seal}`, the
root included when the seal creates the box. The anchor's clause fits the room
space's residency ceiling, and on an entry it sits beside the entry's declared
`[P]`, which still bounds who reads the entry.

Anyone who can read the terms can compute both addresses, so the seal refuses a
box whose root the seal did not write, and an anchor whose value is not the
seal's constant or whose label is not exactly `P ∨ Space(S)` with no integrity.
An anchor holding a link would otherwise carry its target's clauses into every
entry, and integrity on the anchor would reach every entry's label. The anchor
is checked before the receipt is written, so a squatted anchor leaves nothing
durable.

The consequence is the property a release rule relies on. A transformation that
reads the whole box mints
`TransformedBy{identity, inputWitness: TransformedBy{builtin cfc-custody-seal}}`.
A transformation that also reads one confidential value the seal did not write
mints no such atom.

### The blinded entry key

An entry's key is `base64url(SHA-256(sign_actor(domain ‖ digest(P, D))))`: a
digest of the actor's Ed25519 signature over the instance. Ed25519 signatures
are deterministic, so the key is the same on each of the actor's devices. That
is what lets the seal refuse a second entry by the same actor. Without the
actor's signing key the key cannot be computed, so a member who knows every
seat's DID still cannot test which entry is whose. The seal refuses when the
runtime's storage signer is not the acting principal, or when the signer does
not produce the same signature twice.

Neither the entry's value nor its label names the actor. The entry's label is
`[P]`, not `P ∨ User(actor)`. A `User(actor)` alternative would name the actor
in label metadata that every replica of `S` holds. As a stored commitment it
would still be a digest that anyone holding the seat list can test. So the
actor does not read the entry back from `S`: the receipt is the actor's record
of it.

## What this does not cover

- **Who wrote a commit.** The memory service records the issuer of every
  commit, and a replica of `S` may be served that history. Blinding hides the
  actor from the box's contents, keys, and labels, not from the service
  operator or from commit metadata.
- **Timing.** A member watching the box sees when an entry appears.
- **The honest-runtime tier.** Every member's runtime holds and computes over
  the sealed values, and a modified client can read them, forge the builtin
  identity, or seal twice under different keys. One entry per actor is honest
  runtime enforcement, as the writer policy is.
- **Replacing the whole box with a primitive.** Pattern code can write a
  primitive over the root of a document whose writer claim is on that root,
  and the runtime does not refuse the write. Such a write empties the box of
  the seal's witness, so a later release has no witness to rely on: this is
  denial of service, not laundering.
- **A runtime read ceiling that withholds `P`.** The seal refuses to run on a
  runtime whose ceiling withholds the anchor. The room's releasing code needs
  to read the same labels on every member's runtime.
- **Retry.** Consent is in memory and single-use. A receipt without an entry is
  not resumed.
- **Sealing into more than one instance.** One entry per actor holds per
  instance. Anyone who can write in `S` can create further terms documents,
  each a new instance under the same `P`, and an actor who seals into several
  lets whoever controls those instances difference the releases. Showing the
  actor their earlier seals, from their receipts, is the host dialog's job.
- **Which seat wrote an entry.** The entries do not name their actors, so the
  releasing code can compare the number of entries with the number of seats,
  not the set of writers with the set of seats. That count is sound only while
  each seat seals once and only seats can seal.
- **Freezing the room's readers.** Whoever can read `S` when a released value
  is rendered is its audience. Keeping the audience at the seats, whether with
  a room access list fixed at the first seal or with a render fact that admits
  seats only, sits outside this operation.
