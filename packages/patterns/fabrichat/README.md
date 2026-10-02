# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, and the reviewed writer surfaces. `manager.tsx` keeps the
user's private conversation index in their home space, exposed through
`wish({ query: "#chatManager" })`. Its page opens at `chatManager` in Home's
result; Home adds no tab for it. `placement.tsx` links a room into a container;
`adapter.tsx` embeds that room's UI.

`main.tsx` opens the conversation registered on its enclosing space. Its
reviewed Start conversation control claims an empty `chat` slot and records the
policy in one transaction. A space conversation has no creator record. Repeated
starts reuse the same room. The default app exposes it through its Chat link.
The space's access list governs that conversation. Direct rooms and separate
group rooms created by the manager use random spaces with the intended grants at
creation. A group can explicitly opt into WRITE access for anyone with its link;
direct rooms remain private. The host installs the normal default pattern as
their root. Rooms read that root's participants through `#default` and combine
them with message authors.

## Room behavior

Messages retain exact epoch nanoseconds, live profile links, previous versions,
and explicit reply placement. Reactions are separate authored records. Reviewed
controls admit sends, edits, deletions, reactions, and permanent removal. The
space's access tools govern membership, and its default pattern owns profile
contributions. The room keeps no parallel roster or departure record. Forget
reads opaque references, so it remains available after access is revoked.

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
unknown list or wildcard grant fails this check. The placement also enforces
this boundary reactively, hiding its data face when the container widens. A
group room can be placed in a wider container, where nonmembers see only its
inaccessible link.

The manager exposes outgoing notices for delivery by a client. A notice contains
a room link and recipient, never conversation contents. The client acknowledges
a delivered notice through `delivered`. Receiving a notice grants no access;
`accept` checks actual admission before indexing a room. For direct rooms it
reads the creator from the immutable `about.record` attestation and verifies any
counterpart supplied by a client. The room offers Add to my chats, and each
attested participant has a reviewed control for starting a direct conversation.

## Validation

Run `deno task cf test packages/patterns/fabrichat` for protocol assertions and
`deno task integration patterns fabrichat` for the browser conversation test.
Private creation and system-roster integration tests live in
`packages/patterns/integration/fabrichat-manager.test.ts`.
