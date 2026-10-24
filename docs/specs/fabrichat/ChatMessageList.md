# ChatMessageList

A room's messages, offered for structured access rather than as one array. A
room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `messages`. It says
where the conversation stands, holds its newest messages, and lists its
threads, the same for every reader.

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
}
```

## Fields

- **`count`** is how many messages the room holds, obliterated tombstones
  included.
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
  thread in the room that holds a reply: its root, how many replies it holds,
  and when the newest was sent, oldest root first. A client shows a message of
  the main conversation with its thread's count and latest reply time from
  here. A message that roots no thread has no entry, and reads as a count of 0.
  It follows the conversation as replies arrive, and needs no request.

## Scope

Every field is `PerSpace` ([scopes](../scoped-cell-instances.md#summary)): the
same for everyone the room's space admits, derived from the room's messages
when it's read, and stored nowhere, so reading it needs no instance of anything,
and no write. That is what lets every member read the room's newest messages,
including a READ member, who can't write (see
[`ChatRoomOutput`](ChatRoomOutput.md#membership)).

## Reading the rest

`latest` holds the newest `maxWindowCount` messages of the main conversation
(see [`ChatRoomPolicy`](ChatRoomPolicy.md)). A client that shows more, or a
thread, reads the room's stored messages themselves, each a cell, and derives
the view it shows from their `replyTo` as [`ChatReply`](ChatReply.md#the-two-views)
states. A message list offers no stream: every write goes to the room's own
streams (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)).
