# ChatMessageWindow

Status: implemented, with the departures listed in
[`README.md`](README.md#implementation-status).

A run of consecutive messages from one view of a conversation, opened by a
client. A room's [`ChatMessageList`](ChatMessageList.md) keeps each of a
session's open windows in `windows`, under the `windowId` the client chose.

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
  the window, so a client can tell which of its requests it's seeing.
- **`root`** links the thread's root in a thread's window, and is absent in a
  window of the main conversation.
- **`messages`** are the window's [`ChatMessage`](ChatMessage.md)s, oldest
  first: at most the request's `count`, and at most the room's `maxWindowCount`.
- **`hasOlder`** and **`hasNewer`** say whether the view has messages older than
  the first one in the window, and newer than the last one, so a client knows
  whether to offer to load more in either direction. A window anchored at the
  newest end has no newer messages when it's set, but a new message can change
  that, so a client reads `hasNewer` rather than assuming.

A window stays live as the messages in it change, and doesn't grow with new
messages on its own (see
[`ChatMessageList`](ChatMessageList.md#paging-and-following)).
