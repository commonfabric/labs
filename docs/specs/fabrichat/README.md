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
  lives in a shared space whose members are the conversation's members: usually
  a space of its own, or, for the chat of everyone in a shared space, that
  space. It holds the attested history: messages and reactions.
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
  │ FabriChatManager  │ links  │ FabriChatRoom             │
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

- **Room.** One conversation: a `FabriChatRoom` piece, in a space created for it
  or in the shared space whose own chat it is.
- **Member.** A principal the room space's access list admits. A room of its own
  admits only WRITE and OWNER; a space's own chat can have READ members, who
  read only its newest messages. OWNER is needed to add or remove members.
  Membership is the access list, and nothing kept beside it decides it.
- **Direct room.** A room created for exactly two members, found by the manager
  from either member's side by the other member's principal.
- **Group room.** Any other room. Two group rooms can have the same members.
- **Container.** A space that shows chats among other things, such as a space
  whose root is the `loom` pattern (`packages/patterns/loom/`).
- **Placement.** One room placed in a container: a `FabriChatPlacement` piece in
  the container's space, holding a link to the room. It has no rendering.
- **Adapter.** A `FabriChatAdapter` piece that renders one placement for hosts
  that render VDOM. A container holds the adapter.
- **Shared space.** A space whose access list admits more than one principal,
  and whose **member set** is reified: for each principal the access list
  admits, its access and the profile it contributed, readable by the space's
  members. A room's space is a shared space, and so is a container that more
  than one person uses. See [Shared spaces](#shared-spaces).
- **Client.** A program that reads and writes FabriChat on a person's behalf:
  the shell, or a separate application embedding the runtime.
- **Reviewed surface.** The part of a rendering whose gestures the runtime
  admits as the person's own act (`TrustedActionWrite`, in [the CFC authoring
  contract](../ts-transformer/cfc_authoring_contract.md)).

## Decisions

1. **A conversation lives in its own shared space**, or, for the chat of
   everyone in a shared space, in that space (decision 7). A container shows a
   room by linking to it, never by copying it. A link carries its target's label
   across the space boundary, and copied bytes do not ([cross-space
   integrity](../cfc-cross-space-integrity.md), §1).
2. **Membership is the room space's access list**, read through the space's
   member set. A profile shown for a member is one that member contributed. The
   access list, not a list kept beside it, decides who can read and write.
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
6. **Creating rooms and granting access are outward acts.** They are admitted
   from reviewed surfaces, like sends. Leaving is deliberately not reviewed: it
   acts on no one but the person leaving, and has to work from any client acting
   as them.
7. **A shared space's own chat lives in that space.** The chat of everyone in a
   shared space is a room in that space itself, so its membership is the space's
   membership by construction, with nothing to keep in step. Direct rooms and
   other group rooms get spaces of their own.
8. **Clients send to the room directly.** Neither a placement nor an adapter
   relays a send. A reviewed gesture reaches the room's own writer, so the
   room's write policy names only the room's own surfaces.
9. **The protocol surface is UI-free.** The contracts, and the records they
   offer, hold data and take requests. None of them carries rendering state,
   such as a draft, a reply being composed, or a scroll position: that belongs
   to whatever draws the chat. A client's requests to read, such as its windows,
   are part of the protocol.

## Shared spaces

Several parts of this design need to know who a space's members are. They need
to know it for the room's own space, which decides who is in a conversation, and
for a container, which decides who could see a room placed there. A shared space
settles that with a member set: one entry per principal its access list admits,
carrying that principal's access and the profile it contributed.

Two things exist today that a member set would be built from:

- **A space's access list** (`docs/specs/memory-v2/04-protocol.md`, §4.5.1) says
  who can read and write. Only a host can read it (the runtime client's
  `space:getAcl`), and it names principals, not people.
- **A roster of contributed profiles**, as the `loom` pattern keeps in
  `participants` ([shared-profile rosters](../shared-profile-rosters.md)). It
  names people, but every entry is a claim: any participant can add any profile.
  That pattern's own README says only a consumer that can read the access list
  can say which entries are participants.

