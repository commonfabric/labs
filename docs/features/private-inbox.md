# The private inbox

Every identity has one private inbox: a piece, in a space of its own, where
other principals deliver offers to the identity, such as a chat room to join.
Its offers are labeled readable by the owner alone. Anyone can append to it,
through its `receive` stream, which keeps an offer only when the offer names the
principal sending it as its sender. This document says where the inbox lives,
how Home comes to hold it, how a client such as a loom daemon asks Home for it,
what Home records when the host refuses one, how the owner replaces a refused
one, what access its space grants, what `receive` accepts, how the host admits
what it receives, and the limits on what it keeps private.

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
  as "Creating or adopting it" says, and the host's refusal of an inbox a
  profile advertises, if there is one to report, is in its
  `privateInboxRefusal`, as "When the host refuses an inbox" says. The last
  refusal the owner had Home replace, if any, is in its
  `privateInboxReplacement`, as "Replacing a refused inbox" says.
- **Each of the owner's profiles** points at an inbox through its `inbox`
  field, which `profile-home.tsx` describes. A profile space is readable by
  anyone, so the pointer is how a sender finds the inbox.

A profile may point at an inbox other than Home's, set by something else. That
pointer is left as it is.

## Creating or adopting it

An identity has one inbox. Home creates it, or adopts one a profile already
advertises, such as one a loom daemon created, if the inbox is usable, and
nothing replaces a pointer that names a different inbox. A client that would
otherwise create an inbox of its own, as a loom daemon does, asks Home for it
instead through Home's `requestPrivateInbox` stream when Home has that stream,
and adopts the inbox the profile it names then points at, as "Requesting it"
says.

A loom daemon that creates a share inbox of its own and points a profile at it,
because Home has no such stream or because the daemon does not ask, races Home
for the pointer. When both arrive together, as when a new person's Home and
daemon first come up, each can read the pointer before the other sets it, and
the one that sets it last decides what it names. Each side then adopts again,
deciding by the same profile, the one `#profile` answers with: Home adopts the
inbox that profile advertises in place of another, and a loom daemon adopts a
pointer that moved; each keeps reading the inbox it held. A loom daemon does its
half as loom #7300 describes; the loom release that carries it is what the two
halves wait on.

The host gives Home its inbox, normally once per runtime worker, when it first
brings up the user's Home pattern: `PiecesController.ensurePrivateInbox()` in
`packages/piece`, called from `RuntimeProcessor` in `packages/runtime-client`,
which does it through `ensurePrivateInboxOf()` in
`packages/piece/src/ops/private-inbox.ts`.

A worker brings up Home when a client asks it for any of three things, and the
first of them in a worker starts the ensure: to ensure Home is running
(`ensureHomePatternRunning()`), to create a space (`createSpace()`), or for the
root pattern of the identity's own Home space to run (`getSpaceRootPattern()`,
unless the request passes `start: false`). The shell asks for the last of these
when it shows Home. Whatever it shows, it also asks its worker, once per
runtime, to ensure an existing Home is running, as soon as the first piece
shown under that runtime is on screen and the view has settled: the worker is
idle, and what it rendered has reached the page. That request passes
`existingOnly`, so it brings Home up only where Home's root already records
the pattern it runs. Where Home has no root, or has one another writer is
still creating, which records no pattern yet, it creates nothing, starts
nothing, and starts no ensure. The share intake reads the inboxes Home holds
and registers offers in Home's catalog, so without Home it has nothing to do. So
any page of the shell that shows a piece starts the ensure for a user
whose Home exists, and Home's start stays off the path to that first piece. A
page whose view fails to load a piece starts none. None of these waits for the
ensure. A client's `idle()` does: the worker answers it once the ensure, the
adoption of name-only entries, the repair that makes each of the user's profiles
its space's root (see "Profile" in
[`HOME_SPACE.md`](../common/conventions/HOME_SPACE.md)), and the share intake's
start have finished, and the intake has taken up every change it has been told
of. A step that fails has finished too: its failure is logged, and `idle()`
resolves all the same. The ensure has finished once Home's handler has run on the event it sends
and that run has committed, which under server execution is on the server, after
the event itself has committed. The shell's
`commonfabric.viewSettled` waits for its own request to bring Home up as well,
from the moment it decides to make one, so a page that has settled has none of
this still running. A request for another space's root starts no ensure, nor does a read
of Home's root with `start: false`, which reads what the root exported
without running it. The `cf` CLI brings Home up through `PiecesController`
directly and never starts one.

