# FabriChat: the adapter

Status: proposed design (see [`README.md`](README.md)).

`FabriChatAdapter` shows one room inside some other space, a container that
displays chats among other things. A room can have any number of adapters, in
any number of containers. There is still one conversation.

## What it holds

An adapter is a piece in the container's space. It holds:

- **`room`** (`PerSpace`): a link to one `FabriChatRoom`. It is set when the
  adapter is created, and never changes afterward.
- **`draft`** and **`replyingTo`** (`PerSession`): the viewer's composer state.

It MUST NOT hold anything read from the room: no copied messages, titles,
rosters, or counts. A link carries the room's label across the space boundary,
but copied bytes would be written into the container under the adapter's own
integrity, readable by everyone the container admits
([cross-space integrity](../cfc-cross-space-integrity.md), §1). Everything the
adapter shows is computed from the link when it is read, under the viewer's
own access.

## How a container places it

A container places an adapter the way it places any piece. For example, the
`loom` pattern (`packages/patterns/loom/`) holds it as a piece panel. The
container never links to the room directly. The adapter is what a container
knows how to show, and it is where the viewer's composer state lives.

A client creates an adapter from a manager entry: it reads the entry's `room`
link and instantiates `FabriChatAdapter({ room })` in the container's space.
Two adapters for the same room, in the same container or in different ones,
show the same conversation.

## Viewers who aren't members

A container's members aren't necessarily the room's. A viewer the room space
doesn't admit can read the adapter, but not the room. The adapter MUST then
show that it's a chat the viewer can't read, and nothing else. It MUST NOT
show the room's title, members, or history. The link itself reveals only that
a room exists.

A client MUST NOT place a direct room's adapter in a container that admits
anyone besides the room's two members. Even an unreadable link to it tells the
container's other members that the conversation exists. A client learns whom
a container admits from its member set (see
[shared spaces](README.md#shared-spaces)). A client that can't learn it MUST
treat the container as admitting others.

## Outputs

- `[UI]`: for hosts that render VDOM. It embeds the room's own `[UI]`, so the
  composer and the reaction controls are the room's reviewed surfaces, and
  adds the adapter's framing: the non-member state, the draft, and the reply
  target.
- `[VIEWS]`: a `chat` group for hosts that draw natively:
  - `state`: `"member"`, `"not-member"`, or `"unavailable"` (the room can't be
    read right now).
  - `room`: the link, so a client can reach the room's own streams.
  - `about`, `messages`, `participants`, and `reactionTallies` (per message:
    emoji, count, whether the viewer is among them, and the reactors'
    profiles), each read through the link. They're empty unless `state` is
    `"member"`.
  - `draft` and `replyingTo`, and a `setDraft` stream for them.

The adapter offers no stream that sends or reacts. A client sends to the
room's own `sendMessage` and `react` streams, reached through `room`. If the
adapter relayed a send, the reviewed surface would be the adapter's, in
another space, and the room's write policy would have to trust it. Leaving the
adapter out of the write path keeps the room's policy about the room alone.

## Removing it

Removing an adapter removes that placement and nothing else. The room, its
history, and the manager's entry for it are untouched.
