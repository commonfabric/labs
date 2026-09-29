# ChatMessageList

Status: proposed design (see [`README.md`](README.md)).

What a room offers about its messages as a whole, rather than the messages as
one array. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as
`messages`. It is the same for every reader, and it is all a reader needs to see
where the conversation stands and read its newest messages. A client reads the
rest of the conversation through windows of its own, which belong to its session
(see [`ChatRoomSession`](ChatRoomSession.md#windows)).

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
}
```

## Fields

- **`count`** is how many messages the room holds, obliterated tombstones
  included.
- **`oldestAt`** and **`newestAt`** are the oldest and newest messages'
  `sentAt`, and are absent while the room has no messages.
- **`latest`** holds the newest messages of the main conversation (see
  [`ChatReply`](ChatReply.md#the-two-views)), up to the room's `maxWindowCount`
  (see [`ChatRoomPolicy`](ChatRoomPolicy.md)), oldest first, and `hasOlder` says
  whether there are more. It follows the conversation as new messages arrive,
  and needs no request.

## Scope

Everything here is derived from the room's messages when it's read, and stored
nowhere. It describes the room's shared messages, so it is the same for everyone
the room's space admits, like the rest of the room (see
[`ChatRoomOutput`](ChatRoomOutput.md#scopes)).

Reading it needs no instance of anything, and no write. That is what lets every
member read the room's newest messages, including a READ member, who can't write
and so can't open a window (see
[`ChatRoomOutput`](ChatRoomOutput.md#membership)).