The ensure decides by one profile: the first,
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

The host then sends Home's `ensurePrivateInbox` stream. When the inbox is
usable, the event names it as the inbox to adopt, and names the deciding
profile. When it is not, the event names the refusal instead, with its reason
and the refused inbox, and the deciding profile. When the deciding profile
points at the inbox Home holds, the event names that profile and nothing else,
and when no profile points at an inbox it names nothing. A Home pattern without
the stream is left alone. Home's handler
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
  `piece.private-inbox`, and Home records the refusal, as "When the host
  refuses an inbox" says. A loom daemon likewise leaves an unusable pointer
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
execution on and off; keeping, adopting, adopting again, refusing and recording
a refusal are tested there, by `packages/patterns/system/private-inbox.test.tsx`
and, vetting rule by rule, by `packages/piece/test/ops/private-inbox.test.ts`.

`retainedPrivateInboxes` holds a link to each inbox Home gave up, in the order
it gave them up, and never the one it holds: adopting an inbox the list holds,
as when a profile is pointed back at it, takes it out. It is there so that the
offers senders delivered to an earlier inbox stay readable, and the share
intake reads them, as "The share intake" says. Like `privateInbox`, nothing
clears it.

Home adopts again only when an ensure runs, which is at a runtime worker's first
bring-up of Home, and again at the worker's next bring-up of Home if that ensure
failed. So when a pointer moves away from the inbox Home holds, as when a daemon
writes the pointer last or the owner points a profile elsewhere, Home goes on
holding the earlier inbox while senders deliver to the new one, until the next
runtime worker to start brings Home up. Nothing watches the pointers in between.
A loom daemon instead reads its profile's pointer again at intervals. A daemon
that asks Home for the inbox, as "Requesting it" says, writes no pointer of its
own, so the pointer moves this way only for a daemon that creates its own inbox,
or when the owner points a profile elsewhere.

Home opens without waiting for the ensure, which reads every profile's pointer
and loads inbox documents in other spaces. The ensure itself waits for Home's
handling of the event it sends: it finishes once the handler's run has
committed, on the server under server execution, and fails when that run
fails. Either kind of failure, one raised while sending the event, such as Home
failing to come up, or one inside the handler, is logged, and the next time
that worker brings up Home it sends the event again.

A profile is pointed in one of three ways:

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
- **When the owner replaces a refused inbox**, as "Replacing a refused inbox"
  says: every profile in Home's list that points at the refused inbox.

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

The host, the handler, the pointing and re-pointing steps, the seed step and
the answers to requests for the inbox read each profile's pointer, and the
handlers read the inbox the event names to adopt, the inbox Home holds, the ones
it retains, the one its refusal record names and the one its replacement record
names, as a typed link,
`Cell<ShareInboxPiece>`; the host reads it through `inboxPieceLinkSchema` in
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

The handler reads the inbox an event names as refused through the same typed
link, for a narrower reason. That link travels in the event, which carries no
label of its own, so read untyped it joins nothing; with server execution on
and the event drain delivering the run, a handler reading it as
`Cell<unknown>` keeps its event. What the type bars is naming a labeled member
of the inbox's result through it, such as `offers`: read that way, the run joins
the inbox's label and the event is lost. The copy Home's refusal record stores
is a different matter: it names the refused inbox's result document, as an
adoption's link does, so like Home's holder it carries the label the refused
inbox's owner gives its offers, and any reader of the record's `inbox` reads it
as the typed link. The notice in Home's UI, as "When the host refuses an inbox"
says, reads the record's `reason` and `refusedAt` and never its `inbox`.

`private-inbox.pointer-type.test.ts` fails to compile if any reader's pointer
type, the host's, the ensure's and the pointing step's, the seed step's, the
profile's own, the event's refused inbox or Home's holder, retained list,
refusal record and replacement record, becomes unconstrained, or names a member
of the inbox's result other than its name. For the event's refused inbox, the
second of those is the one the measurement above bears out.

