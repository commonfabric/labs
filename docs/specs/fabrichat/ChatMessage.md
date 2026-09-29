# ChatMessage

Status: proposed design (see [`README.md`](README.md)).

One message in a room ([`ChatRoomOutput`](ChatRoomOutput.md)), with its
reactions and its edit history. A room offers its messages, oldest first, as
`messages`.

```ts
// Shown for illustration only.
interface ChatMessage {
  /** The profile the sender sent under. */
  authorProfile: Cell<ChatProfile>;

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
  represents.
- **`body`** is the current version's text, as the person saw it when they sent
  or edited it. Text is never empty. A deleted message's body is exactly the
  plain object `{ deleted: true }`, with no other keys.
- **`sentAt`** is the time the room recorded for the message's first version.
  The sender's client proposes a time with the message, and the room records
  that proposal if it finds it plausible, possibly adjusted, and otherwise its
  own handler clock (see [`ChatRoomOutput`](ChatRoomOutput.md#recorded-times)).
  The handler clock is close to when the person sent the message when the room's
  handler runs in the sender's own runtime, and later when it runs elsewhere,
  since an event carries no time of its own apart from the proposal. The clock's
  resolution is the system's to set (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)), and a client MUST NOT
  assume a finer one. See also [unique times](#unique-times).
- **`editedAt`** is the time the room recorded for the current version, whether
  an edit or a deletion: for an edit, chosen from the sender's proposal and the
  handler clock as for `sentAt`, and for a deletion, the handler clock. It is
  absent until the message is first edited or deleted.
- **`earlierVersions`** holds each version the message had before its current
  one, as a [`ChatMessageVersion`](ChatMessageVersion.md): its body and when it
  was recorded. It is empty for a message that has never changed. What the room
  keeps here is a policy question (see [open questions](#open-questions)).
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
  `sendMessage`, `editMessage`, and `deleteMessage` streams, each admitted only
  as a trusted gesture on its own surface (see
  [`ChatRoomOutput`](ChatRoomOutput.md#streams)). Each version is labeled
  `authored-by` the principal who recorded it.
- **Each reaction** is written only by the room's `sendReaction` and
  `deleteReaction` streams, as a trusted gesture on `ChatReactSurface`, and is
  labeled `authored-by` its reactor.

So a reaction never changes the message's own label, and a message's sender
can't write anyone's reactions. An implementation MUST keep the two apart:
reactions are a separately authorized part of the message, not fields the
message's writer can set.

## Unique times

Every record a room makes has a time unique in that room: every message
version's time (each `sentAt`, each `editedAt`, and each `sentAt` in
`earlierVersions`) and every reaction's `sentAt`, across the main conversation,
every thread, and every message's history. One record keeps one time, so a
message's `sentAt` and its first earlier version's `sentAt` are the same
recording, not two.

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

## Open questions

Editing and deleting leave policy choices that this design hasn't made:

- **Who may edit or delete.** The streams admit only the message's sender. A
  room's OWNERs removing others' messages, for moderation, is a separate
  decision.
- **What an edit keeps.** Whether every edit adds its previous version to
  `earlierVersions`, or only some do, and whether history is kept at all.
- **What a deletion keeps.** Whether deleting a message also clears its
  `earlierVersions`, replacing each earlier body with `{ deleted: true }` or
  dropping them, so that deleted text doesn't survive in history. A deleted
  version in `earlierVersions` is also how a message that was deleted and then
  edited again would show its deletion.
- **Deleting a single earlier version.** Whether a sender can redact one version
  in `earlierVersions` without deleting the message.
- **Reactions and replies.** Whether a deleted message keeps its reactions, and
  can take new ones or new replies. A reply to it, and a thread rooted at it,
  still link to it either way.
- **Labels on moved text.** Recording an edit writes the previous body into
  `earlierVersions` from the editor's handler, which labels it with the editor.
  That is the original author only as long as only senders edit.

## Future directions

Not part of this design, and not planned yet. They are recorded here so that the
shape above doesn't close them off.

- **Rich text.** A body with formatting, rather than plain text. The format has
  to render the same way in every client, since the rule that a person sends
  exactly what they saw applies to the formatting as much as to the words. A
  room's title could use the same format (see
  [`ChatAbout`](ChatAbout.md#future-directions)).
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
