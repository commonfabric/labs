# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, and reviewed writer surfaces. `manager.tsx` presents the
user's private conversation index through `wish({ query: "#chatManager" })`.
Home's Chats tab renders it. `placement.tsx` links a room into a container;
`adapter.tsx` embeds the room's UI. The
[FabriChat specification](../../../docs/specs/fabrichat/README.md) defines the
room and manager contracts, and `schemas.tsx` holds their protocol types.

## Standalone space starter

`main.tsx` opens the enclosing space's conversation through the Loom root's
`chatRoom` and `ensureChatRoom` interface. The default app does not instantiate
this starter. The conversation takes its membership from its enclosing space.

Start is available when the root supplies `ensureChatRoom`, the viewer has WRITE
or OWNER access, and the registry holds no room. An empty room cell still counts
as no room. The reviewed Start gesture asks the root to create and register the
room. Repeated requests keep the same room, including a request from a starter
whose Start control was rendered before another starter created it. Creation
adds no panel or piece-registry entry.

Before a room is registered, the starter offers profile setup when the viewer
has no selected profile. Once registered, the room supplies its own rendering
and profile setup. The starter's `room` output retains the registered cell's
identity, and `VIEWS.room` exposes that room's data face. Both outputs are
absent while no room is registered.

## Validation

`deno task cf test patterns/system/fabrichat/main.test.tsx` exercises the
starter against Loom's real registry: missing capability, an empty conversation
cell, reviewed creation, shared room identity, and a delayed second Start
gesture. `patterns/integration/fabrichat-starter-profile-multi-runtime.test.ts`
checks setup visibility with missing, selected, and empty profiles, with server
execution on and off. The root's access enforcement and concurrent creation are
covered by `patterns/integration/loom-chat-room-multi-runtime.test.ts`.
