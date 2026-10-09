# The principal a label attests

A pattern often holds a cell standing for a person — a profile, or a record
someone wrote — and needs that person's DID: to start a direct conversation
from a profile, or to check who created a room before accepting it.
`principalOf(target, kind)`, exported to patterns through the `commonfabric`
module, returns the one principal the label on `target`'s value attests. This
document says which claims it reads, what it returns when they do not settle on
one principal, what it reads to find out, and what the result discloses. The
implementation is `packages/runner/src/builder/principal-of.ts`.

## The claims it reads

A principal claim is an integrity atom of the form
`{ kind, subject }`, where `subject` is a DID:

| `kind` | What the claim says | Written by |
| --- | --- | --- |
| `represents-principal` | the value stands for the subject, as a profile does | `RepresentsCurrentUser`, or `ownerPrincipal` |
| `authored-by` | the subject wrote the value | `AuthoredByCurrentUser` |

A pattern writes the runtime's placeholder as a claim's subject, and the
runtime replaces it with the principal the write acts for when it prepares the
commit. A pattern-written subject that looks like a DID is refused there, in
any spelling a reader could take for a claim, with one exception: a claim may
name, as a literal, the `ownerPrincipal` its schema declares, and a literal
`ownerPrincipal` is itself refused unless it is the principal the write acts
for. Either way, a claim the runtime admits names the principal the write acts
for.
`packages/runner/src/cfc/represents-principal.ts` is the one definition of a
claim for both sides: the check `prepare.ts` makes on a write, and the readers.

`principalOf()` reads a claim as `exactPrincipalAttestations()` in that module
does, in exactly the form a runtime mints: an object of `kind` and `subject`
and nothing else, with a subject that is a well-formed DID as written. It reads
the claims on the value's root and on its top-level fields, where a profile's
owner-protected fields carry their owner's claim. It does not read a claim
deeper down, which describes a document the value links to, nor one that a
link carries from the document it points to (an entry observed as `followRef`).

`target` is followed through any links it holds first, so a cell holding a
link to a profile returns the profile's principal.

## The label on a field that holds a link

A field that links another document has a label of its own, on the document
holding the link: what the runtime stamped there when the link was written,
such as `represents-principal` for whoever wrote a field typed
`RepresentsCurrentUser`. That is a different fact from what the linked
document's label says. A panel's `addedByProfile` in the Loom root links the
profile its adder acted under, and any participant may link any profile, so
the profile's label names its owner while the field's names who acted.

`principalOf(target, kind, { label: "written" })` and the same call of
`principalsOf()` read the field's label, where the default, `"resolved"`,
reads the label on the document the field's value resolves to. Links on the
way to `target` are followed, and so is a redirect stored there, which is where
a write to `target` would land; a link `target` holds as its value is not. The
claims are read in the same places relative to that field, and the copies of
the linked document's claims that the link carries are not counted, as in the
default read. For a field holding no link, the two reads are the same.
`options` throws when it is not an object, or when its `label` is neither
`"written"`, `"resolved"` nor absent; an absent `label` means `"resolved"`, and
other keys are not read.

## What it returns

| Result | When |
| --- | --- |
| a DID | the claims of `kind` it reads name exactly one principal |
| `undefined` | they name none, or more than one |
| `undefined` | a claim of `kind` there is in any other form: extra keys, a padded subject, a subject that is not a DID |
| `undefined` | a claim of either kind there is in the string form `<kind>:<subject>` |
| `undefined` | `target` was passed as `undefined` |
| throws | the stored label cannot be read: its read fails or is refused, or it is stored in a form this build cannot interpret |

`undefined` means that the label names no verified single principal of that
kind, and a caller refuses whatever needs one. It never guesses. A label that
names two principals, or holds a claim some writer other than a runtime could
have spelled, gives no answer rather than the first or the likeliest one. A
`target` of `undefined` is one not known yet: a computation taking its target
by value reads `undefined` while the value cannot be read.

A label that cannot be read is not reported as `undefined`, since that would
make a labeled document read as an unlabeled one; the read's error propagates.
A `kind` other than the two above, or a `target` that is neither a cell nor
`undefined`, throws too.

## Every principal a label attests

`principalsOf(target, kind)`, exported beside `principalOf()`, reads the same
claims in the same places and returns all of them: `[]` when the label attests
none of `kind`, and the DIDs it attests, in the order they first appear, when it
attests one or more. It returns `undefined` where `principalOf()` does for a
claim in any other form and for a `target` of `undefined`, and it throws where
`principalOf()` throws. It can be called where `principalOf()` can, and reads
what `principalOf()` reads.

