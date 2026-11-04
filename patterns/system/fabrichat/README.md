# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, and reviewed writer surfaces. `manager.tsx` presents the
user's private conversation index through `wish({ query: "#chatManager" })`.
Home's Chats tab renders it. `placement.tsx` links a room into a container;
`adapter.tsx` embeds the room's UI. The
[FabriChat specification](../../../docs/specs/fabrichat/README.md) defines the
room and manager contracts, and `schemas.tsx` holds their protocol types.

## Standalone space starter

`space-starter.tsx` opens the enclosing space's conversation through the Loom
root's `chatRoom`, `hasChatRoom`, and `ensureChatRoom` interface. The default
app does not instantiate this starter. The conversation takes its membership
from its enclosing space.

Start is available when the root supplies `ensureChatRoom`, the viewer has WRITE
or OWNER access, and `hasChatRoom` is `false`. A root without `hasChatRoom`
keeps creation disabled; an existing readable room can still be rendered. The
space's access list authorizes creation. Start asks the root to create and
register the room; repeated requests keep the same room. Creation adds no panel
or piece-registry entry.

A root that names a piece whose conversation cannot be read shows an unavailable
message. The starter preserves that designation and offers no Start control.

Before a room can be rendered, the starter offers profile setup when the viewer
has no selected profile. Once rendered, the room supplies its own profile setup.
The starter's `room` output retains the registered cell's identity, and
`VIEWS.room` exposes that room's data face when available.

## Validation

`deno task cf test patterns/system/fabrichat/space-starter.test.tsx` exercises
missing capability, creation, shared room identity, a delayed second Start, and
existing designations that cannot be rendered as conversations. It also checks
profile-setup visibility and the exported room view.
`patterns/integration/fabrichat-starter-profile-multi-runtime.test.ts` checks
setup visibility with missing, selected, and empty profiles, with server
execution on and off. The root's access enforcement and concurrent creation are
covered by `patterns/integration/loom-chat-room-multi-runtime.test.ts`.
`patterns/integration/fabrichat-starter-source-lifecycle.test.ts` checks served
source loading, source updates, and retirement of the old entry-point URLs.
