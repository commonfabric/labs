# ChatRoomPolicy

A room's policy: how it behaves where
[`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior) leaves the
choice to the implementation. A room states it in its
[`ChatRoomAbout`](ChatRoomAbout.md), as `policy`.

```ts
// Shown for illustration only.
interface ChatRoomPolicy {
  /** Whether an OWNER may obliterate messages, anyone's. */
  ownersMayObliterate: boolean;

  /** Whether an edit or a plain deletion keeps the version it replaces. */
  keepsHistory: boolean;

  /** Whether a sender's deletion of their own message obliterates it. */
  deletionIsObliteration: boolean;

  /** How far before the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxAgeNsec: FabricDurationNsec;

  /** How far after the room's clock a proposed time is accepted, in ns. */
  proposedTimeMaxLeadNsec: FabricDurationNsec;

  /** How long an entry stays in `recentActivity`, in ns. */
  recentActivityWindowNsec: FabricDurationNsec;

  /** How many of the newest messages `messages.latest` holds. */
  maxWindowCount: number;

  /** The most message windows a session can have open. */
  maxOpenWindows: number;

  /** The most attachments a message may have; absent for 10. */
  maxAttachments?: number;
}
```

A plain object, with every key present but `maxAttachments`, which a policy
stated before rooms took attachments doesn't hold, and which then means 10. A
room enforces `ownersMayObliterate`, `deletionIsObliteration` and
`maxAttachments`, and holds `maxWindowCount` of its newest messages in
`messages.latest`; it states `keepsHistory`,
`proposedTimeMaxAgeNsec`, `proposedTimeMaxLeadNsec`,
`recentActivityWindowNsec`, and `maxOpenWindows` for the policy's shape, and
reads none of them. Each duration is a
[`FabricDurationNsec`](../space-model-formal-spec/1-fabric-values.md): an exact
count of nanoseconds, held as a `bigint`.

## Stated correctly

An implementation MUST state its policy correctly: every key in `policy` MUST
describe what the room actually does, for as long as the room exists. A client
reads `policy` to learn what a room allows, and can show it to a person before
they write in the room.

A client has no way to check `policy` against the room's behavior, so it rests
on the implementation. An implementation whose `policy` misstates what its room
does doesn't conform to this contract.

The policy document is labeled `authored-by` the principal who wrote it (see
[`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)).

## Keys

- **`ownersMayObliterate`**: whether an OWNER of the room's space may
  obliterate any message in it, whoever sent it, in a direct room as in a group
  room. Where it is false, an OWNER may obliterate only what anyone else may
  (in a direct room, their own messages), and it never lets anyone delete a
  message someone else sent. A room under a retention requirement may say no,
  and so may a direct room, between two people who each hold OWNER. A room
  enforces the value its policy states, and a policy that can't be read lets
  no OWNER obliterate.
- **`keepsHistory`**: stated and read by nothing. A message keeps no history
  ([`ChatMessage`](ChatMessage.md#deleted-messages)).
- **`deletionIsObliteration`**: whether a sender's `deleteMessage` of their own
  message obliterates it, removing its history and its author, as
  `obliterateMessage` does (see [obliterated
  messages](ChatMessage.md#obliterated-messages)). This is the only way a member
  of a group room takes back what they said completely. It governs
  `deleteMessage` only: a direct room MUST let either person obliterate their
  own messages with `obliterateMessage`, whatever its policy.
- **`proposedTimeMaxAgeNsec`**, **`proposedTimeMaxLeadNsec`**, and
  **`recentActivityWindowNsec`**: stated and read by nothing. A sender
  proposes no time, and the room keeps no activity log (see
  [times](ChatMessage.md#times)).
- **`maxWindowCount`**: how many of the newest messages of the main
  conversation `messages.latest` holds (see
  [`ChatMessageList`](ChatMessageList.md#fields)).
- **`maxOpenWindows`**: stated and read by nothing. A room offers no message
  windows.
- **`maxAttachments`**: the most attachments a message may have (see
  [`ChatMessage`](ChatMessage.md#fields)); a send attaching more is refused.
  Absent, it is 10, so a policy that doesn't state it is still stated
  correctly for a room that allows 10.

## When it changes

`about.policy` links the policy, which is a document of its own, so that
changing it never touches `about` or the creator's label on it (see
[`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)). It states the room's
settings when the room is created. If an implementation lets a room's settings
change afterward, it MUST update the policy in the same transaction that changes
them, so the two never disagree. The policy's own label names whoever last
changed it.