A member set is the two combined: the roster's entries whose profile represents
a principal the access list admits, plus any admitted principal with no entry.
This design treats a member set as a property of the space, the same for every
pattern in it, rather than something each pattern keeps. Until the runtime
provides one, a room keeps its own roster, as `loom` does (see
[`ChatRoomOutput`](ChatRoomOutput.md#membership)).

With a member set:

- A room's membership, and who to show as its members, come from its space.
- A space's own chat (decision 7) needs no membership of its own.
- Starting a conversation from a shared space's members yields principals
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

- **A member set for a shared space**, readable by the space's members and by
  patterns running there (see [Shared spaces](#shared-spaces)).
- **Creating a private space from a pattern.** `Factory.inSpace()` creates a
  space with a random DID whose genesis document grants only its creator
  (`{ [creator]: "OWNER" }`), or the grants `inSpace(name, { grants })` names
  as well ([random space identities](../random-space-identities.md)).
- **Granting access from a pattern.** A handler on a client runtime can grant
  and revoke a space's members by principal with `grantSpaceAccess()` and
  `revokeSpaceAccess()`, gated on a trusted gesture from an OWNER
  ([changing a space's access list](../../features/space-access-changes.md)).
  A serving runtime refuses both. Space invitations don't serve: they are
  bearer credentials, not bound to the person they are meant for (see
  [`ChatManagerOutput`](ChatManagerOutput.md#admission-to-a-room)).
- **Delivering a notice.** Nothing in this repository lets a pattern deliver a
  message to a principal who shares no space with the sender (see
  [`FabriChatManager.md`](FabriChatManager.md#first-contact)).
- **Scoped sub-patterns and split write policies**, both still to check: a
  room's handler writing the sending session's own windows, and one message
  document written by two sets of writers (see
  [`FabriChatRoom.md`](FabriChatRoom.md#prerequisites)).
- **Host-issued trusted gestures.** A client that draws natively needs a
  sanctioned way to issue a reviewed gesture without a DOM. That is the
  "sanctioned headless issuance path" in the [host embedding policy
  record](../../features/host-embedding.md#6-policy-record-trusted-mark-threat-model)
  (see [`clients.md`](clients.md)).

## Implementation status

The four patterns are in `packages/patterns/fabrichat/`: `room.tsx`,
`manager.tsx`, `placement.tsx`, and `adapter.tsx`, with the contracts' records
in `schemas.tsx`. The home pattern holds a manager, and `#chatManager` resolves
to it (see [`HOME_SPACE`](../../common/conventions/HOME_SPACE.md#chat-manager)).
Home's **Chats** tab renders the manager: the user's rooms, the room chosen
among them, and the controls that start a direct or a group chat. Where the
runtime lacks a prerequisite, the patterns depart from this design, as below.

### Access and principals

- **Access changes only at creation.** The manager creates a room of its own
  with `FabriChatRoom.inSpace()`, naming grants, so its space grants the
  creator OWNER and each other member WRITE, as the design says. After that,
  nothing grants, revokes, or gives up access: `leave` removes the sender's
  roster entry and records them as having left, and `add` adds its notice, so
  a member added later can open the room only once a host grants them access.
  Each records its activity entry. `remove` is refused, since a removal that
  changed nothing would be recorded falsely.
- **One OWNER.** A room knows one OWNER, its creator, whose profile the manager
  passes when it creates the room, and takes the OWNER-only rules to mean the
  creator. A space's own chat knows no OWNER. `canSend` is whether the
  reader's profile resolves.
- **Principals from handlers only.** A handler learns the principal it acts
  for (`currentPrincipal()`), so a room keys its request memory, and the
  members who left, by the sender's principal, and refuses to `add` someone
  who left; the manager refuses a direct room with the user themself and
  leaves them out of a group's other members. A reaction's address still
  derives from its reactor's profile, as the design says. What no pattern can
  learn is the principal a profile represents, so a roster entry stays a
  claim.
- **Creation takes one transaction.** The room's space comes with its grants,
  so writing the room, its notices, and its index entry happens in one commit,
  rather than in the design's resumable steps, and a request's outcome is
  `done` or `refused` from the start. A request already
  decided changes nothing when it arrives again.
- **Placements don't know who is a member.** A placement can't read access, so
  a viewer who can't read the room sees it as `"unavailable"`, never as
  `"not-member"`. No container creates placements yet: a client does.

### Writers and labels

- **Every record names its writers.** Beyond what the design requires of
  messages and reactions, each of the room's records (its request memory,
  used times, activity and its numbering, roster, departures, notices, and
  each session's windows) has a write policy listing the handlers that write
  it (`WritePolicyAnyOf`), so no other code can write it, even code a member
  runs in the room's space. `remove` is on the lists it will write once it can
  revoke access.
- **Membership and starts are not gesture-checked.** `add` and `remove` are
  sent from controls marked `ChatMembersSurface`, and `openDirect` and
  `createGroup` from controls marked `ChatStartSurface`, but no write policy
  requires either gesture, since the records they write are also written by
  acts with none. One handler, `commitManager`, writes the manager's records,
  and each of its streams is a binding of it.
- **Only messages and reactions are labeled `authored-by`.** The runtime gives
  that label only to a record every one of whose writers names a reviewed
  gesture, so neither `about`, which the creator's manager writes, nor a
  `recentActivity` entry, which acts with no gesture write too, carries it.
  `about` is a plain argument of the room, written when the room is created,
  and its `policy` links a document the room writes when it starts.

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
- **Notices.** A room's notice id is `[principal, requestId]` as JSON, so the
  client that sent `add` can report it delivered without reading it back. A
  manager's is `[recipient, requestId]`.
- **Request ids.** A rendered control sends no `requestId`, and the room and
  the manager use the event's own key (`eventKey()`), which is the same on
  every run of that event.

## Identity and presentation

The five questions from [multi-user
patterns](../../common/patterns/multi-user-patterns.md#what-a-spec-should-capture-about-identity):

1. **The current viewer** is resolved with `wish({ query: "#profile" })`, never
   typed in.
2. **Each person is displayed** with `cf-profile-badge`, bound to the profile
   link on their messages and roster entries, and read when drawn. FabriChat
   stores no names or avatars, so a changed name shows everywhere, history
   included. A profile that can't be read shows as a neutral placeholder (see
   [`ChatProfile.md`](ChatProfile.md)).
3. **Shared and per-user state.** A room's history is `PerSpace` in the room's
   space, and its members are that space's member set. The manager's index is in
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