The read and the `setInbox` it leads to are two transactions, in Home's space
and then in the profile's, so the event carries `replacing` and `setInbox`
checks the pointer again in the transaction that writes it: holding
`undefined` from `pointAtInboxIfUnset()`, and holding a link to the refused
inbox from `pointAtInboxInPlaceOf()`. A pointer that something else sets
between the two,
such as a loom daemon pointing the profile at a share inbox it has minted, is
kept, and the profile goes on advertising it. Two senders racing to point the
same unpointed profile both read it unset, and the one that commits second
finds its commit stale, runs again, and leaves the first one's pointer. A
profile still running a `setInbox` that predates the condition ignores it
and sets the pointer as sent, so on such a profile a pointer set in between is
still replaced, until the profile runs the current handler.

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

## Requesting it

A client that reads the owner's offers, such as a loom daemon, gets the inbox
from Home rather than creating one, so that the inbox senders find through a
profile is the one Home and the client both read. It sends Home's
`requestPrivateInbox` stream an event naming the profile it finds the owner
by, the one `#profile` answers with, under `from`: `{ from: <profile> }`, where
the profile is a link to it. Event schemas are open, so a field the event
carries beyond that is dropped.

Home's handler, `requestPrivateInbox` in `private-inbox.tsx`, sends Home's
`ensurePrivateInbox` an event naming nothing. So Home keeps the inbox it holds,
creates one when it holds none and no profile advertises one, and points every
profile in its list that points at no inbox at its own, as "Creating or
adopting it" says. It adopts nothing: adopting an inbox a profile advertises
waits on the host's vetting, at the next ensure the host sends.

The handler's result, which is its handling's receipt, is a link into Home's
answers. The handler records the profile the request names, by the space and
the entity of the profile's own document, in Home's `privateInboxRequests`, and
`PrivateInboxAnswering` computes, once for all of them, with
`privateInboxAnswersOf()`, an answer for each profile so recorded, filed under
that key, and one each for a request naming no listed profile and for one
naming a profile without `setInbox`. So a request leaves nothing running,
however many are sent, and the receipt reads whatever the answer it links to
reads now. A receipt answers for the profile it was sent for whatever else
leaves or joins Home's list, and once that profile leaves the list its
answer is `unlisted`. An answer holds `status`:

| `status` | The profile `from` names | Final |
| --- | --- | --- |
| `pending` | is in Home's list and points at no inbox, and Home is pointing it at the inbox it holds or creates | no |
| `ensured` | points at the inbox Home holds | yes |
| `unlisted` | is not in Home's list, or has left it since the request, or the event names none, so Home points it at nothing | yes |
| `unpointable` | has no `setInbox`, through which alone Home points a profile | yes |
| `not-held` | points at an inbox other than the one Home holds, as when something other than Home sets its pointer first, which Home never replaces, or points anywhere while Home holds none, or points at none while Home holds none and creates none, because another profile advertises an inbox that awaits the host's vetting | yes |

The profile is pointed in events after the handler's run, Home's pointing step
and then the profile's own `setInbox`, so `ensured` comes only once the
profile's pointer names Home's inbox, and every way that pointer can come to
name something else is a final status rather than a `pending` that never ends.
The handler reads whether the profile has `setInbox` from Home's list, bound
as a value, so it decides only once the profile has loaded.

One way the pointer can fail to come is not a final status: the profile's
`setInbox` run refused, as by Contextual Flow Control or a write policy. A
refused run records nothing, and the pointing step's send gives Home no word
of how the profile handled it, so Home cannot tell a refused pointing from one
still on its way, and the answer stays `pending`. A client's own abort is the
only way out of that wait. The answer holds
no link to the inbox: a link to an inbox carries the label its
owner gives its offers, which would then reach every run reading Home's
answers. Once a request is `ensured`, the client reads the inbox from the
profile's pointer.

A client reads the answer without polling. It sends the event through
`sendEvent()` with a completion callback, reads `handlingReceiptLink` from the
transaction the callback receives, and subscribes to the cell at that address
until the answer is not `pending`, as the share intake reads the result of
Home's `registerSharedSpace`. The callback's transaction reports a failure of
the send or of Home's handling as an error status, and carries no receipt
address unless the runtime writes receipts, which it does with commit
preconditions or server execution on. For `ensured`, the client then reads the
profile's `inbox.piece`, through the typed link `inboxPieceLinkSchema` in
`packages/piece/src/ops/private-inbox.ts`, for the reason every reader of the
pointer does, as "Creating or adopting it" says, and waits for the pointer to
name an inbox.

