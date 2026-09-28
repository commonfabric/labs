# FabriChat: the manager

Status: proposed design (see [`README.md`](README.md)).

`FabriChatManager` is each user's index of the rooms they belong to. It finds
the direct room a user shares with a given person, and it creates new rooms.
It is how a single conversation with a person is found again, whichever
container a client is showing at the time.

## Where it lives

The manager is a field of the home pattern (`packages/patterns/system/home.tsx`),
so each user has exactly one, and it resolves through a well-known `wish`
target:

```ts
// Shown for illustration only.
const chats = wish<FabriChatManagerOutput>({ query: "#fabrichat" });
```

`#fabrichat` is a home target, like `#agent_queue` and `#profile`. On a
serving runtime, it resolves against the demanding identity's home space and
never the service's
([server-side builtins](../server-side-execution/builtins.md)). Because home is
private to its user, so is the index: nobody else learns whom a user talks to
by reading it.

Adding the target takes the same steps `#agent_queue` took: the field and child
piece in `home.tsx`, a case in `getResolutionKind` and in
`resolveHomeSpaceTarget` (`packages/runner/src/builtins/wish.ts`), tests
beside each, and a row in the built-in targets table of
[`wish`](../../common/conventions/wish.md) and in
[`HOME_SPACE.md`](../../common/conventions/HOME_SPACE.md).

## The index

```ts
// Shown for illustration only.
interface FabriChatIndexEntry {
  /** The room. */
  room: Cell<FabriChatRoomOutput>;

  kind: "direct" | "group";

  /** A direct room's other member, by principal. */
  counterpart?: string;

  /** When this user created or accepted it, in milliseconds since the epoch. */
  since: number;
}
```

The manager keeps:

- **`rooms`**: every entry, newest first.
- **`direct`**: for each counterpart principal, the entry of the direct room
  this user shares with them. There is at most one per counterpart.

An entry is a link to the room, never a copy of the room's data. What a room
holds is read from the room, under the reader's own access.

## Requests

A client asks the manager for something by sending an event on one of its
streams, and then reads the outcome from the manager's outputs. Each request
carries a `requestId` the client chooses. The manager records the outcome
under that id in `requests`, as `pending`, `done` (with the entry), or
`refused` (with a reason), and a client watches for it there.

| Stream | Event | Outcome |
| --- | --- | --- |
| `openDirect` | `{ requestId, counterpart }` | the existing direct room, or a new one |
| `createGroup` | `{ requestId, members, title }` | a new group room |
| `accept` | `{ requestId, room }` | an entry for a room this user was invited to |
| `forget` | `{ requestId, room }` | the entry removed; the room itself is untouched |

`openDirect` first looks in `direct`. It creates a room only when there is no
entry for that counterpart. That is what keeps one person's conversation from
splitting.

`openDirect` and `createGroup` are outward acts: they create a space and grant
another person access to it. They are admitted only from a reviewed surface
(`FabriChatStartSurface`). `accept` and `forget` change only the user's own
index, and they need none.

## Creating a room

The manager creates rooms of their own. A shared space's own chat is created
with the space, not by a manager. A manager records it in `rooms` when this
user first opens it, as it would any other room.

Creating a room is one operation from the client's point of view, and several
steps for the manager:

1. Create the room's space, with only this user granted (OWNER), and
   instantiate `FabriChatRoom` there with its `about`.
2. Grant each other member access, or issue each an invitation.
3. Deliver each invitation to its recipient ([first contact](#first-contact)).
4. Record the entry in `rooms`, and in `direct` for a direct room.

A creation interrupted between steps leaves a room that only its creator can
use. On retry with the same `requestId`, the manager resumes that room rather
than creating another.

## Accepting a room

The recipient of an invitation redeems it under their own signature, which is
what adds them to the room's access list. Their client then sends `accept` to
their own manager, which records the entry. A direct room is recorded under
`direct` by its other member, the inviter.

## Crossing creations

Each user's index is their own. If two people each `openDirect` to the other
before either invitation arrives, there are two rooms. Each manager keeps the
room it recorded first in `direct`. The other stays in `rooms` and can be
forgotten. This design accepts that for now. A deterministic tie-break, such
as the room whose creator's principal sorts first, is future work.

## Prerequisites

- **Creating a private space from a pattern**, and **pattern-facing access
  control**: the same as the room's (see [`room.md`](room.md#prerequisites)).
- **A principal from a profile.** A client that starts a direct room from a
  person's profile needs that profile's principal. A profile's value carries a
  `represents-principal` label, but no pattern-facing call returns the
  principal. `openDirect` and `createGroup` take principals. A shared space's
  member set pairs each principal with a profile (see
  [shared spaces](README.md#shared-spaces)), so starting a conversation with
  someone found in one needs nothing more. Starting one from a profile found
  anywhere else still needs this call.

### First contact

Step 3 of creation needs a way to deliver an invitation to a principal who
shares no space with the sender. Nothing reachable from a pattern does that
today:

- DID inboxes ([`did-inboxes.md`](../../features/did-inboxes.md)) deliver to a
  principal, but patterns can't reach them.
- A profile's `inbox` field can point at a receiving piece, but this
  repository provides no such piece.
- A space's access list can admit any writer, but that is the `"*"` grant a
  room must not have.

Until one of these is usable from a pattern, delivery is the client's job: the
manager records the invitation, and the client delivers it by whatever means
it has (see [`clients.md`](clients.md)).