`principalOf()` returns `undefined` both for a label attesting no principal and
for one attesting several, which suits a caller that refuses whatever needs a
verified principal. A caller that must admit a value nobody attests and refuse
one somebody else does reads `principalsOf()` instead, so that a contested
label is refused rather than admitted as an unattested one. The Loom root's
`addPanel` reads its occurrence's `addedBy` field that way.

## Where it can be called

| Where the call runs | Result |
| --- | --- |
| A handler | the principal, read through the handler's transaction |
| A reactive computation (`computed()`, `lift()`) | the principal, read through the computation's transaction |
| A pattern body | none: the call throws |

A handler is the usual place: a handler that receives a cell in its event, such
as the room an `accept` names, can ask about that cell directly. The answer
does not depend on who is asking, so a call in a computation leaves the
computation's read scope as it was.

## What it reads

The call reads the target's stored label, and no contents of its value beyond
the link pointers needed to resolve the target. Following the target's links
probes whether its value is a link, and that probe is the only read of the
value's document it makes outside the label. The label is read
through `readStoredCfcMetadata()`, the runtime-internal verifier read the rest
of the runtime uses for label metadata, in the calling code's own transaction.
The read is a dependency like any other, so a computation that called
`principalOf()` runs again when the label changes.

A document whose load is still in flight has no label to read yet, and that is
not its state. A computation needs nothing for it, since the load's arrival
runs the computation again. A handler runs once per event, so in a handler the
call withdraws the run instead, through the transaction's
`dispatchedHandlerNotRun`, and the scheduler runs the handler again once the
load lands; this is what lets a served handler read the label of a cell its
event names, a cell whose document the serving runtime may never have read
before. The call withdraws only when the replica has no local basis for the
document, not even a confirmed absence, and a load for it is in flight. A
withdrawal therefore always has a load to wait on: once the load for a
document that does not exist has settled, its absence is confirmed, and the
handler's next run reads it as unlabeled and gives `undefined`.

## What the result discloses

What a claim names is public by design. The label-metadata classification in
[the label-metadata confidentiality design](../specs/cfc-label-metadata-confidentiality.md)
§2 classes the `kind` and the `subject` of both claim kinds as public: they are
the attribution a product displays, and the replica already carries them to
every client holding the value. So the observation of a claim adds no
confidentiality to the result, and the call records no label-metadata
observation on the transaction; the transaction's recorder keeps only labeled
ones. The rest of what the calling code read labels what it writes, as it
would without the call.

The classification is consulted on every call rather than assumed. If it ever
classed a claim's subject as anything but public, `principalOf()` would throw
rather than return an unlabeled copy of it, since nothing carries a label for
an integrity atom's field.

`principalOf()`, `principalsOf()` and `inspectConfLabel()` are the
pattern-facing surfaces for label metadata. All read inside the observing
transaction and take the cell whose label they read as their target;
`principalOf()` and `principalsOf()` also accept a target of `undefined`, for
which they return `undefined`.

## What the DID can and cannot do

The DID returned is data. A pattern can compare it with `currentPrincipal()`,
check it with `isWellFormedDID()`, store it, or pass it to
`grantSpaceAccess()`. It cannot turn it back into a claim for anyone else:
written into a label as a claim's subject, it is a literal DID like any other,
and the write is refused, unless the schema declares that DID as its
`ownerPrincipal` and it is the principal the write acts for. The claim then
names the same principal the placeholder would have.

## How far the answer can be trusted

A claim is as trustworthy as the runtime that minted it. On an honest runtime a
claim names the principal the write acted for, and nothing a pattern writes can
change that. The memory server does not check a claim against the session that
committed it, so a modified client can store a claim naming anyone, just as it
can write any record its access allows. A claim binds honest runtimes, and does
not hold against a modified client.

An `authored-by` claim says whose authority the write ran under, not that the
person asked for it; [`current-principal.md`](current-principal.md) covers
authority and intent.

## Tests

`packages/runner/test/builder/principal-of.test.ts` covers the reader against
stored labels of each shape above, claims the runtime minted in a handler
(`authored-by` against that handler's `currentPrincipal()`, and
`represents-principal`), the refused pattern-written claim and the refused
write-back of a returned DID, the reads the call makes, a lift that runs again
on a label-only change beside one that holds the same cell and does not, the
withdrawal of a handler that reads a document still loading beside the cases
that do not withdraw, and the call in a compiled pattern's handler and
`computed()`. `packages/runner/test/executor-cross-space.test.ts` covers a
served handler reading the label of a foreign document its event reaches
through a link chain, and one whose chain reaches a document that does not
exist.
`packages/runner/test/cfc/represents-principal.test.ts` covers
`exactPrincipalAttestations()` for both kinds.
