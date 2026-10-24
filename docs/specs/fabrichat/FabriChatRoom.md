# FabriChatRoom

`FabriChatRoom` is an implementation of [`ChatRoomOutput`](ChatRoomOutput.md),
which states everything a room does: where it lives, its membership, its facts,
and its streams. This document says how this implementation does it.

Its records and surfaces are named for the contract rather than for the
implementation, because they are part of the contract: `ChatMessage`,
`ChatReaction`, and the surfaces the table under [writers](#writers) names.

## State

The room keeps these `PerSpace` values, shared by everyone the space admits:

- The contract's own records: `about` and its messages. The messages are a
  list in the order the room recorded them, each message an object pushed onto
  it and so a document of its own. Each message links a list of its own
  reactions, a document the send that made the message makes, which each
  reaction is pushed onto, and links each file it attaches, an entry of its
  space's store, which the send reads to check it and the room never writes.
- Those who joined the room: profile links, in the order they were added, a
  roster only `addParticipant` writes
  (`packages/patterns/loom/participants.tsx`).
- The title a member last set: one keyed record, absent until a member sets
  one, which only `commitSetTitle` writes. `about.title` is computed from it
  and, where it is absent, from the title `about.record` holds.
- Where the room keeps its space's file store, for a room that is its space's
  root: a `FileStoreRecord`, `{}` until `ensureFileStore` creates the store
  (see [`FileStore`](../fabrifile/FileStore.md#where-it-lives)), which it
  offers as `fileStoreRecord`. A room that isn't its space's root keeps none,
  and reads the record its container offers as `fileStoreRecord` instead.
  `ensureFileStore` sends the store's own handler only where the container
  offers one, since its binding to the container's field reads as one whether
  or not it is there.

`participants` is computed from those who joined, the participants the space's
root lists when the room is not that root (`wish({ query: "#default" })`), and
the messages' authors, keyed by profile cell. A room with `about`, which only a
manager creates, is its space's root, and reads only its own roster: its
`#default` is itself. `roster` is computed from those who joined alone.
`messages` (its `count`, `oldestAt`, `newestAt`, `latest`, and `threads`) is
computed from the messages, and `canSend` from the reader's access and profile,
when they're read. Neither is stored. `viewer` and `messageRights` are computed
for each reader too, `viewer` from their profile and access, and
`messageRights` from those and the messages, for every message at once.

`participantEntries` is computed from `participants`, reading the
`represents-principal` label on each profile with `principalOf()`, and
`participantPrincipals` is computed from those entries. A profile lives in its
owner's own space, so a reader that space refuses reads no principal from it.
Both are derived per session, so each session reads instances of its own,
derived under its own access.

The `PerSession` values in the contract are `participantEntries` and
`participantPrincipals`.

The room's `[UI]` keeps its composer's state, the draft, the reply and the
attachments being composed, as a `PerSession` value of its own, so two
placements of the same room open in one session show the same composer state,
as one conversation shown twice should.

The main composer attaches files. Its attach control sends the room's
`ensureFileStore` as it opens its file picker, so that the space has a store by
the time a file is picked. Each file it stores in the blob store it adds to the
space's store with `add`, under its own name or a free one
([FabriFile's clients](../fabrifile/clients.md#adding-a-file)), and keeps in the
composer as that request, which the composer shows as being attached, attached,
or refused with the store's reason. A file can be taken out before the send,
and its entry stays in the store. The composer's send attaches the entries the
store added, in the order the files were picked, leaves out any the store
refused, and waits, refusing the send, while a file is still being added; it
reads each request's outcome by its id alone. A send ends the composer's
attachments. Picking more files than the room's `maxAttachments`, or picking
any in a space that still has no store, is refused. The thread composer
attaches nothing.

## Writers

Every write goes through one handler per stream:

| Handler | Stream | Reviewed surface |
| --- | --- | --- |
| `commitSend` | `sendMessage` | `ChatSendSurface` |
| `commitComposerSend` | `composerSend` | `ChatSendSurface` |
| `commitThreadSend` | `threadComposerSend` | `ChatSendSurface` |
| `commitReply` | a message row's `replyInThread`, `replyInBoth`, `replyInMain` | `ChatSendSurface` |
| `commitEdit` | `editMessage` | `ChatEditSurface` |
| `commitDelete` | `deleteMessage` | `ChatDeleteSurface` |
| `commitObliterate` | `obliterateMessage` | `ChatObliterateSurface` |
| `commitSendReaction` | `sendReaction` | `ChatReactSurface` |
| `commitDeleteReaction` | `deleteReaction` | `ChatReactSurface` |
| `commitSetTitle` | `setTitle` | `ChatRetitleSurface` |

The four send handlers differ only in where a send's reply comes from:
`commitSend` takes it from the event, `commitComposerSend` from the reply the
composer is composing, which a sent message ends, `commitThreadSend` from the
open thread, and `commitReply` from the message its control is bound to. They
admit and record a send alike, and are called the send handlers below. Each
handler is bound to the cells it reads or writes and no others, and reads at
most the message it acts on: nothing it does grows with the room.

Those who joined the room are the exception. The room's `addParticipant`
stream is bound to the roster's one writer, also named `addParticipant`, which
adds a profile with no gesture and no `requestId`: it is a set-add, so a
profile already listed is not added again. The roster's write contract admits
no other writer.

The send handlers and `commitSendReaction` push a value typed
`AuthoredByCurrentUser<TrustedActionWrite<…>>`, so the runtime labels it with
its writer and refuses it without a trusted gesture from the named surface. The
room's own composer sends the text the person submitted, which its handler
reads as `target.value`.

A successful message or reaction sends `joinRoom` to the viewer's manager
when one is available and the room is either standalone or its space's root
explicitly declares it through `chatRoom`. A declared container room includes
that root as `container`; a standalone room needs no container, including when
another space declares it. The manager's separate event checks private Home
membership and lists or restores the conversation. Joining an already listed
room without a `requestId` changes no membership and records nothing. A join
from a message or a reaction, marked `messageAct`, leaves the title the
manager's catalog lists the room under as it is, and any other join brings that
title up to the room's (see
[`joinRoom`](ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput)).
Room write handlers send their
local `joined` stream after recording the write. Its `tellManagerJoined`
handler reads the manager binding and sends `joinRoom` in a separate event,
so the transaction that stores shared messages and reactions reads neither
the manager nor its private catalog.

Every handler in the table runs once per event, and keeps no memory of the
events it has acted on: the runtime delivers one durable stream entry to its
handler exactly once as a completed run, and a client's re-sent append is
deduplicated at its event id
([events](../server-side-execution/events.md), "One entry, one COMPLETED
delivery" and §4). So two sends of the same text are two messages.

An act on a message, and a reply, takes the message by its cell and reads it
alone. A handler checks what the element's write policy does not — whose
message or reaction it is, the obliteration rights, and that a message acted
on or replied to lives in the room's space — and refuses anything else: the
run fails with a reason a person can read, and writes nothing. The room's
rendering offers only acts the viewer can take, so a refusal reaches a client
whose own event broke the rules. An act that would change nothing, such as a
reaction added twice, succeeds and writes nothing. The acts on a message are bound to a
handle on one of the room's records, and the sends to the room's messages,
either of which names the room's space and is read for nothing else for
this. A message's write policy names its handlers, not a room, so the space
is what keeps one room's rules, its kind and its `ownersMayObliterate`, off
a message another room's rules govern, and what keeps a reply from linking
the room to a document of another space.

`commitEdit` and `commitDelete` are admitted only for the message's own sender.
`commitEdit` records the new text in place, with the time as `editedAt`.
`commitDelete` records the deletion, which keeps the author and drops the text
and the message's link to its reactions, or, when the room's
`deletionIsObliteration` setting is on, does exactly what `commitObliterate`
does. They have the same kind of write policy as the send handlers.

`commitObliterate` is admitted for an OWNER of the room's space, in a direct
room as in a group room or a space's own chat, when the room's policy states
`ownersMayObliterate`, and for a message's own sender in a direct room. The
handler is bound to that setting as a value, the same value that picks which
policy document `about.policy` links, so a room enforces what it states, and a
binding without the setting lets no OWNER obliterate. One function,
`messageRightsOf()`, states who may edit, delete, and obliterate a message: the
three handlers admit an act by it, and `messageRights` and the rendering's
controls offer one by it, so what a reader is offered is what the room takes.
`commitObliterate` rewrites the message to its tombstone, which drops its author
and its link to its reactions. So the message's write policy admits it alongside
the send handlers, `commitEdit`, and `commitDelete`.

Every time a handler records, a message's `sentAt` and `editedAt` and a
reaction's `sentAt`, is its own handler clock's reading when it made the
record. Nothing is unique about it, and nothing keys by it: a message or a
reaction is identified by its cell.

A reaction is never toggled, since a repeated or delayed toggle can turn into
the opposite of what the person meant. `commitSendReaction` and
`commitDeleteReaction` each change nothing when the reaction is already as
asked.

`commitSendReaction` reads the message's reaction list, and pushes a reaction
onto it unless the sender already has one there with that emoji.
`commitDeleteReaction` reads the list, and removes the sender's reaction with
that emoji by its cell, with `removeByValue()`, the mergeable removal, so a
reaction added and one removed at the same moment both land. The reactions
are a separately authorized part of the message: the list is a document of
its own, which the send that made the message made and the message links, so
the send handlers and `commitEdit` can't write a reaction, and the reaction
handlers can write nothing else (see
[`ChatMessage`](ChatMessage.md#who-wrote-what)). A list carries no policy of
its own: each element's policy governs pushing it and removing it, and the
reaction's names the two reaction handlers.

`about.record` is stored as `AuthoredByCurrentUser`, written once by the handler
that creates the room, so it is labeled with its creator, and `about` links it.
`commitSetTitle` stores the title a member sets the same way, as a record of its
own, so it is labeled with that member, and the creator's record keeps its
label. It records each retitle's outcome in the sender's own `titleRequests`,
kept `PerUser`, under the event's `requestId`, and a request already there
changes nothing; a refusal writes nothing else.
`canSend` is computed for each viewer from their access and whether their
profile resolves.

## Configuration

[`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior) leaves
some behavior to the implementation. `FabriChatRoom` has an affordance for
configuring each of them: a room's settings, kept apart from the room's
record. The configuration itself isn't built at first. The first build fixes
each setting at an initial value:

| Setting | `ChatRoomPolicy` key | Initial value |
| --- | --- | --- |
| OWNERs may obliterate messages, anyone's | `ownersMayObliterate` | yes in a group room or a space's own chat, no in a direct room |
| An edit or a plain deletion keeps the version it replaces | `keepsHistory` | no |
| A sender's deletion obliterates their message | `deletionIsObliteration` | no |
| How far before the clock a proposed time is accepted | `proposedTimeMaxAgeNsec` | 10 minutes |
| How far after the clock a proposed time is accepted | `proposedTimeMaxLeadNsec` | 10 seconds |
| How long an entry stays in `recentActivity` | `recentActivityWindowNsec` | 10 minutes |
| How many of the newest messages `messages.latest` holds | `maxWindowCount` | 100 |
| The most message windows a session can have open | `maxOpenWindows` | 50 |
| The most attachments a message may have | `maxAttachments` | 10 |

These are the first build's values. Once the configuration exists, rooms can
differ from them. The room reads `ownersMayObliterate`,
`deletionIsObliteration`, `maxWindowCount`, and `maxAttachments`; the other
keys are stated for
the policy's shape, which a user's Home carries, and read by nothing. `ownersMayObliterate` is there for a group room with many
OWNERs; a direct room is set up without it, and its two people each obliterate
only their own messages. The room's kind picks which policy document
`about.policy` links, one stating `ownersMayObliterate` and one not, unless
`FabriChatRoomCore` is given the setting as an input, which the room's own
pattern leaves unset. Nothing in the room's rendering shows or changes it. A
room states its settings in `about.policy`
([`ChatRoomPolicy`](ChatRoomPolicy.md)), with every key present. Its handlers
are bound to `ownersMayObliterate` as the value that picks that document, so
what the document states is what the room allows.

## Prerequisites

- **A private space, created from a pattern.** The manager's
  `FabriChatRoom.inSpace()` creates a space with a random DID whose genesis
  document names its creator an OWNER, plus the grants it names
  ([random space identities](../random-space-identities.md)), reserves the
  room as the space's root
  ([custom space roots](../../features/custom-space-roots.md)), and declares
  the space's kind ([space kinds](../../features/space-kinds.md)).
- **Once-only delivery.** The room keeps no memory of the events it has acted
  on, so it relies on the runtime delivering each durable stream entry to its
  handler exactly once, and deduplicating a client's re-sent append at its
  event id ([events](../server-side-execution/events.md), §4).
