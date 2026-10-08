# ChatManagerOutput

The result of a user's chat manager: what `wish({ query: "#chatManager" })`
resolves to. It is the contract clients read, and it is named for the role
rather than for an implementation. [`FabriChatManager`](FabriChatManager.md) is
an implementation of it: its result satisfies `ChatManagerOutput`, and another
pattern that satisfies it can fill the same role. Everything in this document
binds every implementation.

```ts
// Shown for illustration only.
interface ChatManagerOutput {
  /** Every room this user belongs to and hasn't forgotten, newest first. */
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

  /** Notices this user's requests have produced that no one has delivered. */
  outgoingNotices: {
    id: string;
    room: Cell<ChatRoomOutput>;
    recipient: string;
  }[];

  openDirect: Stream<{ requestId: string; counterpart: string }>;
  createGroup: Stream<{
    requestId: string;
    members: string[];
    title: string;
    joinableByLink?: boolean;
  }>;
  accept: Stream<{
    requestId: string;
    room: Cell<ChatRoomOutput>;
    counterpart?: string;
  }>;
  forget: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
  delivered: Stream<{ requestId: string; id: string }>;

  [VIEWS]: { chats: object };
}
```

Principals are DIDs throughout.

## Where the role lives

Each user has exactly one chat manager, in their home space. A client reaches it
with `wish<ChatManagerOutput>({ query: "#chatManager" })` and uses the wish's
`result`. `#chatManager` is a home target, like `#agent_queue` and `#profile`,
and names the role rather than the pattern that fills it. On a serving runtime,
it resolves against the demanding identity's home space and never the service's
([server-side builtins](../server-side-execution/builtins.md)). A home whose
system pattern was set up before it held a manager holds none until the home
space is next opened, and a custom home pattern holds one only if it says so;
until then the wish reports an error naming both remedies, with no `result`.

Everything a manager holds is private to its user, as the home space is: nobody
else learns whom a user talks to by reading it.

## Admission to a room

A manager admits the other members of a room it creates by granting each of them
access to the room's space, by principal. It never issues a space invitation: a
space invitation is a bearer credential, redeemable by whoever holds its code,
so it can't guarantee that the person admitted is the one intended, and a direct
room's `counterpart` has to be exactly that person.