Under server execution, the serving runtime runs Home's handler, writes the
receipt and runs `PrivateInboxAnswering`, as part of Home, so it is the
serving runtime's answers the receipt links to. A client whose runtime runs
Home too computes them as well, as a speculative preview over its own view,
which shows the server's writes with that runtime's previews of Home's
handlers over them. That view can pair values from different moments, and an
answer computed over it can be one the server never gives: `not-held` for a
profile pointing at the inbox Home holds. So a client reads the answer, and
then the profile's pointer, past its own speculation, as `readDurable()` does
(see [Transaction Commit](transaction-commit.md)). It reads again on each
change its subscription to the receipt delivers, and once the speculation
layers over what it read have settled, since a write arriving beneath a layer
changes nothing the subscription sees. A client's runtime can also settle
before the served pointer write reaches it, so a read taken once that runtime
has settled can still find `pending` while the served answer is already
`ensured`, and the next read after that write arrives finds `ensured`. A
client subscribed to the receipt, as `requestPrivateInboxOf()` is, reads
again when that write arrives.

`requestPrivateInboxOf()` in `packages/piece/src/ops/private-inbox.ts` is the
host's implementation of that client. It returns `ensured` with the inbox,
`unlisted`, `unpointable` or `not-held`; `unavailable`, sending nothing, for a
Home without the stream; and `abandoned` once the caller's signal aborts while
it waits. It rejects when the send or Home's handling fails, when the handling
writes no receipt, or when Home answers with a status the host does not know.

A client tells the cases apart by what Home has and what it answers:

- **No Home, or a Home without the stream**, as one whose source predates it:
  the identity's Home space has no root, or `requestPrivateInbox` at Home's
  root holds nothing. The client sends nothing, and goes on as it would
  without a Home: a loom daemon creates its own inbox, and the race in
  "Creating or adopting it" applies to it.
- **`ensured`**: the client reads the inbox the profile points at, which Home
  holds.
- **`unlisted`, `unpointable` or `not-held`**: Home will not have that profile
  advertise its inbox. The client goes on as it would without a Home, a loom
  daemon adopting the inbox the profile advertises, if it is usable, and
  creating its own when the profile advertises none.
- **A failure** of the send or of Home's handling: nothing about the inbox is
  decided. Sending the request again is safe, since the ensure it sends creates
  and re-points nothing more once it has run.

Two requests in flight at once over a Home holding no inbox send two ensures,
and with server execution off the second one's commit, across Home's space and
the inbox's, can find the first one's changes. The runtime logs that under
`storage.v2.multi-space-commit` as an error, and both requests still end at the
one inbox.

`packages/patterns/system/private-inbox-request.test.tsx` tests the answers,
`packages/piece/test/ops/requestPrivateInboxOf.test.ts` the host's client, and
`packages/patterns/integration/private-inbox-multi-runtime.test.ts`, with
server execution on and off, requests through the receipt: two at once
answered with the one inbox both profiles point at, each linking to Home's one
answer for its profile; a receipt still answering `ensured` for its own
profile once an earlier profile leaves the list, and one for the profile that
left answering `unlisted`; one for a profile something else pointed elsewhere
answered `not-held`, one for a profile without `setInbox` `unpointable`, one to
a Home with no profiles `unlisted` while the Home creates its inbox, and one to
a Home without the stream sending nothing.

## When the host refuses an inbox

Home's `privateInboxRefusal` holds, under `refusal`, the host's refusal of the
inbox the deciding profile points at: `reason`, the host's code for why the
inbox failed vetting, as the event named it, trimmed and cut to
`REFUSAL_REASON_MAX_LENGTH` (64), which today is one of `InboxAdoptionRefusal`'s
codes in `packages/piece/src/ops/private-inbox.ts`, such as
`inbox-adoption-acl-mismatch`; `inbox`, a link to the inbox refused; and
`refusedAt`, when Home first recorded this refusal, of this inbox for this
reason, by the handler's clock, which reads to the second. Home stores the code
as given rather than checking it against the host's list, so a newer host's code
needs no change to Home. The host's refusal codes don't map one for one onto
loom's: `inbox-profile-space` is the host's alone, loom has a code for a
malformed pointer that the host doesn't, and the host checks the access list
before `offers` and `receive` where loom checks them after, so an inbox failing
more than one check can get different codes from each. With no `refusal`, there
is no refusal to report. It is there so that the owner, and what acts for them,
can learn that shares may not reach them: senders deliver to the inbox the
profile advertises, which Home does not read.

