# ChatIndexEntry

One room in a user's chat manager. A manager's `rooms` and `direct` hold these
([`ChatManagerOutput`](ChatManagerOutput.md)).

```ts
// Shown for illustration only.
interface ChatIndexEntry {
  /** The room, as a handle that declares nothing of it. */
  room: Cell<unknown>;

  kind: "direct" | "group";

  /** A direct room's other member, by principal. */
  counterpart?: string;

  /** When first listed for this user. */
  since: FabricEpochNsec;

  /** The room's title as the manager last read it; absent for none. */
  title?: string;

  /** The opaque revision of the membership. */
  revision?: string;
}
```

## Fields

- **`room`** links the room ([`ChatRoomOutput`](ChatRoomOutput.md)), as a
  handle that declares nothing of what it links: a link at a position typed
  `unknown`. A read of an entry, or of anything holding one, keeps the link and
  loads nothing in the room's space, so a list of entries costs the same
  whatever the rooms hold. A reader that reads the room reads it through a link
  that declares what it reads, under the reader's own access. A manager's own
  readers declare `about`; `messages.count` and `messages.newestAt`; and
  `roster`, from which the manager draws its `people`. A client subscribing to
  entries declares `room` the same way, as `{ type: "unknown", asCell: ["cell"]
  }`: a declaration with any shape of its own, even an object with no
  properties, makes every read of the entry load the room's root.
- **`kind`** is the room's own `about.kind`
  ([`ChatRoomAbout`](ChatRoomAbout.md)) as the handler that recorded the entry
  read it, so a client can list and filter rooms without reading each one. An
  entry for the chat a container declares holds that room's kind; what marks it
  as a container's is the membership's `container`.
- **`counterpart`** is set only for a direct room: the principal of its other
  member, which is the key `direct` is indexed by. It is a principal and not a
  profile, because a person can have several profiles, and one conversation with
  a person must not split along them. The manager records the one it verified
  when it created or accepted the room.
- **`since`** is the room's listing time for this user, recorded with its
  membership and preserved across forgetting and restoration: for a room the
  catalog lists when the membership is recorded, the catalog entry's admission
  time, so adopting a room leaves its place in the list, and otherwise the
  recording handler's clock, at whatever resolution the system provides (see
  the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).
- **`title`** is a hint: the room's `about.title` as the manager last read it,
  when it created, accepted or joined the room, or handled a `joinRoom` that no
  message or reaction sent, as a visit to the room sends. It is absent for a
  room with no title, and otherwise exactly the room's own, so an empty title
  and a title such as `"Chat"` both differ from none. A member's retitle runs in
  that member's runtime, which can't write this user's manager, so this user's
  hint changes once they next visit the room. A client that shows the room's
  current title reads it from the room.
- **`revision`** is the opaque token supplied by the manager's `rooms` view
  for the room's membership. A request to [`forget`](ChatManagerOutput.md) uses
  that listed entry's revision, so that a choice made since by another client
  is not overridden. Direct mappings and act outcomes may omit the revision even
  when the room is listed.

An entry is private to its user, like everything in the home space.
