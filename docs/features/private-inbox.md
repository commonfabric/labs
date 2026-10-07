# The private inbox

Every identity has one private inbox: a piece, in a space of its own, where
other principals deliver offers to the identity, such as a chat room to join.
Its offers are labeled readable by the owner alone. Anyone can append to it,
through its `receive` stream, which keeps an offer only when the offer names
the principal sending it as its sender. This document says where the inbox
lives, how Home comes to hold it, what access its space grants, what `receive`
accepts, and the limits on what it keeps private.

The pattern is `packages/patterns/system/private-inbox.tsx`.

## Where it lives

- **The inbox piece** runs `private-inbox.tsx`, in a space created for it. The
  space is named `private-inbox` in the owner's Home space, so it is one space
  per identity, whichever device creates it and however many times. Home may
  instead hold an inbox it adopted, such as one a loom daemon created, which
  lives wherever its creator put it.
- **Home** holds a link to the piece in its `privateInbox` field, under the key
  `piece`. The field is empty until Home first ensures the inbox. Links to the
  inboxes Home held before, if any, are in its `retainedPrivateInboxes` list,
  as "Creating or adopting it" says.
- **Each of the owner's profiles** points at an inbox through its `inbox`
  field, which `profile-home.tsx` describes. A profile space is readable by
  anyone, so the pointer is how a sender finds the inbox.

A profile may point at an inbox other than Home's, set by something else. That
pointer is left as it is.

## Creating or adopting it

An identity has one inbox, whichever side creates it: Home, or a loom daemon,
which creates a share inbox of its own and points a profile at it. Whichever
side arrives second adopts the inbox the first one advertises, if the inbox is
usable, and never replaces a pointer that names a different inbox. When both
arrive together, as when a new person's Home and daemon first come up, each can
read the pointer before the other sets it, and the one that sets it last decides
what it names. Each side then adopts again, deciding by the same profile, the
one `#profile` answers with: Home adopts the inbox that profile advertises in
place of another, and a loom daemon adopts a pointer that moved; each keeps
reading the inbox it held. A loom daemon does its half as loom #7300 describes;
the loom release that carries it is what the two halves wait on.

The host gives Home its inbox, normally once per runtime worker, when it first
brings up the user's Home pattern: `PiecesController.ensurePrivateInbox()` in
`packages/piece`, called from `RuntimeProcessor` in `packages/runtime-client`,
which does it through `ensurePrivateInboxOf()` in
`packages/piece/src/ops/private-inbox.ts`. It decides by one profile: the first,
in the order `#profile` answers in, that points at an inbox. That order is
`orderProfileCandidates()` in `packages/runner/src/profile-order.ts`, which the
`wish` builtin answers `#profile` by: Home's default profile first, then by rank
in its MRU list, then in `profiles` list order, leaving out a profile whose
document is absent. A loom daemon reads `#profile` to find the profile it treats
as active, so the two decide by the same profile whenever it points at an inbox.
The host keeps the inbox Home holds when the deciding profile points at it,
whatever the other profiles point at, or when no profile points at an inbox.
Otherwise the host vets the inbox the deciding profile points at, as a loom
daemon vets an inbox before adopting it. When a profile ordered ahead of the
deciding one cannot be read, which profile decides is unknown, and the ensure
rejects, sending nothing. The inbox is usable when:

- its space is neither the Home space nor the deciding profile's own space;
- that space grants the identity `OWNER` and every principal, `"*"`, `WRITE`,
  as the host reads its access list; a list that is malformed or names no
  concrete owner grants neither;
- the piece holds a list of `offers` and a `receive` stream.

A failure to read the inbox's space that is not a refusal of access, such as a
lost connection, rejects the ensure, and the next time that worker brings up
Home it tries again.

The host then sends Home's `ensurePrivateInbox` stream, naming the inbox to
adopt and the deciding profile when the inbox is usable, and no inbox
otherwise. A Home pattern without the stream is left alone. Home's handler
checks the host's decision rather than repeating it, against the profiles'
pointers as it reads them, so a pointer that moved after the host vetted it
is decided by where it now points:

