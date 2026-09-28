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

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| `openDirect` | `ChatStartSurface` | the existing direct room with `counterpart`, or a new one |
| `createGroup` | `ChatStartSurface` | a new group room with `members` |
| `accept` | none | an entry for a room this user has been admitted to |
| `forget` | none | the entry removed; the room itself is untouched |
| `delivered` | none | the invitation removed from `outgoingInvitations` |

`openDirect` and `createGroup` are outward acts, since they create a space and
grant other people access to it. They are admitted only as trusted gestures on
their surface (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)). The other
streams change only this user's own index.

- **`openDirect`** first looks in `direct`, and creates a room only when there
  is no entry for `counterpart`. That is what keeps one person's conversation
  from splitting, and it is the only way a direct room is created.
- **`createGroup`** always creates a new room. Two group rooms can have the same
  members.
- **`accept`** records a room this user has already been admitted to. For an
  invitation, the user redeems it under their own signature first, which is what
  adds them to the room's access list, and then sends `accept`. A direct room is
  recorded in `direct` under its other member, the inviter. A client also sends
  `accept` when the user first opens a shared space's own chat, which is created
  with its space and not by a manager.
- **`forget`** removes the entry, and from `direct` too. The room, and this
  user's access to it, are untouched.

A request that is interrupted, including a creation that stopped partway, is
resumed by sending the same request again with the same `requestId`. It never
creates a second room. A creation that stopped partway leaves a room that only
its creator can use until the request is resumed.

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
