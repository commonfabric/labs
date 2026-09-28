# ChatManagerOutput

Status: proposed design (see [`README.md`](README.md)).

The result of a user's chat manager: what `wish({ query: "#chatManager" })`
resolves to. It is the contract clients read, and it is named for the role
rather than for an implementation. [`FabriChatManager`](FabriChatManager.md) is
an implementation of it: its result satisfies `ChatManagerOutput`, and another
pattern that satisfies it can fill the same role.

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

  openDirect: Stream<{ requestId: string; counterpart: string }>;
  createGroup: Stream<{ requestId: string; members: string[]; title: string }>;
  accept: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
  forget: Stream<{ requestId: string; room: Cell<ChatRoomOutput> }>;
}
```

A client reads it with `wish<ChatManagerOutput>({ query: "#chatManager" })` and
uses the wish's `result`.

## Facts

- **`rooms`** and **`direct`** hold [`ChatIndexEntry`](ChatIndexEntry.md)s.
  `direct` has at most one entry per counterpart principal.
- **`requests`** records each request's outcome under the `requestId` its caller
  chose. `done` carries the entry, except for `forget`, whose entry is gone. A
  retry with the same `requestId` resumes the request rather than starting
  another.

## Streams

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| `openDirect` | `ChatStartSurface` | the existing direct room with `counterpart`, or a new one |
| `createGroup` | `ChatStartSurface` | a new group room with `members` |
| `accept` | none | an entry for a room this user has been admitted to |
| `forget` | none | the entry removed; the room itself is untouched |

`openDirect` and `createGroup` are outward acts, since they create a space and
grant other people access to it. They are admitted only as trusted gestures on
their surface (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)). `accept`
and `forget` change only this user's own index. Principals are DIDs.