- When the event names an inbox, Home adopts it if the profile the event names
  is in Home's list and still points at that inbox, comparisons of links that
  read only link shape in the inbox's space; if not, as when the pointer moved
  after the host vetted it or the profile is not one of Home's, Home is left as
  it is. When that adoption succeeds, an inbox Home held until then goes to the
  end of Home's `retainedPrivateInboxes` list. An event from a host that names
  no profile is checked against the first profile in the list that points at an
  inbox, and adopts only while Home holds none.
- Otherwise, when Home holds no inbox and no profile in the list points at an
  inbox, Home creates one, as "Where it lives" says.
- Otherwise Home keeps the inbox it holds, or holds none. That is the case when
  the deciding profile advertises the held inbox, when nothing is advertised,
  and when the deciding profile advertises an inbox that failed vetting; for
  the last, the host logs a warning naming the reason, under
  `piece.private-inbox`. A loom daemon likewise leaves an unusable pointer
  alone and creates no inbox of its own.

It then has every profile in the list that points at no inbox point at Home's,
through the profile's own `setInbox`. A profile pointing at another inbox keeps
its pointer, so after adopting one of several inboxes, the profiles pointing at
the others still advertise them. Home gives up a held inbox when it adopts the
inbox the deciding profile points at instead, whichever profile still points at
the held one; when that inbox fails vetting, Home keeps the one it holds. While
Home holds no inbox, as after a refusal, a profile that points at none stays
unpointed, until a later ensure finds a usable advertisement or none. Sending
the stream again creates nothing, re-points nothing and retains nothing more.
Creation is tested by
`packages/patterns/integration/private-inbox-multi-runtime.test.ts`, with server
execution on and off; keeping, adopting, adopting again and refusing are tested
there, by `packages/patterns/system/private-inbox.test.tsx` and, vetting rule by
rule, by `packages/piece/test/ops/private-inbox.test.ts`.

`retainedPrivateInboxes` holds a link to each inbox Home gave up, in the order
it gave them up, and never the one it holds: adopting an inbox the list holds,
as when a profile is pointed back at it, takes it out. It is there so that the
offers senders delivered to an earlier inbox stay readable, by the intake that
reads Home's offers; no intake reads offers from it yet. Like `privateInbox`,
nothing clears it.

Home adopts again only when an ensure runs, which is at a runtime worker's first
bring-up of Home, and again at the worker's next bring-up of Home if that ensure
failed. So when a pointer moves away from the inbox Home holds, as when a daemon
writes the pointer last or the owner points a profile elsewhere, Home goes on
holding the earlier inbox while senders deliver to the new one, until the next
runtime worker to start brings Home up. Nothing watches the pointers in between.
A loom daemon instead reads its profile's pointer again at intervals. Two
further changes could close that window: a `setInbox` that sets the pointer only
while it is unset, which needs older profile vintages detected and still leaves
the side that loses to adopt the winner; or a single minter, where a loom daemon
asks Home to ensure its inbox when Home has the stream and adopts the result.
Either would need the loom side to agree.

Home opens without waiting for the ensure, which reads every profile's pointer
and loads inbox documents in other spaces. The host learns only whether the
event was sent, not whether Home's handler committed: a stream's `send` returns
before the handler runs. So an exception raised while sending it, such as Home
failing to come up, is logged, and the next time that worker brings up Home it
sends the event again; a failure inside the handler is not seen, and the event
is not sent again until another worker brings Home up.

A profile is pointed in one of two ways:

- **When Home ensures the inbox**, as above: every profile in Home's list that
  points at no inbox.
