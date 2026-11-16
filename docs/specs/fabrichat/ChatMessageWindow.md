# ChatMessageWindow

A run of consecutive messages from one view of a room's messages, which a
session opens. A room's [`ChatMessageList`](ChatMessageList.md) keeps each of a
session's open windows in `windows`, under the `windowId` the session's client
chose, and sets one only when that session sends to `openWindow` or
`closeWindow`.

```ts
// Shown for illustration only.
interface ChatMessageWindow {
  /** The `openWindow` request that set the window as it is now. */
  requestId: string;

  /** For a thread's window, the thread's root; absent for the main one. */
  root?: Cell<ChatMessage>;

  /** The messages in the window, oldest first. */
  messages: ChatMessage[];

  /** Whether the view has messages older than the window's first. */
  hasOlder: boolean;

  /** Whether the view has messages newer than the window's last. */
  hasNewer: boolean;
}
```

## Fields

- **`requestId`** is the `requestId` of the `openWindow` request that last set
  the window, so a client can tell which of its requests it is seeing.
- **`root`** links the thread's root in a thread's window, and is absent in a
  window of the main conversation.
- **`messages`** are the window's [`ChatMessage`](ChatMessage.md)s, oldest
  first, each the link to the message's own cell, the same link every other
  field of the room naming it holds: at most the request's `count`, and at most
  the room's `maxWindowCount` (see [`ChatRoomPolicy`](ChatRoomPolicy.md)).
- **`hasOlder`** and **`hasNewer`** say whether the view held messages before
  the window's first and after its last when the window was set.

A window holds the run of messages it was set to. Each message in it reads as
it stands, edits and reactions included, but the run itself does not move as
messages arrive: a client that wants the newest messages again sends the same
`openWindow` again, and `messages.latest` follows the main conversation with no
request at all.

## Opening and closing

`openWindow` and `closeWindow` take the same event:

```ts
// Shown for illustration only.
interface RoomWindowEvent {
  /** Chosen by the client; shown in the window once an open is fulfilled. */
  requestId: string;

  /** The window to set or close, chosen by the client. */
  windowId: string;

  /** The root of the thread to show; absent for the main conversation. */
  root?: Cell<ChatMessage>;

  /** Which end of its view the window holds; required to open one. */
  from?: { before: "end" } | { after: "start" };

  /** The most messages to show, capped by the room's `maxWindowCount`. */
  count?: number;
}
```

- **The view.** A window shows the main conversation, or, where `root` names
  one of the room's messages that the main conversation shows and that is in
  no thread itself, the thread it roots: the root first, then its replies, in
  the order the room recorded them (see
  [`ChatReply`](ChatReply.md#the-two-views)).
- **The run.** `from: { before: "end" }` holds the view's newest `count`
  messages, and `from: { after: "start" }` its oldest. A `count` that is not a
  finite number, or is below 0, holds none, a fractional one is rounded down,
  and one above `maxWindowCount` holds that many.
- **Moving.** An `openWindow` naming an open window sets it again, as the new
  request says.
- **Closing.** `closeWindow` removes the window it names, and changes nothing
  for a window not open.
- **What changes nothing.** An open with no `from`, or a `from` other than the
  two above, or a `root` that roots no thread, or one more window than
  `maxOpenWindows` (see [`ChatRoomPolicy`](ChatRoomPolicy.md)) opens no window.
  A request writes nothing but the sending session's windows, so the room keeps
  no request memory for it: repeating a request sets or removes the same window
  again.

## Scope

`windows` is `PerSession` ([scopes](../scoped-cell-instances.md#summary)): a
session's windows are its own, and another session of the same person reads
none of them. They are no part of the room's record. Only the room's
`commitWindow` handler writes them.

A session's windows are stored under the schema of the program that last wrote
them, which describes the messages they name, their reactions' write policy
included. Where that policy lists writers the room's does not, as one a room
program listing `commitDelete` and `commitObliterate` among its reactions'
writers stores (see [`ChatMessage`](ChatMessage.md#deleted-messages)), the
runtime refuses the room's rewriting those windows, so an `openWindow` or a
`closeWindow` changes nothing there.