Home's handler records the refusal an event names, in place of a different one
recorded before, under the check it makes of an adoption: the profile the event
names is in Home's list and still points at the refused inbox, and that inbox is
not the one Home holds. So an event that a moved pointer has left behind, one
naming no profile, and one refusing the inbox Home holds, as a refusal that lost
a race to an adoption of the same inbox does, record nothing. A repeat of the
recorded refusal, of the same inbox for the same reason, keeps its time and
writes nothing. The record is cleared when Home adopts or creates an inbox, when
the profile an event names is in Home's list and points at the inbox Home holds,
and, on any event that records no refusal, when no profile in Home's list points
at the refused inbox any longer, by the comparison the check uses. So once no
profile points at the refused inbox, whether its pointers moved to another inbox
or to none, the next ensure clears the record, or records in its place a refusal
it names. Like every other ensure, that runs only at a runtime worker's bring-up
of Home. Apart from the ensure, the record is cleared when the owner replaces
the refused inbox, as "Replacing a refused inbox" says.

The record is a field of Home's result, `privateInboxRefusal`, so `cf` and an
agent each read it as they read any other field of Home, at Home's root, the
link the `#default` wish answers with in the Home space
(`docs/common/conventions/HOME_SPACE.md`, "Custom Home Pattern"). Being a field
of Home, it lives in the owner's Home space. Home's `ensurePrivateInbox` is a
stream on its result, and its handler does not ask who sent an event, so the
owner's own code can record a refusal of any listed profile's inbox, with any
code, or clear the record, as it can move Home between two inboxes its profiles
advertise.

While the record holds a refusal, Home shows a notice above its tabs, whichever
tab is open, saying that what others share may not arrive. It shows the code,
with a sentence saying what the code means when it is one of the host's codes,
`INBOX_ADOPTION_REFUSALS` in `packages/piece/src/ops/private-inbox.ts`, and
`refusedAt`, in UTC, with the zone named. Home's sentences are in
`packages/patterns/system/private-inbox-refusal-text.ts`, and
`private-inbox-refusal-text.test.ts` beside it fails while one of the host's
codes has none. The sentence for `inbox-adoption-acl-mismatch` names the likely
case, a loom daemon of the owner's running as another identity, for which loom
shares still arrive at the daemon. The pattern sandbox formats a date given no
zone in UTC and one given a zone in that zone, while a date's local getters read
the host's zone, so the notice gives UTC explicitly. It reads the record's
`reason` and `refusedAt` and nothing else, so it never reads through the
record's link to the refused inbox, and nothing the refused inbox's owner labels
reaches Home's rendering. A code Home doesn't know is shown as given, and an
empty one as `none given`. The notice carries a "Use a new inbox" button, as
"Replacing a refused inbox" says, and says that a loom daemon running as another
identity than the owner's stops receiving loom shares once the owner uses it.
The notice goes when the record is cleared.
`packages/patterns/system/home.test.tsx` tests it, and
`home-refusal-notice.test.tsx` beside it, with the refused inbox created by
another user, checks that `inspectConfLabel` reports no user's label on the
notice's sentence, where it reports one once the computed producing the notice's
text reads the refused inbox's offers. It covers the notice's text only: the
same read in the computed that decides whether the notice shows, or in another
computed the notice renders, leaves the test green.

A Home of a vintage whose ensure takes no refusal is sent the same event. Event
schemas are open, so its handler is delivered the fields it declares, `adopt`
and `from`, and not `refused`, whose link it does not follow; it keeps what it
holds, as for an event naming nothing. A host of a vintage that names no
refusal sends a newer Home an event naming nothing, so Home records nothing,
and clears a record only when it adopts or creates an inbox, or when no profile
points at the refused inbox.

## Replacing a refused inbox

The owner can have Home replace the refused inbox, from the button on the
notice. Home's `replaceRefusedPrivateInbox` stream, which the button sends,
does nothing while the record holds no refusal. Otherwise it:

1. keeps the inbox Home holds, or, when Home holds none, creates Home's own, as
   the ensure creates one, in the space named `private-inbox` in Home's space;
2. clears the refusal record;
3. records the refusal it acted on in `privateInboxReplacement`, under
   `replacement`: the refused inbox, as a typed link; the refusal's `reason`
   and `refusedAt`; and `replacedAt`, when the owner acted, by the handler's
   clock;
