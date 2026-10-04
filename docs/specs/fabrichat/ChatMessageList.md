# ChatMessageList

A room's messages, offered for structured access rather than as one array. A
room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `messages`. It says
where the conversation stands and holds its newest messages, the same for every
reader. The rest of the conversation a client reads through windows, each a run
of messages it asked for, so a long history never has to arrive whole. The
windows are the reading session's own.

```ts
// Shown for illustration only.
interface ChatMessageList {
  /** How many messages the room holds, obliterated tombstones included. */
  count: number;

  /** The oldest and newest messages' `sentAt`; absent while there are none. */
  oldestAt?: FabricEpochNsec;
  newestAt?: FabricEpochNsec;

  /** The newest messages of the main conversation, kept current. */
  latest: { messages: ChatMessage[]; hasOlder: boolean };

  /** This session's open windows, by the `windowId` its client chose. */
  windows: Cell<PerSession<Record<string, ChatMessageWindow>>>;

  openWindow: Stream<{
    requestId: string;
    windowId: string;
    root?: Cell<ChatMessage>;
    from: ChatWindowAnchor;
    count: number;
  }>;
  closeWindow: Stream<{ requestId: string; windowId: string }>;
}
```

## Fields

- **`count`** is how many messages the room holds, obliterated tombstones
  included.
- **`oldestAt`** and **`newestAt`** are the oldest and newest messages'
  `sentAt`, and are absent while the room has no messages.
- **`latest`** holds the newest messages of the main conversation (see
  [`ChatReply`](ChatReply.md#the-two-views)), up to the room's `maxWindowCount`
  (see [`ChatRoomPolicy`](ChatRoomPolicy.md)), oldest first, and `hasOlder` says
  whether there are more. It follows the conversation as new messages arrive,
  and needs no request.
- **`windows`** holds the reading session's open windows onto the messages, each
  a [`ChatMessageWindow`](ChatMessageWindow.md) under the `windowId` its client
  chose (see [windows](#windows)).

## Scope

A message list mixes two [scopes](../scoped-cell-instances.md#summary), and the
line between them runs through its fields:

- **`PerSpace`**: `count`, `oldestAt`, `newestAt`, and `latest`, the same for
  everyone the room's space admits. They are derived from the room's messages
  when they're read, and stored nowhere, so reading them needs no instance of
  anything, and no write. That is what lets every member read the room's newest
  messages, including a READ member, who can't write and so can't open a window
  (see [`ChatRoomOutput`](ChatRoomOutput.md#membership)). The streams are the
  same for everyone too.
- **`PerSession`**: `windows`, one instance per memory session in the room's
  space. It is a cell of its own, linked from the list, since a narrower scope
  inside a broader one needs a `Cell` boundary between them (see [scoped cell
  instances](../scoped-cell-instances.md)). A session is, roughly, one
  connection: a client's runtime talking to the room. Two sessions reading the
  same room have their own windows, even when they belong to the same person.
  The windows go when their session does, and none of them is part of the room's
  record. A session's `windows` come into being with its first `openWindow`, and
  read as empty until then, so a session that only reads, as a READ member's
  does, has none.

## Windows

A client reads the conversation through windows, each a run of consecutive
messages it asked for, so a long history never has to arrive whole. A window
comes from one of the two views of a conversation (see
[`ChatReply`](ChatReply.md#the-two-views)): the main conversation, or one
thread. The newest messages of the main conversation need no window: they are in
`latest`, for everyone. A client can have any number of windows open at once,
each under a `windowId` it chooses, such as one per panel it shows. Ten panels
on ten threads are ten windows, which never interfere with one another.

### `openWindow(requestId: string, windowId: string, root?: Cell<ChatMessage>, from: ChatWindowAnchor, count: number)`

- `requestId: string` — Chosen by the client, and unique among its requests. It
  shows up in the window as the window's `requestId` once the request is
  fulfilled.
- `windowId: string` — The window to set, chosen by the client.
- `root?: Cell<ChatMessage>` — The root of the thread to show. Absent for the
  main conversation. Must be a thread's root in this room.
- `from: ChatWindowAnchor` — Where the window sits: at the newest end, at the
  earliest end, or around one message (see
  [`ChatWindowAnchor`](ChatWindowAnchor.md)).
- `count: number` — The most messages to show. The room's `maxWindowCount` caps
  it.

Sets the window `windowId` to up to `count` messages of the view, placed as
`from` says. It opens the window if it isn't open, and moves it if it is, so
paging is opening the same window again with a new `from`. The result is a
[`ChatMessageWindow`](ChatMessageWindow.md) in `windows[windowId]`. It is
refused as [limits](#limits) says.

### `closeWindow(requestId: string, windowId: string)`

- `requestId: string` — Chosen by the client, and unique among its requests.
- `windowId: string` — The window to close.

Removes the window. Closing one that isn't open changes nothing.

### Paging and following

`sentAt` is unique in the room, so it works as a cursor in both directions. To
read further back, a client opens the window again with
`{ before: <oldest sentAt it has> }`; to read further forward, with
`{ after: <newest sentAt it has> }`. `hasOlder` and `hasNewer` say whether there
is anything further in either direction.

Two placements of the same room in one session see the same `windows`, and keep
out of each other's way by choosing different `windowId`s, such as ones the
client mints at random.

A window stays live: as the messages in it change, it changes with them. It
doesn't grow with new messages on its own. A client learns of those from
`recentActivity` (see [`ChatRoomActivity`](ChatRoomActivity.md)), and moves a
window when it wants them in it.

Like every stream, `openWindow` is one-way. A client knows its request has been
fulfilled when `windows[windowId].requestId` becomes the request's.

`openWindow` and `closeWindow` are idempotent by construction: repeating one
sets or removes the same window again. So they stay out of the room's request
memory (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)), and their
`requestId` serves only to tell a client which request it's seeing.

## Limits

A room states two limits in its policy (see
[`ChatRoomPolicy`](ChatRoomPolicy.md)):

- **`maxWindowCount`**: the most messages a window holds. A request for more
  gets this many.
- **`maxOpenWindows`**: the most windows a session can have open. An
  `openWindow` for a new window beyond that is refused, silently, like any
  refusal, so a client closes the windows it no longer shows.

An `openWindow` whose `root` isn't a thread's root in this room is refused, too,
as is one whose `from` is `{ around: t }` for a `t` that isn't a message in the
view.

## Streams that don't write the room

`openWindow` and `closeWindow` are the only streams on a message list, and they
change nothing but the sending session's own windows. Every write that changes
the room goes to the room's own streams (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)), because the room is `PerSpace`
and shared.

## Reaching it from a native client

A native client reaches a room's message list through the room's `messages`
link, reads its `windows`, and sends to `openWindow` and `closeWindow` through
it, as it reaches the room itself (see
[`clients.md`](clients.md#showing-a-room)).
