# ChatIndexEntry

Status: proposed design (see [`README.md`](README.md)).

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

  /** When this user created or accepted it, in milliseconds since the epoch. */
  since: number;
}
```

## Fields

- **`room`** links the room ([`ChatRoomOutput`](ChatRoomOutput.md)). An entry is
  a link and never a copy: what a room holds is read from the room, under the
  reader's own access.
- **`kind`** repeats the room's own `about.kind` ([`ChatAbout`](ChatAbout.md)),
  so a client can list and filter rooms without reading each one.
- **`counterpart`** is set only for a direct room: the principal of its other
  member, which is the key `direct` is indexed by. It is a principal and not a
  profile, because a person can have several profiles, and one conversation with
  a person must not split along them.
- **`since`** comes from the manager's handler clock.

An entry is private to its user, like everything in the home space.
