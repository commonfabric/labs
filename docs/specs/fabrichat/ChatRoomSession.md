# ChatRoomSession

Status: proposed design (see [`README.md`](README.md)).

One session's view of a room: the state that belongs to a single connection to
the room, not to the room. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) is one
per room and the same for everyone. Each session that reads it gets a
`ChatRoomSession` of its own, through the room's `session`.

```ts
// Shown for illustration only.
interface ChatRoomSession {
  /** The room this is a session of. */
  room: Cell<ChatRoomOutput>;

  /** This session's open windows, by the `windowId` its client chose. */
  windows: Record<string, ChatMessageWindow>;

  /** The composer's state: the draft, and the reply being composed. */
  composer: {
    draft: string;
    replyTo?: ChatReply;
  };

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

## Scope

Everything here is [`PerSession`](../scoped-cell-instances.md#summary): one
instance per memory session in the room's space. A session is, roughly, one
connection: a client's runtime talking to the room. Two sessions reading the
same room get two `ChatRoomSession`s, with their own windows and their own
drafts, even when they belong to the same person.

The state here goes when its session does. None of it is shared, and none of it
is part of the room's record.

A session's state comes into being with its first write, such as opening a
window or typing in the composer. A session that only reads has none, which is
how a READ member, who can't write, reads a room: through the room's `messages`
([`ChatMessageList`](ChatMessageList.md)), which needs no session. What a reader
can do, `canSend`, is on the room too.

## Fields

- **`room`** links back to the room, which is the room's unique representative:
  the thing to pass around, compare, or record, as a manager's index does.
- **`windows`** holds this session's open windows onto the room's messages, each
  a [`ChatMessageWindow`](ChatMessageWindow.md) under the `windowId` its client
  chose (see [windows](#windows)).
- **`composer`** is the state of the room's own composer, which the room's
  `[UI]` shows and sends from. A client that draws its own composer keeps its
  own state instead.

## Windows

A client reads the conversation through windows, each a run of consecutive
messages it asked for, so a long history never has to arrive whole. A window
comes from one of the two views of a conversation (see
[`ChatReply`](ChatReply.md#the-two-views)): the main conversation, or one
thread. The newest messages of the main conversation need no window: the room
offers them to everyone, as `messages.latest` (see
[`ChatMessageList`](ChatMessageList.md)). A client can have any number of
windows open at once, each under a `windowId` it chooses, such as one per panel
it shows. Ten panels on ten threads are ten windows, which never interfere with
one another.

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

Each viewer's windows are their own, and a session's windows go when the session
does. Two placements of the same room in one session see the same `windows`, and
keep out of each other's way by choosing different `windowId`s, such as ones the
client mints at random.

A window stays live: as the messages in it change, it changes with them. It
doesn't grow with new messages on its own. A client learns of those from
`recentActivity` (see [`ChatRoomActivity`](ChatRoomActivity.md)), and moves a
window when it wants them in it.

Like every stream, `openWindow` is one-way. A client knows its request has been
fulfilled when `windows[windowId].requestId` becomes the request's.

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

## Writing

A session has no streams that write the room. Every write goes to the room's own
streams (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)), whichever session
the client reads through, because every write changes the room, which is
`PerSpace` and shared, and never the session. Keeping the writes on the room
keeps that line where the scopes draw it: the room is the shared thing, and a
session is one reader's view of it. A session's only streams are `openWindow`
and `closeWindow`, which change nothing but the session's own windows.

## Reaching it from a native client

A native client reaches a session through the room's `session` link, and sends
to `openWindow` and `closeWindow` through it, as it reaches the room itself (see
[`clients.md`](clients.md#showing-a-room)).
