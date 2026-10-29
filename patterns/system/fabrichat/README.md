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

Messages are pushed records, identified by their cells, with live profile links
and explicit reply placement. Edits replace text in place; deletion keeps an
author and obliteration leaves an authorless tombstone. Reactions are separate
authored records. Times come from the handler clock and need not be unique. The
room relies on the runtime's once-per-event delivery, so it keeps no message
request ledger, activity log, or version history.

Ownership checks in writers compare the authenticated principal with the
record's `authored-by` attestation, independently of profile selection. Only the
author may edit or delete a message. A direct room also lets the author
obliterate it. The room's `ownersMayObliterate` policy controls owner
moderation, defaulting to true for group rooms and false for direct rooms.
Editing, deleting, and reacting require a resolved profile. Obliteration depends
on ownership and moderation rights and works without a readable profile.

Display controls use the owner `profileOwnerOf()` identifies for the viewer's
profile, including its name-chain ownership check. Without a recognized owner,
original-sender controls are unavailable. The runtime exposes the authenticated
principal only inside handlers. Selecting another person's attested profile can
therefore offer controls the handler refuses; view rights cannot fully identify
the authenticated viewer yet. Participant presentation does not determine
membership; access to the space does.

The room offers the latest 100 main-conversation messages and derives thread
summaries in one pass through the messages. Its UI has thread and older-message
navigation, retitling, and a composer shared by placements in the same session.
Message bodies preserve the exact submitted text. A whitespace-only body is
accepted only with attachments. Replies cannot target deleted messages or quote
a thread-only message in the main conversation. Each session keeps a main draft
and a separate draft for each thread root. A refused send preserves its draft; a
successful send clears only the draft with the submitted text and revision, so a
newer edit survives even if its text is identical. Switching threads restores
each thread's draft, and a send captured for another thread is refused.
Message-act refusals throw with a reason, and add and retitle requests retain
private outcomes.

## Manager and clients

The protocol types are in `schemas.tsx`. Send directly to the room's streams; a
placement or adapter does not relay writes. Native hosts bind reviewed controls
through the trusted native UI bridge, which belongs to the host's real
user-input path.

Home's shared-space catalog supplies standalone rooms and container
declarations. The manager discovers a container's conversation through its root
`chatRoom` link and deduplicates by room identity. Private membership records
keep joins and forgotten conversations independently of their containers. The
manager retains its direct-room lookup after forgetting, so opening that
conversation again restores the same room. Creation commits the room, its
grants, catalog registration, and terminal outcome together. Repeated requests
preserve their original outcome.

A client must verify direct-room container admission before creating a
placement, as the specification requires. The placement reports the viewer's
room access and hides room facts while access is unavailable. A group can be
placed in a wider container, where nonmembers see its inaccessible link.

The manager offers a room through the share inboxes of the recipient profiles
the request names. Members offered nothing receive a notice containing a room
link and recipient, never conversation contents. The manager's people picker
finds profiles through the participants of its listed rooms. Clients acknowledge
delivered notices through `delivered`. Receiving a notice grants no access;
`accept` checks admission and the immutable creator attestation. A declared
container conversation can be joined through its root declaration. Writing in a
standalone or declared container room asks the manager to join it through a
separate event; shared message writes read neither the manager binding nor its
private catalog. Each attested participant has a reviewed control for starting a
direct conversation.

## Validation

Run `deno task cf test patterns/system/fabrichat` for protocol assertions and
`deno task integration patterns fabrichat` for browser and cross-runtime tests.
