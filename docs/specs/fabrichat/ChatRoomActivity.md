# ChatRoomActivity

Status: proposed design (see [`README.md`](README.md)).

One entry in a room's log of recent activity: something the room recorded, and
when. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers its recent activity,
oldest first, as `recentActivity`.

```ts
// Shown for illustration only.
interface ChatRoomActivity {
  /** When the room recorded it. Unique in the room. */
  at: FabricEpochNsec;

  /** The `requestId` of the event it records. */
  requestId: string;

  /** The thing the event changed or added. */
  what: Cell<ChatMessage> | Cell<Cell<ChatProfile>[]>;
}
```

## What it's for

`recentActivity` lets a client follow a room by reading what changed, rather
than by comparing `messages` with what it had before. An entry doesn't describe
the change: it points at the thing that changed, and a client reads that thing
afresh.

It also tells a client something `messages` can't: which message a send
produced. The room may record a message at a time other than the one its sender
proposed (see [recorded times](ChatRoomOutput.md#recorded-times)), so a sender
can't find its message by its proposal in `messages`. It can in
`recentActivity`, where the send's entry pairs its `requestId` with the message.

## Fields

- **`at`** is the time the room recorded the entry. For an entry that made a
  record (a message's version, or a reaction), it is that record's time: the
  message's `sentAt` or `editedAt`, or the reaction's `sentAt`. Every other
  entry gets a time of its own. Every `at` is unique in the room, like every
  time a room records (see [unique times](ChatMessage.md#unique-times)), so it
  identifies its entry.
- **`requestId`** is the `requestId` of the event the entry records.
- **`what`** links the thing the event changed or added:

  | Event | `what` |
  | --- | --- |
  | `sendMessage` | the new message |
  | `editMessage`, `deleteMessage`, `obliterateMessage` | the message |
  | `sendReaction`, `deleteReaction` | the message the reaction is on |
  | `showProfile`, `leave`, `add`, `remove` | the room's membership, as the room offers it |

  The room's membership, as the room offers it, is its `roster`, until the
  room's space has a member set, and the member set after that.

Each entry is labeled `authored-by` the principal whose event it records, as the
record it describes is. So a sender finds the entry for a request of its own by
the `requestId` and the label together: two senders can choose the same
`requestId`, but not under the same label.

An entry records only that something happened, and where. It copies nothing from
the thing it points at, so it holds nothing of a message's content that a later
obliteration would have to reach.

## Recent

`recentActivity` holds entries no older than the room's
`recentActivityWindowNsec` (see [`ChatRoomPolicy`](ChatRoomPolicy.md)), measured
from the room's handler clock. A room drops older entries. The window MUST be at
least `proposedTimeMaxAgeNsec`, so a sender can still find the entry for any
send the room could have accepted.

A client that has been away longer than the window can't catch up from
`recentActivity`, and reads `messages` afresh instead.

## Obliteration

When a message is obliterated, by `obliterateMessage` or by a deletion that is
obliteration, the room removes that message's earlier entries from
`recentActivity`, and the obliteration's own entry is the only one left for it.
Otherwise the entries' labels would keep, for a while, who sent the message,
edited it, and reacted to it, which obliteration exists to remove.
