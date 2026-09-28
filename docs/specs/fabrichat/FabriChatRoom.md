# FabriChatRoom

Status: proposed design (see [`README.md`](README.md)).

`FabriChatRoom` is one conversation. It is the successor to the room in today's
`packages/patterns/fabrichat/chat.tsx`, and keeps that room's record, writers,
and reviewed surfaces. What changes is where it lives, what decides its
membership, and the names of its records and surfaces, which are now neutral
with respect to the implementation because they are part of the contract (for
example, today's `FabriChatMessage` and `FabriChatSendSurface` become
`ChatMessage` and `ChatSendSurface`).

## Where it lives

A room is a piece in a shared space (see [shared
spaces](README.md#shared-spaces)). It can be placed in two ways:

- **A room of its own.** A direct room, or a group room, lives in a space
  created for it, and nothing else of consequence lives in that space. It is
  created by a manager ([`FabriChatManager.md`](FabriChatManager.md)), and never
  by a placement, an adapter, or a container.
- **A space's own chat.** The chat of everyone in a shared space is a room in
  that space itself. Its members are the space's members, by construction. It is
  created in the space by whatever sets the space up, and a space has at most
  one.

For a room of its own, the space's access list MUST grant only the room's
members. Its creator holds OWNER. The other members of a direct room hold WRITE.
A group room MAY grant OWNER to more than one member, so that more than one
person can add people. The access list MUST NOT contain the `"*"` wildcard: a
room is not open to principals it hasn't admitted. A space's own chat takes the
space's access list as it is, and adds nothing to it.

## The record

The room keeps three `PerSpace` values, shared by everyone the space admits:

- **`messages`**: the conversation, oldest first, each a
  [`ChatMessage`](ChatMessage.md).
- **`reactions`**: each a [`ChatReaction`](ChatReaction.md), one per reactor,
  message, and emoji.
- **`roster`**: live links to members' profiles, for display, only until the
  space has a member set (see [Membership](#membership)).

It also keeps **`about`**, a [`ChatAbout`](ChatAbout.md) set once at creation.

Messages, reactions, and the roster link people's profiles
([`ChatProfile`](ChatProfile.md)) and copy nothing from them. A client reads a
person's name and avatar from their profile when it draws, so a change to either
shows everywhere, history included.

## Writers

Every write to the record goes through one of these handlers, and each is
admitted only from its reviewed surface:

| Handler | Stream | Reviewed surface | Writes |
| --- | --- | --- | --- |
| `commitSend` | `sendMessage` | `ChatSendSurface` | appends a message |
| `commitReact` | `react` | `ChatReactSurface` | adds or removes the viewer's reaction |
| `commitJoin` | `join` | none | adds the viewer's profile to `roster` |

`commitSend` and `commitReact` keep today's types: the stored value is
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
event a send carries is `{ body, replyTo? }` (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)). The room's own composer builds
it from the text the person submitted, which today's room reads as
`target.value`. A react event names the message and the emoji.

`commitJoin` contributes the viewer's own `#profile` link, as [shared-profile
rosters](../shared-profile-rosters.md) describe. It needs no reviewed gesture,
because it asserts nothing but the viewer's own profile, and an entry stays a
claim. A client SHOULD join when it first shows a room to a member.

Each handler refuses to act before the viewer's profile resolves, and a refused
event is spent, as today.

## Membership

The access list is the membership, and the space's member set is how the room
and its clients read it: who the members are, and which profile shows each of
them. A room reads its members from its space and keeps no list of its own.

Until the runtime provides member sets, a room keeps `roster`, a set of profile
claims, as the `loom` pattern keeps `participants`, and consumers combine it
with the access list themselves. The roster is display, and the two can
disagree: a member who has never joined has no roster entry, and a roster entry
whose principal has lost access stays until it's cleaned up. Clients MUST NOT
treat a roster entry as proof of access.

Adding and removing members changes the access list. For group rooms, the room
offers two streams that record the intent and ask the host to act:

- **`invite`** `{ principal, access }`: grant a principal access, or issue an
  invitation for them to redeem.
- **`remove`** `{ principal }`: revoke a principal's access.

Both are outward acts: they grant or withdraw another person's access. So each
is admitted only from a reviewed surface (`ChatMembersSurface`), and only from a
member the access list makes OWNER. A direct room has neither: its membership is
fixed at creation. A space's own chat has neither: its members change when the
space's do.

## Outputs

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
the contract that placements, adapters, and clients read. It holds the record's
facts, a stream for each writer, the room's own `[UI]` with its reviewed
surfaces, and a `[VIEWS]` group for hosts that draw natively.

## Prerequisites

- **A private space.** Creating a room's space with only its creator granted
  needs [random space identities](../random-space-identities.md).
  `FabriChatRoom.inSpace()` works today, but the space it creates also grants
  `"*": "WRITE"`. A prototype MAY use it, and MUST say that the room is open to
  any authenticated principal.
- **Pattern-facing access control.** `invite` and `remove` need a way for a
  pattern to ask its host to change an access list or issue a space invitation.
  Today only hosts can do that (`ACLManager`, `SpaceInviteClient`).
