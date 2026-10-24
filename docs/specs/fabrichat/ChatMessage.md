# ChatMessage

One message in a room ([`ChatRoomOutput`](ChatRoomOutput.md)), with its
attachments and its reactions. A client reads a room's newest messages from its
[`ChatMessageList`](ChatMessageList.md), and the rest from the stored messages
themselves.

```ts
// Shown for illustration only.
interface ChatMessage {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: Cell<ChatProfile>;

  /**
   * The current text, empty only where the message has attachments, or the
   * marker of a deleted message.
   */
  body: string | { deleted: true };

  /**
   * The files sent with the message, in the order they were sent; absent for
   * none, and once the message is deleted.
   */
  attachments?: Cell<FileEntry>[];

  /** The room's handler clock when it recorded the message. */
  sentAt: FabricEpochNsec;

  /**
   * The room's handler clock at the latest edit or deletion; absent until the
   * message is first edited or deleted.
   */
  editedAt?: FabricEpochNsec;

  /** What this message replies to, and where it is shown; absent for none. */
  replyTo?: ChatReply;

  /**
   * Everyone's reactions to this message, in the order they were added;
   * absent once the message is deleted.
   */
  reactions?: ChatReaction[];
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
  or edited it. Text is empty only in a message with attachments, such as a
  photo sent on its own. A deleted message's body is exactly the plain object
  `{ deleted: true }`, with no other keys.
- **`attachments`** links the files sent with the message, each a
  [`FileEntry`](../fabrifile/FileEntry.md) of the store of the room's space,
  in the order they were sent, and no more of them than the room's
  `maxAttachments` (see [`ChatRoomPolicy`](ChatRoomPolicy.md#keys)). A message
  links an entry rather than copying it, so a reader reads the file's name, its
  media type and its blob through the link, under their own access, and learns
  of a rename or a removal (see [attaching a
  file](../fabrifile/clients.md#attaching-a-file)). It never changes, and it is
  absent from a message with none, and once the message is deleted.
- **`sentAt`** is the room's handler clock when it recorded the message (see
  [times](#times)).
- **`editedAt`** is the room's handler clock when it recorded the current
  text, or the deletion. It is absent until the message is first edited or
  deleted.
- **`replyTo`** is a [`ChatReply`](ChatReply.md): the message this one replies
  to, in the same room, and whether the reply is shown in the main conversation,
  in a thread, or both. Threads, and which messages the main conversation shows,
  are derived from it (see [`ChatReply`](ChatReply.md#threads)). A message
  without one is shown in the main conversation. It never changes.
- **`reactions`** holds each person's reactions to this message, as
  [`ChatReaction`](ChatReaction.md)s, in the order they were added. A reaction
  belongs to its message, so it names no message of its own. It is absent once
  the message is deleted.

## Who wrote what

A message is written by more than one person, so its parts carry their own
labels and are admitted by their own writers:

- **The message**, meaning everything but `reactions`, is written by the
  room's `sendMessage`, `editMessage`, `deleteMessage`, and
  `obliterateMessage` streams, each admitted only as a trusted gesture on its
  own surface (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)). Each
  version is labeled `authored-by` the principal who recorded it, so an
  obliterated message's tombstone is labeled with whoever obliterated it. Its
  attachments are links the message holds, so they carry the message's label;
  each file they link is an entry of its store, labeled and written as the
  store's own (see [`FileEntry`](../fabrifile/FileEntry.md)).
- **Each reaction** is written only by the room's `sendReaction` and
  `deleteReaction` streams, as a trusted gesture on `ChatReactSurface`, and is
  labeled `authored-by` its reactor.

So a reaction never changes the message's own label, and a message's sender
can't write anyone's reactions. An implementation MUST keep the two apart:
reactions are a separately authorized part of the message, not fields the
message's writer can set. [`FabriChatRoom`](FabriChatRoom.md#writers) keeps
them as a list of their own, which the message links.

## Obliterated messages

A message can be removed entirely, with its history, using the room's
`obliterateMessage` (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)): by an
OWNER of the room's space curating the conversation, where the room's policy
lets OWNERs obliterate, or by either person in a direct room, for their own
messages. A sender's `deleteMessage` does the same to their own message where
the implementation makes deletion obliteration. Whether a sender deleting their
own message obliterates it, and whether a room lets its OWNERs obliterate, are
left to the implementation
([`ChatRoomOutput`](ChatRoomOutput.md#implementation-defined-behavior)). What is
left is a tombstone, kept so that replies to the message and a thread rooted at
it aren't orphaned:

- `body` is `{ deleted: true }`, and `editedAt` is when the room obliterated the
  message.
- `sentAt` and `replyTo` stay, so the message keeps its place in the
  conversation and in its thread, and its identity.
- `authorProfile`, `attachments` and `reactions` are gone. Nothing of what was
  said, or by whom, remains in the message.
- The tombstone is labeled `authored-by` whoever obliterated it. That label is
  the attestation of who removed the message.

A client tells an obliterated message from one its sender deleted by the absence
of `authorProfile`, and shows who removed it from the tombstone's label.

Obliterating a message removes it from the room's current state. Copies a client
kept, the reactions the message no longer links, and whatever the space's
storage keeps of earlier states, are beyond the room's reach.

## Times

Every time a room records, a message's `sentAt` and `editedAt` and a
reaction's `sentAt`, is the room's handler clock when it made the record: the
time of the event that set the handler running (see the [timing side-channel
mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)), at whatever resolution
the system provides, and a client MUST NOT assume a finer one. When the
handler runs in the sender's own runtime, it is the sender's clock. Nothing
is unique about a recorded time: two messages can carry the same `sentAt`,
and a time identifies nothing.

Every recorded time is a
[`FabricEpochNsec`](../space-model-formal-spec/1-fabric-values.md): an exact
count of nanoseconds since the POSIX epoch, held as a `bigint`.

## Identity

A message's identity is its entity: links to a message, such as a reply's, name
the entity, and two links to a message are compared with `equals()`. Clients
MUST NOT make up ids from content, time, or position.

## Deleted messages

A deleted message, whether deleted by its sender or obliterated, accepts nothing
further except obliteration. The room refuses an `editMessage`, a
`sendReaction`, or a `deleteReaction` on it, a `deleteMessage` on it changes
nothing, and a client sends no reply to it. Replies it already had, and a thread rooted at it, keep
their links.

There is no undeletion. A message keeps no history: an edit replaces its text,
and a deletion drops it with the message's attachments, so nothing of what a
message said before remains in the room. A deletion takes no file out of its
store: an attachment's entry stays there, and anyone else linking it still
reads it.

## Future directions

Not part of this design, and not planned yet. They are recorded here so that the
shape above doesn't close them off.

- **Rich text.** A body with formatting, rather than plain text. The format has
  to render the same way in every client, since the rule that a person sends
  exactly what they saw applies to the formatting as much as to the words. A
  room's title could use the same format (see
  [`ChatRoomAbout`](ChatRoomAbout.md#future-directions)).
- **Links as items.** Links in a message held as items of their own rather than
  as text inside `body`: both web URLs and in-model links to cells in other
  spaces, including spaces served by other hosts (see [Common Fabric
  URLs](../fabric-urls.md)). An in-model link would carry its target's label
  across the space boundary, as every link in this design does. A client that
  shows a preview of a web link has to decide who fetches it, since fetching
  tells the linked site that someone is reading.
