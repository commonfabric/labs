# FabriChatAdapter

Status: proposed design (see [`README.md`](README.md)).

`FabriChatAdapter` renders one placement
([`FabriChatPlacement.md`](FabriChatPlacement.md)) for hosts that render VDOM,
such as the shell. It is the placement's rendering and nothing else. It decides
nothing about the room that the placement doesn't already say, and it holds only
what a rendering needs.

## What it holds

An adapter is a piece in the container's space, beside its placement. It holds:

- **`placement`** (`PerSpace`): a link to one `FabriChatPlacement`. It is set
  when the adapter is created, and never changes afterward.
- **`draft`** and **`replyingTo`** (`PerSession`): the viewer's composer state.

Like a placement, it MUST NOT hold anything read from the room.

## How a container holds it

A container holds the adapter, the way it holds any piece it renders. For
example, the `loom` pattern (`packages/patterns/loom/`) holds it as a piece
panel. The adapter links to its placement, and the placement to its room:

```text
  container ──► FabriChatAdapter ──► FabriChatPlacement ──► FabriChatRoom
               (renders)            (what a viewer may see)  (the conversation)
```

A client that draws natively ignores the adapter's rendering and follows its
`placement` output to the placement's `[VIEWS]` (see
[`clients.md`](clients.md)). So a placed chat is always a pair, created together
and removed together.

## Outputs

- `placement`: the link.
- `[UI]`: the rendering. When the placement's `state` is `"member"`, it embeds
  the room's own `[UI]`, so the composer and the reaction controls are the
  room's reviewed surfaces, and it adds its framing: the draft and the reply
  target. Otherwise it shows the non-member or unavailable state, and nothing of
  the room.

An adapter offers no `[VIEWS]`, since the placement is the data face, and no
stream that sends or reacts. Every write reaches the room's own writers, through
the room's own surfaces.
