# ChatMessageList

Status: proposed design (see [`README.md`](README.md)).

A room's messages, offered for structured access rather than as one array. A
room's session ([`ChatRoomSession`](ChatRoomSession.md)) offers one, as
`messages`. Like everything in a session it is `PerSession`: its facts describe
the room's shared messages, and its windows are the session's own. A client
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
    from: ChatWindowAnchor;
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

- **`openWindow(requestId, windowId, root?, from, count)`** sets the window
  `windowId` to up to `count` messages of the thread rooted at `root`, or of the
  main conversation when `root` is absent, placed as `from` says: at the newest
  end, at the earliest end, or around one message (see
  [`ChatWindowAnchor`](ChatWindowAnchor.md)). It opens the window if it isn't
  open, and moves it if it is, so paging is opening the same window again with a
  new `from`. The result is a [`ChatMessageWindow`](ChatMessageWindow.md) in
  `windows[windowId]`.
- **`closeWindow(requestId, windowId)`** removes the window. Closing one that
  isn't open changes nothing.

`sentAt` is unique in the room, so it works as a cursor in both directions. To
read further back, a client opens the window again with
`{ before: <oldest sentAt it has> }`; to read further forward, with
`{ after: <newest sentAt it has> }`. `hasOlder` and `hasNewer` say whether there
is anything further in either direction.

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

An `openWindow` whose `root` isn't a thread's root in this room is refused, too,
as is one whose `from` is `{ around: t }` for a `t` that isn't a message in the
view.

## Reaching it from a native client

`messages` is part of a session, with streams of its own. A native client
reaches it through the room's `session` link, and sends to `openWindow` and
`closeWindow` through its link, as it reaches the room itself (see
[`clients.md`](clients.md#showing-a-room)).
