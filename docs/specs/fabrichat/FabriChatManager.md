# FabriChatManager

`FabriChatManager` is an implementation of
[`ChatManagerOutput`](ChatManagerOutput.md), which states everything a chat
manager does: where it lives, what its indexes mean, and what each request does.
This document says how this implementation does it.

## Where it lives

`FabriChatManager` is a field of the home pattern
(`patterns/system/home/home.tsx`), which is what gives each user exactly
one. The home target `#chatManager` resolves to that field. The spelling follows
the camel case of the other multi-word targets (`#learnedSummary`,
`#pieceRegistry`, `#profileName`).

Adding the target takes the same steps `#agent_queue` took: the field and child
piece in `home.tsx`, a case in `getResolutionKind` and in
`resolveHomeSpaceTarget` (`runtime/runner/src/builtins/wish.ts`), tests beside
each, and a row in the built-in targets table of
[`wish`](../../common/conventions/wish.md) and in
[`HOME_SPACE.md`](../../common/conventions/HOME_SPACE.md).

## State

The manager keeps `direct`, `requests`, `outgoingNotices`, and
`roomMembership` in the home space. `rooms` is derived per user from those
membership records and the user's shared-space catalog, Home's, which Home
hands the manager
([`shared-space-catalog.md`](../../features/shared-space-catalog.md)), and from
nothing else: deriving it reads no room. Every link to a room the manager
stores, in `roomMembership`, `direct`, `requests` and `outgoingNotices`, is
declared a handle with nothing behind it (`Cell<unknown>`), so a read of any of
them, Home's own sync among them, keeps the link and loads no room. The
derivations that read rooms, `people` from the listed rooms' rosters and
`outgoingNotices` from each notice's room's roster, first re-type the links to
`ChatRoomLink`, which declares the rosters; nothing else reads them. `people`
re-types each link where it reads that room's roster, in an instance of its
own per room whose argument holds the handle, so no list the manager stores
types a room as more than a handle; a reader that syncs such a list would walk
into every room it names.