4. queues a second event, as the ensure queues its pointing, because a created
   inbox's result document exists only once the first event's transaction has
   committed. That event has every profile in Home's list that points at the
   refused inbox, by the comparison the ensure uses, point at Home's inbox,
   through the profile's own `setInbox`, with the inbox's own result document.
   It reads the refused inbox from `privateInboxReplacement` rather than from
   its event.

A profile pointing at any other inbox, or at none, is left as it is, for the
ensure to decide. The refused inbox does not go into `retainedPrivateInboxes`:
Home never held it, and its offers carry the label its own owner gives them.
Once the deciding profile points at the inbox Home holds, the next ensure keeps
it, as "Creating or adopting it" says.

`privateInboxReplacement` is a trusted-action write. Only the replacement
handler may write it, and only for an event the renderer marks as a click on
the trusted surface the notice declares, `PrivateInboxRefusalSurface`, with the
action `ReplaceRefusedPrivateInbox`. So a send of the stream that no such click
marks is refused, together with everything else its run writes and sends: no
inbox is created, the refusal stays recorded, and no profile is re-pointed. The
mark certifies that the event came from Home's rendered surface, so no pattern's
code can replace the inbox. A principal holding the owner's key is trusted, and
may issue the event headlessly, as "Policy record: trusted-mark threat model" in
[`host-embedding.md`](host-embedding.md) says; keeping untrusted code from that
key is the system's job. The second event can be sent without a click, but it
only re-points profiles from the inbox the owner chose to replace.

When the refused inbox is Home's own, in the space named `private-inbox` in
Home's space, the inbox Home creates is another piece in that same space. The
refused piece keeps its offers as they were, and Home no longer reads them, as
it reads no refused inbox. Since the new piece is in the refused one's space,
replacing helps when what the host refused is the piece, as for
`inbox-offers-invalid` or `inbox-receive-missing`, and can't help when it is the
space's access list. Even then the replacement clears the record, and the notice
doesn't come back: the deciding profile now points at the inbox Home holds,
which the host keeps without vetting it again.

A loom daemon reads its profile's pointer again at intervals, and when the
pointer names another inbox it adopts that inbox if the inbox's space grants
the daemon's own identity `OWNER` and every principal `WRITE`, keeping the inbox
it had among those it reads. A daemon running as the owner's identity therefore
adopts Home's inbox at its next reading and goes on reading the refused one. A
daemon running as another identity refuses Home's inbox, which grants that
identity no `OWNER`, and leaves the pointer as it is. Senders then deliver to
Home's inbox, where the share intake skips loom offers, as "The share intake"
says, so that daemon stops receiving loom shares. The daemon never re-points a
profile that already points at an inbox, so the two don't contend for the
pointer.

The replacement never clears a profile's pointer, only replaces one, so it
doesn't depend on how a cleared pointer reads.

One case the replacement can't handle: the refused inbox is one the owner could
read when the profile was pointed at it, and its space has since revoked the
owner's `READ`. With server execution off, the default, a runtime of the owner's
started after the revocation can't replace it. `privateInboxReplacement` keeps a
typed link to the refused inbox, and CFC refuses the commit for want of that
inbox's label, so nothing changes: no inbox is created, no profile is
re-pointed, and the refusal stays recorded. The owner sees nothing happen. The
notice stays as it was, Home shows no error, and the refusal shows only as a
warning in that runtime's log. A runtime that loaded the refused inbox's label
before the revocation replaces it, and so does the serving loop with server
execution on; a runtime started after the revocation has no way to load it.
`private-inbox-multi-runtime.test.ts` pins the refusal, as a step marked to
change once the record keeps the replaced inbox without the typed link.

Replacing, refusing a send no click marks, re-pointing only the profiles that
pointed at the refused inbox, replacing an inbox whose space has revoked the
owner's `READ`, and replacing Home's own inbox without touching its offers are
tested by
`packages/patterns/integration/private-inbox-multi-runtime.test.ts`, with server
execution on and off, and by `packages/patterns/system/private-inbox.test.tsx`.

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
`OWNER` entry on the offered `space`, and the share intake checks the same.

## The share intake

The host reads the owner's offers and registers the ones it admits in Home's
shared-space catalog, which
[`shared-space-catalog.md`](shared-space-catalog.md) describes. The intake is
`ShareIntake` in `packages/piece/src/ops/share-intake.ts`, which
`PiecesController.startShareIntake()` starts over the identity's Home, and
`RuntimeProcessor` starts it beside the ensure, the first time a runtime
worker brings up Home. Home opens without waiting for it; a failure to start
it is logged, and the worker's next bring-up of Home starts it again. It runs
until the processor is disposed. The shell brings an existing Home up on any
page that shows a piece, once that page has settled, as "Creating or adopting
it" says, so an offer is taken up while any such page of the user's is open,
and not only while Home is. A Home pattern without a `registerSharedSpace`
stream is left alone.

