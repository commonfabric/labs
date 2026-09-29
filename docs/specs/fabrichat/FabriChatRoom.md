# FabriChatRoom

Status: proposed design (see [`README.md`](README.md)).

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
which states everything a room does: where it lives, its membership, its facts,
and its streams. This document says how this implementation does it.

`FabriChatRoom` is the successor to the room in today's
`packages/patterns/fabrichat/chat.tsx`, and keeps that room's record, writers,
and reviewed surfaces. What changes is where it lives, what decides its
membership, and the names of its records and surfaces, which are now neutral
with respect to the implementation because they are part of the contract (for
example, today's `FabriChatMessage` and `FabriChatSendSurface` become
`ChatMessage` and `ChatSendSurface`).

## State

The room keeps these `PerSpace` values, shared by everyone the space admits:

- The contract's own records: `about`, its messages, `recentActivity` with its
  next `seq` and `recentActivityExpiredThrough`, `roster`, and
  `outgoingNotices`. The messages are a list ordered by `sentAt`. Each message's
  reactions, and `roster`, are keyed collections, projected as lists in the
  contract.
- The request memory: the requests the room has acted on, by sender and
  `requestId` (see [writers](#writers)).
- The times the room has used, so it can make each new one unique.
- The principals who have left, which `commitAdd` checks.
- The admission order: when each member was admitted, from the room's creation
  or their `add`, which `commitLeave` reads to choose whom to promote. Members
  admitted at the room's creation are ordered by principal, so the order is
  total. This is bookkeeping, not membership: the access list still decides who
  is a member. Once the runtime provides member sets, the order can come from
  them instead.
- The membership changes in progress, each under its `requestId` (see
  [membership changes take more than one
  commit](#membership-changes-take-more-than-one-commit)).

`participants` is computed from `roster` and the messages' authors, keyed by
profile cell. `messages` (its `count`, `oldestAt`, `newestAt`, and `latest`) is
computed from the messages, and `canSend` from the reader's access and profile,
when they're read. Neither is stored.

`session` is a sub-pattern the room instantiates per session, as a `PerSession`
value, over the same record: it holds the composer's state, and the session's
windows. Its state comes into being with the session's first write to it, so a
session that only reads, as a READ member's does, has none. The composer is the
room's own reviewed surface, reading its state from the session, so two
placements of the same room open in one session show the same composer state, as
one conversation shown twice should.

## Writers

Every write goes through one handler per stream:

| Handler | Stream | Reviewed surface |
| --- | --- | --- |
| `commitSend` | `sendMessage` | `ChatSendSurface` |
| `commitEdit` | `editMessage` | `ChatEditSurface` |
| `commitDelete` | `deleteMessage` | `ChatDeleteSurface` |
| `commitObliterate` | `obliterateMessage` | `ChatObliterateSurface` |
| `commitSendReaction` | `sendReaction` | `ChatReactSurface` |
| `commitDeleteReaction` | `deleteReaction` | `ChatReactSurface` |
| `commitShowProfile` | `showProfile` | none |
| `commitLeave` | `leave` | none |
| `commitAdd` | `add` | `ChatMembersSurface` |
| `commitRemove` | `remove` | `ChatMembersSurface` |
| `commitDelivered` | `delivered` | none |

`commitSend` and `commitSendReaction` keep the types of today's `commitSend` and
`commitReact`: the stored value is
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
room's own composer builds a send's `{ version: { body, sentAt }, replyTo? }`
from the text the person submitted, which today's room reads as `target.value`,
and the composer event's time as the proposed `sentAt`.

Every handler first checks its event's sender and `requestId` against a keyed
collection of the requests the room has acted on, and does nothing for one it
finds. It records the request there in the same transaction as its effect, and
the collection drops a request once it was recorded longer ago than the greater
of `proposedTimeMaxAgeNsec` plus `proposedTimeMaxLeadNsec`, and
`recentActivityWindowNsec`. The collection keeps a request even after its
message is obliterated: it says only that the sender made a request, not what,
and without it a late redelivery of the original send would send the message
again. The two bounds of its window for proposed times are constants of the
pattern, documented beside it.

`commitEdit` and `commitDelete` are admitted only for the message's own sender.
`commitEdit` moves the current version into `earlierVersions` before recording
the new one. `commitDelete` records the deletion and clears the reactions, or,
when the room's `deletionIsObliteration` setting is on, does exactly what
`commitObliterate` does. They have the same kind of write policy as
`commitSend`.

`commitObliterate` is admitted for an OWNER in a group room or a space's own
chat, when the room's `ownersMayObliterate` setting is on, and for a message's
own sender in a direct room. It rewrites the message to its tombstone and clears
its reactions. So the message's write policy admits it alongside `commitSend`,
`commitEdit`, and `commitDelete`, and the reactions' write policy admits both it
and `commitDelete` alongside the reaction handlers.

`commitSend`, `commitEdit`, `commitDelete`, and `commitSendReaction` choose a
recorded time in the same transaction that records it: the chosen time, or the
smallest later time, in nanoseconds, that the room hasn't used yet (see [unique
times](ChatMessage.md#unique-times)). A room keeps the times it has used in a
keyed collection, so the check doesn't scan every message, and two records made
at once conflict and retry rather than share a time.

Today's `commitReact` toggles a reaction, which a repeated or delayed event can
turn into the opposite of what the person meant. It splits into
`commitSendReaction` and `commitDeleteReaction`, each of which changes nothing
when the reaction is already as asked.

`commitSendReaction` keeps each reaction at an address within its message
derived from its reactor's profile and its emoji (`reactionKeyFor`, which today
also takes the message). One person's one reaction to one message has a single
address in every session, which is how the room meets
[`ChatReaction`](ChatReaction.md#uniqueness)'s uniqueness rule without reading
the list. The reactions are a separately authorized part of the message:
`commitSend` and `commitEdit` can't write them, and the reaction handlers can
write nothing else (see [`ChatMessage`](ChatMessage.md#who-wrote-what)). Whether
the runtime's write policies can split one document this way is a prerequisite
to check.

`commitShowProfile` appends to `roster` as the `loom` pattern's `addParticipant`
does: a mergeable set add, so concurrent additions all land and a profile is not
listed twice.

`commitLeave` asks the host to remove the sender's own entry from the room
space's access list. When the sender is the last OWNER, it first asks the host
to grant OWNER to the remaining member admitted earliest. The room keeps the
admission order (see [state](#state)) for that. It also records the sender in a
keyed collection of principals who have left, which `commitAdd` checks.

### Membership changes take more than one commit

`add`, `remove`, and `leave` change the room space's access list, and the memory
layer requires an access-list change to be its commit's only operation (INV-12
in the [memory invariants](../memory-v2/09-invariants.md)). So none of them can
change the access list and the room's own records in one transaction. Each runs
in steps, in an order that keeps an interruption safe, and records its progress
under its `requestId`:

1. Record the intent in the room: the request, marked pending, and for `leave`
   the sender in the set of principals who have left, so the room already
   refuses to re-add them.
2. Change the access list, in a commit of its own.
3. Complete the record: the `recentActivity` entry, the notice for an `add`, and
   the request marked done.

A room finds any request left pending, and finishes its remaining steps, before
it acts on another event. So an interruption leaves at most a short gap between
the access list and the room's records, never a lasting one. Between steps 2 and
3, a member added may already have access with no notice or activity yet.

`commitAdd` and `commitRemove` ask the host to change the room space's access
list. They are the only handlers that reach beyond the room's own record.
`commitAdd` also adds a notice to `outgoingNotices`, and `commitDelivered`
removes one.

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`, written once by the
handler that creates the room, so it is labeled with its creator. `canSend` is
computed for each viewer from their access and whether their profile resolves,
as today's room computes `cannotSend`.

Every handler that changes the room's own record, except `commitDelivered`,
appends its `recentActivity` entry in the same transaction as the change, so the
log never disagrees with the messages. A membership change appends its entry in
its last step (see above). Entries older than the window are dropped as new ones
are appended. `commitObliterate`, and `commitDelete` when it obliterates, also
remove the message's earlier entries.

The session keeps `windows` as a `PerSession` keyed collection, and fulfills
`openWindow` and `closeWindow` by setting and removing entries in it. A window
is a computed selection over the record, so it stays live as the messages in it
change.

## Configuration

[`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior) leaves
some behavior to the implementation. `FabriChatRoom` has an affordance for
configuring each of them: a room's settings, read by the handlers the setting
governs, and kept apart from the room's record. The configuration itself isn't
built at first. The first build fixes each setting at an initial value:

| Setting | `ChatRoomPolicy` key | Initial value |
| --- | --- | --- |
| OWNERs may obliterate messages | `ownersMayObliterate` | yes |
| An edit or a plain deletion keeps the version it replaces | `keepsHistory` | yes, every version |
| A sender's deletion obliterates their message | `deletionIsObliteration` | no |
| How far before the clock a proposed time is accepted | `proposedTimeMaxAgeNsec` | 10 minutes |
| How far after the clock a proposed time is accepted | `proposedTimeMaxLeadNsec` | 10 seconds |
| How long an entry stays in `recentActivity` | `recentActivityWindowNsec` | 10 minutes |
| The most messages a window holds | `maxWindowCount` | 100 |
| The most windows a session can have open | `maxOpenWindows` | 50 |

These are the first build's values. Once the configuration exists, rooms can
differ from them. A room states its settings in `about.policy`
([`ChatRoomPolicy`](ChatRoomPolicy.md)), with every key present, written when
the room is created from the same settings the handlers read.

## Prerequisites

- **A private space, created from a pattern.** A host can already create a space
  whose genesis grants only its creator (`registerSpaceIdentity` with a
  `genesisAcl`). A pattern can't: `FabriChatRoom.inSpace()` works today, but the
  space it creates takes the default grants, including `"*": "WRITE"`. Exposing
  creator-only creation to patterns is the direction of [random space
  identities](../random-space-identities.md). Until then, a prototype MAY use
  `inSpace()`, and MUST say that the room is open to any authenticated
  principal.
- **Pattern-facing access control.** `commitAdd` and `commitRemove` need a way
  for a pattern to ask its host to change an access list. Today only hosts can
  do that (`ACLManager`, the runtime client's `space:setAclEntry`).
- **Leaving without OWNER.** `commitLeave` removes the sender's own access list
  entry even when the sender is only a WRITE member. Whether the memory layer
  lets a non-OWNER remove their own entry, or the host has to do it on their
  behalf, is part of pattern-facing access control.
- **Member sets.** Until the runtime provides them, the room keeps `roster` (see
  [shared spaces](README.md#shared-spaces)).
- **A session per memory session.** `session` assumes the room can give each
  memory session its own `ChatRoomSession`, instantiating the session's
  sub-pattern as a `PerSession` value (see [scoped cell
  instances](../scoped-cell-instances.md)). That fits the scoped-cell design,
  but whether the runtime supports a sub-pattern per session today is still to
  check.
- **A write policy split within one document.** A message's reactions are
  written only by the reaction handlers (and obliteration), and the rest of the
  message only by the message handlers (see
  [`ChatMessage`](ChatMessage.md#who-wrote-what)). Whether one document's write
  policies can be split between writers this way is still to check. If not,
  reactions move to a record of their own, keyed by message.
- **Redelivery ends.** Two things can make an event arrive, or run, more than
  once. A client runtime re-submits an event when it can't tell whether its
  append committed, and the memory ignores a re-submission by its event id, but
  only while the client's append queue remembers the event, which lasts as long
  as the client's process. And a served handler runs an event again until its
  run is recorded as complete. The room's request memory covers both only as
  long as it lasts (see [writers](#writers)). So the room relies on every event
  being run to completion, or dropped, within the memory, including one queued
  while its client was offline and appended much later. Whether the runtime
  guarantees this is still to check.
- **Admitting an access-list change atomically.** The steps above are the
  pattern-level answer to INV-12. A host facility that changes an access list
  and the room's records together would remove the gap between steps 2 and 3.
