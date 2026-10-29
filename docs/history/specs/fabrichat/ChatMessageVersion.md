---
status: historical
created: 2026-09-29
archived: 2026-10-15
reason: "Superseded design; a message keeps no earlier versions, and a send or an edit carries its text alone."
---

# ChatMessageVersion

One version of a message: its body, and a time. A
[`ChatMessage`](../../../specs/fabrichat/ChatMessage.md) keeps its versions before the current one in
`earlierVersions`, oldest first, each with the time the room recorded it. A
sender also sends a new message, or an edit, as a version, whose `sentAt` is the
time it proposes (see
[`sendMessage`](../../../specs/fabrichat/ChatRoomOutput.md#sendmessagerequestid-string-version-chatmessageversion-replyto-chatreply)
and
[`editMessage`](../../../specs/fabrichat/ChatRoomOutput.md#editmessagerequestid-string-message-cellchatmessage-version-chatmessageversion)).

```ts
// Shown for illustration only.
interface ChatMessageVersion {
  /** The version's text. */
  body: string;

  /** When the room recorded this version. Unique in the room. */
  sentAt: FabricEpochNsec;
}
```

## Fields

- **`body`** is the text the message had in this version. It is always a string:
  a deleted message is never edited again, so a deletion is never an earlier
  version (see [deleted messages](../../../specs/fabrichat/ChatMessage.md#deleted-messages)).
- **`sentAt`** is when the room recorded this version: the message's own
  `sentAt` for its first version, and the `editedAt` it had then for each later
  one. Like every recorded time in a room, it is unique there (see [unique
  times](../../../specs/fabrichat/ChatMessage.md#unique-times)).

In a send or an edit, `body` must not be empty, and `sentAt` is the sender's
proposal: a hint to the room, which records its own time. It doesn't identify
the send; the stream's `requestId` does.

A version is not a full message: it has no author, reply, or reactions of its
own. Those belong to the message.
