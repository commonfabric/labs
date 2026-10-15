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
- Those who joined the room: profile links, in the order they were added, a
  roster only `addParticipant` writes
  (`packages/patterns/loom/participants.tsx`).
- The title a member last set: one keyed record, absent until a member sets
  one, which only `commitSetTitle` writes. `about.title` is computed from it
  and, where it is absent, from the title `about.record` holds.

`participants` is computed from those who joined, the participants the space's
root lists when the room is not that root (`wish({ query: "#default" })`), and
the messages' authors, keyed by profile cell. A room with `about`, which only a
manager creates, is its space's root, and reads only its own roster: its
`#default` is itself. `roster` is computed from those who joined alone.
`messages` (its `count`, `oldestAt`, `newestAt`, `latest`, and `threads`) is
computed from the messages, and `canSend` from the reader's access and profile,
when they're read. Neither is stored. `viewer` and `messageRights` are computed
for each reader too, `viewer` from their profile and access, and
`messageRights` from those and the messages, for every message at once.

`participantEntries` is computed from `participants`, reading the
`represents-principal` label on each profile with `principalOf()`, and
`participantPrincipals` is computed from those entries. A profile lives in its
owner's own space, so a reader that space refuses reads no principal from it.
Both are derived per session, so each session reads instances of its own,
derived under its own access.

The `PerSession` values in the contract are `messages.windows`, the session's
windows, kept as a `PerSession` keyed collection, `participantEntries`, and
`participantPrincipals`.
The windows come into being with the session's first `openWindow`, so a session
that only reads, as a READ member's does, has none.

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
| `commitSetTitle` | `setTitle` | `ChatRetitleSurface` |

Those who joined the room are the exception. The room's `addParticipant`
stream is bound to the roster's one writer, also named `addParticipant`, which
adds a profile with no gesture and no `requestId`: it is a set-add, so a
profile already listed is not added again. The roster's write contract admits
no other writer.

`commitSend` and `commitSendReaction` store a value typed
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
room's own composer builds a send's `{ version: { body, sentAt }, replyTo? }`
from the text the person submitted, which its handler reads as `target.value`,
and the composer event's time as the proposed `sentAt`.

A successful message or reaction sends `joinRoom` to the viewer's manager
when one is available and the room is either standalone or its space's root
explicitly declares it through `chatRoom`. A declared container room includes
that root as `container`; a standalone room needs no container, including when
another space declares it. The manager's separate event checks private Home
membership and lists or restores the conversation. Joining an already listed
room without a `requestId` changes nothing. Room write handlers send their
local `joined` stream after recording the write. Its `tellManagerJoined`
handler reads the manager binding and sends `joinRoom` in a separate event,
so the transaction that stores shared messages and reactions reads neither
the manager nor its private catalog.

Every handler in the table but `commitSetTitle` first checks its event's sender
and `requestId` against a keyed collection of the requests the room has acted
on, and does nothing for one it finds. It records the request there in the same
transaction as its effect. The collection retains each request for the room's
lifetime, including after its message is obliterated: it says only that the
sender made a request, not what. The runtime supplies no finite maximum
redelivery delay, so expiring a request could admit a repeated edit or reaction.
The two bounds of its window for proposed times are constants of the pattern,
documented beside it.

`commitEdit` and `commitDelete` are admitted only for the message's own sender.
`commitEdit` moves the current version into `earlierVersions` before recording
the new one. `commitDelete` records the deletion and clears the reactions, or,
when the room's `deletionIsObliteration` setting is on, does exactly what
`commitObliterate` does. They have the same kind of write policy as
`commitSend`.

