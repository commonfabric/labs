# FileStoreOutput

The result of a space's file store: what the space root's `fileStore` link
resolves to. It is the contract clients read, and it is named for the role
rather than for an implementation. [`FileStore`](FileStore.md) is an
implementation of it: its result satisfies `FileStoreOutput`, and another
pattern that satisfies it can fill the same role. Everything in this document
binds every implementation.

```ts
// Shown for illustration only.
interface FileStoreOutput {
  /** Every file in the store, in the order they were added. */
  entries: Cell<FileEntry>[];

  /** The same files, by name. */
  byName: Record<string, Cell<FileEntry>>;

  /** The outcome of each request, by its `requestId`. */
  requests: Record<
    string,
    | { status: "done"; entry: Cell<FileEntry>; name: string }
    | {
      status: "refused";
      reason: string;
      code?:
        | "invalid-request"
        | "invalid-name"
        | "name-taken"
        | "other-space"
        | "no-blob"
        | "not-found"
        | "not-permitted";
    }
  >;

  add: Stream<{
    requestId?: string;
    name: string;
    mediaType: string;
    blob: BlobRef;
    size: number;
    onConflict?: "refuse" | "rename";
  }>;
  remove: Stream<{ requestId?: string; entry: Cell<FileEntry> }>;
  rename: Stream<{
    requestId?: string;
    entry: Cell<FileEntry>;
    name: string;
    onConflict?: "refuse" | "rename";
  }>;

  [VIEWS]: { files: object };
}
```

Principals are DIDs throughout.

## Where the role lives

A space has at most one store, which its root names with a `fileStore` link
(see [`FileStore.md`](FileStore.md#where-it-lives)). A pattern in the space
reaches it through the root, `wish({ query: "#default" })`, and a client through
the root it already reads. Something that refers to a file in another space,
such as an attachment, links the entry itself, and never needs that space's
store.

A store's files are as private as its space: a reader its space's access list
refuses reads nothing of the store. The bytes are a different matter (see
[privacy](README.md#privacy)).

## Views

The store offers its facts and streams as a `[VIEWS]` group, `files`, for hosts
that draw natively: `entries`, `byName` and `requests`, and every stream below.
A native client drives the store through that group, and never needs the
store's view (see [`clients.md`](clients.md)).

## Scopes

`entries` and `requests` are `PerSpace` in the store's space (see
[scopes](../scoped-cell-instances.md#summary)), shared by everyone the space
admits. `byName` is derived from `entries`, and reads nothing that differs
between readers, so it is the same for every reader too.

## Facts

- **`entries`** holds a link to every [`FileEntry`](FileEntry.md) in the store,
  in the order they were added. A removed entry is not in it. A client sorts
  the entries however it shows them.
- **`byName`** holds the same entries, each under its name. It is how a store
  finds a file by its name. Names are unique within a store, so it holds each
  entry exactly once.
- **`requests`** records each request's outcome under its `requestId`: `done`,
  with the entry it added or changed and the name the request gave it, or
  `refused`, with a reason, prose for a
  person, and a `code` a client can act on, which stays the same whatever the
  reason says. An implementation MAY discard an outcome after a retention period
  it documents.

## Streams

Each stream is a one-way, asynchronous request to the store. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value. A sender that needs the outcome names a `requestId` and watches for it
in `requests`. A request with no `requestId` is recorded under the event's own
key (`eventKey()`).

These rules hold for every stream:

- A request from a principal the store's space doesn't admit with WRITE or
  OWNER is not admitted, and records no outcome.
- An admitted request missing a key its stream needs, or naming a key of the
  wrong type, is refused, with `code: "invalid-request"` and a reason that says
  which, rather than ignored.
- A request sent again with the same `requestId` changes nothing, and its
  outcome stays the one first recorded.
- Every stream changes only this store.

| Stream | Effect |
| --- | --- |
| [`add`](#add) | a new entry, for a blob already in the store's space |
| [`remove`](#remove) | the entry taken out of the store, and marked removed |
| [`rename`](#rename) | the entry's name changed, and its blob with it |

### `add`

`add(requestId?: string, name: string, mediaType: string, blob: BlobRef, size:
number, onConflict?: "refuse" | "rename")`

- `name: string` — The new entry's name. A name that isn't valid (see
  [names](FileEntry.md#names)) is refused, with `code: "invalid-name"`.
- `mediaType: string` — The media type the blob was stored with.
- `blob: BlobRef` — The blob holding the bytes, stored under `name`. A
  `blob.space` other than the store's own space is refused, with
  `code: "other-space"`.
- `size: number` — The size of the file, in bytes.
- `onConflict` — What to do when `name` is taken. With `"refuse"`, the default,
  the request is refused, with `code: "name-taken"`. With `"rename"`, the store
  adds the entry under the first of `name (2)`, `name (3)`, and so on that is
  free, with the number before the name's last extension: `photo.png` becomes
  `photo (2).png`. A client adding a file whose name a person didn't choose,
  such as a pasted image, uses `"rename"`.

The outcome's `name` is the name the entry was added under. It differs from the
request's `name` exactly when the store chose a free one, so a client learns
what became of its file from the outcome alone, without reading the entry, whose
name a later `rename` can change. A client that tells a person where their file
went names a `requestId`, since it can't know the event's own key.

When the entry's name is not the name its blob was stored under, because the
store chose a free one, or because the client stored the blob with no name, the
store stores the blob's bytes and media type again under the entry's name, and
the entry names that blob (see [`FileStore`](FileStore.md#writers)). An
entry's blob always carries the entry's name.

The store adds an entry with the request's fields, `addedAt` from the handler's
clock, and `addedBy` the adder's profile, `wish({ query: "#profile" })`. An
adder with no profile is refused, with `code: "not-permitted"`, so that no file
is stored unattributed. The outcome's `entry` links the new entry.

A blob the store's space does not hold is refused, with `code: "no-blob"`.
Beyond that, the store takes `blob`, `mediaType` and `size` as the request
states them, and can't yet check the media type or the size against the blob
store (see [prerequisites](README.md#prerequisites)). A client MUST name the
blob it stored, with the name, media type and size it stored.

### `remove`

`remove(requestId?: string, entry: Cell<FileEntry>)`

- `entry` — The entry to remove. One not in `entries` is refused, with
  `code: "not-found"`.

Only the entry's adder, or a principal the store's space admits as OWNER, may
remove it. Anyone else is refused, with `code: "not-permitted"`. The store takes
the entry out of `entries` and sets its `removedAt` (see
[removed entries](FileEntry.md#removed-entries)). The bytes stay in the blob
store.

### `rename`

`rename(requestId?: string, entry: Cell<FileEntry>, name: string, onConflict?:
"refuse" | "rename")`

- `entry` — The entry to rename. One not in `entries` is refused, with
  `code: "not-found"`.
- `name` and `onConflict` — As for [`add`](#add). Renaming an entry to its own
  name changes nothing, and is `done`. The outcome's `name` is the name the
  entry was given, as for `add`.

Only the entry's adder, or a principal the store's space admits as OWNER, may
rename it. Anyone else is refused, with `code: "not-permitted"`, and an entry
whose blob the space no longer holds with `code: "no-blob"`.

The store stores the entry's bytes and media type again, as a blob under the new
name, and changes the entry's `name` and `blob` together, in one transaction.
The client sends only the new name: the new blob is the store's business, and a
person sees only the rename. The blob the entry named before stays in the blob
store (see [privacy](README.md#privacy)).
