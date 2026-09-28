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
`roster` and the messages' authors, keyed by profile cell. `messages` is a list;
`reactions` and `roster` are keyed collections, projected as lists in the
contract.

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
| `commitReact` | `react` | `ChatReactSurface` |
| `commitJoin` | `join` | none |
| `commitAdd` | `add` | `ChatMembersSurface` |
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

`commitAdd` and `commitRemove` ask the host to change the room space's access
list. They are the only handlers that reach beyond the room's own record.

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
