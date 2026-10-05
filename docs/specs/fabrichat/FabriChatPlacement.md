# FabriChatPlacement

`FabriChatPlacement` is one room placed in some other space: a container that
shows chats among other things. It has no rendering. It is the thing a client
reads to learn what a placed chat holds and what the viewer may see of it, and
`FabriChatAdapter` ([`FabriChatAdapter.md`](FabriChatAdapter.md)) is the piece
that renders it for hosts that render VDOM. A room can have any number of
placements, in any number of containers, and there is still one conversation.

## What it holds

A placement is a piece in the container's space. It holds one `PerSpace` value
(see [scopes](../scoped-cell-instances.md#summary)), shared by everyone the
container admits, **`room`**: a link to one `FabriChatRoom`. The link is set
when the placement is created, and never changes afterward.

It MUST NOT hold anything read from the room: no copied messages, titles,
rosters, or counts. A link carries the room's label across the space boundary,
but copied bytes would be written into the container under the placement's own
integrity, readable by everyone the container admits ([cross-space
integrity](../cfc-cross-space-integrity.md), §1). Everything the placement
offers is computed from the link when it is read, under the viewer's own access.

It holds no presentation state either. The draft and the reply target belong to
the room's own `[UI]`, since its composer is the room's surface, and whatever
draws a placement keeps the rest, such as its scroll position.

## Viewers who aren't members

A container's members aren't necessarily the room's. A viewer the room space
doesn't admit can read the placement, but not the room. The placement's `state`
is then `"not-member"`, and every fact read through the room is empty. It MUST
NOT offer the room's title, members, or history. The link itself reveals only
that a room exists.

A client MUST NOT place a direct room in a container that admits anyone besides
the room's two members. Even an unreadable link to it tells the container's
other members that the conversation exists. A client learns whom a container
admits from its member set (see [shared spaces](README.md#shared-spaces)). A
client that can't learn it MUST treat the container as admitting others.

## Outputs

- `room`: the link, so a client can reach the room's own streams.
- `[VIEWS]`: a `chat` group, the placement's whole data face:
  - `state`: `"member"` (the room space admits the viewer, at any level),
    `"not-member"`, or `"unavailable"` (the room can't be read right now). A
    member with READ only sees the room but can't send to it (see
    [`ChatRoomOutput`](ChatRoomOutput.md#membership)).
  - `messages` and `canSend`, from the room (see
    [`ChatRoomOutput`](ChatRoomOutput.md#facts)). Through `messages` the reader
    reaches their own windows onto the room's messages.
  - `about`, `recentActivity`, `participants`, and `reactionTallies` (per
    message in `messages.latest` and in the session's windows: emoji, count,
    whether the viewer is among them, and the reactors' profiles), each read
    through the link. They're empty unless `state` is `"member"`.

A placement offers no stream that sends or reacts. A client sends to the room's
own `sendMessage` and `sendReaction` streams, reached through `room`. If a
placement relayed a send, the reviewed surface would be the placement's, in
another space, and the room's write policy would have to trust it. Leaving the
placement out of the write path keeps the room's policy about the room alone.

## Creating and removing it

A client creates a placement from a manager entry
([`FabriChatManager.md`](FabriChatManager.md)): it reads the entry's `room` link
and instantiates `FabriChatPlacement({ room })` in the container's space,
together with the adapter that renders it (see
[`FabriChatAdapter.md`](FabriChatAdapter.md#how-a-container-holds-it)). Two
placements of the same room, in the same container or in different ones, show
the same conversation.

Removing a placement removes that placement and nothing else. The room, its
history, and the manager's entry for it are untouched.
