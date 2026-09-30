# ChatReply

Status: proposed design (see [`README.md`](README.md)).

What a reply says about the message it replies to: which message, and where the
reply is shown. A [`ChatMessage`](ChatMessage.md) that is a reply carries one as
`replyTo`.

```ts
// Shown for illustration only.
interface ChatReply {
  /** The message replied to, in the same room. */
  message: Cell<ChatMessage>;

  /** Where the reply is shown. */
  shownIn: "main" | "thread" | "both";
}
```

## Fields

- **`message`** links the message replied to. It MUST be a message in the same
  room, and not deleted. The reference preserves the message's identity and
  carries its own acquisition confidentiality. Reading the message through it
  additionally consumes the message's labels.
- **`shownIn`** says where the reply is shown:

  | `shownIn` | The reply is shown | Like |
  | --- | --- | --- |
  | `"main"` | in the main conversation, with its target quoted | an inline reply |
  | `"thread"` | only in the thread | a thread reply |
  | `"both"` | in the thread, and in the main conversation too | a thread reply also sent to the conversation |

A `"main"` reply MUST reply to a message that is itself shown in the main
conversation. A message shown only in a thread can't be quoted there, since
readers of the main conversation wouldn't see it in context: a reply to it is a
`"thread"` or `"both"` reply.

`shownIn` is part of what the person chose when they sent the reply, so a client
that draws its own composer shows it and sends exactly what it showed (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).

## Threads

Threads are flat, one level deep. A thread is identified by its **root**, and a
message's thread is found from its `replyTo`:

- A message whose `shownIn` is `"thread"` or `"both"` is in a thread. If the
  message it replies to is itself in a thread, it is in that same thread.
  Otherwise, it is in the thread rooted at the message it replies to.
- Any other message, with no `replyTo` or with `shownIn: "main"`, is in no
  thread, and can be a thread's root.

So a thread's root is always a message shown in the main conversation, and a
reply to a message already in a thread joins that thread rather than starting
another. A room never holds a thread within a thread.

## The two views

- **The main conversation** is every message with no `replyTo`, or with
  `shownIn` `"main"` or `"both"`, oldest first.
- **A thread** is its root, followed by every message in that thread, oldest
  first.

A `"both"` message appears in both. A `"main"` reply is in no thread, and quotes
a message that the main conversation also shows.

Neither view is stored. Both are derived from the room's messages, the same way
in every client.
