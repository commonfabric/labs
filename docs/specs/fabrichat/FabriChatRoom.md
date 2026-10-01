# FabriChatRoom

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
which states everything a room does: where it lives, its membership, its facts,
and its streams. This document says how this implementation does it.

Its records and surfaces are named for the contract rather than for the
implementation, because they are part of the contract: `ChatMessage`,
`ChatReaction`, and the surfaces the table under [writers](#writers) names.

## State

The room keeps these `PerSpace` values, shared by everyone the space admits:

- The contract's own records: `about`, its messages, and `recentActivity` with
  its next `seq` and `recentActivityExpiredThrough`. The messages are a list
  ordered by `sentAt`. Each message's reactions are a keyed collection,
  projected as a list in the contract.
- The request memory: the requests the room has acted on, by sender and
  `requestId` (see [writers](#writers)).
- The times the room has used, so it can make each new one unique, each kept
  as long as a request is remembered: no new time is chosen from before the
  proposed-time window, which that span covers.
`participants` is computed from the participants the space's default pattern
lists (`wish({ query: "#default" })`) and the messages' authors, keyed by
profile cell. `messages` (its `count`, `oldestAt`, `newestAt`, and `latest`) is
computed from the messages, and `canSend` from the reader's access and profile,
when they're read. Neither is stored.

The one `PerSession` value in the contract is `messages.windows`, the session's
windows, kept as a `PerSession` keyed collection. It comes into being with the
session's first `openWindow`, so a session that only reads, as a READ member's
does, has none.

The room's `[UI]` keeps its composer's state, the draft and the reply being
composed, as a `PerSession` value of its own, so two placements of the same room
open in one session show the same composer state, as one conversation shown
twice should.

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

`commitSend` and `commitSendReaction` store a value typed
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
room's own composer builds a send's `{ version: { body, sentAt }, replyTo? }`
from the text the person submitted, which its handler reads as `target.value`,
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

A reaction is never toggled, since a repeated or delayed toggle can turn into
the opposite of what the person meant. `commitSendReaction` and
`commitDeleteReaction` each change nothing when the reaction is already as
asked.

`commitSendReaction` keeps each reaction at an address within its message
derived from its reactor's profile and its emoji. One person's one reaction to
one message has a single address in every session, which is how the room meets
[`ChatReaction`](ChatReaction.md#uniqueness)'s uniqueness rule without reading
the list. The reactions are a separately authorized part of the message:
`commitSend` and `commitEdit` can't write them, and the reaction handlers can
write nothing else (see [`ChatMessage`](ChatMessage.md#who-wrote-what)). Whether
the runtime's write policies can split one document this way is a prerequisite
to check.

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`, written once by the
handler that creates the room, so it is labeled with its creator. `canSend` is
computed for each viewer from their access and whether their profile resolves.

Every handler that changes the room's own record appends its
`recentActivity` entry in the same transaction as the change, so the log never
disagrees with the messages. Entries older than the window are dropped as new ones
are appended. `commitObliterate`, and `commitDelete` when it obliterates, also
remove the message's earlier entries.

The message list keeps `windows` as a `PerSession` keyed collection, and
fulfills `openWindow` and `closeWindow` by setting and removing entries in it. A
window is a computed selection over the record, so it stays live as the messages
in it change.

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

- **A private space, created from a pattern.** The manager's
  `FabriChatRoom.inSpace()` creates a space with a random DID whose genesis
  document names its creator as the only OWNER, plus the grants it names
  ([random space identities](../random-space-identities.md)).
- **The space's participants.** The room reads them from its space's default
  pattern, which a host creates the first time someone opens the space. Until
  then, the room's participants are only its authors.
- **Per-session state written by a handler.** `windows` is a `PerSession` cell
  linked from the room's `PerSpace` message list, a nesting the scoped-cell
  design provides across a `Cell` boundary (see [scoped cell
  instances](../scoped-cell-instances.md)). `openWindow`'s handler has to write
  the instance belonging to the session that sent the event, including when the
  handler runs somewhere other than that session's client. Whether the runtime
  does that today is still to check.
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
