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
create a room of its own in four steps:

1. Create the room's space, with only this user granted (OWNER), and instantiate
   `FabriChatRoom` there with its `about`.
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

- **Creating a private space from a pattern**, and **pattern-facing access
  control**: the same as the room's (see
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
Nothing in this repository lets a pattern deliver one today:

- DID inboxes ([`did-inboxes.md`](../../features/did-inboxes.md)) deliver to a
  principal, but patterns can't reach them.
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
these is usable from a pattern, the manager can deliver notices itself.

## As built

`packages/patterns/fabrichat/manager.tsx` departs from the design above where
the runtime lacks a prerequisite:

- **Rooms are open.** It creates a room with `FabriChatRoom.inSpace()`, whose
  space grants OWNER to the creator and WRITE to `"*"`, so a room is open to
  any authenticated principal holding a link to it. It grants no one access.
- **One transaction.** With no grants to commit apart, creating a room, its
  notices, and its entry happen in one commit, and a request's outcome is
  `done` or `refused` from the start. A request already decided changes
  nothing when it arrives again.
- **No principals.** A pattern can't learn its user's principal, so
  `openDirect` can't refuse the user as their own counterpart, and `accept`
  records the `counterpart` its client checked.
- **One writer.** One handler, `commitManager`, writes the manager's records,
  and each stream is a binding of it. `openDirect` and `createGroup` are sent
  from controls marked as `ChatStartSurface`, and no write policy requires it.
- **Notices.** A notice's id is `[recipient, requestId]` as JSON.

Home's **Chats** tab renders the manager: the user's rooms, the room chosen
among them, and the controls that start a direct or a group chat.
