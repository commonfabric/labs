# ChatRoomPolicy

Status: proposed design (see [`README.md`](README.md)).

A room's policy: how it behaves where
[`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior) leaves the
choice to the implementation. A room states it in its
[`ChatRoomAbout`](ChatRoomAbout.md), as `policy`.

```ts
// Shown for illustration only.
interface ChatRoomPolicy {
  /** Whether an OWNER may obliterate messages. */
  ownersMayObliterate: boolean;

  /** Whether an edit keeps the version it replaces in `earlierVersions`. */
  editKeepsHistory: boolean;

  /** Whether a sender's deletion of their own message obliterates it. */
  deletionIsObliteration: boolean;

  /** How far before the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxAgeNsec: bigint;

  /** How far after the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxLeadNsec: bigint;

  /** How long an entry stays in `recentActivity`, in ns. */
  recentActivityWindowNsec: bigint;
}
```

A plain object, with every key present.

## Stated correctly

An implementation MUST state its policy correctly: every key in `policy` MUST
describe what the room actually does, for as long as the room exists. A client
reads `policy` to learn what a room allows, and can show it to a person before
they write in the room.

A client has no way to check `policy` against the room's behavior, so it rests
on the implementation. An implementation whose `policy` misstates what its room
does doesn't conform to this contract.

Like the rest of `about`, `policy` is labeled `authored-by` the principal who
wrote it (see [`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)).

## Keys

- **`ownersMayObliterate`**: whether an OWNER may obliterate messages in a group
  room or a space's own chat. A room under a retention requirement may say no.
- **`editKeepsHistory`**: whether an edit keeps the version it replaces in
  `earlierVersions` ([`ChatMessage`](ChatMessage.md)).
- **`deletionIsObliteration`**: whether a sender's `deleteMessage` of their own
  message obliterates it, removing its history and its author, as
  `obliterateMessage` does (see [obliterated
  messages](ChatMessage.md#obliterated-messages)). This is the only way a member
  of a group room, or of a space's own chat, takes back what they said
  completely. It governs `deleteMessage` only: a direct room MUST let either
  person obliterate their own messages with `obliterateMessage`, whatever its
  policy.
- **`proposedTimeMaxAgeNsec`**: how far before the room's handler clock a
  sender's proposed time is accepted, and recorded as proposed. It covers
  network delay, retries, and sends queued offline, so it can be generous.
- **`proposedTimeMaxLeadNsec`**: how far after the room's handler clock a
  sender's proposed time is accepted. It covers only clock skew, so it can be
  small. An accepted proposal on this side is recorded at the current time,
  never later (see [recorded times](ChatRoomOutput.md#recorded-times)).

A proposal outside both bounds is refused.

- **`recentActivityWindowNsec`**: how long, before the room's handler clock, an
  entry stays in `recentActivity` ([`ChatRoomActivity`](ChatRoomActivity.md)).
  It MUST be at least `proposedTimeMaxAgeNsec`.

## When it changes

`policy` states the room's settings when the room is created. If an
implementation lets a room's settings change afterward, it MUST update `policy`
in the same transaction that changes them, so the two never disagree. `policy`
is the only part of `about` that can change.
