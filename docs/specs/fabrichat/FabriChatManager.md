# FabriChatManager

Status: normative reference (see [`README.md`](README.md)).

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

The home wish resolver supplies the manager child through `#chatManager`.
Home's Conversations tab renders its index and creation controls.

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

Starting a conversation requires a resolved `#profile`. A request without one
is recorded as refused before the manager allocates a space or publishes a link.

- Private creation and grants use the room's
  [runtime support](FabriChatRoom.md#runtime-support).
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
