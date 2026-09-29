# ChatRoomActivity

Status: implemented, with the departures listed in
[`README.md`](README.md#implementation-status).

One entry in a room's log of recent activity: something the room recorded, and
when. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers its recent activity,
in `seq` order, as `recentActivity`.

```ts
// Shown for illustration only.
interface ChatRoomActivity {
  /** The entry's place in the room's activity: 1, 2, 3, … with no gaps. */
  seq: number;

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
than by comparing the room's messages with what it had before. An entry doesn't
describe the change: it points at the thing that changed, and a client reads
that thing afresh.

It also tells a client something the messages can't: which message a send
produced. The room may record a message at a time other than the one its sender
proposed (see [recorded times](ChatRoomOutput.md#recorded-times)), so a sender
can't find its message by its proposal among the messages. It can in
`recentActivity`, where the send's entry pairs its `requestId` with the message.

## Fields

- **`at`** is the time the room recorded the entry: its own handler clock when
  it made the record, never a sender's proposal. For a send, that can be later
  than the message's `sentAt`, which may be the sender's proposed time. Every
  `at` is unique in the room, like every time a room records (see [unique
  times](ChatMessage.md#unique-times)), so it identifies its entry. Entries
  expire by `at`, but are ordered by `seq` (see [catching up](#catching-up)).
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

## Catching up

A room numbers its entries with `seq`: 1 for its first entry, and one more for
each entry after, assigned in the same transaction as the entry itself. So `seq`
has no gaps and never goes backward, whatever any clock says, and it is what a
client catches up by. `recentActivity` is in `seq` order, which can differ from
the order of `at`, since a delayed event can carry an old `at` with a new `seq`.

A client remembers the highest `seq` it has seen. When it reads the room again,
it reads the entries after that one. It can do that as long as the room still
has them: the room says, in `recentActivityExpiredThrough`, the highest `seq` it
has dropped for age (see [`ChatRoomOutput`](ChatRoomOutput.md#facts)). If that
is past the highest `seq` the client has seen, the client has missed entries,
and it reopens its windows instead of catching up.

This doesn't depend on time. An entry's `at` is its handler clock, which is the
instant of the event that set the handler running, so an event that waited
before it was recorded can carry an old `at`. That can make the entry expire
soon after it's recorded, but a client that misses it that way sees the gap and
catches up by reopening its windows. It never silently misses a change.

## Recent

`recentActivity` holds entries recorded no longer ago than the room's
`recentActivityWindowNsec` (see [`ChatRoomPolicy`](ChatRoomPolicy.md)), by their
`at`. A room drops older entries, and advances `recentActivityExpiredThrough` as
it does. The window MUST be at least `proposedTimeMaxAgeNsec`: an accepted
send's entry is recorded no more than that after its proposal, and lives for the
window after that, so a client that finds no entry for a send whose proposal is
older than `proposedTimeMaxAgeNsec` can conclude it wasn't sent (see
[`clients.md`](clients.md)), unless it sees a gap.

## Obliteration

When a message is obliterated, by `obliterateMessage` or by a deletion that is
obliteration, the room removes that message's earlier entries from
`recentActivity`, and the obliteration's own entry is the only one left for it.
Otherwise the entries' labels would keep, for a while, who sent the message,
edited it, and reacted to it, which obliteration exists to remove.

The removed entries leave holes in `seq`, which a client doesn't mistake for
missed entries: it checks `recentActivityExpiredThrough`, which removals don't
change, and the obliteration's entry points it at the message to read again.