A grant gives access but tells the recipient nothing. So the manager also
produces a **notice** for each other member, saying which room they have been
admitted to and by whom (see [delivering notices](#delivering-notices)).

## Views

The manager offers its facts and streams as a `[VIEWS]` group, `chats`, for
hosts that draw natively: `rooms`, `direct`, `requests`, and `outgoingNotices`,
and every stream below. A native client drives the manager through that group as
it drives a room through the room's `room` group (see
[`clients.md`](clients.md#showing-a-room)).

## Scopes

Everything a manager holds is `PerSpace` in the user's home space (see
[scopes](../scoped-cell-instances.md#summary)). A home space admits only its
user, so `PerSpace` there means one instance for that user, which is why nothing
in it needs to be `PerUser` or `PerSession`.

## Facts

- **`rooms`** holds a [`ChatIndexEntry`](ChatIndexEntry.md) for every room this
  user belongs to and hasn't forgotten, newest first. An entry is a link to its
  room and never a copy of the room's data: what a room holds is read from the
  room, under the reader's own access. Through the link a reader finds the
  room's `about`, and where its conversation stands, `messages.count` and
  `messages.newestAt`; [`ChatIndexEntry`](ChatIndexEntry.md) says why the link
  declares those and no more.
- **`direct`** holds, for each counterpart principal, the entry of the direct
  room this user shares with them. It has at most one entry per counterpart. It
  keeps a direct room's entry even after the room is forgotten, so the
  conversation with that person is always the same room.
- **`requests`** records each request's outcome under the `requestId` its caller
  chose: `pending`, then `done` or `refused`. `done` carries the entry, except
  for `forget`, whose entry is no longer in `rooms`. `refused` carries a reason.
  An implementation MAY discard a `done` or `refused` outcome after a retention
  period it documents. A request sent again after that starts afresh: an
  `openDirect` still finds the existing room, but a `createGroup` creates
  another.
- **`outgoingNotices`** holds each notice this user's requests have produced,
  until a client reports it delivered.

## Streams

Each stream is a one-way, asynchronous request to the manager. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value. So every event carries a `requestId` its sender chooses, and the manager
records the outcome under that id in `requests`: `pending`, then `done` or
`refused`. A sender watches for it there. An event a stream does not admit, by
the rules below, is not a request, and records no outcome.

Each stream below is written as a call, with its event's keys as the parameters:
`openDirect(requestId: string, counterpart: string)` sends
`{ requestId, counterpart }`.

These rules hold for every stream:

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A request that is interrupted is resumed by sending the same event again with
  the same `requestId`. It never creates a second room.
- An admitted request missing a key its stream needs is refused, with a reason
  that says which, rather than ignored.
- Every stream changes only this user's own manager, except `openDirect` and
  `createGroup`, which also create a room and grant other people access to it.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`openDirect`](#opendirectrequestid-string-counterpart-string) | `ChatStartSurface` | the direct room with `counterpart`, found or created |
| [`createGroup`](#creategrouprequestid-string-members-string-title-string-joinablebylink-boolean) | `ChatStartSurface` | a new group room |
| [`accept`](#acceptrequestid-string-room-cellchatroomoutput-counterpart-string) | none | an entry for a room this user has been admitted to |
| [`forget`](#forgetrequestid-string-room-cellchatroomoutput) | none | the entry removed from `rooms`; the room itself is untouched |
| [`delivered`](#deliveredrequestid-string-id-string) | none | the notice removed from `outgoingNotices` |

### `openDirect(requestId: string, counterpart: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `counterpart: string` — The DID of the other person. Must not be this user's
  own.

Finds the direct room this user shares with a person, or creates it. This is an
outward act when it creates a room.

- **Admitted:** as a trusted gesture on `ChatStartSurface`.
- **Effect:** if `direct` has an entry for `counterpart`, that entry is the
  outcome, and it is put back in `rooms` if it was forgotten. Otherwise, if a
  creation for the same `counterpart` is still pending under another
  `requestId`, the manager MUST resume that creation rather than start another,
  and records its outcome under both ids. Otherwise, creates a direct room whose
  members are this user and `counterpart`, grants `counterpart` access, produces
  a notice for them, and records the new entry in `rooms` and `direct`.
- **Outcome:** `done` with the entry, or `refused` if `counterpart` is this
  user.

It is the only way a direct room is created, which is what keeps one person's
conversation from splitting.

### `createGroup(requestId: string, members: string[], title: string, joinableByLink?: boolean)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `members: string[]` — The DIDs of the people to admit besides this user,
  each a principal's. Duplicates, and this user's own DID, are ignored. It may
  be empty, which creates a group room of one, and people can be added later
  from the room's add control.
- `title: string` — The room's title, which every member sees. Must not be
  empty.
- `joinableByLink?: boolean` — Whether the room admits anyone who has its
  link. When true, the room's space grants every principal WRITE (the `"*"`
  wildcard) besides its members, so the room's address is all that keeps it
  private: whoever holds it can read and write the room, and add it to their
  chats from the room itself. Absent or false, the room admits its members
  alone.

Creates a group room. This is an outward act: it grants other people access.

- **Admitted:** as a trusted gesture on `ChatStartSurface`.
- **Effect:** always creates a new space, with a new room as its chat, even when
  another group room has the same members. Grants each member access, produces a
  notice for each, and records the entry in `rooms`.
- **Outcome:** `done` with the entry, or `refused` if `title` is empty,
  `members` is absent, or a member is not a principal's DID.

### `accept(requestId: string, room: Cell<ChatRoomOutput>, counterpart?: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `room: Cell<ChatRoomOutput>` — A link to the room this user has been admitted
  to, from the notice that announced it.
- `counterpart?: string` — For a direct room, the DID of its other member,
  which is the room's creator, as the room's `about.record` is labeled. The
  client MUST have checked that before sending (see
  [`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room) and
  [`clients.md`](clients.md#finding-conversations)); a notice's claim of who
  sent it is only a hint. Ignored for a group room.

Records a room this user has been admitted to.

- **Admitted:** without a reviewed gesture, since it changes only this user's
  own index. Whether to add a room to their index is the user's decision (see
  [`clients.md`](clients.md#finding-conversations)).
- **Effect:** records an entry in `rooms`. For a direct room, the counterpart it
  records is the creator `about.record`'s label names, which it reads itself;
  once the room's space has a member set, it also checks that the counterpart is
  a member. For a direct room, it also records the entry in `direct`, unless
  `direct` already has an entry for `counterpart`, in which case that entry
  stays, as under [crossing creations](#crossing-creations).
- **Outcome:** `done` with the entry, or `refused` if the request names no
  room, or this user can't read the room, or if the room is direct and its
  label names no creator, names this user, or names someone other than a
  `counterpart` sent, or, once there are member sets, the counterpart isn't a
  member.

A client also sends `accept` when the user first opens the chat of an existing
social space, which is created with its space and not by a manager.

### `forget(requestId: string, room: Cell<ChatRoomOutput>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  outcome is recorded under it in `requests`, and sending the same event again
  with it resumes the request rather than starting another.
- `room: Cell<ChatRoomOutput>` — A link to a room in this user's list.

Removes a room from this user's list.

- **Admitted:** without a reviewed gesture.
- **Effect:** removes the entry from `rooms`. A direct room's entry stays in
  `direct`, so a later `openDirect` with the same person returns the same room.
  The room, and this user's access to it, are untouched.
- **Outcome:** `done`, with no entry, or `refused` if the request names no
  room.

### `delivered(requestId: string, id: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests.
  Sending the same event again with it changes nothing further.
- `id: string` — The id of a notice in `outgoingNotices`. An id that isn't there
  is ignored.

Reports that a notice in `outgoingNotices` has been delivered.

- **Admitted:** without a reviewed gesture.
- **Effect:** removes the notice from `outgoingNotices`. It records no outcome
  in `requests`, except `refused` when the request names no notice.

## Creating a room: partial states

Creating a room takes several steps, and a request interrupted between them
leaves a room in between. Until a creation's request is `done`:

- The room can already admit some of its other members, since grants come before
  notices. A member granted before an interruption can use the room, but has no
  notice of it until the request is resumed.
- The room is not yet in `rooms` or `direct`. A new `openDirect` for the same
  counterpart resumes the pending creation, whatever its `requestId` (see
  [`openDirect`](#opendirectrequestid-string-counterpart-string)). A
  `createGroup` has no such key, so a client MUST resume an interrupted request
  with its original `requestId`, and SHOULD do so for `openDirect` too.

Resuming the request finishes the grants and notices that remain, and records
the entry. It never creates a second room.

## Delivering notices

A notice has to reach a principal who may share no space with this user. Until a
pattern can deliver one itself (see [first
contact](FabriChatManager.md#first-contact)), the manager lists notices in
`outgoingNotices` and a client delivers them. A notice says which room, and who
sent it: this user. A client MUST deliver only that, and MUST NOT deliver any of
the room's contents. It then sends `delivered` with the notice's `id`.

A notice carries no credential. The recipient already has access through the
grant, so a notice that reaches the wrong person gives them nothing but the
knowledge that a room exists.

A notice is also unauthenticated: it travels by whatever channel a client has,
so its claim of who sent it can be false. A recipient MUST NOT rely on that
claim. Who created a room is what the room's `about` is labeled with (see
[`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)), and a client checks a
direct room's `counterpart` against that label before it sends `accept`.

## Crossing creations

Each user's manager is their own. If two people each `openDirect` to the other
before either notice arrives, there are two rooms. Each manager keeps the room
it recorded first in `direct`. The other stays in `rooms`, and can be forgotten.
This contract accepts that for now. A deterministic tie-break, such as the room
whose creator's principal sorts first, is future work.
