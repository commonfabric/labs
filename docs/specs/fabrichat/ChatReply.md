# ChatReply

What a message says about the conversation around it: the thread it joins, the
message it quotes, and where it is shown. A [`ChatMessage`](ChatMessage.md) that
joins a thread or quotes a message carries one as `replyTo`.

```ts
// Shown for illustration only.
interface ChatReply {
  /** The root of the thread the message joins; absent for none. */
  thread?: Cell<ChatMessage>;

  /** The message this one answers; absent for a plain post. */
  quotes?: Cell<ChatMessage>;

  /** Where the message is shown. */
  shownIn: "main" | "thread" | "both";
}
```

## Fields

- **`thread`** links the root of the thread the message joins: a message in the
  same room that is in no thread itself. It is absent for a message in no
  thread.
- **`quotes`** links the message this one answers, in the same room. Beside a
  `thread`, it is that thread's root or one of the thread's messages. It is
  absent for a plain post.
- **`shownIn`** says where the message is shown:

  | `shownIn` | The message is shown | It names |
  | --- | --- | --- |
  | `"main"` | in the main conversation | `quotes`, and no `thread` |
  | `"thread"` | only in its thread | `thread`, and `quotes` where it answers a message of the thread |
  | `"both"` | in its thread, and in the main conversation too | `thread`, and `quotes` where it answers a message of the thread |

Each link names the message's own cell, as every field of the room naming a
message does. So the three ways to send are:

- a **plain post in a thread**, which names its `thread` alone;
- a **reply in a thread**, which names its `thread` and the message it
  `quotes`;
- a **reply in the main conversation**, which names the message it `quotes`
  alone, shown in `"main"`.

A `"main"` reply MUST quote a message that is itself shown in the main
conversation. A message shown only in a thread can't be quoted there, since
readers of the main conversation wouldn't see it in context: a reply to it is a
reply in that thread.

`shownIn` and the links are part of what the person chose when they sent the
message, so a client that draws its own composer shows them and sends exactly
what it showed (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).

## Threads

Threads are flat, one level deep. A thread is identified by its **root**, and a
message names the root of the thread it joins. The room refuses a send whose
`thread` is in a thread itself, whose `quotes` beside a `thread` is outside that
thread, or whose links don't fit its `shownIn`, so a room never holds a thread
within a thread. Any message in no thread can be a thread's root, so a thread's
root is always a message shown in the main conversation.

A thread can have a title (see [`ChatThreadSummary`](ChatThreadSummary.md)).

## The two views

- **The main conversation** is every message with no `replyTo`, or with
  `shownIn` `"main"` or `"both"`, oldest first.
- **A thread** is its root, followed by every message that names it as its
  `thread`, oldest first.

A `"both"` message appears in both. The main conversation shows it as a message
of its thread, which a reader can open from it, and shows what it quotes where
it quotes something. A `"main"` reply is in no thread, and shows the message it
quotes.

Neither view is stored. Both are derived from the room's messages, the same way
in every client. So is each thread's summary: its title, how many replies it
holds, when the newest was sent, and its newest messages (see
[`ChatThreadSummary`](ChatThreadSummary.md)).

## A reply naming neither

No send stores a `replyTo` that names neither a `thread` nor a message it
`quotes`, but a room's messages can hold one, from a FabriChat that didn't name
the two apart. The room can't say what such a message replied to: it shows one
shown in the main conversation as a message in no thread, and doesn't show one
shown only in a thread. It counts them as `legacyReplies` (see
[`ChatMessageList`](ChatMessageList.md)), and says how many there are.
