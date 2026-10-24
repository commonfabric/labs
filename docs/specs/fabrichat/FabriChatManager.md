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

The manager keeps `direct`, `requests`, `outgoingNotices`, and
`roomMembership` in the home space. `rooms` is derived per user from those
membership choices and the user's shared-space catalog, Home's, which Home
hands the manager
([`shared-space-catalog.md`](../../features/shared-space-catalog.md)).

For each saved catalog entry, the manager resolves the space's root with
`wish({ query: "#default", scope: [space] })`. A `fabrichat-room` entry names
a standalone room at that root. Every other kind uses the root's explicit
`chatRoom` link. An unknown kind uses that same declaration; the absence of a
kind says nothing about whether the space has a chat. A declaration can appear
or change after a space is saved, and discovery follows it reactively.

Each entry links the room itself, so opening it displays the full conversation.
Resolved room identity, compared with `equals()`, deduplicates a conversation
reached through several containers or both a container and its standalone
entry. Membership records keep the resolved room reference, so retargeting an
alias cannot move a choice to a different conversation. Distinct rooms in one
space remain distinct entries. For container rooms, explicit
`roomMembership` choices take precedence over discovery: an archived
conversation stays forgotten even while a saved container still declares it.
A saved explicit entry remains listed if the container changes its declaration.
Forgetting a declared conversation never archives its container.

Joining a record-backed standalone room registers its own space even when a
container declares it. A standalone room's catalog membership remains authoritative. Its current
catalog state and revision govern listing and forgetting even when the room
also has an explicit membership record or a container declares it. Catalog
restoration supersedes an older room tombstone; catalog archive or removal
supersedes a saved room record. A record's optional `catalogRevision` remembers
that authority across catalog removal.

A room's `kind` comes from its `about`. Its `since` and opaque `revision` come
from the explicit membership record, or from its discovery source until a
choice is recorded. A discovered conversation's revision identifies its source
catalog entry, that entry's revision, and the resolved room identity. Clients pass the revision back
unchanged to `forget`; they need supply no container. A direct room's
`counterpart` is the one `direct` holds the resolved room under, or else the
room's labeled creator. `people` is drawn from listed rooms' rosters per
user, keyed by the principal each profile attests.

The manager's rendering labels each listed room with its `about.title`, read
through the room's link, so a retitle shows there once the room records it. A
direct room with no title is labeled by its counterpart. A standalone room's
catalog entry holds its title too, as a display hint for readers of the
catalog, which neither the rendering nor `rooms` reads. Registration takes the
room's title, whatever its kind. Whenever the manager handles `accept` or
`joinRoom` for a room its catalog lists, it reads the room's `about`, and
retitles the entry (`retitleSharedSpaceIn()`) where the room's title differs
from the entry's, moving neither its revision nor its membership. That is all a
join of an already-listed room reads of the room, and it writes the catalog
only on a mismatch. The one exception is a `joinRoom` marked `messageAct`,
which a room sends with every message and reaction: none of those changes the
title, so the manager reads nothing of the room's `about` for one. The member
who retitles a room tells their manager at once; another member's entry follows
on their manager's next event for that room other than a message or a
reaction: their own retitle, an acceptance, or a client's `joinRoom` when they
open it.

`direct` holds one entry per counterpart, including forgotten rooms, for direct
rooms this manager created or accepted. `openDirect` finds a direct room there
and restores its membership. A room found there that has a notice for its
counterpart still waiting in `outgoingNotices`, since the room was offered them
nothing, is offered to them, as step 3 of [creating a room](#creating-a-room)
offers a new room, once a request names a profile of theirs that points at an
inbox, and the notice is removed. A counterpart the room's roster already lists
has joined the room, and is offered nothing. A room another manager created and
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
   and add to the room's participants each member it is offered to, once, by
   the first profile it is offered through. Add a notice to
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
user sending it reads `people`. It records `offered` or `noticed` under the
request's id, which the room reads back as the add's `delivery`.

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
a member's profile, as `openDirect` does with its `profile` and `createGroup`
with its `profiles`, step 3 offers the
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
