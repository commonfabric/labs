# ChatMessage

Status: implemented, with the departures listed in
[`README.md`](README.md#implementation-status).

One message in a room ([`ChatRoomOutput`](ChatRoomOutput.md)), with its
reactions and its edit history. A client reads a room's newest messages from its
[`ChatMessageList`](ChatMessageList.md), and the rest through its session's
[windows](ChatMessageList.md#windows).

```ts
// Shown for illustration only.
interface ChatMessage {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: Cell<ChatProfile>;

  /** The current text, or the marker of a deleted message. */
  body: string | { deleted: true };

  /** When the room recorded the message's first version. Unique in the room. */
  sentAt: FabricEpochNsec;

  /**
   * When the room recorded the current version, if it isn't the first: the
   * latest edit or deletion. Unique in the room.
   */
  editedAt?: FabricEpochNsec;

  /** The versions before the current one, oldest first. */
  earlierVersions: ChatMessageVersion[];

  /** What this message replies to, and where it is shown; absent for none. */
  replyTo?: ChatReply;

  /** Everyone's reactions to this message, in no particular order. */
  reactions: ChatReaction[];
}
```

## Fields

- **`authorProfile`** links the sender's profile
  ([`ChatProfile.md`](ChatProfile.md)). It is the only way a message names its
  sender. A message stores no name or avatar: a client reads them from the
  profile when it draws, so a person's history shows their current name. The
  link is a claim, since a sender could link any profile. The message is
  verified when the principal in its `authored-by` label is the one the profile
  represents. It is absent only from an obliterated message (see [obliterated
  messages](#obliterated-messages)).
- **`body`** is the current version's text, as the person saw it when they sent
  or edited it. Text is never empty. A deleted message's body is exactly the
  plain object `{ deleted: true }`, with no other keys.
- **`sentAt`** is the time the room recorded for the message's first version.
  The sender's client proposes a time with the message, and the room records
  that proposal if it falls within the room's window, possibly adjusted, and
  never later than the room's current time; a proposal outside the window is
  refused (see [`ChatRoomOutput`](ChatRoomOutput.md#recorded-times)). The
  clock's resolution is the system's to set (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)), and a client MUST NOT
  assume a finer one. See also [unique times](#unique-times).
- **`editedAt`** is the time the room recorded for the current version, whether
  an edit or a deletion: for an edit, chosen from the sender's proposal and the
  handler clock as for `sentAt`, and for a deletion, the handler clock. It is
  absent until the message is first edited or deleted.
- **`earlierVersions`** holds each version the message had before its current
  one, as a [`ChatMessageVersion`](ChatMessageVersion.md): its body and when it
  was recorded. It is empty for a message that has never changed. What the room
  keeps here is the room's policy (`keepsHistory`, see
  [`ChatRoomPolicy`](ChatRoomPolicy.md)). It never holds `{ deleted: true }`
  (see [deleted messages](#deleted-messages)).
- **`replyTo`** is a [`ChatReply`](ChatReply.md): the message this one replies
  to, in the same room, and whether the reply is shown in the main conversation,
  in a thread, or both. Threads, and which messages the main conversation shows,
  are derived from it (see [`ChatReply`](ChatReply.md#threads)). A message
  without one is shown in the main conversation. It never changes.
- **`reactions`** holds each person's reactions to this message, as
  [`ChatReaction`](ChatReaction.md)s. A reaction belongs to its message, so it
  names no message of its own.

## Who wrote what

A message is written by more than one person, so its parts carry their own
labels and are admitted by their own writers:

- **The message**, meaning everything but `reactions`, is written by the room's
  `sendMessage`, `editMessage`, `deleteMessage`, and `obliterateMessage`
  streams, each admitted only as a trusted gesture on its own surface (see
  [`ChatRoomOutput`](ChatRoomOutput.md#streams)). Each version is labeled
  `authored-by` the principal who recorded it, so an obliterated message's
  tombstone is labeled with the OWNER who obliterated it.
- **Each reaction** is written only by the room's `sendReaction` and
  `deleteReaction` streams, as a trusted gesture on `ChatReactSurface`, and is
  labeled `authored-by` its reactor.

So a reaction never changes the message's own label, and a message's sender
can't write anyone's reactions. An implementation MUST keep the two apart:
reactions are a separately authorized part of the message, not fields the
message's writer can set.

## Obliterated messages

A message can be removed entirely, with its history, using the room's
`obliterateMessage` (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)): by an
OWNER curating a group room or a space's own chat, or by either person in a
direct room, for their own messages. A sender's `deleteMessage` does the same to
their own message where the implementation makes deletion obliteration. Whether
a sender deleting their own message obliterates it, and whether a room allows
OWNERs to obliterate at all, are left to the implementation
([`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior)). What is
left is a tombstone, kept so that replies to the message and a thread rooted at
it aren't orphaned:

- `body` is `{ deleted: true }`, and `editedAt` is when the room obliterated the
  message.
- `sentAt` and `replyTo` stay, so the message keeps its place in the
  conversation and in its thread, and its identity.
- `authorProfile`, `earlierVersions`, and `reactions` are gone. Nothing of what
  was said, or by whom, remains in the message.
- The tombstone is labeled `authored-by` whoever obliterated it. That label is
  the attestation of who removed the message.

A client tells an obliterated message from one its sender deleted by the absence
of `authorProfile`, and shows who removed it from the tombstone's label.

Obliterating a message removes it from the room's current state. Copies a client
kept, and whatever the space's storage keeps of earlier states, are beyond the
room's reach.

## Unique times

Every record a room makes has a time unique in that room: every message
version's time (each `sentAt`, each `editedAt`, and each `sentAt` in
`earlierVersions`), every reaction's `sentAt`, and every `recentActivity`
entry's `at` ([`ChatRoomActivity`](ChatRoomActivity.md)), across the main
conversation, every thread, and every message's history. One record keeps one
time, so a message's `sentAt` and its first earlier version's `sentAt` are the
same recording, not two.

Every recorded time is a
[`FabricEpochNsec`](../space-model-formal-spec/1-fabric-values.md): an exact
count of nanoseconds since the POSIX epoch, held as a `bigint`. When a new
record's time is one the room has already used, the room records it at the
smallest later time, in nanoseconds, that it hasn't used.

A bumped time stays within the end of the current clock tick (see
[`ChatRoomOutput`](ChatRoomOutput.md#recorded-times)). A one-second tick holds a
billion nanoseconds, so running out is not a concern at human timescales; if it
ever happened, the room would refuse the record, and a retry in a later tick
would record it. Making a record and choosing its time happen in one
transaction, so two records made at once can't both take the same time.

So within a room, a recorded time identifies its record: every message's
`sentAt` identifies the message, and every reaction's identifies the reaction.
The nanoseconds a bump adds are only for uniqueness: a client MUST NOT read a
recorded time as finer than the system's clock resolution.

## Identity

A message's identity is its entity: links to a message, such as a reply's, name
the entity. Its `sentAt` identifies it too, within its room (see [unique
times](#unique-times)). Clients MUST NOT make up ids from content or position.

## Deleted messages

A deleted message, whether deleted by its sender or obliterated, accepts nothing
further except obliteration. The room refuses, silently, an `editMessage`, a
`deleteMessage`, a `sendReaction`, or a `deleteReaction` on it, and a
`sendMessage` that replies to it. Replies it already had, and a thread rooted at
it, keep their links.

There is no undeletion, and no redacting a single earlier version. Obliteration
is the one way to remove a message's history, and it removes all of it.

So `{ deleted: true }` is only ever a message's current `body`, and never
appears in `earlierVersions`: a deleted message is never edited again, so its
deletion never becomes an earlier version.

Whether an edit keeps the version it replaces is the room's policy
(`keepsHistory`, see [`ChatRoomPolicy`](ChatRoomPolicy.md)).

## Future directions

Not part of this design, and not planned yet. They are recorded here so that the
shape above doesn't close them off.

- **Rich text.** A body with formatting, rather than plain text. The format has
  to render the same way in every client, since the rule that a person sends
  exactly what they saw applies to the formatting as much as to the words. A
  room's title could use the same format (see
  [`ChatRoomAbout`](ChatRoomAbout.md#future-directions)).
- **Attachments.** Images and other media sent with a message. An attachment
  would be linked rather than copied into the message, so it keeps its own label
  and is read under the reader's own access, as profiles are.
- **Links as items.** Links in a message held as items of their own rather than
  as text inside `body`: both web URLs and in-model links to cells in other
  spaces, including spaces served by other hosts (see [Common Fabric
  URLs](../fabric-urls.md)). An in-model link would carry its target's label
  across the space boundary, as every link in this design does. A client that
  shows a preview of a web link has to decide who fetches it, since fetching
  tells the linked site that someone is reading.
