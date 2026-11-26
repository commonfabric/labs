# ChatMessageList

A room's messages, offered for structured access rather than as one array. A
room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `messages`. It says
where the conversation stands, holds its newest messages, and lists its
threads, the same for every reader, and holds the reading session's windows
onto them.

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

  /** Every thread that holds a reply, oldest root first. */
  threads: ChatThreadSummary[];

  /** How many messages reply naming neither a thread nor a quote. */
  legacyReplies: number;

  /** This session's open windows, by the `windowId` its client chose. */
  windows: PerSession<Record<string, ChatMessageWindow>>;

  /** Opens a window, or moves one already open. */
  openWindow: Stream<RoomWindowEvent>;

  /** Closes a window. */
  closeWindow: Stream<RoomWindowEvent>;
}
```

## Fields

- **`count`** is how many messages the room holds, obliterated tombstones
  included, and any it [can't read](ChatMessage.md#a-message-the-room-cant-read)
  left out.
- **`oldestAt`** and **`newestAt`** are the first and last messages' `sentAt`,
  in the order the room recorded them, and are absent while the room has no
  messages.
- **`latest`** holds the newest messages of the main conversation (see
  [`ChatReply`](ChatReply.md#the-two-views)), up to the room's `maxWindowCount`
  (see [`ChatRoomPolicy`](ChatRoomPolicy.md)), oldest first, and `hasOlder` says
  whether there are more. Each is the link to the message's own cell, the same
  link every other field of the room that names it holds. It follows the
  conversation as new messages arrive, and needs no request.
- **`threads`** holds a [`ChatThreadSummary`](ChatThreadSummary.md) for each
  thread in the room that holds a reply: its root, its title, how many replies
  it holds, when the newest was sent, and its newest messages, oldest root
  first. A client shows a message of the main conversation with its thread's
  count and latest reply time from here, and a thread from its `messages`. A
  message that roots no thread has no entry, and reads as a count of 0. It
  follows the conversation as replies arrive, and needs no request.
- **`legacyReplies`** is how many of the room's messages carry a `replyTo`
  naming neither a thread nor a message it quotes, a shape no send stores (see
  [`ChatReply`](ChatReply.md#a-reply-naming-neither)). The room shows such a
  message as a message in no thread, where it was shown in the main
  conversation, and doesn't show it where it was shown only in a thread. A
  client that shows the room's messages says how many there are while this
  isn't 0.
- **`windows`** holds the reading session's open
  [`ChatMessageWindow`](ChatMessageWindow.md)s, each under the `windowId` its
  client chose; it is absent until the session opens one. **`openWindow`** and
  **`closeWindow`** set and remove them, as
  [`ChatMessageWindow`](ChatMessageWindow.md#opening-and-closing) states.

## Scope

Every field but the windows is `PerSpace`
([scopes](../scoped-cell-instances.md#summary)): the same for everyone the
room's space admits, derived from the room's messages when it's read, and
stored nowhere, so reading it needs no instance of anything, and no write. That
is what lets every member read the room's newest messages, including a READ
member, who can't write (see [`ChatRoomOutput`](ChatRoomOutput.md#membership)).
`windows` is `PerSession`: each session's are its own, and no part of the
room's record.

## Reading the rest

`latest` holds the newest `maxWindowCount` messages of the main conversation,
and each thread's `messages` the newest of its own (see
[`ChatRoomPolicy`](ChatRoomPolicy.md)). A window holds up to as many again,
from either end of either view. A client that shows more reads the room's
stored messages themselves, each a cell, and derives the view it shows from
their `replyTo` as [`ChatReply`](ChatReply.md#the-two-views) states. The
message list's only streams are `openWindow` and `closeWindow`, which change
nothing but the sending session's windows: every write to the room's record
goes to the room's own streams (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)).

The room's own rendering opens no window. A room's stored result can hold a
writer claim at `messages/windows` naming the handler that writes the windows,
and every later program of the room keeps that claim (see `commitWindow` in
`room-records.tsx`), so the position keeps holding them.
