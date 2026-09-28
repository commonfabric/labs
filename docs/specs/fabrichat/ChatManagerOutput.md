# ChatManagerOutput

Status: proposed design (see [`README.md`](README.md)).

The result of a user's chat manager: what `wish({ query: "#chatManager" })`
resolves to. It is the contract clients read, and it is named for the role
rather than for an implementation. [`FabriChatManager`](FabriChatManager.md) is
an implementation of it: its result satisfies `ChatManagerOutput`, and another
pattern that satisfies it can fill the same role. Everything in this document
binds every implementation.

```ts
// Shown for illustration only.
interface ChatManagerOutput {
  /** Every room this user belongs to, newest first. */
  rooms: ChatIndexEntry[];

  /** The direct room this user shares with each counterpart, by principal. */
  direct: Record<string, ChatIndexEntry>;

  /** The outcome of each request, by the `requestId` its caller chose. */
  requests: Record<
    string,
    | { status: "pending" }
    | { status: "done"; entry?: ChatIndexEntry }
    | { status: "refused"; reason: string }
  >;

  /** Invitations this user has issued that no one has delivered yet. */
  outgoingInvitations: {
    id: string;
    room: Cell<ChatRoomOutput>;
    invitee: string;
    redeem: { inviteId: string; code: string };
  }[];

  openDirect: Stream<{ requestId: string; counterpart: string }>;
  createGroup: Stream<{ requestId: string; members: string[]; title: string }>;
  accept: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
  forget: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
  delivered: Stream<{ id: string }>;
}
```

Principals are DIDs throughout.

## Where the role lives

Each user has exactly one chat manager, in their home space. A client reaches it
with `wish<ChatManagerOutput>({ query: "#chatManager" })` and uses the wish's
`result`. `#chatManager` is a home target, like `#agent_queue` and `#profile`,
and names the role rather than the pattern that fills it. On a serving runtime,
it resolves against the demanding identity's home space and never the service's
([server-side builtins](../server-side-execution/builtins.md)).

Everything a manager holds is private to its user, as the home space is: nobody
else learns whom a user talks to by reading it.

## Facts

- **`rooms`** holds a [`ChatIndexEntry`](ChatIndexEntry.md) for every room this
  user belongs to, newest first. An entry is a link to its room and never a copy
  of the room's data: what a room holds is read from the room, under the
  reader's own access.
- **`direct`** holds, for each counterpart principal, the entry of the direct
  room this user shares with them. It has at most one entry per counterpart, and
  every entry in it is also in `rooms`.
- **`requests`** records each request's outcome under the `requestId` its caller
  chose: `pending`, then `done` or `refused`. `done` carries the entry, except
  for `forget`, whose entry is gone. `refused` carries a reason.
- **`outgoingInvitations`** holds each invitation this user's requests have
  issued, until a client reports it delivered (see [delivering
  invitations](#delivering-invitations)).

## Streams

Each stream is a one-way, asynchronous request to the manager. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value. So every event carries a `requestId` its sender chooses (except
`delivered`), and the manager records the outcome under that id in `requests`:
`pending`, then `done` or `refused`. A sender watches for it there.

Each stream below is written as a call, with its event's keys as the
parameters: `openDirect(requestId: string, counterpart: string)` sends
`{ requestId, counterpart }`.

These rules hold for every stream:

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A request that is interrupted, including a creation that stopped partway, is
  resumed by sending the same event again with the same `requestId`. It never
  creates a second room. A creation that stopped partway leaves a room that only
  its creator can use until the request is resumed.
- Every stream changes only this user's own manager, except `openDirect` and
  `createGroup`, which also create a room and grant other people access to it.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`openDirect`](#opendirectrequestid-string-counterpart-string) | `ChatStartSurface` | the direct room with `counterpart`, found or created |
| [`createGroup`](#creategrouprequestid-string-members-string-title-string) | `ChatStartSurface` | a new group room |
| [`accept`](#acceptrequestid-string-room-cellchatroomoutput) | none | an entry for a room this user has been admitted to |
| [`forget`](#forgetrequestid-string-room-cellchatroomoutput) | none | the entry removed; the room itself is untouched |
| [`delivered`](#deliveredid-string) | none | the invitation removed from `outgoingInvitations` |

### `openDirect(requestId: string, counterpart: string)`

Finds the direct room this user shares with a person, or creates it. This is an
outward act when it creates a room.

- **Event:** `counterpart` is the other person's principal, a DID.
- **Admitted:** as a trusted gesture on `ChatStartSurface`.
- **Effect:** if `direct` has an entry for `counterpart`, that entry is the
  outcome, and nothing is created. Otherwise, creates a direct room whose
  members are this user and `counterpart`, issues `counterpart` an invitation,
  and records the new entry in `rooms` and `direct`.
- **Outcome:** `done` with the entry.

It is the only way a direct room is created, which is what keeps one person's
conversation from splitting.

### `createGroup(requestId: string, members: string[], title: string)`

Creates a group room. This is an outward act: it grants other people access.

- **Event:** `members` are the principals to admit besides this user. `title`
  becomes the room's `about.title`.
- **Admitted:** as a trusted gesture on `ChatStartSurface`.
- **Effect:** always creates a new room, even when another group room has the
  same members. Issues each member an invitation, and records the entry in
  `rooms`.
- **Outcome:** `done` with the entry.

### `accept(requestId: string, room: Cell<ChatRoomOutput>)`

Records a room this user has already been admitted to.

- **Event:** `room` links the room.
- **Admitted:** without a reviewed gesture, since it changes only this user's
  own index. Joining a room is the user's decision, and it is made where the
  invitation is redeemed (see [`clients.md`](clients.md#finding-conversations)).
- **Effect:** records an entry in `rooms`, and for a direct room in `direct`,
  under its other member, the inviter.
- **Outcome:** `done` with the entry, or `refused` if this user can't read the
  room.

For an invitation, the user redeems it under their own signature first, which
is what adds them to the room's access list, and then sends `accept`. A client
also sends `accept` when the user first opens a shared space's own chat, which
is created with its space and not by a manager.

### `forget(requestId: string, room: Cell<ChatRoomOutput>)`

Removes a room from this user's index.

- **Event:** `room` links the room.
- **Admitted:** without a reviewed gesture.
- **Effect:** removes the entry from `rooms`, and from `direct` too. The room,
  and this user's access to it, are untouched.
- **Outcome:** `done`, with no entry.

### `delivered(id: string)`

Reports that an invitation in `outgoingInvitations` has been delivered.

- **Event:** `id` is the invitation's.
- **Admitted:** without a reviewed gesture.
- **Effect:** removes the invitation from `outgoingInvitations`. It carries no
  `requestId`, and has no outcome in `requests`.

## Delivering invitations

Creating a room issues an invitation for each other member, and each one has to
reach a principal who may share no space with this user. Until a pattern can
deliver one itself (see [first contact](FabriChatManager.md#first-contact)), the
manager lists them in `outgoingInvitations` and a client delivers them. A client
MUST deliver only the invitation, meaning who it's from, which room, and how to
redeem it, and MUST NOT deliver any of the room's contents. It then sends
`delivered` with the invitation's `id`.

## Crossing creations

Each user's manager is their own. If two people each `openDirect` to the other
before either invitation arrives, there are two rooms. Each manager keeps the
room it recorded first in `direct`. The other stays in `rooms`, and can be
forgotten. This contract accepts that for now. A deterministic tie-break, such
as the room whose creator's principal sorts first, is future work.
