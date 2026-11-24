# ChatThreadSummary

One thread, as the main conversation shows it beside its root: its title, how
many replies it holds, when the newest was sent, and its newest messages. A
room's [`ChatMessageList`](ChatMessageList.md) offers one for each thread that
holds a reply, in `threads`.

```ts
// Shown for illustration only.
interface ChatThreadSummary {
  /** The thread's root, a message the main conversation shows. */
  root: Cell<ChatMessage>;

  /** The thread's title, as a member set it, or its root's opening words. */
  title: string;

  /** How many messages the thread holds besides its root; never 0. */
  replyCount: number;

  /** The newest `sentAt` among those messages. */
  latestReplyAt: FabricEpochNsec;

  /** The root, then up to `maxWindowCount` of the newest other messages. */
  messages: Cell<ChatMessage>[];

  /** Whether the thread holds older messages than those. */
  hasOlder: boolean;
}
```

## Fields

- **`root`** links the thread's root (see
  [`ChatReply`](ChatReply.md#threads)), which is always a message the main
  conversation shows, by the link to its own cell, the link every field of the
  room naming it holds. A client finds the summary for a message it shows by
  comparing this link with the message's, which are equal exactly when they
  name the same message.
- **`title`** is the thread's title as a member last set it (see
  [titles](#titles)), or, where none has, the opening words of its root.
- **`replyCount`** is how many messages the thread holds besides its root: those
  that name it as their `thread` (see [`ChatReply`](ChatReply.md#threads)),
  whichever message of the thread each quotes. A `"main"` reply quoting the root
  is in no thread, and isn't counted.
- **`latestReplyAt`** is the greatest `sentAt` among those messages.
- **`messages`** holds the thread's root, then up to the room's `maxWindowCount`
  (see [`ChatRoomPolicy`](ChatRoomPolicy.md)) of its newest other messages,
  oldest first, each by its own cell. It follows the thread as messages arrive,
  and needs no request.
- **`hasOlder`** says whether the thread holds older messages than those
  `messages` holds besides its root. A client showing more reads the room's
  stored messages and takes those that name the root as their `thread`.

## Titles

A member sets a thread's title through the room's `setThreadTitle`, or with the
send that starts the thread, as its `threadTitle` (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)). The room keeps one title per
thread, labeled `authored-by` the member who last set it, and every member
shares it.

A thread no member has titled is titled by its root's text, cut by the room to
at most 50 characters:

- each run of whitespace reads as one space, and none leads or trails;
- text of 50 characters or fewer is the title as it stands;
- longer text is cut to the whole words that fit before an ellipsis (`…`)
  within 50 characters, and a first word longer than that to as much of it as
  fits;
- a character is a Unicode code point, so a cut never splits one;
- a deleted root reads as "This message was deleted.", an obliterated one as
  "This message was removed.", and a root with no text, only attachments, as
  "Attachments".

## Deleted and obliterated replies

A deleted or obliterated reply stays in its thread: its tombstone keeps `sentAt`
and `replyTo` (see [obliterated messages](ChatMessage.md#obliterated-messages)),
and a window onto the thread still shows it. So it is still counted, and its
`sentAt` can still be `latestReplyAt`. A summary never goes down: a thread's
count rises with each reply and stays.

A deleted root keeps its thread too, and its summary with it.

## A message with no replies

A message of the main conversation that roots no thread has no summary. A client
reads that as a count of 0 and no latest reply time. Every summary therefore has
a `replyCount` of at least 1, and a `latestReplyAt`.

## Derived, not stored

Summaries are derived from the room's messages, and the titles members set, when
they're read, and stored nowhere, like the two views they describe (see
[`ChatReply`](ChatReply.md#the-two-views)). So a summary can't disagree with the
thread it describes, and reading one needs no instance of anything and no write:
a READ member reads them as they read `latest`.
