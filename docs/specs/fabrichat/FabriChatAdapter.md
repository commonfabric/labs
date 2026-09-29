# FabriChatAdapter

Status: proposed design (see [`README.md`](README.md)).

`FabriChatAdapter` renders one placement
([`FabriChatPlacement.md`](FabriChatPlacement.md)) for hosts that render VDOM,
such as the shell. It is the placement's rendering, and passes the placement's
data face through. It decides nothing about the room that the placement doesn't
already say, and it holds only what a rendering needs.

## What it holds

An adapter is a piece in the container's space, beside its placement. It holds:

- **`placement`** (`PerSpace`, see
  [scopes](../scoped-cell-instances.md#summary)): a link to one
  `FabriChatPlacement`. It is set when the adapter is created, and never changes
  afterward.

That is all it holds. Like a placement, it MUST NOT hold anything read from the
room. It holds no composer state either: the composer is the room's own reviewed
surface, so the room's own `[UI]` keeps the draft and the reply target (see
[`ChatRoomOutput`](ChatRoomOutput.md#renderings)).

## How a container holds it

A container holds the adapter, the way it holds any piece it renders. For
example, the `loom` pattern (`packages/patterns/loom/`) holds it as a piece
panel. The adapter links to its placement, and the placement to its room:

```text
  container ──► FabriChatAdapter ──► FabriChatPlacement ──► FabriChatRoom
               (renders)            (what a viewer may see)  (the conversation)
```

A client that draws natively ignores the adapter's rendering and reads the
placement's `chat` group, which the adapter re-exports in its own `[VIEWS]` (see
[`clients.md`](clients.md)). So a placed chat is always a pair, created together
and removed together.

## Outputs

- `placement`: the link.
- `[UI]`: the rendering. When the placement's `state` is `"member"`, it embeds
  the room's own `[UI]`, composer and all, so the composer and the reaction
  controls are the room's reviewed surfaces. Otherwise it shows the non-member
  or unavailable state, and nothing of the room.
- `[VIEWS]`: the placement's `chat` group, re-exported by link. The adapter adds
  nothing to it. It's there so that a host that asks a placed piece for its
  `[VIEWS]`, as a host drawing a container's panels natively does, finds the
  placement's data face on the piece the container holds.

An adapter offers no stream that sends or reacts. Every write reaches the room's
own writers, through the room's own surfaces.
