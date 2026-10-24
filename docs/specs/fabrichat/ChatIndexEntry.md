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

  /** When first listed for this user, using catalog admission for discovery. */
  since: FabricEpochNsec;

  /** The opaque revision of the membership or discovery source. */
  revision?: string;
}
```

## Fields

- **`room`** links the room ([`ChatRoomOutput`](ChatRoomOutput.md)). An entry is
  a link and never a copy: what a room holds is read from the room, under the
  reader's own access. The link declares the part of the room a manager reads
  through it: `about`; `messages.count` and `messages.newestAt`, which say how
  many messages the room holds and when the newest was sent; and `roster`, the
  profiles of those who joined it, from which the manager draws its `people`.
  Those are what the room's space holds at space scope, and cost little to
  read: the first two are derived from the room's messages alone, and `roster`
  holds each profile as a link, which the declaration doesn't follow. The rest
  of the room's output, its `canSend` decided per reader, its
  `messages.latest`, which holds up to `maxWindowCount` messages, and its
  `participants`, which reads every message for its authors,
  is read from the room itself: the link's schema is part of every manager
  handler's declared reads, and a served handler whose run reads a per-user or
  per-session instance in a space other than its own fails. That is a limit of
  scope and not of access: the runtime serving the manager reads the room's
  space with its owner's access
  ([`serverExecution`](../../development/EXPERIMENTAL_OPTIONS.md#serverexecution)).
- **`kind`** repeats the room's own `about.kind`
  ([`ChatRoomAbout`](ChatRoomAbout.md)), so a client can list and filter rooms
  without reading each one.
- **`counterpart`** is set only for a direct room: the principal of its other
  member, which is the key `direct` is indexed by. It is a principal and not a
  profile, because a person can have several profiles, and one conversation with
  a person must not split along them.
- **`since`** is the room's listing time for this user. Discovery uses the
  source catalog entry's admission time; explicit membership uses its first
  recorded join time, preserved across forgetting and restoration. It comes
  from the corresponding handler's clock, at whatever resolution the system
  provides (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).
- **`revision`** is the opaque token supplied by the manager's `rooms` view
  for the room's individual membership or discovery source. A request to
  [`forget`](ChatManagerOutput.md) uses that listed entry's revision, so that a
  choice made since by another client is not overridden. Direct mappings and
  act outcomes may omit the revision even when the room is listed.

An entry is private to its user, like everything in the home space.
