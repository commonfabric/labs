# ChatAbout

Status: proposed design (see [`README.md`](README.md)).

What a room says about itself: its kind, its title, and when it was created. A
room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `about`, and sets it
once, when the room is created.

```ts
// Shown for illustration only.
interface ChatAbout {
  /** `"direct"` if created as a direct room; `"group"` otherwise. */
  kind: "direct" | "group";

  /** A group room's title. A direct room has none. */
  title?: string;

  /** When the room was created, in milliseconds since the epoch. */
  createdAt: number;
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

A space's own chat (see [shared spaces](README.md#shared-spaces)) is a group
room with no title, and a client shows it by the space's own name.

## Future directions

Not part of this design, and not planned yet:

- **A rich-text title.** A group room's `title` could be rich text rather than
  plain text, in the same format as rich-text message bodies (see
  [`ChatMessage`](ChatMessage.md#future-directions)) and under the same
  constraint: it renders the same way in every client, so every member sees the
  title that was set.