- **When the profile is created.** Every way of creating one goes through
  `submitProfileCreation` in `profile-create.tsx`, whose queued
  `seedProfileName` step runs once the new profile's create has committed and
  points it at Home's inbox, if Home holds one and the profile points at none.
  That covers Home's own `createProfile` stream and the profile picker's create
  section, which Home hands its `privateInbox`, and the create surface a
  `#profile` wish opens, which the runtime hands the `privateInbox` of the
  demanding user's own Home, beside its `profiles`
  (`packages/runner/src/builtins/wish.ts`). An embedder that hands no inbox
  leaves the profile to the next ensure.

So a profile created before Home holds an inbox is pointed by the next ensure
after the inbox exists, and a profile created after Home adopted an inbox is
pointed at the adopted one. Both ways go through `pointAtInboxIfUnset()` in
`profile-home.tsx`, which reads the pointer as a typed link, as the next
paragraphs require.

The handler reads the profile list as a value, as `advertisedInbox()` in
`private-inbox.tsx` requires, so the runner holds the event until every profile
has loaded, and an unloaded profile is never taken for one that advertises no
inbox. Vetting reads the inbox's access list and two of its members in the
inbox's own space, which is why the host does it rather than Home's handler: an
access list is the host's to read, and a handler's read of a labeled inbox in
another space is the hazard the next paragraph describes. The pointing runs as a
second event, queued behind the one that gives Home its inbox, because a created
inbox piece exists only once that event's transaction has committed. It reads
the list as a value too, for the same reason. A profile of any vintage with a
`setInbox` is pointed this way; one predating `setInbox` drops the event, and
the runtime logs a warning that no handler took it.

The host, the handler, the pointing step and the seed step read each profile's
pointer, and the handler reads the inbox the event names, the inbox Home holds
and the ones it retains, as a typed link, `Cell<ShareInboxPiece>`; the host
reads it through `inboxPieceLinkSchema` in
`packages/piece/src/ops/private-inbox.ts`, the same type as a schema. A link
that names the inbox's own result document, as `setInbox` and an adoption write
it, carries the label of what it reaches, and the inbox labels its offers
confidential to its owner; a profile's pointer, and Home's holder once Home has
adopted an inbox, hold such a link. Read as an untyped link, `Cell<unknown>`,
the pointer joins that label, from another space, into the reading run.
Writer-fit then refuses the run's own sends, whichever path delivered it. When
the event drain, rather than the wave that queued it, delivered the run, it also
refuses the run's record that it handled the event, and the event is lost. Read
as the typed link, the pointer joins no confidentiality.
`private-inbox.pointer-type.test.ts` fails to compile if any reader's pointer
type, the host's, the ensure's and the pointing step's, the seed step's, the
profile's own or Home's holder and retained list, becomes unconstrained, or
names a member of the inbox's result other than its name.

The read and the `setInbox` it leads to are two transactions, in Home's space
and then in the profile's, so a pointer that something else sets between them
is replaced by Home's inbox.

A profile whose stored `inbox` is not an object holding a link, as a writer
bypassing `setInbox` can leave it, is repaired: the typed read takes it for no
pointer, so the owner's Home points the owner's profile at its own inbox, and
the host's vetting takes it for no advertisement. A loom daemon never writes
over such a pointer, and reports it instead, so the two converge on Home's
repair. The pattern test pins it with a profile whose stored `inbox` is a
string.

The link a profile receives names the inbox's own result document rather than
the cell Home's link reaches it through: a link written into a profile's
labeled `inbox` takes its label from the document it names, and the result
document is the one with a schema to take it from. Home's own link to an
adopted inbox names that document too, rather than the profile's pointer, so
a later change to that pointer moves Home's inbox only through a later ensure,
by the rules above.

The inbox lives in a field of Home's root, as the shared-space catalog does, so
replacing Home's root would replace it: a new root holds no inbox and retains
none, and its first ensure gives it one by the rules above, from whatever
profile list the new root holds. Nothing replaces an identity Home's root:
`PiecesController.recreateDefaultPattern()` in `packages/piece` refuses one,
absent or present, and a Home's source is changed in place, which keeps both
(`docs/common/conventions/HOME_SPACE.md`, "Custom Home Pattern").

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
