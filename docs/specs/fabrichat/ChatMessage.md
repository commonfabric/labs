# ChatMessage

Status: proposed design (see [`README.md`](README.md)).

One message in a room ([`ChatRoomOutput`](ChatRoomOutput.md)). A room offers its
messages, oldest first, as `messages`.

```ts
// Shown for illustration only.
interface ChatMessage {
  /** The profile the sender sent under. */
  authorProfile: Cell<ChatProfile>;

  body: string;

  /**
   * When the message was sent, in milliseconds since the epoch, at the
   * one-second resolution a handler's clock has.
   */
  sentAt: number;

  /** What this message replies to, and where it is shown; absent for none. */
  replyTo?: ChatReply;
}
```

A message is stored as `AuthoredByCurrentUser<TrustedActionWrite<ChatMessage,
…>>`: the runtime labels it `authored-by` the principal who sent it, and admits
it only through the room's `sendMessage` stream, as a trusted gesture on
`ChatSendSurface` (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)).

## Fields

- **`authorProfile`** links the sender's profile
  ([`ChatProfile.md`](ChatProfile.md)). It is the only way a message names its
  sender. A message stores no name or avatar: a client reads them from the
  profile when it draws, so a person's history shows their current name. The
  link is a claim, since a sender could link any profile. The message is
  verified when the principal in its `authored-by` label is the one the profile
  represents.
- **`body`** is the text, as the person saw it when they sent it. It is never
  empty.
- **`sentAt`** comes from the sending handler's clock.
- **`replyTo`** is a [`ChatReply`](ChatReply.md): the message this one replies
  to, in the same room, and whether the reply is shown in the main conversation,
  in a thread, or both. Threads, and which messages the main conversation shows,
  are derived from it (see [`ChatReply`](ChatReply.md#threads)). A message
  without one is shown in the main conversation.

## Identity

A message's identity is its entity. Clients MUST use the entity as the message's
id, and MUST NOT make up ids from content or position.

A message is never edited or deleted (see [`README.md`](README.md#decisions)).

## Future directions

Not part of this design, and not planned yet. They are recorded here so that the
shape above doesn't close them off.

- **Rich text.** A body with formatting, rather than plain text. The format has
  to render the same way in every client, since the rule that a person sends
  exactly what they saw applies to the formatting as much as to the words.
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