It subscribes to Home's `privateInbox` and `retainedPrivateInboxes`, and to
the `offers` of every inbox they name, so an inbox Home comes to hold or
retain, and an offer arriving in any of them, is taken up as it lands, with no
restart. It reads the pointers through `inboxPieceLinkSchema`, as the ensure
does.

An offer of `kind` `loom` is skipped, since a loom daemon admits those; so is
an offer whose `from` and `id` already key a receipt in the catalog. Any other
offer is registered when:

- its envelope is well formed: `space` and `from` are well-formed DIDs, `host`
  is an origin, as `normalizeSpaceHost()` reads one, `ownerOrigin` is empty,
  as `receive` keeps one it was not given or could not read, or else such an
  origin, every string fits the length `receive` cuts it to, and `sharedAt` is
  a nonnegative integer;
- its `kind` is one the intake admits, which `ADMITTED_SPACE_KINDS` in the
  intake's module lists: `fabrichat-room`, a kind of space as
  [`space-kinds.md`](space-kinds.md) lists it. An offer of any other kind is
  refused, and stays in the inbox for a reader that knows it;
- its `host` is the origin of the host the intake runs against, the one whose
  memory it can read, with both normalized as `normalizeSpaceHost()` normalizes
  a host, so a default port or a trailing slash makes no difference;
- `from` holds a `WRITE` or `OWNER` entry of its own in the access list of
  `space`; a grant to every principal, `"*"`, does not count, since any
  principal holds that;
- the owner can open `space` and holds `WRITE` or `OWNER` there, through an
  entry of its own or the grant to every principal;
- `space` declares the offer's `kind` as its own, in its genesis commit, as
  `Runtime.spaceKind()` reads it;
- `space` has a root, its space cell linking a piece in `space` itself, and
  that piece is at the address the space's genesis commit reserves for a root
  `inSpace()` makes with `root: true`: the address `inSpaceRootCause(space)`
  derives in `space`.

The kind check reads the kind the space's creator declared, which nobody can
change afterward, so it is the creator's claim and no more; the intake loads
and runs none of the space's code to read it. A space created without a kind
never has one, so an offer of it is refused, whatever its root. The root check
is what a `fabrichat-room` space's contract asks of a reader beyond the claim,
as "What a kind does not vouch for" in [`space-kinds.md`](space-kinds.md)
says: a member with `WRITE` can link another document as the space's root,
and the intake refuses an offer of the space while it does. A consumer of the
catalog reads the live root when it opens the space.

FabriChat's manager creates each room as its space's root, at that reserved
address, in a space that declares itself a `fabrichat-room`, so an offer of a
room it creates passes both checks while the space's root stays at that
address. A room in a space created without a kind is refused, as above,
however it was made.

Each refusal has a reason of its own, which its log entry names. A final one
decides its row for good, and any other leaves the row to be vetted again, as
the paragraph below on deciding rows says:

| Reason | The offer | Final |
| --- | --- | --- |
| `offer-malformed` | has an envelope that is not well formed | yes |
| `offer-kind-unknown` | is of a `kind` the intake does not admit | yes |
| `offer-foreign-host` | names another host | yes |
| `sender-not-member` | names a `from` holding no `WRITE` or `OWNER` entry of its own | no |
| `recipient-access-refused` | names a space the owner cannot open, or holds no `WRITE` or `OWNER` in | no |
| `space-kind-undeclared` | names a space declaring no kind | yes |
| `space-kind-mismatch` | names a space declaring another kind | yes |
| `space-root-missing` | names a space whose root is no piece of the space | no |
| `space-root-misplaced` | names a space whose root is not at the address its genesis reserves | no |

The intake sends Home's `registerSharedSpace` the offer's `space`, its `host` as
normalized, its `kind`, its `title` unless it is empty, and `{ from, id }`. It
sends no `since`, so Home's handler records the time it admits the entry, as the
catalog's `since` requires, rather than the sender's `sharedAt`. The handler
reads only Home's own catalog, never an inbox pointer, so the hazard an untyped
pointer read carries, above, cannot reach it. Registration is insert-if-absent,
so an offer of a space already in the catalog under the same host and kind,
archived or not, adds a receipt and leaves the entry as it is; one under another
host or kind is a `conflict`, which writes nothing.

