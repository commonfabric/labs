# FabriChatManager

`FabriChatManager` is an implementation of
[`ChatManagerOutput`](ChatManagerOutput.md), which states everything a chat
manager does: where it lives, what its indexes mean, and what each request does.
This document says how this implementation does it.

## Where it lives

`FabriChatManager` is a field of the home pattern
(`packages/patterns/system/home.tsx`), which is what gives each user exactly
one. The home target `#chatManager` resolves to that field. The spelling follows
the camel case of the other multi-word targets (`#learnedSummary`,
`#pieceRegistry`, `#profileName`).

Adding the target takes the same steps `#agent_queue` took: the field and child
piece in `home.tsx`, a case in `getResolutionKind` and in
`resolveHomeSpaceTarget` (`packages/runner/src/builtins/wish.ts`), tests beside
each, and a row in the built-in targets table of
[`wish`](../../common/conventions/wish.md) and in
[`HOME_SPACE.md`](../../common/conventions/HOME_SPACE.md).

## State

The manager keeps `direct`, `requests`, and `outgoingNotices` in the home space.
`rooms` it keeps nowhere: it is drawn from the user's shared-space catalog,
Home's, which Home hands the manager
([`shared-space-catalog.md`](../../features/shared-space-catalog.md)). The
manager lists the entries of kind `fabrichat-room` the catalog keeps as saved,
each the space of a room that is its space's root, found with `wish({ query:
"#default", scope: [space] })`. A room's `kind` is the one its `about` gives,
and its `since` and `revision` are its entry's. A direct room's `counterpart` is
the one `direct` holds the room under, for a room `direct` holds, or else the
room's creator, as its `about.record` is labeled; a room whose label can't be
read is listed with no counterpart. A room appears in `rooms` once its root
resolves and its `about` reads. `direct` holds one entry per counterpart,
including forgotten rooms, for the direct rooms this manager created or
accepted, and `openDirect` finds a direct room there and nowhere else. A room
another manager created and offered the user is there too, once the user's host
has registered the offer, since the host's share intake then has the manager
accept it on the user's behalf (see [first contact](#first-contact)). `rooms`
can also hold a second direct room with the same counterpart, after crossing
creations.

The handlers write the catalog. Creating a room, or accepting one a manager
created, registers the room's space (`registerSharedSpaceIn()`), forgetting a
room archives its entry, at the revision the request names, and finding a direct
room again, or accepting a room, restores its entry if it was archived
(`changeSharedSpaceMembershipIn()`), except that an acceptance made on the
user's behalf, with `keepArchived`, leaves it archived. A room offered to the
user is registered by the host that vets the offer (see [first
contact](#first-contact)). Accepting a space's own chat, which no manager
created, is refused, since its space is the social space it belongs to. A
manager given no catalog keeps one of its own.

Creating or accepting a room also adds this user's profile to the room's
participants, through the room's `addParticipant`, from an event of its own
that follows. Accepting a room needs no profile: one accepted before the
user's profile resolves is recorded all the same, and the user isn't added.
Offering a new room to a member adds that member's profile the same way (see
[first contact](#first-contact)).

## Creating a room

`openDirect` (when it finds no room with the counterpart) and `createGroup`
create a space for the conversation, with the room as its root, in four steps:

1. Create the conversation's space, with only this user granted (OWNER), and
   instantiate `FabriChatRoom` there with its `about`, as the space's root, in
   a space that declares itself a `fabrichat-room`
   (`inSpace(undefined, { grants, root: true, spaceKind: "fabrichat-room" })`).
   The room is then a social space in its own right: opening the space shows
   it, and it keeps the space's participants itself.
2. Grant each other member OWNER on the room's space, by principal, so any
   member may add others.
3. Offer the room to each other member whose profile the request names,
   through the share inbox the profile points at, and add to the room's
   participants each member it is offered to. Add a notice to
   `outgoingNotices`, for a client to deliver, for each other member offered
   nothing: one the request names only by principal, or one whose profile
   points at no inbox.
4. Record the entry in `rooms`, and in `direct` for a direct room, register the
   room's space in the user's catalog, and mark the request `done`. The
   registration waits for the space's name to resolve, and adding this user to
   the room's participants follows then: the run that sees the name pending is
   discarded and run again, and its sends could still be delivered.

Each step is recorded under the request's `requestId` as it completes, which is
how a repeated request resumes where the last attempt stopped instead of
creating another room. A pending `openDirect` is also recorded under its
`counterpart`, which is how a second `openDirect` for the same person finds it
and resumes it. Step 1 writes the room's `about` from this user's handler, which
is what labels it `authored-by` this user.

## Prerequisites

- **Creating a private space from a pattern**: the same as the room's (see
  [`FabriChatRoom.md`](FabriChatRoom.md#prerequisites)).
- **A principal from a profile.** A client that starts a direct room from a
  person's profile needs that profile's principal, since `openDirect` and
  `createGroup` take principals. A profile's value carries a
  `represents-principal` label, which
  `principalOf(profile, "represents-principal")` reads
  ([reading the principal a label attests](../../features/principal-of.md)).
  A social space's member set pairs each principal with a profile (see [social
  spaces](README.md#social-spaces)), so starting a conversation with someone
  found in one needs nothing more.

### First contact

A notice has to reach a principal who may share no space with the sender. Its
route is the recipient's profile share inbox: a profile's `inbox` field
(`inbox.piece`, `packages/patterns/system/profile-home.tsx`) points at an inbox
piece in a space of its own. That is either the private inbox the recipient's
Home creates ([the private inbox](../../features/private-inbox.md)) or another
share inbox the profile points at, and both take the same offer envelope. Any
principal may write to the inbox's space, and its offers are labeled readable by
the owner alone, a label that binds only an honest runtime. When a request names
a member's profile, as `openDirect` does with its `profile`, step 3 offers the
room there, in that envelope, from an event of its own that follows the room's
creation, since the offer names the room's space (see
[`ChatManagerOutput`](ChatManagerOutput.md#offers)). The same event reads the
profile's `inbox`, which the creating transaction never reads, and adds the
member's profile to the room's participants, through the room's
`addParticipant`, before they have opened the room, whose space already grants
them OWNER. The recipient's host reads the offer and vets it before it registers
the room's space in the recipient's Home catalog ([the share
intake](../../features/private-inbox.md#the-share-intake)). Once the host has
registered a new entry for the room, it sends the room to the recipient's own
manager's `accept`, with `keepArchived`, so their manager records it as an
acceptance from the room would, in `direct` for a direct room unless `direct`
already holds a room with its creator, and adds their profile to the room's
participants, which already list them. A member the
request names only by principal is offered nothing, since the manager has no
profile to reach their inbox through. A space's access list can admit any
writer, but that is the `"*"` grant a room has only when its creator makes a
group joinable by its link, and then its address, sent some other way, is the
notice.

That is why step 3 hands a notice for each member offered nothing to a client
through `outgoingNotices` (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). A profile
pointing at no inbox gets a notice too, decided by the event that reads the
pointer. A member sent an offer gets no notice, and nothing tells the sender
whether the offer arrived. Once offers deliver end to end, the manager can
deliver notices itself.
