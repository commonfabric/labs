# FabriChatManager

Status: proposed design (see [`README.md`](README.md)).

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

The manager keeps `rooms`, `direct`, `requests`, and `outgoingInvitations` in
the home space. `direct` is maintained alongside `rooms` by the same handlers,
so the two can't disagree.

## Creating a room

`openDirect` (when there is no entry for the counterpart) and `createGroup`
create a room of its own in four steps:

1. Create the room's space, with only this user granted (OWNER), and instantiate
   `FabriChatRoom` there with its `about`.
2. Grant each other member access, or issue each an invitation.
3. Add each invitation to `outgoingInvitations`, for a client to deliver.
4. Record the entry in `rooms`, and in `direct` for a direct room, and mark the
   request `done`.

Each step is recorded under the request's `requestId` as it completes, which is
how a repeated request resumes where the last attempt stopped instead of
creating another room.

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

An invitation has to reach a principal who may share no space with the sender.
Nothing reachable from a pattern delivers one today:

- DID inboxes ([`did-inboxes.md`](../../features/did-inboxes.md)) deliver to a
  principal, but patterns can't reach them.
- A profile's `inbox` field can point at a receiving piece, but this repository
  provides no such piece.
- A space's access list can admit any writer, but that is the `"*"` grant a room
  must not have.

That is why step 3 hands invitations to a client through `outgoingInvitations`
(see [`ChatManagerOutput`](ChatManagerOutput.md#delivering-invitations)). Once
one of these is usable from a pattern, the manager can deliver invitations
itself.