When Home's handler returns `registered`, a new entry, the intake then accepts
the room on the owner's behalf: it sends the space's root, the one vetting read,
to Home's `chatManager.accept`, when Home has that stream, with `keepArchived`
set. The manager records the room as an acceptance from the room itself would.
A direct room goes in its `direct` under the room's creator, unless `direct`
already holds a room with that creator, which stays; either way, the owner's
later start of a chat with that creator finds the room `direct` holds rather
than creating another. The acceptance also adds the owner's profile to the
room's participants. `keepArchived` leaves the entry archived if the owner has
archived it since the registration, so an acceptance the owner didn't make never
lists a room they forgot. An entry that was already there, archived or not, gets
no acceptance (see
[`ChatManagerOutput`](../specs/fabrichat/ChatManagerOutput.md)). A send to the
manager that throws is logged under `piece.share-intake`.

Each row of an inbox is decided by its whole content, so a row that names
another offer's `from` and `id` decides nothing about that offer. A row the
intake sent, skipped for its receipt, or refused for something in the row itself
(its envelope, its `kind` or its `host`) or for the kind its space declares,
which never changes, is decided for the life of the runtime worker. A row
refused for the state of its space (the access list, or the root) is vetted
again the next time the offers of its inbox change; a change to the space alone,
such as a grant to the sender or a root linked back at its reserved address,
does not bring that about. A refusal is logged once per row, as a warning under
`piece.share-intake`, with its reason. When Home's handler returns a `conflict`
for a row it was sent, as for a space the catalog already holds under another
kind, the intake logs that once too, with the reason. A failure to read what
vetting needs, other than a refusal of access, is logged, and the row is vetted
again when its inbox next changes. So is a space whose kind the host cannot
tell, as when it does not report kinds, and a send to Home that throws. A
catalog that cannot be read is taken to hold no receipts, since Home's handler
refuses a duplicate in any case. The intake removes and marks nothing, so every
offer stays in its inbox, and another reader, such as a loom daemon, reads them
all.

## Joining a room the user visits

The labs shell counts a visit to a FabriChat room's page as joining the room.
Each time a runtime shows a piece of a space other than the last one it showed,
the shell waits for Home's bring-up to answer and for the view to settle, and
then asks the worker, through `RuntimeClient.joinVisitedRoom()`, to join the
user to the room in that space. The worker does nothing for a user with no
Home, and creates none. If Home has no `chatManager.joinRoom` stream, it
returns `no-chat-manager` without vetting. Otherwise it requires write access
to the visited space, through the user's own entry or the grant to every principal, and uses
the space's declared kind to select its locator:

- A `fabrichat-room` uses the same strict vetting as a share offer
  (`vetSpace()` in `packages/piece/src/ops/space-vetting.ts`): its root is a
  document of that space at the address its genesis commit reserves.
- Every other kind, including an undeclared kind, uses the root's explicit
  `chatRoom` link. The root must be a document of the visited space; its
  address need not be reserved. The link may follow aliases, and must resolve
  to a room document in that space or to the root of a foreign standalone
  `fabrichat-room` space that passes strict vetting, including write access.
  Inline objects and links to paths inside a document are refused. A missing
  declaration yields `chat-room-missing`; a malformed one yields
  `chat-room-invalid`. The host infers nothing from room-like fields.

A passing visit sends the room to Home's `chatManager.joinRoom`, when Home has
that stream, with no `requestId`. A declaration-based join also sends the
root as `container`; the manager verifies that its `chatRoom` names the same
room (`joinVisitedRoomOf()` in
`packages/piece/src/ops/join-visited-room.ts`). Visiting a container counts as
visiting its declared chat. A placement with no declaration is outside this
locator contract. The share intake still requires a standalone room.

The manager makes the room one of the user's chats, and, once the user's
profile has resolved, adds them to its participants; a room their chats list
already is left as it is, and nothing is recorded for it (see
[`ChatManagerOutput`](../specs/fabrichat/ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput)).
A join restores an archived entry, so visiting a room the user forgot lists it
again. So a person who opens a joinable group's link, or a room they were
admitted to and offered nothing, finds it among their chats without a step of
their own. Which visits count as joining is the shell's choice: another host
makes its own, and the room pattern makes none.

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
