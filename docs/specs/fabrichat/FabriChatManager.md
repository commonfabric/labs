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

The manager keeps `direct`, `requests`, and `outgoingNotices` in the home
space. `rooms` it keeps nowhere: it is drawn from Home's shared-space catalog
([`shared-space-catalog.md`](../../features/shared-space-catalog.md)), which
Home hands the manager, and which lists the social spaces the user keeps. The
manager draws its rooms from the entries of kind `fabrichat-room` the catalog
keeps as saved, each the space of a room that is its space's root, found with
`wish({ query: "#default", scope: [space] })`; a room in another social space,
which isn't its space's root, isn't found that way yet. A room's `kind` is the
one its `about` gives, and its `since` and `revision` are its entry's. A direct
room's `counterpart` is the one `direct` holds the room under, for a room this
manager created or accepted, or else the room's creator, as its `about.record`
is labeled; a room whose label can't be read is listed with no counterpart. A
room appears in `rooms` once its root resolves and its `about` reads.

The handlers write the catalog: creating or accepting a room registers its
space (`registerSharedSpaceIn()`), forgetting one archives its entry, at the
revision the request names, and finding a forgotten one again restores it
(`changeSharedSpaceMembershipIn()`). Creating or accepting a room also adds this
user's profile to the room's participants, through the room's
`addParticipant`, from an event of its own that follows.
A room offered to the user is registered by the host that vets the offer (see
[first contact](#first-contact)). `direct` holds one entry per counterpart, for
the direct rooms this manager created or accepted, including forgotten ones,
and `rooms` can also hold a second direct room with the same counterpart after
crossing creations, or one offered to the user, which `openDirect` doesn't
find. A manager given no catalog keeps one of its own.

## Creating a room

`openDirect` (when there is no entry for the counterpart) and `createGroup`
create a space for the conversation, with the room as its chat, in four steps:

1. Create the conversation's space, with only this user granted (OWNER), and
   instantiate `FabriChatRoom` there with its `about`, as the space's root
   (`inSpace(undefined, { grants, root: true })`). The room is then a social
   space in its own right: opening the space shows it, and it keeps the
   space's participants.
2. Grant each other member OWNER on the room's space, by principal, so any
   member may add others.
3. Add a notice for each other member to `outgoingNotices`, for a client to
   deliver, and offer the room to each member whose profile the request names,
   through the share inbox the profile points at.
4. Register the room's space in the catalog, which lists it in `rooms`, record
   it in `direct` for a direct room, and mark the request `done`.

Each step is recorded under the request's `requestId` as it completes, which is
how a repeated request resumes where the last attempt stopped instead of
creating another room. A pending `openDirect` is also recorded under its
`counterpart`, which is how a second `openDirect` for the same person finds it
and resumes it. Step 1 writes the room's `about` from this user's handler, which
is what labels it `authored-by` this user.

The implementation takes the steps in one transaction, since the space comes
with its grants. The space's name is pending on the transaction's first run,
which the runtime discards and runs again with the name resolved, so nothing is
registered in the catalog, and nothing is sent, until the name resolves.

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
share inbox the profile points at, and both take the same offer envelope. Any principal may
write to the inbox's space, and its offers are labeled readable by the owner
alone, a label that binds only an honest runtime. When a request names a
member's profile, as `openDirect` does with its `profile`, step 3 offers the
room there, in that envelope, from an event of its own that follows the
room's creation, since the offer names the room's space (see
[`ChatManagerOutput`](ChatManagerOutput.md#offers)). The recipient's host reads
the offer, vets it, and registers the room's space in the recipient's Home
catalog ([the share intake](../../features/private-inbox.md#the-share-intake)),
which is where their manager lists it. A member the request names only by
principal is offered nothing, since the manager has no profile to reach their
inbox through. A space's access list can admit any writer, but that is the
`"*"` grant a room has only when its creator makes a group joinable by its
link, and then its address, sent some other way, is the notice.

That is why step 3 also hands a notice for every other member to a client
through `outgoingNotices` (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)).
