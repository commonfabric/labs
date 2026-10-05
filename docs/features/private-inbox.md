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
without an inbox. A profile of any vintage with a `setInbox` is pointed this
way; one predating `setInbox` drops the event, and the runtime logs a warning
that no handler took it.

The pointing step reads each profile's pointer as a typed link,
`Cell<PrivateInboxPiece>`. The link carries the label of what it reaches, and
the inbox labels its offers confidential to its owner. Read as an untyped link,
`Cell<unknown>`, the pointer joins that label, from another space, into the
served run in Home's space. Writer-fit then refuses the run's own sends,
whichever path delivered it. When the event drain, rather than the wave that
queued it, delivered the run, it also refuses the run's record that it handled
the event, and the event is lost. Read as the typed link, the pointer joins no
confidentiality. `private-inbox.pointer-type.test.ts` fails to compile if
either reader's pointer type becomes unconstrained, or names a member of the
inbox's result other than its name.

The read and the `setInbox` it leads to are two transactions, in Home's space
and then in the profile's, so a pointer that something else sets between them
is replaced by Home's inbox.

The link a profile receives names the inbox's own result
document rather than the cell Home's link reaches it through: a link written
into a profile's labeled `inbox` takes its label from the document it names,
and the result document is the one with a schema to take it from.

## The access its space grants

The inbox's space grants its owner `OWNER` and every principal, `"*"`,
`WRITE`, whether server execution is on or off. The inbox asks for that
through `PatternFactory.inSpace()`'s `grants` option. With server execution
off, a sender's own runtime makes the sender's write; with it on, the inbox
space's server does. `WRITE` also lets a sender read the offers back to
confirm its own, past the label, as the next sections describe.

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
- `space`: the DID of the space the offered thing lives in, when the sender
  names it. A sender that holds only a link to the offered piece leaves it out,
  since a pattern has no way to read a link's space.
- `host`: the origin of the host serving that space, when the sender names
  one.
- `entry`: a link to the offered piece, when the sender names one. A link
  names the space it reaches into, and `spaceAccess()` takes it as it stands.
- `title`: what the sender calls the offered thing, when it names one.
- `from`: the DID of the event's actor, from `currentPrincipal()`. Nothing in
  the event's payload can choose it. With server execution on, the serving loop
  stamps the actor; with it off, the sender's own runtime does.
- `id`: the event key of the event that delivered the offer, from
  `eventKey()`, which [`event-key.md`](event-key.md) describes. Like `from`, it
  is stamped by `receive`, and an `id` in the event's payload is never read.
  Every run of one delivery stamps the same id, and every other delivery gets
  another, except one that re-admits the same event id, which a reader keying
  its receipts by `id` takes for the offer it already handled.
- `receivedAt`: when the inbox received the offer. A handler's clock reads to
  the second, so two offers can share it, and `id` is what tells them apart.

## Sending one

A sender appends with the inbox's `receive` stream, reached through a
profile's `inbox.piece`, from a handler of the sender's own. With server
execution on, that handler is served, and the append reaches the inbox space
as a stream event the space's server runs.

The sender reads the pointer through `profile-home.tsx`'s own types, where
`inbox.piece` is the typed link `Cell<ShareInboxPiece>`, for the reason the
pointing step does: read as an untyped link, the pointer joins the offers'
label into the sender's run, and the run's sends are refused. `receive` stamps the offer with the
sender as `from`, including when the send comes from a handler that another
of the sender's handlers queued.

`receive` appends nothing for an event that has no actor, whose `kind` is not
as described above or is longer than `OFFER_KIND_MAX_LENGTH`, whose `space` is
not a DID, that names neither a `space` nor an `entry`, or whose `host` is not
an `http` or `https` origin of at most `OFFER_HOST_MAX_LENGTH` characters.
`receive` cannot tell whether `entry` names a piece: a value sent there that is
not a link arrives as a link to the event's own copy of the value. So a reader
checks what `entry` reaches before acting on it, and does not take an answer
from `spaceAccess(entry)` as a sign that the link names the offered thing. A
`title` longer than `OFFER_TITLE_MAX_LENGTH` is cut to that length. The sender
is not told: a refusal inside `receive` happens in the inbox, which the sender
cannot read.

## Reading them

The owner reads `offers`. Nothing marks an offer as read or removes it, so a
reader keeps its own record of the offers it has handled, keyed by `id`,
wherever it keeps its own state.

## What it does not protect

- **The inbox is readable by anyone.** `WRITE` implies `READ`, and the label
  binds only an honest runtime, so anyone holding a memory client can read the
  offers, titles included, and can rewrite or remove them.
- **Nothing limits how many offers arrive.** A sender can append as many as it
  likes.
