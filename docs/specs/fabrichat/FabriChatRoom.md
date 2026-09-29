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

The room keeps four `PerSpace` values, shared by everyone the space admits:
`about`, `messages`, `roster`, and `outgoingNotices`. `participants` is computed
from `roster` and the messages' authors, keyed by profile cell. `messages` is a
list ordered by `sentAt`. Each message's reactions, and `roster`, are keyed
collections, projected as lists in the contract.

The room also keeps its composer's state, `PerSession`: the draft, the message
being replied to, and where the reply is to be shown. The composer is the room's
own reviewed surface, so the state it shows, and sends, is the room's. Two
placements of the same room open in one session show the same composer state, as
one conversation shown twice should.

## Writers

Every write goes through one handler per stream:

| Handler | Stream | Reviewed surface |
| --- | --- | --- |
| `commitSend` | `sendMessage` | `ChatSendSurface` |
| `commitEdit` | `editMessage` | `ChatEditSurface` |
| `commitDelete` | `deleteMessage` | `ChatDeleteSurface` |
| `commitSendReaction` | `sendReaction` | `ChatReactSurface` |
| `commitDeleteReaction` | `deleteReaction` | `ChatReactSurface` |
| `commitJoin` | `join` | none |
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

`commitSend` and `commitEdit` keep each sender's proposed times in a keyed
collection, keyed by the sender's principal and the proposal (and, for an edit,
the message), so a repeated send or edit finds what it already recorded without
reading the list. Its plausibility window for proposed times is a constant of
the pattern, documented beside it.

`commitEdit` and `commitDelete` are admitted only for the message's own sender,
and move the current version into `earlierVersions` before recording the new
one. They have the same kind of write policy as `commitSend`.

`commitSend`, `commitEdit`, `commitDelete`, and `commitSendReaction` choose a
recorded time in the same transaction that records it: the handler clock, or the
smallest later time in milliseconds that the room hasn't used yet. A room keeps
the times it has used in a keyed collection, so the check doesn't scan every
message, and two records made at once conflict and retry rather than share a
time.

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

`commitJoin` appends to `roster` as the `loom` pattern's `addParticipant` does:
a mergeable set add, so concurrent joins all land and a profile is not listed
twice.

`commitAdd` and `commitRemove` ask the host to change the room space's access
list. They are the only handlers that reach beyond the room's own record.
`commitAdd` also adds a notice to `outgoingNotices`, and `commitDelivered`
removes one.

`about` is stored as `AuthoredByCurrentUser<ChatAbout>`, written once by the
handler that creates the room, so it is labeled with its creator. `canSend` is
computed for each viewer from their access and whether their profile resolves,
as today's room computes `cannotSend`.

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
- **Member sets.** Until the runtime provides them, the room keeps `roster` (see
  [shared spaces](README.md#shared-spaces)).
