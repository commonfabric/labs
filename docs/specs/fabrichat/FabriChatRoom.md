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
  ordered by `sentAt`. Each message links its reactions as separately
  authored documents, projected as a list in the contract.
- The request memory: the requests the room has acted on, by sender and
  `requestId` (see [writers](#writers)).
- The times the room has used, so it can make each new one unique, each kept
  as long as a request is remembered: no new time is chosen from before the
  proposed-time window, which that span covers.
- Those who joined the room: profile links, in the order they were added, a
  roster only `addParticipant` writes
  (`packages/patterns/loom/participants.tsx`).

`participants` is computed from those who joined, the participants the space's
root lists when the room is not that root (`wish({ query: "#default" })`), and
the messages' authors, keyed by profile cell. A room with `about`, which only a
manager creates, is its space's root, and reads only its own roster: its
`#default` is itself. `messages` (its `count`, `oldestAt`, `newestAt`, and
`latest`) is computed from the messages, and `canSend` from the reader's access
and profile, when they're read. Neither is stored.

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

Every handler in the table first checks its event's sender and `requestId`
against a keyed collection of the requests the room has acted on, and does
nothing for one it finds. It records the request there in the same transaction
as its effect, and retains that identity for the room's lifetime. The collection
keeps a request even after its message is obliterated: it says only that the
sender made a request, not what,
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

`commitSendReaction` finds a reaction by its reactor profile and emoji, and
changes nothing when that pair is already present. Its transaction reads the
message's reaction list before appending, so concurrent attempts conflict and
re-evaluate against the committed list. Each reaction is a separately authored
document; editing a message preserves its reaction references.

`about.record` is stored as `AuthoredByCurrentUser`, written once by the handler
that creates the room, so it is labeled with its creator, and `about` links it.
`canSend` is computed for each viewer from their access and whether their
profile resolves.

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

## Prerequisites

- **A private space, created from a pattern.** The manager's
  `FabriChatRoom.inSpace()` creates a space with a random DID whose genesis
  document names its creator an OWNER, plus the grants it names
  ([random space identities](../random-space-identities.md)), reserves the
  room as the space's root
  ([custom space roots](../../features/custom-space-roots.md)), and declares
  the space's kind ([space kinds](../../features/space-kinds.md)).
- **Per-session state written by a handler.** `windows` is a `PerSession` cell
  linked from the room's `PerSpace` message list. The runtime selects the
  originating session's instance for handler writes, including served events.
- **Separately authorized records.** Message and reaction documents retain
  their own labels and writer policies through cell references.
- **Unbounded redelivery.** The runtime establishes no finite upper bound on
  event redelivery. Request identities and used times remain for the room's
  lifetime, including after obliteration. Expiring them after the proposed-time
  window would allow a delayed deletion or reaction to execute again.
