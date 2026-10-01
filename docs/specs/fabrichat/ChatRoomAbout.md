# ChatRoomAbout

What a room says about itself: its kind, its title, when it was created, and its
policy. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `about`,
and sets it once, when the room is created. It never changes: its `policy` is a
link to a document of its own, which can (see
[`ChatRoomPolicy`](ChatRoomPolicy.md#when-it-changes)).

```ts
// Shown for illustration only.
interface ChatRoomAbout {
  /** `"direct"` if created as a direct room; `"group"` otherwise. */
  kind: "direct" | "group";

  /** A group room's title. A direct room has none. */
  title?: string;

  /** When the room was created. */
  createdAt: FabricEpochNsec;

  /** The room's policy, stated correctly, in a document of its own. */
  policy: Cell<ChatRoomPolicy>;
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
- **`policy`** links a [`ChatRoomPolicy`](ChatRoomPolicy.md): how the room
  behaves where its implementation decides. An implementation MUST state it
  correctly.

A chat created with an existing shared space, rather than by a manager (see
[shared spaces](README.md#shared-spaces)), is a group room with no title, and a
client shows it by the space's own name.

## Who created the room

`about` is stored as `AuthoredByCurrentUser<ChatRoomAbout>`: the runtime labels
it `authored-by` the principal who created the room, as it labels a message with
its sender. `about` never changes, so the label stays the creator's: `policy`,
the one thing about a room that can change, is a document of its own, with
labels of its own. That label is the authority on who created a room. A notice's
claim of who sent it is not (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). For a direct
room, the label names the counterpart of the member who didn't create it.

A client checks a direct room's creator through the runtime's label view before
it sends `accept` (see [`clients.md`](clients.md#finding-conversations)). The
manager verifies the same claim with `principalOf(room.about, "authored-by")`;
[principal label reading](../../features/principal-of.md) describes that call.
A missing or ambiguous creator claim cannot establish a direct counterpart.

## Future directions

Not part of this design, and not planned yet:

- **A rich-text title.** A group room's `title` could be rich text rather than
  plain text, in the same format as rich-text message bodies (see
  [`ChatMessage`](ChatMessage.md#future-directions)) and under the same
  constraint: it renders the same way in every client, so every member sees the
  title that was set.
