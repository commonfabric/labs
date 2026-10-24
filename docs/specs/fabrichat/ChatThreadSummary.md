# ChatThreadSummary

One thread, as the main conversation shows it beside its root: how many replies
it holds, and when the newest was sent. A room's
[`ChatMessageList`](ChatMessageList.md) offers one for each thread that holds a
reply, in `threads`.

```ts
// Shown for illustration only.
interface ChatThreadSummary {
  /** The thread's root, a message the main conversation shows. */
  root: Cell<ChatMessage>;

  /** How many messages the thread holds besides its root; never 0. */
  replyCount: number;

  /** The newest `sentAt` among those messages. */
  latestReplyAt: FabricEpochNsec;
}
```

## Fields

- **`root`** links the thread's root (see
  [`ChatReply`](ChatReply.md#threads)), which is always a message the main
  conversation shows, by the link to its own cell, the link every field of the
  room naming it holds. A client finds the summary for a message it shows by
  comparing this link with the message's, which are equal exactly when they
  name the same message.
- **`replyCount`** is how many messages the thread holds besides its root, by
  the membership [`ChatReply`](ChatReply.md#threads) states, whichever message
  of the thread each replies to. It is the number of messages a window onto
  the thread shows besides the root, when the window holds the whole thread. A
  `"main"` reply to the root is in no thread, and isn't counted.
- **`latestReplyAt`** is the greatest `sentAt` among those messages.

## Deleted and obliterated replies

A deleted or obliterated reply stays in its thread: its tombstone keeps
`sentAt` and `replyTo` (see [obliterated
messages](ChatMessage.md#obliterated-messages)), and a window onto the thread
still shows it. So it is still counted, and its `sentAt` can still be
`latestReplyAt`. A summary never goes down: a thread's count rises with each
reply and stays.

A deleted root keeps its thread too, and its summary with it.

## A message with no replies

A message of the main conversation that roots no thread has no summary. A client
reads that as a count of 0 and no latest reply time. Every summary therefore has
a `replyCount` of at least 1, and a `latestReplyAt`.

## Derived, not stored

Summaries are derived from the room's messages when they're read, and stored
nowhere, like the two views they describe (see
[`ChatReply`](ChatReply.md#the-two-views)). So a summary can't disagree with
the thread it describes, and reading one needs no instance of anything and no
write: a READ member reads them as they read `latest`.
