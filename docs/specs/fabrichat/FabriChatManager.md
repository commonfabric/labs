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

The manager keeps `rooms`, `direct`, `requests`, and `outgoingNotices` in the
home space. `direct` is maintained alongside `rooms` by the same handlers, which
keep the two consistent: `direct` holds one entry per counterpart, including
forgotten rooms, and `rooms` can also hold a second direct room with the same
counterpart after crossing creations.

## Creating a room

`openDirect` (when there is no entry for the counterpart) and `createGroup`
create a space for the conversation, with the room as its chat, in four steps:

1. Create the conversation's space, with only this user granted (OWNER), and
   instantiate `FabriChatRoom` there with its `about`. The space's root, its
   default pattern, comes from its host the first time someone opens it.
2. Grant each other member WRITE on the room's space, by principal.
3. Add a notice for each other member to `outgoingNotices`, for a client to
   deliver.
4. Record the entry in `rooms`, and in `direct` for a direct room, and mark the
   request `done`.

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
  person's profile needs that profile's principal. A profile's value carries a
  `represents-principal` label, but no pattern-facing call returns the
  principal. `openDirect` and `createGroup` take principals. A shared space's
  member set pairs each principal with a profile (see [shared
  spaces](README.md#shared-spaces)), so starting a conversation with someone
  found in one needs nothing more. Starting one from a profile found anywhere
  else still needs this call.

### First contact

A notice has to reach a principal who may share no space with the sender.
Nothing in this repository delivers one end to end today:

- DID inboxes ([`did-inboxes.md`](../../features/did-inboxes.md)) deliver to a
  principal. A handler on a client runtime sends to one with
  `noticeSpaceAccess()`, which tells a member of a space about it
  ([telling a member of a space about it](../../features/space-access-notices.md)),
  but no client in this repository reads a recipient's inbox, a serving runtime
  refuses the call, and a notice it sends may not arrive.
- A profile's `inbox` field (`inbox.piece`,
  `packages/patterns/system/profile-home.tsx`) points at a receiving piece in a
  space of its own, which a host outside this repository provides. It is the
  likeliest path for notices: a pattern could send a notice to that piece, if
  the piece takes one and its space admits the sender. Whether it does is for
  that host to say.
- A space's access list can admit any writer, but that is the `"*"` grant a room
  must not have.

That is why step 3 hands notices to a client through `outgoingNotices` (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). Once one of
these delivers end to end, the manager can deliver notices itself.
