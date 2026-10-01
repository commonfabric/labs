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

The Home pattern instantiates the manager, and the runtime's home-target
resolver exposes it as `#chatManager`.

## State

The manager keeps `rooms`, `direct`, `requests`, and `outgoingNotices` in the
home space. `direct` is maintained alongside `rooms` by the same handlers, which
keep the two consistent: `direct` holds one entry per counterpart, including
forgotten rooms, and `rooms` can also hold a second direct room with the same
counterpart after crossing creations.

## Creating a room

`openDirect` (when there is no entry for the counterpart) and `createGroup`
create a space for the conversation, with the room as its chat:

1. Resolve the sender's profile and persist the immutable creation intent.
2. Allocate the space with the creator as OWNER and all intended other members
   as WRITE in its genesis. The first `inSpace()` call creates the policy with
   those grants; the room uses the same named allocation.
3. Persist the room reference. A handler in the new space claims its canonical
   `chat` slot, then queues a continuation in the home space.
4. Verify registration, then publish the index entry and outgoing notices
   together and mark the request `done`.

Each phase is recorded under `requestId`, so repeating a request resumes its
existing allocation. Pending direct requests coalesce by counterpart. An
interrupted allocation may leave an unindexed space with the intended members'
creation grants; no room is published before those grants exist.

The space record holds one `chat` link, separate from `defaultPattern`.
Registration and home publication use separate transactions because a
transaction writes one space.

The host installs the normal default app as the space's root when the space is
opened. That root owns the participant roster. The manager creates no separate
room roster and supplies no subsequent space-administration handlers.

## Prerequisites

- **Creating a private space from a pattern**: the same as the room's (see
  [`FabriChatRoom.md`](FabriChatRoom.md#runtime-support)).
- **A principal from a profile.** `principalOf(profile, "represents-principal")`
  returns the principal attested by a profile. `openDirect` and `createGroup`
  take principals; a client or pattern starting from a profile resolves its
  attested principal first and refuses a missing or ambiguous claim. See
  [principal label reading](../../features/principal-of.md).

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
