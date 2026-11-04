# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, and reviewed writer surfaces. `manager.tsx` presents the
user's private conversation index through `wish({ query: "#chatManager" })`.
Home's Chats tab renders it. `placement.tsx` links a room into a container;
`adapter.tsx` embeds the room's UI. The
[FabriChat specification](../../../docs/specs/fabrichat/README.md) defines the
room and manager contracts, and `schemas.tsx` holds their protocol types.

## Standalone space starter

`main.tsx` starts an existing social space's conversation through the Loom
root's `chatRoom` and `setChatRoom` interface. The default app does not
instantiate this starter. The conversation takes its membership from its
enclosing space.

Start is available when the root supplies its registry, the viewer has WRITE or
OWNER access, and the registry holds no room. A cell whose value is empty still
counts as no room. The reviewed Start gesture registers the candidate through
the root's writer. The starter then renders the registered room, preserving its
cell identity, and offers the profile-setup surface when the viewer has no
selected profile.

`main.test.tsx` exercises the starter against Loom's real registry: it checks
that a missing registry disables Start, an empty conversation cell keeps Start
available, and registration selects the same room and removes Start.

## Validation

Run `deno task cf test patterns/system/fabrichat` for protocol assertions and
`deno task integration patterns fabrichat` for browser and cross-runtime tests.
The spaces integration suite includes an invited member selecting an attested
profile and sending through a manager-created root room, checking the message,
author link, and client write-refusal counts.
