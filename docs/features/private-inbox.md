# The private inbox

Every identity has one private inbox: a piece, in a space of its own, where
other principals deliver offers to the identity, such as a chat room to join.
Only the owner reads what is in it. Anyone can append to it, but only through
its `receive` stream, which records who sent each offer. This document says
where the inbox lives, who creates it and when, what access its space grants,
what `receive` accepts, and the limits on what it keeps private.

The pattern is `packages/patterns/system/private-inbox.tsx`.

## Where it lives

- **The inbox piece** runs `private-inbox.tsx`, in a space created for it. The
  space is named `private-inbox` in the owner's Home space, so it is one space
  per identity, whichever device creates it and however many times.
- **Home** holds a link to the piece in its `privateInbox` field, under the key
  `piece`. The field is empty until the inbox exists.
- **Each of the owner's profiles** points at an inbox through its `inbox`
  field, which `profile-home.tsx` describes. A profile space is readable by
  anyone, so the pointer is how a sender finds the inbox.

A profile may point at an inbox other than Home's, set by something else. That
pointer is left as it is.

## Creating it

Home's `ensurePrivateInbox` stream creates the inbox when Home holds none, and
then has every profile in Home's `profiles` list that points at no inbox point
at Home's, through the profile's own `setInbox`. Sending it again creates
nothing and re-points nothing.

The host sends it once per runtime worker, when it first brings up the user's
Home pattern: `PiecesController.ensurePrivateInbox()` in `packages/piece`,
called from `RuntimeProcessor` in `packages/runtime-client`. A Home pattern
without the stream is left alone. A failure is logged, and the next time the
host brings up Home it sends the event again. A profile created after that
point gets its pointer the next time the stream runs.

The pointing runs as a second event, queued behind the one that creates the
inbox, because the inbox piece exists only once that event's transaction has
committed. It reads the profile list as a value, so the runner holds the event
until every profile has loaded, and an unloaded profile is never taken for one
without an inbox. The link a profile receives names the inbox's own result
document rather than the cell Home's link reaches it through: a link written
into a profile's labeled `inbox` takes its label from the document it names,
and the result document is the one with a schema to take it from.

## The access its space grants

A pattern cannot see whether server execution is on, and the access the inbox
needs depends on it. `PatternFactory.inSpace()` takes the choice instead: the
`grantsWithoutServerExecution` option names access the created space grants,
over `grants`, only when the runtime creating it does not have server execution
on. The builder chooses the grants where it resolves the `inSpace()` target
(`packages/runner/src/builder/pattern.ts`). The inbox asks for `"*": WRITE`
there.

| Server execution | Access list of the inbox space | Who makes a sender's write |
| --- | --- | --- |
| On | the owner, `OWNER` | the serving loop, in the inbox space's server |
| Off | the owner, `OWNER`; `"*"`, `WRITE` | the sender's own runtime |

The choice is made once, when the space is created. A deployment that turns
server execution on later leaves an inbox created without it open to every
principal's writes. Nothing narrows such a space yet.

## What the offers carry

`offers` is a list, oldest first. The list and each offer in it are labeled
confidential to `User(CurrentPrincipal)`, bound to the owner who created the
inbox. An offer a sender appends is a document of its own, created in the
sender's transaction, and binds to the inbox's owner rather than to the sender;
[`current-principal.md`](current-principal.md) describes that binding. A
runtime holding the inbox refuses to let another principal's code read the
offers, or copy them anywhere.

An offer holds:

- `kind`: what is offered, as lowercase words joined by hyphens, such as
  `fabrichat-room`. A reader acts only on the kinds it knows.
- `space`: the DID of the space the offered thing lives in.
- `host`: the origin of the host serving `space`, when the sender names one.
- `entry`: a link to the offered piece in `space`, when the sender names one.
- `title`: what the sender calls the offered thing, when it names one.
- `from`: the DID of the event's actor, from `currentPrincipal()`. Nothing in
  the event's payload can choose it. With server execution on, the serving loop
  stamps the actor; with it off, the sender's own runtime does.
- `receivedAt`: when the inbox received the offer.

## Sending one

A sender appends with the inbox's `receive` stream, reached through a
profile's `inbox.piece`, from a handler of the sender's own. With server
execution on, that handler is served, and the append reaches the closed inbox
space as a stream event the space's server runs. A client sending to `receive`
directly is then refused, since it holds no `WRITE` in the space.

`receive` appends nothing for an event that has no actor, whose `kind` is not
as described above or is longer than `OFFER_KIND_MAX_LENGTH`, whose `space` is
not a DID, or whose `host` is not an `http` or `https` origin of at most
`OFFER_HOST_MAX_LENGTH` characters. A `title` longer than
`OFFER_TITLE_MAX_LENGTH` is cut to that length. The sender is not told: a
refusal inside `receive` happens in the inbox, which the sender cannot read.

## Reading them

The owner reads `offers`. Nothing marks an offer as read or removes it, so a
reader keeps its own record of the offers it has handled, wherever it keeps its
own state.

## What it does not protect

- **Delivery into the closed space rests on an owed check.** With server
  execution on, a served append to another space's stream is admitted on the
  presence of the actor's carriage alone; admission resolves no grant against
  the stream. That is spec rule OW13 in
  [`../specs/server-side-execution/verification-coverage.md`](../specs/server-side-execution/verification-coverage.md),
  whose grant-resolution check is still owed. When that check lands, delivery
  into a space that grants senders nothing needs a grant the stream opts into.
- **Without server execution, the inbox is readable by anyone.** `WRITE`
  implies `READ`, and the label binds only an honest runtime, so anyone holding
  a memory client can read the offers, titles included, and can rewrite or
  remove them.
- **Nothing limits how many offers arrive.** A sender can append as many as it
  likes.
