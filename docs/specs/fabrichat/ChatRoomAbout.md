# ChatRoomAbout

Status: proposed design (see [`README.md`](README.md)).

What a room says about itself: its kind, its title, when it was created, and its
policy. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `about`,
and sets it when the room is created. Only its `policy` can change after that
(see [`ChatRoomPolicy`](ChatRoomPolicy.md#when-it-changes)).

```ts
// Shown for illustration only.
interface ChatRoomAbout {
  /** `"direct"` if created as a direct room; `"group"` otherwise. */
  kind: "direct" | "group";

  /** A group room's title. A direct room has none. */
  title?: string;

  /** When the room was created. */
  createdAt: FabricEpochNsec;

  /** The room's policy, stated correctly. */
  policy: ChatRoomPolicy;
}
```

- **`kind`** says how the room was created, not how many members it has, and
  never changes. A direct room's membership is decided at creation, and it is
  what the manager finds by the other member's principal
  ([`ChatManagerOutput`](ChatManagerOutput.md)). A group room can gain and lose
  members.
- **`title`** is only for group rooms. A client shows a direct room by its other
  member, read from that member's profile ([`ChatProfile.md`](ChatProfile.md)),
  so it follows changes to the member's name.
- **`createdAt`** comes from the handler clock, at whatever resolution the
  system provides (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).
- **`policy`** is a [`ChatRoomPolicy`](ChatRoomPolicy.md): how the room behaves
  where its implementation decides. An implementation MUST state it correctly.

A space's own chat (see [shared spaces](README.md#shared-spaces)) is a group
room with no title, and a client shows it by the space's own name.

## Who created the room

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`: the runtime labels
it `authored-by` the principal who created the room, as it labels a message with
its sender. Since `policy` can be rewritten later by whoever changes the room's
settings, the label that counts is the one on `about`'s other fields, which
never change. That label is the authority on who created a room. A notice's
claim of who sent it is not (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). For a direct
room, the label names the counterpart of the member who didn't create it, which
is what `accept` checks
([`ChatManagerOutput`](ChatManagerOutput.md#acceptrequestid-string-room-cellchatroomoutput-counterpart-string)).
A pattern reads a stored label as the `loom` pattern reads a panel's adder
(`packages/patterns/loom/README.md`).

## Future directions

Not part of this design, and not planned yet:

- **A rich-text title.** A group room's `title` could be rich text rather than
  plain text, in the same format as rich-text message bodies (see
  [`ChatMessage`](ChatMessage.md#future-directions)) and under the same
  constraint: it renders the same way in every client, so every member sees the
  title that was set.
