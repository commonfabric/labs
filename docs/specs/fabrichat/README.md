# FabriChat

This directory describes the four patterns FabriChat is made of, and what they
require of the runtime and of the programs that use them. [Implementation
status](#implementation-status) says where they are built, and where the build
departs from this design.

## Quick links

- Patterns:
  - [`FabriChatRoom`](FabriChatRoom.md): one conversation.
  - [`FabriChatManager`](FabriChatManager.md): each user's index of rooms.
  - [`FabriChatPlacement`](FabriChatPlacement.md): a room placed in a container.
  - [`FabriChatAdapter`](FabriChatAdapter.md): a placement's rendering.
- Contracts, named for their roles:
  - [`ChatRoomOutput`](ChatRoomOutput.md): what a room offers.
  - [`ChatManagerOutput`](ChatManagerOutput.md): what `#chatManager` resolves
    to.
- Windows onto a room's messages:
  - [`ChatMessageWindow`](ChatMessageWindow.md): one window of them.
  - [`ChatWindowAnchor`](ChatWindowAnchor.md): where a window sits: at either
    end, or around one message.
- Records a room holds:
  - [`ChatMessage`](ChatMessage.md)
  - [`ChatMessageList`](ChatMessageList.md): a room's messages: facts, the
    newest, and each session's windows.
  - [`ChatReply`](ChatReply.md): what a reply replies to, and where it's shown.
  - [`ChatMessageVersion`](ChatMessageVersion.md): an earlier version of a
    message.
  - [`ChatReaction`](ChatReaction.md)
  - [`ChatRoomAbout`](ChatRoomAbout.md)
  - [`ChatRoomPolicy`](ChatRoomPolicy.md): a room's policy, stated correctly.
  - [`ChatRoomActivity`](ChatRoomActivity.md): an entry in a room's recent
    activity.
  - [`ChatProfile`](ChatProfile.md): the part of a profile the room reads.
- Records a manager holds:
  - [`ChatIndexEntry`](ChatIndexEntry.md)
- [Requirements on clients](clients.md)

## Purpose

FabriChat is a chat among people, each identified by their own profile, where
every message and reaction is attested: the runtime labels it with the principal
who wrote it, and the write is admitted only from a reviewed surface.

As a single piece, a conversation lives wherever that piece lives. That is the
wrong shape once a conversation can appear in more than one place. A one-to-one
conversation with a particular person should be _one_ conversation, whichever
container space it is shown in. Showing it in three places must not create three
conversations. So the conversation, the index that finds it, and the places that
show it become four patterns:

- **The room** ([`FabriChatRoom.md`](FabriChatRoom.md)) is the conversation. It
  is the chat of a social space whose members are the conversation's members:
  a space created for the conversation, whose root the room is, or an existing
  social space. It holds the attested history, messages and reactions. Who is
  in the space is the space's business: its access list decides, and its root
  lists its participants, as a room that is its space's root does itself.
- **The manager** ([`FabriChatManager.md`](FabriChatManager.md)) is a singleton
  in each user's home space. It finds the rooms that user belongs to, in
  particular the one direct room they share with a given person, and it creates
  new rooms.
- **The placement** ([`FabriChatPlacement.md`](FabriChatPlacement.md)) is one
  room placed in some other space, a container that displays chats. It holds a
  link to the room, has no rendering, and offers a `[VIEWS]` group: what the
  placed chat holds, and what the viewer may see of it. It is what a client that
  draws natively reads.
- **The adapter** ([`FabriChatAdapter.md`](FabriChatAdapter.md)) renders one
  placement for hosts that render VDOM. A container holds the adapter, which
  links to its placement.

[`clients.md`](clients.md) states what a separate program that uses these
patterns must do, and must not do. That applies especially to a program that
draws chats with its own toolkit instead of rendering the patterns' `[UI]`.

```text
  home space (per user)        room space (per conversation)
  ┌───────────────────┐        ┌───────────────────────────┐
  │ FabriChatManager  │ links  │ FabriChatRoom (the root)  │
  │  index of rooms   ├───────►│  messages, reactions      │
  │  direct: by person│        │  members (access list)    │
  └───────────────────┘        └───────────────────────────┘
                                   ▲                ▲
                           link    │                │  link
  container space A ───────────────┘                └─────── container space B
  ┌────────────────────┐                            ┌────────────────────┐
  │ FabriChatPlacement │                            │ FabriChatPlacement │
  │   ▲ link           │                            │   ▲ link           │
  │ FabriChatAdapter   │                            │ FabriChatAdapter   │
  └────────────────────┘                            └────────────────────┘
```

## Status and interpretation

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are normative. Where this design depends on something the runtime does not yet
provide, the document says so, under the heading "Prerequisites".

## Reading order

1. [`FabriChatRoom.md`](FabriChatRoom.md): the conversation, its record, its
   writers, and its membership.
2. [`FabriChatManager.md`](FabriChatManager.md): the per-user index, direct-room
   lookup, and room creation.
3. [`FabriChatPlacement.md`](FabriChatPlacement.md): a room placed inside
   another space, and what a viewer may see of it.
4. [`FabriChatAdapter.md`](FabriChatAdapter.md): rendering a placement for hosts
   that render VDOM.
5. The contracts: [`ChatRoomOutput.md`](ChatRoomOutput.md) and
   [`ChatManagerOutput.md`](ChatManagerOutput.md), named for the roles rather
   than the patterns that fill them.
6. The records a room holds: [`ChatMessage.md`](ChatMessage.md),
   [`ChatMessageList.md`](ChatMessageList.md),
   [`ChatMessageWindow.md`](ChatMessageWindow.md),
   [`ChatWindowAnchor.md`](ChatWindowAnchor.md), [`ChatReply.md`](ChatReply.md),
   [`ChatMessageVersion.md`](ChatMessageVersion.md),
   [`ChatReaction.md`](ChatReaction.md), [`ChatRoomAbout.md`](ChatRoomAbout.md),
   [`ChatRoomPolicy.md`](ChatRoomPolicy.md),
   [`ChatRoomActivity.md`](ChatRoomActivity.md), and
   [`ChatProfile.md`](ChatProfile.md), the part of a person's profile the room
   reads.
7. The record a manager holds: [`ChatIndexEntry.md`](ChatIndexEntry.md).
8. [`clients.md`](clients.md): the requirements on a separate program that uses
   FabriChat, including one that renders natively.

## Terms

- **Room.** One conversation: a `FabriChatRoom` piece, the chat of a social
  space, which is either created for it, with the room as its root, or an
  existing one.
- **Member.** A principal the room space's access list admits. A member with
  READ reads only the newest messages; WRITE or OWNER is needed to act. Who is
  a member changes through the space's own tools, such as the CLI's `cf acl`,
  and, for a room in a space of its own, through the room's add control.
- **Direct room.** A room created for exactly two members, found by the manager
  from either member's side by the other member's principal.
- **Group room.** Any other room. Two group rooms can have the same members.
- **Container.** A space that shows chats among other things, such as a space
  whose root is the `loom` pattern (`packages/patterns/loom/`). A container
  may name its own chat, a room in its space, as the `loom` pattern's root
  does with its `chatRoom` link.
- **Placement.** One room placed in a container: a `FabriChatPlacement` piece in
  the container's space, holding a link to the room. It has no rendering.
- **Adapter.** A `FabriChatAdapter` piece that renders one placement for hosts
  that render VDOM. A container holds the adapter.
- **Social space.** A space with more than one member or participant
  ([glossary](../../common/concepts/glossary.md#social-space)), whose root
  lists its **participants**: the profiles members contributed by joining the
  space. A room's space is a social space, and so is a container that more than
  one person uses. See [Social spaces](#social-spaces).
- **Client.** A program that reads and writes FabriChat on a person's behalf:
  the shell, or a separate application embedding the runtime.
- **Reviewed surface.** The part of a rendering whose gestures the runtime
  admits as the person's own act (`TrustedActionWrite`, in [the CFC authoring
  contract](../ts-transformer/cfc_authoring_contract.md)).

## Decisions

1. **A conversation lives in a social space**, as that space's chat (decision
   7). A container shows a room by linking to it, never by copying it. A link
   carries its target's label across the space boundary, and copied bytes do not
   ([cross-space integrity](../cfc-cross-space-integrity.md), §1).
2. **Membership is the room space's.** Its access list decides who can read and
   write, and its root lists the profiles its participants contributed, which
   for a room in a space of its own is the room itself. The room keeps no
   membership beyond that list.
3. **History is attested.** Messages and reactions are `AuthoredByCurrentUser`
   and `TrustedActionWrite`. A message's sender can
   edit or delete it, each change recorded as a new version, and a message can
   be obliterated, by an OWNER curating a group room or by either person in a
   direct room for their own messages, leaving only an attested tombstone. A
   reaction is removed only by its own reactor, or with its message. Every
   recorded version has a time unique in its room.
4. **Each user has one manager, in their home space**, found with a well-known
   `wish` target. A user's index of conversations is private to that user.
5. **A direct room is keyed by the other member's principal**, not by a profile.
   A person can have several profiles, and one conversation with a person must
   not split along them.
6. **Creating a conversation is an outward act.** It is admitted from a
   reviewed surface, like a send. Changing who is in a conversation's space is
   the space's business, through its own tools.
7. **Every conversation is a space's chat.** A room's membership is its
   space's membership by construction, with nothing to keep in step. A direct
   or group conversation gets a space created for it, whose root is the room: a
   social space in its own right, which lists its participants itself, and
   which declares itself a `fabrichat-room`
   ([space kinds](../../features/space-kinds.md)). A space that already exists,
   such as a container, can have its own chat too, and keeps its own root. A
   room can be part of any other social space as well, through a placement and
   an adapter, and there the other space's root stays the root.
8. **Clients send to the room directly.** Neither a placement nor an adapter
   relays a send. A reviewed gesture reaches the room's own writer, so the
   room's write policy names only the room's own surfaces.
9. **The protocol surface is UI-free.** The contracts, and the records they
   offer, hold data and take requests. None of them carries rendering state,
   such as a draft, a reply being composed, or a scroll position: that belongs
   to whatever draws the chat. A client's requests to read, such as its windows,
   are part of the protocol.

## Social spaces

Several parts of this design need to know who a space's members are. They need
to know it for the room's own space, which decides who is in a conversation, and
for a container, which decides who could see a room placed there. A space
offers two halves of that:

- **Its access list** says who can read and write. A pattern reads its own
  principal's level (`spaceAccess()`), and the space's own tools change it.
  No pattern can list the whole access list.
- **Its participants**, the profiles its root lists (`participants`, which a
  pattern in the space reads through `wish({ query: "#default" })`), name
  people, but each entry is a claim: any participant can add any profile, by
  joining the space ([shared-profile rosters](../shared-profile-rosters.md)). A
  room in a space of its own is that root, and keeps them itself.

A **member set**, the participants whose profile represents a principal the
access list admits, plus any admitted principal with no entry, would combine
the two. It is a property of the space, the same for every pattern in it. Until
a space offers one, a reader shows the participants as claims.

With a member set:

- Starting a conversation from a social space's members yields principals
  directly (see [`FabriChatManager.md`](FabriChatManager.md#prerequisites)).
- A client can tell whether a container admits anyone besides a direct room's
  two members, which it must know before placing that room there (see
  [`FabriChatPlacement.md`](FabriChatPlacement.md#viewers-who-arent-members)).

## Known quirks, accepted for now

- **Refusals are invisible.** A room refuses a bad event silently, so a sender
  learns of a refusal only by the absence of its effect. Streams are one-way,
  and a room's record is shared by every member, so outcomes kept there would
  tell everyone about each member's refused requests. The manager can keep
  outcomes because it's private to its user (see
  [`ChatRoomOutput`](ChatRoomOutput.md#streams)).
- **Crossing creations.** Two managers each keep their own index. If two people
  each start a direct room with the other at the same moment, there are two
  rooms. Each manager records the one it saw first. A tie-break rule is future
  work.
- **Group rooms shown in wider containers.** A container's members who aren't in
  the room see a placement whose room they can't read. That's safe, but it can
  be surprising. A direct room is never placed that way (see
  [`FabriChatPlacement.md`](FabriChatPlacement.md#viewers-who-arent-members)).

## Prerequisites

The design depends on runtime capabilities that don't exist yet. Each document
names the ones it needs, and they are gathered here:

- **A member set for a social space**, readable by the space's members and by
  patterns running there (see [Social spaces](#social-spaces)).
- **Creating a private space from a pattern.** `Factory.inSpace()` creates a
  space with a random DID whose genesis document grants only its creator
  (`{ [creator]: "OWNER" }`), or the grants `inSpace(name, { grants })` names
  as well ([random space identities](../random-space-identities.md)).
- **Delivering a notice.** A room is offered to its recipient through the
  share inbox their profile points at when the request that creates it names
  their profile. A member whose profile the request doesn't name is reached by
  nothing but a notice, and nothing delivers a notice to a principal who shares
  no space with the sender end to end (see
  [`FabriChatManager.md`](FabriChatManager.md#first-contact)).
- **Scoped sub-patterns and split write policies**, both still to check: a
  room's handler writing the sending session's own windows, and one message
  document written by two sets of writers (see
  [`FabriChatRoom.md`](FabriChatRoom.md#prerequisites)).
- **Native reviewed acts as trusted gestures.** A client that draws natively
  issues a reviewed act through the sanctioned path
  ([host embedding](../../features/host-embedding.md#10-native-reviewed-controls),
  §10), and a native reviewed act counts wherever a trusted gesture does
  ([§11](../../features/host-embedding.md#11-policy-record-native-reviewed-acts-count-as-trusted-gestures)),
  adding a member included (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)).

## Implementation status

The four patterns are in `packages/patterns/fabrichat/`: `room.tsx`,
`manager.tsx`, `placement.tsx`, and `adapter.tsx`, with the contracts' records
in `schemas.tsx`. The room's stored records and the handlers that write them are
in `room-records.tsx`, and one message's rendering in `message-row.tsx`. The
home pattern holds a manager, and `#chatManager` resolves to it (see
[`HOME_SPACE`](../../common/conventions/HOME_SPACE.md#chat-manager)), but
home renders it nowhere of its own: a page shows it at its path in home's
result, with the user's rooms, each a link that opens the room as a page of its
own, the controls that start a direct or a group chat, and, when the session's
latest start was refused, the reason. A refusal of text that isn't a principal
also shows the text. Where the runtime lacks a prerequisite, the patterns depart
from this design, as below.

### Access and principals

- **Membership is set at creation, then the space's.** The manager creates a
  space for a conversation with `FabriChatRoom.inSpace()`, with the room as its
  root and the space declaring itself a `fabrichat-room`, naming grants: the
  creator and each other member OWNER, and everyone WRITE for a group made
  joinable by its link. After that, who is in it changes through the space's
  own tools, and through the room's add control, from which any OWNER admits
  someone as OWNER with `grantSpaceAccess()`. A client that draws natively can
  offer it too, through the sanctioned issuing path (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)).
- **A room keeps its own participants.** A room in a space of its own keeps
  the space's participants through `addParticipant`, the roster's one writer
  (`packages/patterns/loom/participants.tsx`): the manager that creates or
  accepts the room adds its user, from an event that follows. As a stop-gap, a
  member whose manager has done neither is not on the roster, and is shown
  among the participants only once they write, as an author. A room in an
  existing social space lists that space's participants, then those who
  joined the room itself.
- **Principals.** A handler learns the principal it acts for
  (`currentPrincipal()`), so a room keys its request memory by the sender's
  principal, and the manager refuses a direct room with the user themself and
  leaves them out of a group's other members. A reaction's address still
  derives from its reactor's profile, as the design says. The manager takes
  principals as typed. A room offers a direct chat with each participant
  whose profile attests a principal (`principalOf()`), except the viewer, by
  sending that principal to the `openDirect` of the viewer's manager, found
  with `#chatManager`. `accept` takes a direct room's counterpart from the
  label on its `about.record`, and refuses one the event names otherwise (see
  [writers and labels](#writers-and-labels)).
- **Creation takes one transaction.** The space comes with its grants, so
  writing the room, the manager's notices, and its index entry happens in one
  commit, rather than in the design's resumable steps, and a request's outcome
  is `done` or `refused` from the start. A request already decided changes
  nothing when it arrives again.
- **No container creates placements.** A client does. A placement reads its
  viewer's access to the room's space, so `"none"` shows as `"not-member"`,
  and a level not known yet as `"unavailable"`.

### Writers and labels

- **Every record names its writers.** Beyond what the design requires of
  messages and reactions, each of the room's records (its request memory, used
  times, activity and its numbering, and each session's windows) has a write
  policy listing the handlers that write it (`WritePolicyAnyOf`), so no other
  code can write it, even code a member runs in the room's space.
- **A start is checked where it creates a room.** `openDirect` and
  `createGroup` are performed by a handler of their own, `commitStart`, and the
  record a manager-created room keeps about itself names that handler and
  `ChatStart` on `ChatStartSurface` as its only writer, so a start that creates
  a room commits only from that reviewed gesture; without it, its run is
  refused whole, and records no outcome. A start that creates none,
  `openDirect` finding a direct room already shared or a start that is
  refused, commits without one, and grants no one access. The manager's other
  acts are performed by `commitManager`, with no gesture. A participant's chip
  in a room sends its click to the viewer's manager's `openDirect` itself,
  naming the participant's principal as `target.dataset.counterpart`, since a
  reviewed gesture does not carry across a `send` from another handler.
- **Labels without a gesture.** Messages and reactions are labeled
  `authored-by` under a reviewed gesture, as the design says, and so is
  `about.record`, under the start that created the room. A `recentActivity`
  entry is labeled too, by a writer that names no gesture (each handler
  appending an entry), so its label says whose run wrote it, not that the
  person made a gesture. `about` is the room's own view, with its `policy`, a
  document the room writes when it starts, and `about.record` links the stored
  record.

### Records

- **Keyed records.** Each message, each reaction, and each `recentActivity`
  entry is a document of its own, addressed by a key (`elementById`), so
  writing one never rewrites another, and a record keeps the label its own
  writer gave it.
- **Reactions are a list the message links.** Each message links a list of its
  own reactions, a document the send creates empty and only the reaction
  handlers write after that, until a deletion or an obliteration clears it and
  drops the link.
- **Windows.** A window holds links to its messages, which stay live;
  `hasOlder` and `hasNewer` are as of when the window was set. `commitWindow`
  writes the windows of the session that sent the event, wherever it runs; an
  event the server itself emitted has no session, and can't open one.
- **Notices and offers.** A manager's notice id is `[recipient, requestId]` as
  JSON, and an offer's `id` is the `requestId` alone. An offer reaches the
  recipient's inbox, and their host's share intake vets it and registers the
  room's space in their Home's shared-space catalog
  ([`private-inbox.md`](../../features/private-inbox.md#the-share-intake)), but
  the manager lists only the rooms it records itself, not the catalog's, so the
  offered room reaches the recipient's chats only as a notice's room does,
  through `accept`. And only an `openDirect` that names `profile` offers a room:
  the rendered start controls name a counterpart by principal, and a group's
  members are principals. Nothing delivers a notice yet (see [first
  contact](FabriChatManager.md#first-contact)), so the manager's rendering shows
  each queued notice with a link to its room, for the room's creator to send on.
  And a room shows a viewer whose manager doesn't list it a control that asks
  the manager to `accept` it, so whoever opens the room's link can add it to
  their chats.
- **The catalog.** Creating a room registers its space in the user's Home
  shared-space catalog
  ([`shared-space-catalog.md`](../../features/shared-space-catalog.md)), in the
  creating transaction once the space's name has resolved, and so does accepting
  a room a manager created. Each room registered is registered under the
  manager's own host, since a pattern can't read which host serves a space.
  Finding a direct room again, or accepting a room, restores its entry if it was
  archived. The manager's `rooms` is still its own list: forgetting a room
  removes it from `rooms` and leaves its catalog entry saved, and a room the
  share intake registers is not in `rooms`.
- **Request ids.** A rendered control sends no `requestId`, and the room and
  the manager use the event's own key (`eventKey()`), which is the same on
  every run of that event.

## Identity and presentation

The five questions from [multi-user
patterns](../../common/patterns/multi-user-patterns.md#what-a-spec-should-capture-about-identity):

1. **The current viewer** is resolved with `wish({ query: "#profile" })`, never
   typed in.
2. **Each person is displayed** with `cf-profile-badge`, bound to the profile
   link on their messages and in their space's participants, and read when
   drawn. FabriChat stores no names or avatars, so a changed name shows
   everywhere, history included. A profile that can't be read shows as a neutral
   placeholder (see [`ChatProfile.md`](ChatProfile.md)).
3. **Shared and per-user state.** A room's history is `PerSpace` in the room's
   space, and its members are that space's. The manager's index is in
   the user's home space. Drafts are `PerSession`, kept by the room's own
   `[UI]`, since they belong to one connection and not to the room.
4. **A person is identified** by cell reference with `equals()` for display, and
   by principal for direct-room lookup. Never by display name.
5. **Authorship is attested.** Every message and reaction carries an
   `authored-by` label for its writer. A message counts as verified when that
   principal is the one its linked profile represents, which is the check
   `cf-cfc-authorship` makes.

## Non-goals

- Bridges to outside messaging networks.
- Typing indicators, presence, and read receipts.
- Notifications and push delivery.
- Encryption beyond what a space's access list provides.
