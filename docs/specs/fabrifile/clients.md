# FabriFile: requirements on clients

A client is a program that reads and writes a store on a person's behalf: the
shell, rendering [`FileStoreView`](FileStoreView.md), or a separate application
embedding the runtime, which draws files with its own toolkit. This document
states what every client must do, and must not do.

## Finding a store

A client finds a space's store through the space's root, by its `fileStore` link
(see [`FileStore.md`](FileStore.md#where-it-lives)), and reads the store's
`files` group (see [`FileStoreOutput`](FileStoreOutput.md#views)). A client that
draws natively reads only that group, and never instantiates the view, so it
loads no rendering code.

## Adding a file

Adding a file is two steps, and the client does both:

1. Store the bytes in the blob store of the store's space. The upload route is
   `POST /<space>/blobs/<name>`, whose body is `{ type, body, name }` encoded
   in the fabric JSON form, `type` the media type, `body` the bytes, and `name`
   the file's name ([files](../../common/capabilities/files.md)). It returns the
   blob's `id`, and a URL relative to the space's path. `cf-file-input` does
   this step for a VDOM host.
2. Send the store's `add`, with the blob reference `{ space, id }`, and the
   name, the media type and the size the client stored.

A client MUST name, in `add`, the blob it stored, with the name and media type
it stored it with, since the store can't yet check them (see
[prerequisites](README.md#prerequisites)). A client SHOULD send `onConflict:
"rename"` for a name the person didn't choose, such as a pasted image's, and
`"refuse"` for a name they typed, so that they can choose another. Either way,
the client names a `requestId`, and reads the outcome's `name`: when it differs
from the name the client sent, the store chose it, and the client tells the
person which name their file has.

A blob stored by step 1 and never added is not a file. Nothing lists it, and
nothing deletes it.

## Attaching a file

Something that refers to a file, such as a chat message's attachment, holds a
link to its [`FileEntry`](FileEntry.md), and reads the name, the media type and
the blob through the link, under the reader's own access. It MUST NOT copy them:
a copy carries the copier's label rather than the entry's, and doesn't learn of
a rename or a removal.

A file attached to a chat message is added to the store of the room's space
first, and the message links the entry. A file someone attaches from another
space is added there again, as a new entry for the same bytes, so that it is as
private as the room, and not as the space it came from.

## Showing a file

A client fetches a file's bytes from its blob's space's blob store, by
`blob.id`, at `GET /<space>/blobs/<id>`. It decides how to show the file from
`mediaType`, never from the name's extension or from what the route serves: the
route serves only a few image types as their own type, and every other type as
`application/octet-stream`
([files](../../common/capabilities/files.md#what-the-store-provides)).

A client showing a link to a removed entry shows that the file was removed, and
doesn't fetch it (see [removed entries](FileEntry.md#removed-entries)).

## Mirroring a store

A program that keeps a local copy of a space's files, such as a sync daemon
writing them into a directory, reads `entries`, and writes each entry's bytes to
a file named by the entry's name. The [name rules](FileEntry.md#names) are what
make that safe without renaming: a name is one path segment, and never `.`,
`..`, or hidden. Such a program:

- MUST still refuse a name it can't write, rather than trust that the store
  checked it;
- MUST detect two names that its file system treats as one, as a file system
  that ignores case does, rather than let one file replace the other;
- SHOULD key what it has fetched by entry, which a rename keeps, so that a
  rename moves a file rather than fetching it again: a rename changes an
  entry's `blob`, but never its bytes;
- removes a file, or keeps it, when its entry leaves `entries`, as the program
  documents.

## What a client must not do, in one place

- Hold a file's bytes, or a data URL of them, in a cell.
- Store a blob URL in place of a blob reference.
- Identify a file by its name, which changes, or by its blob, which two entries
  can share. A file is its entry, compared with `equals()`.
- Copy an entry's fields into another record, rather than linking the entry.
- Load the store's view to use a store.
