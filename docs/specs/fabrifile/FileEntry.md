# FileEntry

One file in a store. A store's `entries` hold these
([`FileStoreOutput`](FileStoreOutput.md)).

```ts
// Shown for illustration only.
interface BlobRef {
  /** The DID of the space whose blob store holds the bytes. */
  space: string;

  /** The blob's id: `fid1:` and the hash of its name, media type and bytes. */
  id: string;
}

interface FileEntry {
  /** The name the store finds this file by. */
  name: string;

  /** The media type of the bytes, as the blob store keeps it. */
  mediaType: string;

  /** The blob holding the bytes. */
  blob: BlobRef;

  /** The size of the file, in bytes. */
  size: number;

  /** When the file was added. */
  addedAt: FabricEpochNsec;

  /** The profile of whoever added it. */
  addedBy: Cell<FileProfile>;

  /** When the file was removed from its store, if it has been. */
  removedAt?: FabricEpochNsec;
}

/** The part of a profile a store reads. */
interface FileProfile {
  name?: string;
  avatar?: string;
}
```

## Fields

- **`name`** is the name the store finds the entry by, unique within its store
  (see [names](#names)). It is always its blob's name too. It changes after
  the entry is added only through the store's `rename`, which changes `blob`
  with it.
- **`mediaType`** is the media type the blob was stored with. The blob's id
  hashes the media type together with the bytes, so a blob has exactly one, and
  an entry MUST name that one. A reader decides how to show a file from
  `mediaType` alone, without fetching it.
- **`blob`** names the bytes: the space whose blob store holds them, and the
  blob's id. The blob is stored under the entry's `name`, so a rename names a
  new blob, holding the same bytes and media type under the new name.
  `blob.space` is the store's own space (see
  [`FileStoreOutput`](FileStoreOutput.md#add)). A reader fetches the bytes from
  that space's blob store. An entry holds no URL: a URL depends on where the
  reader's runtime reaches the blob store, and a blob reference doesn't.
- **`size`** is the size of the file, in bytes, so a reader can show it, and
  decide whether to fetch, without fetching.
- **`addedAt`** comes from the clock of the handler that adds the entry, at
  whatever resolution the system provides (see the [timing side-channel
  mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)).
- **`addedBy`** links the profile of whoever added the file, which a rendering
  shows with `cf-profile-badge`. A store keeps no names or avatars of its own.
- **`removedAt`** is set when the store's `remove` takes the entry out of the
  store (see [removed entries](#removed-entries)).

`mediaType`, `size`, `addedAt` and `addedBy` are fixed when the entry is added,
and never change, and neither do the bytes `blob` names. A changed file is a new
entry.

## Names

A name is a single segment, chosen so that a program can write each entry of a
store as a file of that name in one directory, on the common file systems,
without changing it. A name:

- is between 1 and 255 bytes long, encoded as UTF-8, and is in Unicode
  Normalization Form C;
- holds no `/`, no `\`, no NUL, and no other control character (below U+0020,
  and U+007F);
- is not `.` or `..`, and doesn't start with `.`;
- doesn't end with a space or a `.`.

Two names that differ only in case are different names, and both MAY be in one
store. A program mirroring a store to a file system that ignores case MUST
detect the collision rather than let one file replace the other.

A name's last extension, the part after its last `.`, is not a media type. An
entry's media type is `mediaType`, whatever its name says.

## Removed entries

Removing a file takes its entry out of the store's `entries` and sets its
`removedAt`, in place. The entry's document stays, so a link to it, such as an
attachment's, still reads it, and finds it removed. A rendering of a link to a
removed entry SHOULD say that the file was removed, and SHOULD NOT fetch or show
its bytes.

The bytes stay in the blob store, which deletes nothing, and the blob reference
still fetches them, under the name the entry had last (see
[privacy](README.md#privacy)). A removed entry is never
restored: adding the same blob again makes a new entry.

## Who wrote what

An entry's `addedBy` is labeled `authored-by` the principal who added it, by
the one handler that writes the field, and the entry's write policy names the
store's own handlers as its only writers, so no other code can write it, even
code a member runs in the store's space. A rename writes the entry's `name` and
`blob`, never its `addedBy`, so the label goes on naming the adder, and the
store reads who added an entry from it.

## Identity

An entry is an object pushed onto the store's list, a document of its own,
identified by its cell. Anything that refers to a file, such as a chat message's
attachment, holds a link to the entry and compares two with `equals()`. Two
entries can have the same blob, a removed one and one added later under the
same name, and they are two files.

An entry is never identified by its name or by its blob, which both change
with a rename, and which a removed entry can share with a later one.