`commitObliterate` is admitted for an OWNER of the room's space, in a direct
room as in a group room or a space's own chat, when the room's policy states
`ownersMayObliterate`, and for a message's own sender in a direct room. The
handlers read that from the policy document `about.policy` links, so a room
enforces what it states, and a policy that doesn't read lets no OWNER
obliterate. One function, `messageRightsOf()`, states who may edit, delete,
and obliterate a message: the three handlers admit an act by it, and
`messageRights` and the rendering's controls offer one by it, so what a reader
is offered is what the room takes. `commitObliterate` rewrites the message to
its tombstone and clears its reactions. So the message's write policy admits
it alongside `commitSend`, `commitEdit`, and `commitDelete`, and the
reactions' write policy admits both it and `commitDelete` alongside the
reaction handlers.

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
write nothing else (see [`ChatMessage`](ChatMessage.md#who-wrote-what)). The
records use separate documents so each writer policy has its own boundary.

`about.record` is stored as `AuthoredByCurrentUser`, written once by the handler
that creates the room, so it is labeled with its creator, and `about` links it.
`commitSetTitle` stores the title a member sets the same way, as a record of its
own, so it is labeled with that member, and the creator's record keeps its
label. It records each retitle's outcome in the sender's own `titleRequests`,
kept `PerUser`, under the event's `requestId`, and a request already there
changes nothing; a refusal writes nothing else. So, unlike the other handlers
in the table, it keeps no request memory, claims no time, and appends no
`recentActivity` entry.
`canSend` is computed for each viewer from their access and whether their
profile resolves.

Every handler that changes the room's messages or reactions appends its
`recentActivity` entry in the same transaction as the change, so the log never
disagrees with the messages. Entries older than the window are dropped as new
ones are appended. `commitObliterate`, and `commitDelete` when it obliterates,
also remove the message's earlier entries.

The message list keeps `windows` as a `PerSession` keyed collection, and
fulfills `openWindow` and `closeWindow` by setting and removing entries in it.
The room offers those same two streams at its top level as well. A
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
| OWNERs may obliterate messages, anyone's | `ownersMayObliterate` | yes in a group room or a space's own chat, no in a direct room |
| An edit or a plain deletion keeps the version it replaces | `keepsHistory` | yes, every version |
| A sender's deletion obliterates their message | `deletionIsObliteration` | no |
| How far before the clock a proposed time is accepted | `proposedTimeMaxAgeNsec` | 10 minutes |
| How far after the clock a proposed time is accepted | `proposedTimeMaxLeadNsec` | 10 seconds |
| How long an entry stays in `recentActivity` | `recentActivityWindowNsec` | 10 minutes |
| The most messages a window holds | `maxWindowCount` | 100 |
| The most windows a session can have open | `maxOpenWindows` | 50 |

These are the first build's values. Once the configuration exists, rooms can
differ from them. `ownersMayObliterate` is there for a group room with many
OWNERs; a direct room is set up without it, and its two people each obliterate
only their own messages. The room's kind picks which policy document
`about.policy` links, one stating `ownersMayObliterate` and one not, unless
`FabriChatRoomCore` is given the setting as an input, which the room's own
pattern leaves unset. Nothing in the room's rendering shows or changes it. A
room states its settings in `about.policy`
([`ChatRoomPolicy`](ChatRoomPolicy.md)), with every key present, and its
handlers read `ownersMayObliterate` from that document itself, so it is the
source of truth for what the room allows.

## Prerequisites

- **A private space, created from a pattern.** The manager's
  `FabriChatRoom.inSpace()` creates a space with a random DID whose genesis
  document names its creator an OWNER, plus the grants it names
  ([random space identities](../random-space-identities.md)), reserves the
  room as the space's root
  ([custom space roots](../../features/custom-space-roots.md)), and declares
  the space's kind ([space kinds](../../features/space-kinds.md)).
- **Per-session state written by a handler.** `windows` is a `PerSession` cell
  linked from the room's `PerSpace` message list, a nesting the scoped-cell
  design provides across a `Cell` boundary (see [scoped cell
  instances](../scoped-cell-instances.md)). `openWindow`'s handler has to write
  the instance belonging to the session that sent the event, including when the
  handler runs somewhere other than that session's client. The scoped handler
  context selects that instance; multi-session tests exercise its isolation.
- **A write policy split within one document.** A message's reactions are
  written only by the reaction handlers (and obliteration), and the rest of the
  message only by the message handlers (see
  [`ChatMessage`](ChatMessage.md#who-wrote-what)). Reactions live in separate
  authored documents and a separately authorized list linked from the message,
  so each writer policy has its own document boundary.
- **A finite redelivery bound.** A client can append an event queued while it
  was offline, and a served handler can run an incomplete event again. Neither
  path establishes a maximum delay. The room retains request identities and
  reserved times for its lifetime; a finite retention policy needs a runtime
  guarantee covering both paths.
