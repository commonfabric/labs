# FabriChatRoom

Status: normative reference (see [`README.md`](README.md)).

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
which states everything a room does: where it lives, its membership, its facts,
and its streams. This document says how this implementation does it.

The implementation lives in `packages/patterns/fabrichat/room.tsx`. The protocol
and UI bind separate verified handlers to shared write helpers. Their stored
policies admit those named handlers with matching reviewed actions.

## State

The room keeps these `PerSpace` values, shared by everyone the space admits:

- The contract's own records: `about`, its messages, `recentActivity` with its
  next `seq` and `recentActivityExpiredThrough`, `roster`, and
  `outgoingNotices`. Messages, reactions, and activity use original document
  references. Views order messages by `sentAt`; reaction and roster handlers
  check identity before adding an entry.
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
- Membership request identities, committed atomically with their access-list
  changes and activity records.

`participants` is computed from `roster` and the messages' authors, keyed by
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
| `commitShowProfile` | `showProfile` | none |
| `commitLeave` | `leave` | none |
| `commitAdd` | `add` | `ChatMembersSurface` |
| `commitRemove` | `remove` | `ChatMembersSurface` |
| `commitDelivered` | `delivered` | none |

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

`commitShowProfile` appends to `roster` as the `loom` pattern's `addParticipant`
does: a mergeable set add, so concurrent additions all land and a profile is not
listed twice.

`commitLeave` asks the host to remove the sender's own entry from the room
space's access list. When the sender is the last OWNER, it first asks the host
to grant OWNER to the remaining member admitted earliest. The room keeps the
admission order (see [state](#state)) for that. It also records the sender in a
keyed collection of principals who have left, which `commitAdd` checks.

### Atomic membership changes

`add`, `remove`, and `leave` use `setSpaceMembers()` to commit the room's
metadata and an ACL companion together. The engine retains a separate ACL-only
commit record while making both records durable in one storage transaction
([INV-12](../memory-v2/09-invariants.md#inv-12--acl-mutation-commit-shape)). A
stale ACL conflicts. Removing one's own WRITE grant is supported without OWNER
authority; granting or removing another principal requires OWNER authority.

`commitAdd` and `commitRemove` ask the host to change the room space's access
list. They are the only handlers that reach beyond the room's own record.
`commitAdd` also adds a notice to `outgoingNotices`, and `commitDelivered`
removes one.

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`, written once by the
handler that creates the room, so it is labeled with its creator. `canSend` is
computed for each viewer from their access and whether their profile resolves.

Every handler that changes the room's own record, except `commitDelivered`,
appends its `recentActivity` entry in the same transaction as the change, so the
log never disagrees with the messages. Membership changes include their activity in the atomic data commit. Entries older than the window are dropped as new ones
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

## Runtime support

`Factory.inPrivateSpace()` allocates random creator-only spaces.
`currentPrincipal()`, `spaceMembers()`, `spaceAccess()`, and `setSpaceMembers()`
provide authenticated identity, reactive membership, access status, and atomic
membership changes. The [membership API guide](../../features/pattern-space-membership.md)
describes these capabilities. Reactions have their own storage documents and
writer policies. Session windows use scoped cells; rendered message-card
instances explicitly use the viewer's session scope.

A shared space-wide profile roster is future work. Rooms keep contributed
profiles locally while the access list remains authoritative for membership.
