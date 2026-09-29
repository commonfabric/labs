# ChatMessageList

Status: proposed design (see [`README.md`](README.md)).

A room's messages, offered for structured access rather than as one array. A
room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `messages`. A client
reads the conversation through windows, each a run of messages it asked for, so
a long history never has to arrive whole.

```ts
// Shown for illustration only.
interface ChatMessageList {
  /** How many messages the room holds, obliterated tombstones included. */
  count: number;

  /** The oldest and newest messages' `sentAt`; absent while there are none. */
  oldestAt?: FabricEpochNsec;
  newestAt?: FabricEpochNsec;

  /** This session's open windows, by the `windowId` its client chose. */
  windows: Record<string, ChatMessageWindow>;

  openWindow: Stream<{
    requestId: string;
    windowId: string;
    root?: Cell<ChatMessage>;
    before?: FabricEpochNsec;
    count: number;
  }>;
  closeWindow: Stream<{ requestId: string; windowId: string }>;
}
```

## Windows

A window is a run of consecutive messages from one of the two views of a
conversation (see [`ChatReply`](ChatReply.md#the-two-views)): the main
conversation, or one thread. A client can have any number of windows open at
once, each under a `windowId` it chooses, such as one per panel it shows. Ten
panels on ten threads are ten windows, which never interfere with one another.

- **`openWindow(requestId, windowId, root?, before?, count)`** sets the window
  `windowId` to up to `count` messages of the thread rooted at `root`, or of the
  main conversation when `root` is absent: the newest of them sent before
  `before`, or the newest there are when `before` is absent. It opens the window
  if it isn't open, and moves it if it is, so paging a window back is opening it
  again with an earlier `before`. The result is a
  [`ChatMessageWindow`](ChatMessageWindow.md) in `windows[windowId]`.
- **`closeWindow(requestId, windowId)`** removes the window. Closing one that
  isn't open changes nothing.

`sentAt` is unique in the room, so it works as a cursor: to read further back, a
client opens the window again with `before` set to the `sentAt` of the oldest
message it has. `hasOlder` says whether there is anything further back.

`windows` is kept per session (`PerSession`): each viewer's windows are their
own, and a session's windows go when the session does. Two placements of the
same room in one session see the same `windows`, and keep out of each other's
way by choosing different `windowId`s, such as ones the client mints at random.

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

An `openWindow` whose `root` isn't a thread's root in this room is refused, too.

## Reaching it from a native client

`messages` is a piece of the room's output with streams of its own. A native
client reaches it, and sends to `openWindow` and `closeWindow`, through its
link, as it reaches the room itself (see
[`clients.md`](clients.md#showing-a-room)).
