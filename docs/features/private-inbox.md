# The private inbox

Every identity has one private inbox: a piece, in a space of its own, where
other principals deliver offers to the identity, such as a chat room to join.
Its offers are labeled readable by the owner alone. Anyone can append to it,
through its `receive` stream, which keeps an offer only when the offer names
the principal sending it as its sender. This document says where the inbox
lives, who creates it and when, what access its space grants, what `receive`
accepts, and the limits on what it keeps private.

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
without the stream is left alone. The host learns only whether the event was
sent, not whether Home's handler committed: a stream's `send` returns before
the handler runs. So an exception raised while sending it, such as Home
failing to come up, is logged, and the next time that worker brings up Home it
sends the event again; a failure inside the handler is not seen, and the event
is not sent again until another worker brings Home up. A profile created after
that point gets its pointer the next time the stream runs.

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

The link a profile receives names the inbox's own result document rather than
the cell Home's link reaches it through: a link written into a profile's
labeled `inbox` takes its label from the document it names, and the result
document is the one with a schema to take it from.

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
runtime holding the inbox refuses to let another principal's code copy the
offers anywhere. The label does not stop another principal's runtime reading
them, as the access section says.

An offer is the envelope a loom share inbox keeps, its eight fields, and one
more:

- `kind`: what is offered, such as `loom` or `fabrichat-room`. A reader acts
  only on the kinds it knows.
- `id`: the sender's key for the offer, the same on every resend of it. No two
  offers in the inbox from one sender share one.
- `space`: the DID of the space the offered thing lives in.
- `host`: the origin of the host serving that space.
- `ownerOrigin`: the origin of the sender's own host, or empty.
- `title`: what the sender calls the offered thing, or empty.
- `from`: the DID of the sender, which `receive` requires to be the event's
  actor, from `currentPrincipal()`.
- `sharedAt`: when the sender shared the offer, in milliseconds since the
  epoch, by the sender's clock.
- `receivedAt`: when the inbox received the offer, by its own clock. A
  handler's clock reads to the second, so two offers can share it.

## Sending one

A sender appends with the inbox's `receive` stream, reached through a
profile's `inbox.piece`, from a handler of the sender's own. With server
execution on, that handler is served, and the append reaches the inbox space
as a stream event the space's server runs.

The sender reads the pointer through `profile-home.tsx`'s own types, where
`inbox.piece` is the typed link `Cell<ShareInboxPiece>`, for the reason the
pointing step does: read as an untyped link, the pointer joins the offers'
label into the sender's run, and the run's sends are refused.

`receive` decides what it keeps from the event alone, as a loom share inbox
does, and then checks the sender:

- Every string is trimmed, then cut: `kind` to `OFFER_KIND_MAX_LENGTH` (32),
  `id` to `OFFER_ID_MAX_LENGTH` (320), `title` to `OFFER_TITLE_MAX_LENGTH`
  (200), and `space`, `host`, `from` and `ownerOrigin` to
  `OFFER_ADDRESS_MAX_LENGTH` (256).
- The event is dropped unless `space` and `from` are well-formed DIDs, as
  `isWellFormedDID()` decides (DID Core syntax), and `host` is an `http` or
  `https` origin written as its own canonical origin: it parses as a URL whose
  origin is exactly the string, so it holds no user information (`@`), path,
  query (`?`) or fragment (`#`), no backslash, no default or out-of-range
  port, and is lowercase. A loom share inbox admits more on both counts, so
  this inbox is the stricter. Each of the four addresses is cut before it is
  checked, so one longer than the limit is kept cut, and a cut `space` is a
  different DID.
- What a sender leaves out is filled in: `kind` with `OFFER_DEFAULT_KIND`
  (`loom`), `sharedAt`, unless it is a positive number, with the time the
  inbox received the offer, and `id` with `<space>@<sharedAt>`, so a resend
  with neither `id` nor `sharedAt` in a later second is kept again. An
  `ownerOrigin` that is not an origin is kept empty. A field the envelope does
  not name is not kept.
- The event is dropped when its `from` is not the principal sending it, or
  when an offer in the inbox already has its `from` and `id`. So a resend of
  one offer is kept once, the first one kept stays as it was, and no sender
  can take another sender's `id` first. A loom share inbox keys on `id` alone,
  so this inbox is the stricter of the two.

The sender is not told of a drop, but it can read the offers back and look
for a row with its offer's `id`, `from` and `space`, as a loom sender does.

## Reading them

The owner reads `offers`. Nothing marks an offer as read or removes it, so a
reader keeps its own record of the offers it has handled, keyed by `from` and
`id`, wherever it keeps its own state. Two senders may choose the same `id`,
and the inbox keeps an offer from each.

A row's `from` is the sender's claim, not a fact the inbox vouches for.
`receive` keeps an offer only when `from` is the principal sending it, but
`receive` binds only an honest runtime, and any principal may write `offers`
without it, naming any `from`. So a reader checks `from` itself before
trusting a row. A loom reader checks that `from` holds its own `WRITE` or
`OWNER` entry on the offered `space`, and the intake that reads this inbox is
to check the same.

## What it does not protect

- **The inbox is readable by anyone.** `WRITE` implies `READ`, and the label
  binds only an honest runtime, so anyone holding a memory client can read the
  offers, titles included, and can rewrite or remove them.
- **Anyone can flood it.** Nothing limits how many offers arrive, and
  `receive` reads every offer before it appends, so a flood slows every later
  delivery.
- **Anyone can corrupt it.** A writer bypassing `receive` can add rows naming
  any `from`, as "Reading them" says. It can replace `offers` with something
  other than a list: while it is one, `receive` keeps nothing and leaves the
  value as it is, so delivery stops until something puts a list back. It can
  also add an entry `receive` cannot read, such as a link into a space no
  sender may read, which can make every delivery fail. A loom share inbox,
  granting the same access, accepts the same.
