# ChatIndexEntry

One room in a user's chat manager. A manager's `rooms` and `direct` hold these
([`ChatManagerOutput`](ChatManagerOutput.md)).

```ts
// Shown for illustration only.
interface ChatIndexEntry {
  /** The room. */
  room: Cell<ChatRoomOutput>;

  kind: "direct" | "group";

  /** A direct room's other member, by principal. */
  counterpart?: string;

  /** When this user's index admitted it. */
  since: FabricEpochNsec;
}
```

## Fields

- **`room`** links the room ([`ChatRoomOutput`](ChatRoomOutput.md)). An entry is
  a link and never a copy: what a room holds is read from the room, under the
  reader's own access. The link declares the part of the room a manager reads
  through it: `about`, and `messages.count` and `messages.newestAt`, which say
  how many messages the room holds and when the newest was sent. Those are
  what the room's space shares with every member, derived from the room's
  messages alone. The rest of the room's output, its `canSend` decided per
  reader, its `messages.windows` kept per session, and its `messages.latest`,
  which holds up to `maxWindowCount` messages, is read from the room itself:
  the link's schema is part of every manager handler's declared reads, and a
  served handler whose declared reads reach a member's own documents never
  runs.
- **`kind`** repeats the room's own `about.kind`
  ([`ChatRoomAbout`](ChatRoomAbout.md)), so a client can list and filter rooms
  without reading each one.
- **`counterpart`** is set only for a direct room: the principal of its other
  member, which is the key `direct` is indexed by. It is a principal and not a
  profile, because a person can have several profiles, and one conversation with
  a person must not split along them.
- **`since`** is when the room entered this user's index: when they created or
  accepted it, or when the room offered to them was admitted. It comes from the
  clock of the handler that admitted it, at whatever resolution the system
  provides (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).

An entry is private to its user, like everything in the home space.
