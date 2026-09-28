# FabriChatMessage

Status: proposed design (see [`README.md`](README.md)).

One message in a room ([`FabriChatRoom.md`](FabriChatRoom.md)). A room keeps
its messages, oldest first, as `messages`.

```ts
// Shown for illustration only.
interface FabriChatMessage {
  /** The profile the sender sent under. */
  authorProfile: Cell<FabriChatProfile>;

  body: string;

  /**
   * When the message was sent, in milliseconds since the epoch, at the
   * one-second resolution a handler's clock has.
   */
  sentAt: number;

  /** The message this one replies to, in this room; absent for none. */
  replyTo?: Cell<FabriChatMessage>;
}
```

A message is stored as
`AuthoredByCurrentUser<TrustedActionWrite<FabriChatMessage, …>>`: the runtime
labels it `authored-by` the principal who sent it, and admits it only from
`commitSend` on the room's send surface (see
[`FabriChatRoom.md`](FabriChatRoom.md#writers)).

## Fields

- **`authorProfile`** links the sender's profile
  ([`FabriChatProfile.md`](FabriChatProfile.md)). It is the only way a message
  names its sender. A message stores no name or avatar: a client reads them
  from the profile when it draws, so a person's history shows their current
  name. The link is a claim, since a sender could link any profile. The
  message is verified when the principal in its `authored-by` label is the one
  the profile represents.
- **`body`** is the text, as the person saw it when they sent it. It is never
  empty.
- **`sentAt`** comes from the sending handler's clock.
- **`replyTo`** links another message in the same room, so a reply keeps its
  target's identity and label. A client builds threads from it. A reply MUST
  name a message in the same room.

## Identity

A message's identity is its entity. Clients MUST use the entity as the
message's id, and MUST NOT make up ids from content or position.

A message is never edited or deleted (see [`README.md`](README.md#decisions)).
