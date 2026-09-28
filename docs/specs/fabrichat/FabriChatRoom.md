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
`about`, `messages`, `reactions`, and `roster`. `participants` is computed from
`roster` and the messages' authors, keyed by profile cell.

## Writers

Every write goes through one handler per stream:

| Handler | Stream | Reviewed surface |
| --- | --- | --- |
| `commitSend` | `sendMessage` | `ChatSendSurface` |
| `commitReact` | `react` | `ChatReactSurface` |
| `commitJoin` | `join` | none |
| `commitInvite` | `invite` | `ChatMembersSurface` |
| `commitRemove` | `remove` | `ChatMembersSurface` |

`commitSend` and `commitReact` keep today's types: the stored value is
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
room's own composer builds a send's `{ body, replyTo? }` from the text the
person submitted, which today's room reads as `target.value`.

`commitReact` keeps each reaction at an address derived from its reactor's
profile, its message, and its emoji (`reactionKeyFor`). One person's one
reaction to one message has a single address in every session, which is how the
room meets [`ChatReaction`](ChatReaction.md#uniqueness)'s uniqueness rule
without reading the list.

`commitJoin` appends to `roster` as the `loom` pattern's `addParticipant` does:
a mergeable set add, so concurrent joins all land and a profile is not listed
twice.

`commitInvite` and `commitRemove` ask the host to change the room space's access
list, or to issue a space invitation. They are the only handlers that reach
beyond the room's own record.

## Prerequisites

- **A private space.** Creating a room's space with only its creator granted
  needs [random space identities](../random-space-identities.md).
  `FabriChatRoom.inSpace()` works today, but the space it creates also grants
  `"*": "WRITE"`. A prototype MAY use it, and MUST say that the room is open to
  any authenticated principal.
- **Pattern-facing access control.** `commitInvite` and `commitRemove` need a
  way for a pattern to ask its host to change an access list or issue a space
  invitation. Today only hosts can do that (`ACLManager`, `SpaceInviteClient`).
- **Member sets.** Until the runtime provides them, the room keeps `roster` (see
  [shared spaces](README.md#shared-spaces)).
