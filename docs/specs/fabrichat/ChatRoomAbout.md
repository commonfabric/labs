# ChatRoomAbout

What a room says about itself: its kind, its title, when it was created, and its
policy. A room ([`ChatRoomOutput`](ChatRoomOutput.md)) offers one, as `about`,
and sets it when the room is created. Its `title` is the one part that changes:
any member who can write in the room sets it, through the room's
[`setTitle`](ChatRoomOutput.md#settitlerequestid-string-title-string). The rest
never changes, and its `policy` is a link to a document of its own, which can
(see [`ChatRoomPolicy`](ChatRoomPolicy.md#when-it-changes)).

```ts
// Shown for illustration only.
interface ChatRoomAbout {
  /** `"direct"` if created as a direct room; `"group"` otherwise. */
  kind: "direct" | "group";

  /**
   * The room's title, which every member shares: the one a member last set,
   * or else the one the room was created with.
   */
  title?: string;

  /** When the room was created. */
  createdAt: FabricEpochNsec;

  /** The room's policy, stated correctly, in a document of its own. */
  policy: Cell<ChatRoomPolicy>;

  /** What the room's creator wrote, labeled with them; see below. */
  record?: Cell<{
    kind: "direct" | "group";
    title?: string;
    createdAt: FabricEpochNsec;
  }>;
}
```

- **`kind`** says how the room was created, not how many members it has, and
  never changes. A direct room's membership is decided at creation, and it is
  what the manager finds by the other member's principal
  ([`ChatManagerOutput`](ChatManagerOutput.md)). A group room can gain and lose
  members.
- **`title`** is the room's title, which every member shares and any member who
  can write in the room changes, in a group room or a direct one (see
  [`setTitle`](ChatRoomOutput.md#settitlerequestid-string-title-string)). It is
  the title a member last set, or, until one does, the title the room was
  created with, which `record` keeps. A group room is created with a title, and
  a direct room without one. A client shows a direct room that has no title by
  its other member, read from that member's profile
  ([`ChatProfile.md`](ChatProfile.md)), so it follows changes to the member's
  name.
- **`createdAt`** comes from the handler clock, at whatever resolution the
  system provides (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).
- **`policy`** links a [`ChatRoomPolicy`](ChatRoomPolicy.md): how the room
  behaves where its implementation decides. An implementation MUST state it
  correctly.

A chat created with an existing social space, rather than by a manager (see
[social spaces](README.md#social-spaces)), is a group room with no title, and a
client shows it by the space's own name.

## Who created the room

`about.record` links the record its creator wrote as the room was created: its
`kind`, `title`, and `createdAt`, stored as `AuthoredByCurrentUser` the one
handler that writes it, so the runtime labels it `authored-by` the principal who
created the room, as it labels a message with its sender. The record never
changes, so the label stays the creator's, and its `title` stays the one the
room was created with: the things about a room that can change are documents of
their own, with labels of their own. `policy` is one. The title a member sets is
another, labeled `authored-by` the member who set it, and `about.title` reads it
ahead of the record's. The creator's label is the authority on who created a
room. A notice's claim of who sent it is not (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). For a direct
room, the label names the counterpart of the member who didn't create it. A
space's own chat, which nobody created as a room, has no record.

Pattern code reads the label's principal with
`principalOf(about.record, "authored-by")`
([the principal a label attests](../../features/principal-of.md)), and host
code through the runtime client, as `cf-cfc-authorship` does for messages. So a
client checks a direct room's creator before it sends `accept` (see
[`clients.md`](clients.md#finding-conversations)), and the manager checks it
again when it acts on one.

## Future directions

Not part of this design, and not planned yet:

- **A rich-text title.** A group room's `title` could be rich text rather than
  plain text, in the same format as rich-text message bodies (see
  [`ChatMessage`](ChatMessage.md#future-directions)) and under the same
  constraint: it renders the same way in every client, so every member sees the
  title that was set.
