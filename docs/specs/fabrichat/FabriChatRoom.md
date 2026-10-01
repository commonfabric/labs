# FabriChatRoom

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
which states everything a room does: where it lives, its membership, its facts,
and its streams. This document says how this implementation does it.

Its records and surfaces are named for the contract rather than for the
implementation, because they are part of the contract: `ChatMessage`,
`ChatReaction`, and the surfaces the table under [writers](#writers) names.

## Space hookup

The space record's `chat` field holds the canonical room link. The `/` wish
reaches that record even before a host installs its `defaultPattern`. The
manager registers a newly allocated room there before publishing it. The
standalone entry point claims an empty slot in the same transaction that
initializes the room, so competing starts converge on one link. The default
app's Chat link opens this entry point and reuses the registered conversation.
The slot, like the rest of the space record, is governed by the space ACL.

## State

The room keeps these `PerSpace` values, shared by everyone the space admits:

- The contract's own records: `about`, its messages, and `recentActivity` with
  its next `seq` and `recentActivityExpiredThrough`. Messages and reactions are separate authored documents, linked from the
  room and projected in recorded-time order.
- The request memory: the requests the room has acted on, by sender and
  `requestId` (see [writers](#writers)).
- The times the room has used, so it can make each new one unique.

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

Messages and reactions are separate `AuthoredByCurrentUser` documents with
`WritePolicyAnyOf` branches for their permitted reviewed writers. The runtime
labels each document with its writer and rejects a write without the required
gesture. The composer captures exact submitted text and uses the gesture's
handler clock as the proposed time.

Every handler first checks its event's sender and `requestId` against a keyed
collection of the requests the room has acted on, and does nothing for one it
finds. It records the request there in the same transaction as its effect, and
retains the request for the room's lifetime. The runtime does not establish
a finite maximum event redelivery delay, so finite retention would allow an old
request to recreate removed content. Request memory retains no message body.

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

`commitSendReaction` and `commitDeleteReaction` are explicit idempotent
operations. Each reaction is a separate authored document referenced from the
message's reaction collection. A transaction reads that collection to find the
reactor/profile and emoji pair before adding or removing it; concurrent changes
conflict and rerun against the accepted collection. Message creation and editing
do not receive the reaction documents' writer authority. Deletion and
obliteration may clear them.

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`, written once by the
handler that creates the room, so it is labeled with its creator. `canSend` is
computed for each viewer from their access and whether their profile resolves.

Every handler that changes the room's own record appends its `recentActivity`
entry in the same transaction as the change, so the log never disagrees with the
messages. Entries older than the window are dropped as new ones are appended.
`commitObliterate`, and `commitDelete` when it obliterates, also remove the
message's earlier entries.

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

## Runtime support

- **Private allocation.** The first factory call using a named `inSpace()`
  allocation supplies its genesis grants. The manager creates its policy there
  first, granting the creator OWNER and intended other members WRITE.
- **System participants.** The host creates the space's default pattern when
  someone opens the space. The room reads its participants through `#default`.
  Before that, the room's participants are only its message authors.
- **Session windows.** Handler event scope selects the sending session's
  `PerSession` window collection across the message-list cell boundary.
- **Separate writer authority.** Messages and reactions occupy separate
  documents with their own reviewed-writer policies.
- **Lifetime deduplication.** Request memory lasts for the room's lifetime;
  no finite delivery-delay guarantee is assumed.
- **Activity expiry.** An interval clock updates the visible activity window
  even without a write. The next activity write prunes expired stored entries.
