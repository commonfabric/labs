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
returns a preview together with a one-use consent. The preview names the actor,
the room space, the room's readers, the terms, the instance, the policy, the
sources, and the stance. `commitCustodySeal(consent, event)` performs the seal.
It accepts only a renderer-trusted DOM event whose `provenance.ui.pattern` is
`CustodySeal`, and it inspects everything again before writing.

A room is its terms document and its policy. The terms document's space is the
room space `S`. The terms are a JSON object that names `seats`, the principals
that may seal, and `stanceSchema`, the schema every sealed value satisfies. A
seat is a DID, or a reference to a cell that attests one principal (see
[Seats](#seats)); the seal replaces each reference by the DID it attests, and
it is these resolved terms that the actor reviews, that `D` digests, and that
each entry carries. The resolved seats
must be distinct DIDs in the syntax of W3C DID Core (a lowercase method, then an
identifier of letters, digits, `.`, `-`, `_`, percent-escapes and `:`, not
ending in `:`), at most 256 characters long, so that the confirmation can show
each one as it is. Two further fields are optional and only displayed:
`question`, the question the room asks, and `answers`, the answers the room
says it can give. The seal checks neither; in particular, nothing checks that
the policy releases only the listed answers, and the confirmation presents both
as what the terms say rather than as what was checked. Everything else in the
terms is shown to the actor and sealed with the value. One instance of a room
is `(P, D)`, where `D` is the digest of the terms.

## What the seal checks

Each check runs at prepare and runs again at commit. At commit, the reads that
established the checks are compared against the committing transaction: the
transaction that writes the entry reads each of them again and refuses the seal
if any holds something else, so the value checked is the value committed.

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
- **The sources are allowed.** The host must supply `allowedSources`, and every
  `Context` and `Resource` the draft draws on must be among them. An empty list
  admits only a value labeled for the actor alone, as a value the actor typed
  in is. The preview lists these sources. A host passes the actor's private
  settings cell rather than a list it read itself; the seal reads it as
  `readCustodySourcePolicy(settings)` does: a list of the actor's own `Context`
  and `Resource` atoms in a document in the actor's home space, and nowhere
  else, so that a room cannot widen what the actor allows. The read is one of
  the reads the entry's transaction verifies, so a policy narrowed at any
  point before the entry commits refuses the seal. A fixed list is for a
  caller whose allowance is not stored. Code running as the actor can write
  that space; against that code, what holds is the confirmation, which shows
  the sources the value draws on.
- **The room names its readers.** The room space's access list must exist and
  name a concrete owner, and every principal it names must be `*` or a DID of
  the form the seats take. The preview lists every principal it names, with its
  role, and the room space's own key, which the memory service treats as an
  owner whether or not the list names it, since whoever can read `S` is the
  audience of what the room releases.
  A room whose readers change after the review makes the review stale.
- **The value is instruction-inert.** `stanceSchema` may admit only booleans,
  `null`, numbers with a finite `minimum` and `maximum`, `const` and `enum`
  primitives, closed objects of these, and arrays of these, at most eight
  levels deep. An array names one `items` schema, itself inert, and an
  integer `maxItems` of at most 64, with an optional `minItems` no greater; no
  array may appear anywhere inside an array's elements, directly or within an
  object. Tuple forms, `prefixItems` and the other array keywords are refused,
  as is an array keyword on a node that is not an array. A list of ratings, one
  per option, is such an array. An array is not free text, but like an object
  of enumerated fields it is a payload: its elements' bits, up to `maxItems` of
  them, plus `log₂(maxItems − minItems + 1)` bits in its length, and an array
  of bounded numbers carries that many numbers. The schema admits no free strings, including in a
  property or an element the value leaves out. The value must satisfy the
  schema.
- **The actor holds a seat** in the terms.
- **The terms carry nothing the room's readers lack.** Every clause of the
  terms document's label must admit `Space(S)` or `P`, because the terms are
  copied into each entry.
- **The policy is the room's.** `P` must be an exact module policy reference
  whose subject is `S`, and its manifest must be installed in `S`. A host whose
  reference is stored passes the cell that holds it, or a cell whose stored
  label declares it: a cell holding no reference names the one module policy
  its label carries at the cell itself, and a label carrying more than one is
  refused. A pattern cannot write its own policy's reference, which names its
  module's content identity and manifest digest, but a cell it declares
  `PolicyOf` its rules carries it, with the room space bound as the subject. The actor consents to the
  reference they reviewed, so the seal never seals another one: a cell that
  holds a different reference at commit makes the review stale, and the read
  is one of those the entry's transaction verifies.
- **The actor trusts `P`.** Under the actor's trust closure, `P` must satisfy
  the concept `https://commonfabric.org/cfc/concepts/trusted-declassifier`. The
  closure is built from `RuntimeOptions.cfcTrustConfig`, and only from the
  statements whose pattern names `P`'s exact `policyDigest`. A manifest's
  `moduleIdentity` and `symbol` are written by its author, so a statement that
  leaves the digest open would be met by any manifest that copies them.
- **The actor has not sealed this instance.**

### Seats

A pattern holds a member's profile, never the member's DID. So a seat may be a
reference to a cell whose stored label attests one principal: a
`represents-principal` integrity atom at the cell's root or on one of its
top-level fields, as a profile's owner-protected fields carry their owner's.
This is the evidence `cf-cfc-authorship` reads an author claim from. A runtime
binds the subject of an atom in the form `{kind, subject}` to its acting
principal and refuses a literal DID there, so in that form a cell attests only
the principal whose runtime wrote it. The seal counts only that form: an atom
whose subject is exactly a well-formed DID, with no other key, on any label
entry at the cell or one of its top-level fields, whatever that entry's origin. Any other
spelling that names a principal, the `represents-principal:<did>` string form
or a subject padded with spaces among them, gets past the runtime's refusal,
and the seal refuses a seat whose cell carries one. The seal resolves the cell
the reference names, reads its label, and refuses a cell that attests no
principal or more than one, and a cell whose own label carries a clause
neither `Space(S)` nor `P` satisfies, since the DID it attests is shown to every
reader of the room; the read is evidence the entry's transaction
verifies, so a seat that attests another principal before the entry is written
refuses the seal. Only `seats` may hold references; the other fields are read
as values.

Naming a seat grants the named member nothing and takes nothing from them: only
that member can seal into it, since the seal requires the storage signer to be
the acting principal. A terms author can name any member's profile as a seat,
as it could write any DID, and the confirmation shows every seat's DID.

## Reaching the seal from a pattern

A room is a pattern, and it reaches the seal through `cf-custody-seal`, which
the pattern binds to its own cells: `$terms`, whose seats are references;
`$policy`, a cell it declares `PolicyOf` its custody rules; and `$box`, a cell
in the room space that receives a link to the instance's box. The host
derives the box's address from `(P, D)`, so a pattern never computes it, and
the seal writes the link itself, in the transaction that writes the entry (see
[Which box the room reads](#which-box-the-room-reads)). The link grants
nothing: the box's entries carry `[P]` and its root `P ∨ Space(S)`,
so what the pattern computes from them is shown or written anywhere only as
`P`'s release rules allow. `cf-sealed` carries the instance `D`. `D` digests
the resolved terms, so it is computable by whoever can read the terms and the
attestations on their seat cells; a pattern, which reads neither DIDs nor
attestations, gains from `D` only a test of a guess at the whole set of seat
DIDs, and the box's address already gives it the same test. Neither the component nor the worker hands
the pattern the entry's key: a pattern that held it could write down which
member's entry it is. `packages/patterns/cfc-exchange-rules/custody-answer-room.tsx`
is such a room, and `packages/patterns/cfc-exchange-rules/custody-projector.tsx`
is the same room demo-grade, its rule naming the projector alone.
`packages/patterns/integration/cfc-custody-projector.test.ts` seals two
members' stances through each room's cells and shows that a room reader sees
its projector's answer and not a member's rating. For the answer room, whose
rule requires the seal's witness, the host publishes that answer once and
refuses the answer over a crafted box; for the demo-grade room it publishes
nothing.

## What the seal writes

A transaction writes one space, so the seal commits more than once. First, if
the instance has no anchor yet (see [Attribution](#attribution)), the seal
creates it, so a seal that cannot establish one has written nothing durable.
Then:

1. **A receipt in the actor's home space.** It is labeled `User(actor)` and
   records the event, `P`, `D`, the entry key, the sources, and the stance's
   digest. The receipt is written first, so every entry has one. A receipt
   whose entry is absent records a seal that did not commit, or an entry lost
   afterwards, as when the box is replaced (see below). A seal whose commit
   is aborted after the receipt, as when the host client that asked for it
   detaches (`commitCustodySeal`'s `signal`), is such a seal. The signal is
   checked before each write and until the entry's transaction is sent; a
   transaction already sent is not recalled.
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

Anyone who can compute `D` can compute both addresses, so the seal refuses a
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

### Which box the room reads

A room's projector reads its box through the room's `$box` cell, which holds a
link, and a member's code can write that cell like any other room data: point
it at another document, such as a record of its own whose entries are links to
real entries, one of them repeated. Blinded entries cannot be told apart from
such a record's, and a projector counting entries against seats would count the
repeated member twice. Each entry such a record reaches is the seal's, so a
witness taken over the entries alone would hold.

Two things close this. The seal writes the link into the room's `$box` itself,
in the transaction that writes the entry, so the link carries the seal's
`TransformedBy`: the transaction is the seal's, and the link is recorded as the
one reference the value there holds (`CfcAssertedValueRoot.reference`), so the
cell is stamped as the seal's write. And a reference a transformation follows
to confidential content is an input location of its own
([input witnesses](cfc-transformed-by-input-witnesses.md#references-a-transformation-follows)),
whatever the slot holding it is labeled. So a projector reading the box through
the link the seal wrote keeps the witness, and one reading it through a link any
other code wrote, to the box or to a record of its own, does not; nor does one
that reads such a record directly, since the record's own slots are references
the seal did not write.

The `$box` cell must be in the room space, and the seal refuses one that is
not, at preview and again at commit. The seal writes under its own identity,
which the box and the anchor admit, so it follows the cell's write redirects
only to a location that holds this box's link already, or holds nothing (an
empty default, as a room's `Default` leaves) in a document that exists and that
the seal did not write, and never into the box, the terms, or any instance's
anchor: a member's room code could otherwise have the seal overwrite another
member's entry, or write into another instance's anchor, which every later seal
of that instance would then refuse. The anchor carries no integrity, so the seal
recognizes one by its address, derived from the instance it holds and the
policy its label names. An instance is the digest of its terms, so a member can
derive the address of an anchor or box the seal has yet to create; the seal
cannot tell such an absent document from an ordinary one, so it never links
from a document that does not exist yet. Documents are compared by space, id
and scope. Once the seal has written it, the cell carries the seal's
label, so a link other code writes over it must name a document that carries a
label of its own.

### One answer per instance

A room's projector is reactive: pointed at other input, or run again, it
computes again, and a room that rendered it would show each result its rule
releases. Worse, an answer that does not change is not written again, so it
keeps the stamp its earlier run left, and whether a projection pointed at a
document of a member's choosing is still readable says whether that document
yields the released answer. The consent a member gives is per instance, so the
room releases one answer per instance, and the projection itself to no member:
the room's rule releases it to the seal alone, adding the reader
`Builtin{cfc-custody-seal}` (`CUSTODY_SEAL_READER`) to the policy's clause
rather than dropping it. No render ceiling or deployment sink ceiling lists
that atom, and an atom admits a clause only by equality, so no member's
rendering or sink admits the clause. The seal declassifies
the answer once, into the instance's answer slot, which is the one thing the
room's readers can read. `publishCustodyAnswer(room, output)` is the host operation
that publishes it, and `readCustodyAnswer(room)` the one that reads it back.
A pattern reaches both through `cf-custody-answer` (`$terms`, `$policy`,
`$output`), which asks the worker to publish each time the projected answer
changes, and shows what the seal published. The refusals below are expected
while an answer is not, or is already, published, and the component stays
quiet on them; any other failure, such as a lost worker connection or a slot
the seal did not write, it shows as an alert. Before the room has terms it
asks nothing.

The seal publishes only when all of these hold, read by the worker from the
cells the host names, never from the request:

- every exchange rule of the room's policy requires the seal's witness
  (`witnessedRelease`), and releases only to the seal: its post-condition
  adds `CUSTODY_SEAL_READER` and nothing else (`releasesOnlyToSeal`), so no
  rule makes the projection readable by a member;
- the instance's anchor and box are the seal's, and the box holds one entry
  per seat;
- the projected answer is a scalar of at most 1,024 characters whose stored
  label carries the room's policy, a rule of the room's own policy fires on
  that label, and every clause naming the policy is left admitting the seal
  and every other clause the room space's readers. A value that never carried
  the policy is not the room's answer, whatever its label admits, and a firing
  of another policy's rule is not the room's release;
- the seal's witness on the answer names this instance. The seal acts under
  `{kind: "builtin", builtinId: "cfc-custody-seal", instance: D}`, so every
  `TransformedBy` it mints names the instance it acted for, while a rule's
  guard naming the seal alone still matches it. An answer computed over an
  earlier instance's box, whose members may differ, is not this instance's
  to release;
- the room the seal inspected is the room it publishes for; and
- the instance has no answer yet.

It then writes `{instance, answer}` into the instance's answer slot, a
create-only document in the room space at
`{custodyAnswer: {policy: P, instance: D}}` labeled `Space(S)`. The
transaction reads the anchor, as the entry transaction does, so the slot is
stamped `TransformedBy{builtin cfc-custody-seal}` like the box. Both reading
and publishing refuse a slot without that stamp: anyone who can compute `D` can
compute the slot's address and write there first, which blocks publication but
shows nothing. A host shows the slot's value through `readCustodyAnswer`, never
a link a room holds, which the room's members could point anywhere. A later
publication is refused, so the answer published for an instance never changes,
whatever later points the projector at other input; which instance a room shows
is another matter, below. The slot holds per instance: new terms are a
new instance, with new consents, a slot of its own and an answer of its own.
`cf-custody-answer` follows the room's terms, so it shows the answer of the
instance the terms name.

The shown answer is the slot of the instance the bound `terms` digest to, under
the policy the bound `policy` cell names. What that guarantees depends on who is
writing:

- **Against everyone, the published answer.** The slot is create-only and the
  seal's alone to write, so the answer published for an instance never
  changes.
- **Not against a member's own code, which instance a room shows.** A room's
  bindings are pattern data in the room space, which its members can write.
  The component's `$terms` and `$policy` sit in the room's result document and
  its UI tree, and no writer claim covers either, so a member's code can write
  there a link to another instance's terms: those of a one-seat room of the
  same pattern the member sealed and published alone, whose answer the room
  then shows as its own, or terms whose slot is empty. A writer claim does not
  close this in general either. Write authority is keyed by code, not by piece
  (normative CFC §8.15.8), so a member's own instance of the room's pattern,
  bound beneath the room's cells, runs an authorized writer; and a source
  update registers its successor as the predecessor's delegate
  ([SC-45](cfc-spec-changes.md)), so the successor's writer satisfies the
  claim.

`custody-answer-room.tsx` keeps its argument `terms` and `policy` write-once as
defense in depth. Each is `WriteAuthorizedBy` its `propose`, which writes each
only while it reads as unwritten and reads nothing but the cell it writes, and
the runtime stores the claim with the document from the piece's creation
([#8212](https://github.com/commonfabric/labs/pull/8212)). That refuses a write
to the room's argument document by any other code, through any schema, and
nothing more. A writer claim on `T | null` sits on the `T` branch alone and
does not refuse a write of `null`, so the room's terms are absent until
proposed rather than `null`. The pattern's integration test,
`packages/patterns/integration/cfc-custody-projector.test.ts`, pins a link
written into the room's result document, and the room's own pattern bound
beneath its terms, as known residuals.

Holding which instance a room shows against its members needs a binding they
cannot rewrite: a write-once or create-only primitive for it, or write
authority bound to a piece. That is an open question for the CFC spec. A
cheaper mitigation, suggested and not built: the component could show the
seats and question of the terms it resolved, beside the answer, so that a room
pointed at another instance shows that instance's seats.

The seal writes a room's box link only into a document that exists: an absent
document could be the address of a custody document the seal has yet to
write, such as this instance's answer slot or a later instance's box, and a
link the seal wrote there would pass for its own write.

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
- **Which box a room reads, under a rule that names its projector alone.**
  The link a pattern holds to the box is ordinary pattern data, so a member's
  code can point it at another document: the box of another instance under the
  same `P`, or one that links to some of the real entries, repeated or beside
  entries of its own. A projector checking the entries' terms and their number
  against the seats cannot tell such a document from the box. While the room's
  rule names its projector by identity alone, a member can therefore run the
  projector over another member's entry and values of their own, varied to
  learn that entry answer by answer, and the rule releases each answer. A rule
  requiring the seal's witness refuses these (see
  [Which box the room reads](#which-box-the-room-reads)), except the box of
  another instance under the same `P`, which the seal wrote and whose link the
  seal may have written too; that is the multi-instance case above, and the
  rule alone does not tell the instances apart. Publication does, since the
  seal's witness names its instance (see
  [One answer per instance](#one-answer-per-instance)), so a room that shows
  only its published answer does not show another instance's. The witness
  still rests on writer policies on the box and on the releasing code's
  output, and on endorsed releasing code that takes no public selector
  parameters. The preview reports whether every rule of `P` requires the
  witness on a guard naming its releasing code outright and releases only to
  the seal (`witnessedRelease`), and when one does not, the confirmation shows
  a warning that a member's own code can learn the actor's stance one answer
  at a time, in place of a bound on what an answer reveals.
- **An answer that does not change, through publication.** A stamp is
  replaced when its value is written. When a member's code points the room's
  box at a document of its own and the projector computes the answer it had
  already computed, nothing is written, and the answer keeps the stamp it had;
  and the other way, an honest run after one over other input that yields the
  same answer keeps that run's unwitnessed stamp. The projection is read by
  no member, but whether the seal publishes still depends on which stamp the
  answer kept. Before the answer is published, a member who points the box at
  a document of their choosing, a record repeating one member's entry say,
  learns whether it yields the room's answer: the answer then publishes, or
  it never does. That is at most one comparison per instance: once every
  seat has sealed, the box link the member wrote over the seal's leaves every
  later run unwitnessed, so an answer not published by then never is, a
  denial of service that one write by any member causes and that lasts for
  the instance. New terms start
  a new instance. A transformation that re-stamps an output it recomputed
  unchanged would close both; it is a runtime change to how a no-op write is
  labeled.
- **Cell-valued properties and bindings.** A confidentiality ceiling gates
  what a render shows as text, and the worker decides a binding, and every
  read or subscription a host makes of a cell, under the same ceiling, on
  everything the read takes in. A member's own pattern that takes the room as
  input therefore shows `choice`, or a rating read from the box, to a viewer
  only as that viewer's ceiling admits it. Gating those paths belongs to the
  renderer and the worker, not to this operation.
- **A squatted answer slot.** A slot other code wrote first blocks the
  instance's publication, as a squatted box or anchor blocks sealing. It
  shows nothing, since a host reads only a slot the seal stamped.
- **Freezing the room's readers.** Whoever can read `S` when a released value
  is rendered is its audience. Keeping the audience at the seats, whether with
  a room access list fixed at the first seal or with a render fact that admits
  seats only, sits outside this operation.
