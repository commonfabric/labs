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
- **`createdAt`** comes from the creating handler's clock, at its one-second
  resolution.

A space's own chat (see [shared spaces](README.md#shared-spaces)) is a group
room with no title, and a client shows it by the space's own name.
