# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, membership operations, and the reviewed writer surfaces.
`manager.tsx` keeps the user's private conversation index in their home space,
exposed through `wish({ query: "#chatManager" })` and Home's Conversations tab.
`placement.tsx` links a room into a container; `adapter.tsx` embeds that room's
UI.

`main.tsx` creates the conversation belonging to its enclosing space. Its
reviewed Start conversation control records the creator and policy. The space's
access list governs that conversation. Direct rooms and separate group rooms
created by the manager use random creator-only spaces and explicit grants.

## Room behavior

Messages retain exact epoch nanoseconds, live profile links, previous versions,
and explicit reply placement. Reactions are separate authored records. Reviewed
controls admit sends, edits, deletions, reactions, permanent removal, and
membership administration. Profile contribution and leaving use the
authenticated actor without requiring a reviewed control.

The room offers the latest 100 main-conversation messages and up to 50 fixed
session windows. A window retains original message links, so edits and removal
remain visible without moving the window when new messages arrive. The UI has
thread navigation, older-message navigation, version history, and a composer
shared by placements in the same session.

Activity has a ten-minute display window; the reactive clock expires idle
entries from the public view. Writers prune expired storage when recording the
next event. The expiration watermark is independent of permanent removal.
Request identities remain remembered after removal. They are retained for the
room's lifetime because the runtime does not establish a finite maximum event
redelivery delay.

## Clients

The protocol types are in `schemas.ts`. Send directly to the room's streams; a
placement or adapter does not relay writes. Native hosts can bind a reviewed
control with `bindNativeUiControl` from `@commonfabric/runner/native-ui`. That
capability belongs only to the trusted host's real user-input path.

Before placing a direct room, a client must read both space access lists and
verify that the container admits nobody beyond the room's two principals. An
unknown list or wildcard grant fails this check. A group room can be placed in a
wider container, where nonmembers see only its inaccessible link.

The manager and room expose outgoing notices for delivery by a client. A notice
contains a room link and recipient, never conversation contents. The client
acknowledges a delivered notice through `delivered`. Receiving a notice grants
no access; `accept` checks actual admission before indexing a room.

## Validation

Run `deno task cf test packages/patterns/fabrichat` for protocol assertions and
`deno task integration patterns fabrichat` for the browser conversation test.
Private creation and membership integration tests live in
`packages/runner/test/private-space.test.ts`.