The manager wishes for `#profile` twice. The user's wish, stored per user,
supplies the profile `rooms`, `people` and `outgoingNotices` are derived from,
which are the user's. A second wish, declared `PerSession`, supplies the profile
each session finds for itself: whether the start controls are disabled, the chat
address the rendering shows, and the profile each act is taken as are derived
from it, each per session. A session whose wish finds no profile, or fails,
writes that into its own instance of the second wish, never over the one
another session of the user reads (see
[`ChatManagerOutput`](ChatManagerOutput.md#scopes)).

Each saved membership lists its room, with what its handler recorded: the
room's kind, from its `about`, a direct room's counterpart, verified as the
room's labeled creator, its `since` and opaque `revision`, and its title as the
handler last read it. A standalone room's catalog membership remains
authoritative: its current catalog state and revision govern listing and
forgetting, as `effectiveMemberships()` applies them, even when a container
declares it. Catalog restoration supersedes an older room tombstone; catalog
archive or removal supersedes a saved room record. A record's optional
`catalogRevision` remembers that authority across catalog removal. A
container's conversation is listed by its membership, whose `container` links
the root declaring it; forgetting it never archives its container. Rooms are
compared by their links, which a membership holds as its handler resolved
them, so a comparison resolves nothing; a standalone room is listed once for
its space, which holds no other. Clients pass the revision back unchanged to
`forget`.

Joining a record-backed standalone room registers its own space even when a
container declares it, and records a membership of it, as creating or
accepting a standalone room does, so a deleted room is listed under
`deletedRooms` by its record.

The manager's rendering labels each listed room with its entry's `title`, or,
for a direct room with no title, by its counterpart. A standalone room's
catalog entry holds its title too, as a display hint for readers of the
catalog. Registration takes the room's title, whatever its kind. Whenever the
manager handles `accept` or `joinRoom` for a room, it reads the room's `about`,
and brings the title the room's membership holds, and the catalog entry's
(`retitleSharedSpaceIn()`), up to the room's where they differ, moving neither
its revision nor its membership. That is all a join of an already-listed room
reads of the room, and it writes only on a mismatch. The one exception is a
`joinRoom` marked `messageAct`, which a room sends with every message and
reaction: none of those changes the title, so the manager reads nothing of the
room's `about` for one. The member who retitles a room tells their manager at
once; another member's entry follows on their manager's next event for that
room other than a message or a reaction: their own retitle, an acceptance, or a
client's `joinRoom` when they open it.

### Adopting the catalog's rooms

A room the catalog lists saved with no membership, as a catalog kept before
memberships were recorded lists one, or a container whose chat nobody has
joined, is not listed. The host adopts each one, at Home's bring-up, after the
rest of Home's housekeeping has started (`adoptCatalogRoomsOf()` in
`runtime/piece/src/ops/adopt-catalog-rooms.ts`): it vets the space as a visit
does, and sends the manager's `joinRoom` for the room the space declares,
under a request id naming the entry and its revision, so the manager records
the outcome, a membership or a refusal, once per revision. A joined room joins
the user to it, as a visit does: a user who saved a room has joined it. A
space that declares no room, or that vetting refuses, is sent a `joinRoom`
naming no room, which the manager refuses without reading anything, and which
keeps the entry from being tried again until it changes; a visit to the room
still joins it. An entry whose vetting fails otherwise is tried again at a
later bring-up, and holds back no other entry. A membership adopted this way
keeps the catalog entry's admission time as its `since`, so the room keeps its
place in the list. The manager's handling of the join adds the user to the
room's roster, and that event starts the room's piece on the host, as an event
to a piece that isn't running does. The host adopts five entries at a time.
Once the scheduler is idle after each five, it stops each piece an event's
delivery started during them in the space of a room they joined
(`Runner.releaseEventStart()`), leaving running a piece that ran before, and
one that something else has since started, taken as a child, or has a start
of in flight, and then releases the documents nothing reads. So a catalog of
many unadopted rooms costs a few rooms' pieces and documents at once rather
than all of them. Stopping a room's piece does not undo what its start wrote
into the room's space. Once every entry is adopted, adopting reads only Home's
own records.

`direct` holds one entry per counterpart, including forgotten rooms, for direct
rooms this manager created or accepted. `openDirect` finds a direct room there
and restores its membership. A room found there that has a notice for its
counterpart still waiting in `outgoingNotices`, since the room was offered them
nothing, is offered to them, as step 3 of [creating a room](#creating-a-room)
offers a new room, once a request names a profile of theirs. The offer puts
them on the room's roster by that profile, wherever it points, and
`outgoingNotices` leaves the notice out from then on. A counterpart the room's
roster already lists has joined the room, and is offered nothing. A room another manager created and
offered the user is there too once the host's share intake accepts it on the
user's behalf. `rooms` can also hold a second direct room with the same
counterpart, after crossing creations.

`direct`'s entries, and the entry a `done` outcome in `requests` carries, hold a
room as `FabriChatRoom.inSpace(…)` returned it at creation, or as `accept` was
sent it, while `rooms` holds it as its space's root, as that `wish` finds it:
the two links differ, and resolve to the same room, so a reader compares room
links with `equals()`, which compares what they resolve to, never by space or
by the links themselves.

The handlers write the catalog. Creating a room, or accepting or joining one a
manager created, registers the room's space (`registerSharedSpaceIn()`),
forgetting a room archives its entry, at the revision the request names, and
finding a direct room again, or accepting or joining a room, restores its entry
if it was archived (`changeSharedSpaceMembershipIn()`), except that an
acceptance made on the user's behalf, with `keepArchived`, leaves it archived.
`joinRoom` shares `accept`'s handling, with two differences: a join is always
the user's own choice, so it restores an archived entry whatever it says of
`keepArchived`, and it lists a direct room this user created, which `accept`
refuses, without changing `direct`. A join of a room the catalog keeps as saved
that names no `requestId` changes no membership and records nothing; it brings
the entry's title up to the room's, as described below, unless it is marked
`messageAct`. A room offered to the
user is registered by the host that vets the offer (see [first
contact](#first-contact)). Accepting or joining a container's declared chat supplies `container`, a link
to the root declaring it. The manager checks that its `chatRoom` resolves to
the requested room and records individual membership without registering the
container as a standalone room. `keepArchived` preserves an archived individual
entry too. A room's successful message or reaction supplies this declaration
when its space's root names that room. A manager given no catalog keeps one of
its own.

Creating, accepting, or joining a room also adds this user's profile to the
room's participants, through the room's `addParticipant`, from an event of its
own that follows. Accepting or joining a room needs no profile: one accepted
before the user's profile resolves is recorded all the same, and the user
isn't added.
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
   through each distinct share inbox their profiles point at, once per inbox,
   even an inbox profiles of more than one member point at, and add each of
   those members to the room's participants, once, by the first profile the
   request names for them, wherever it points. Add a notice to
   `outgoingNotices`, for a client to deliver, for each other member the
   request names only by principal. Offers and notices alike are made by
   events of their own that follow the room's creation: one adds the members
   and queues the notices, reading no inbox pointer, and a second reads the
   pointers and sends the offers, writing nothing else. A notice is added to
   the manager's own records, which can carry their owner's `PersonalSpace`
   label as the catalog can, and a profile's inbox pointer can carry a label,
   such as its owner's `PersonalSpace`, that neither the room's space nor
   this user's records admit, so where a profile points decides nothing either
   of them holds. A member whose profiles point at no inbox that takes offers
   is sent nothing, and nothing records that.
4. Record the entry in `rooms`, and in `direct` for a direct room, register the
   room's space in the user's catalog, and mark the request `done`. The
   registration, like adding this user to the room's participants, is an
   event of its own that follows the room's creation, so the catalog is read
   apart from it: a transaction's writes are held to the labels of everything
   it reads, and the catalog can carry its owner's `PersonalSpace` label,
   which the room's space doesn't admit. Both wait for the space's name to
   resolve: the run that sees the name pending is discarded and run again, and
   its sends could still be delivered.

Each step is recorded under the request's `requestId` as it completes, which is
how a repeated request resumes where the last attempt stopped instead of
creating another room. A pending `openDirect` is also recorded under its
`counterpart`, which is how a second `openDirect` for the same person finds it
and resumes it. Step 1 writes the room's `about` from this user's handler, which
is what labels it `authored-by` this user.

The manager's rendering composes a group in a draft of the session's own: a
title, members typed as chat addresses, and members picked from `people`, one
control per person, which picks the first profile `people` lists for them,
from the newest room whose roster holds one. Creating the
group names the picked profiles as `createGroup`'s `profiles`, so each picked
person is offered the room, and empties the draft.

Someone a user adds to a room later is told of it through `offerRoom`, which
the room's `addMember` sends once it has granted them access. It runs as an
event of its own, after the add has committed, and offers the room through the
same steps as step 3: through the profile the add named, or, for an add naming
only an address, through the profiles `people` lists for that person, as the
user sending it reads `people`, from an event of its own like step 3's, so
that its own transaction reads no inbox pointer. It records `noticed` under the
request's id at once for a person with no profile known for them, and
`offered` for anyone else, wherever their profiles point. The room reads it
back as the add's `delivery`.

## Prerequisites

- **Creating a private space from a pattern**: the same as the room's (see
  [`FabriChatRoom.md`](FabriChatRoom.md#prerequisites)).
- **A principal from a profile.** A client that starts a direct room from a
  person's profile needs that profile's principal, since `openDirect` and
  `createGroup` take principals. Whose own profile a profile is,
  `profileOwnerOf(profile)` reads, by the rule every reader of a person's
  profiles applies
  ([whose own profile a profile is](../../features/principal-of.md#whose-own-profile-a-profile-is)).
  A social space's member set pairs each principal with a profile (see [social
  spaces](README.md#social-spaces)), so starting a conversation with someone
  found in one needs nothing more.

### First contact

A notice has to reach a principal who may share no space with the sender. Its
route is the recipient's profile share inbox: a profile's `inbox` field
(`inbox.piece`, `patterns/system/profile-home/profile-home.tsx`) points at an
inbox piece in a space of its own. That is either the private inbox the
recipient's Home creates ([the private inbox](../../features/private-inbox.md))
or another share inbox the profile points at, and both take the same offer
envelope. Any principal may write to the inbox's space, and its offers are
labeled readable by the owner alone, a label that binds only an honest runtime.
When a request names a member's profile, as `openDirect` does with its `profile`
and `createGroup` with its `profiles`, step 3 offers the
room there, in that envelope, from an event of its own that follows the room's
creation, since the offer names the room's space (see
[`ChatManagerOutput`](ChatManagerOutput.md#offers)). The first of its two
events adds the member's profile to the room's participants, through the
room's `addParticipant`, before they have opened the room, whose space already
grants them OWNER, and the second reads the profile's `inbox`, which neither
the creating transaction nor the first event reads. The recipient's host reads the offer and vets it before it registers
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

That is why step 3 hands a notice for each member named only by principal to
a client through `outgoingNotices` (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). A member named
by a profile gets no notice, wherever the profile points, even at nothing the
event sending the offer can send to (see
[`ChatManagerOutput`](ChatManagerOutput.md#offers)), and the offers to the
request's other members stand. Nothing tells the sender whether the offer
arrived. Once offers
deliver end to end, the manager can deliver notices itself.
