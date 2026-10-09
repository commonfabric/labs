# FabriChat

FabriChat separates a conversation from the places that show it. `room.tsx` owns
messages, reactions, and reviewed writer surfaces. `manager.tsx` presents the
user's private conversation index through `wish({ query: "#chatManager" })`.
Home's Chats tab renders it. `placement.tsx` links a room into a container;
`adapter.tsx` embeds the room's UI.

A manager-created conversation is the root of its own `fabrichat-room` space.
Its creator and named members receive OWNER access. A group can explicitly opt
into WRITE access for anyone with its link; direct rooms remain private. The
room keeps participant profiles through the shared `addParticipant` writer and
combines them with message authors. A standalone group offers its owners a
reviewed Add control; a direct room offers none.

`main.tsx` is a standalone starter for an existing social space's conversation.
It uses the Loom root's `chatRoom` and `setChatRoom` interface. Such a
conversation has no creator record and takes its membership from its enclosing
space. The default app does not instantiate this starter.

## Room behavior

Messages retain exact epoch nanoseconds, live profile links, previous versions,
and explicit reply placement. Reactions are separate authored records. Reviewed
controls admit sends, edits, deletions, reactions, and permanent removal.
Ownership checks in writers use the authenticated principal, independently of
profile selection. Display controls use the principal attested by the viewer's
profile. Without that attestation, original-sender controls are unavailable.
Root rooms keep request bookkeeping in a separate protected document from their
creation metadata.

The room offers the latest 100 main-conversation messages and up to 50 fixed
session windows. A window retains original message links, so edits and removal
remain visible without moving the window when new messages arrive. The UI has
thread navigation, older-message navigation, version history, and a composer
shared by placements in the same session. A refused send preserves its draft.

Activity has a ten-minute display window; the reactive clock expires idle
entries from the public view. Writers prune expired storage when recording the
next event. The expiration watermark is independent of permanent removal.
Request identities remain remembered after removal. They are retained for the
room's lifetime because the runtime does not establish a finite maximum event
redelivery delay.

## Manager and clients

The protocol types are in `schemas.tsx`. Send directly to the room's streams; a
placement or adapter does not relay writes. Native hosts bind reviewed controls
through the trusted native UI bridge, which belongs to the host's real
user-input path.

Home's shared-space catalog supplies the manager's rooms. Creating or accepting
a room registers its space; forgetting archives the catalog entry at the
revision the client observed. The manager retains its direct-room lookup after
forgetting, so opening that direct conversation again restores the same room.
Immutable creation intents preserve the initial request's choices during
resumption and coalesce concurrent starts for one counterpart.

A client must verify direct-room container admission before creating a
placement, as the specification requires. The placement reports the viewer's
room access and hides room facts while access is unavailable. A group can be
placed in a wider container, where nonmembers see its inaccessible link.

The manager produces a notice for every other member, containing a room link and
recipient, never conversation contents. A request naming a counterpart's
attested profile also offers the room through that profile's share inbox.
Clients acknowledge delivered notices through `delivered`. Receiving a notice
grants no access; `accept` checks admission and the immutable creator
attestation. A social space's own chat cannot be added to the catalog as a
standalone room. Rooms offer Add to my chats, and each attested participant has
a reviewed control for starting a direct conversation.

## Validation

Run `deno task cf test packages/patterns/fabrichat` for protocol assertions and
`deno task integration patterns fabrichat` for browser and cross-runtime tests.
