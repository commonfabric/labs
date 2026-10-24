# FabriFile

FabriFile is a space's designated file storage. This directory describes the
patterns it is made of, the contracts they fill, and what they require of the
runtime and of the programs that use them. [Implementation
status](#implementation-status) says where they are built, and where the build
departs from this design.

## Quick links

- Patterns:
  - [`FileStore`](FileStore.md): a space's set of files. It has no rendering.
  - [`FileStoreView`](FileStoreView.md): a store's rendering, for hosts that
    render VDOM.
- Contracts, named for their roles:
  - [`FileStoreOutput`](FileStoreOutput.md): what a store offers.
- Records a store holds:
  - [`FileEntry`](FileEntry.md): one file: its name, its media type, and the
    blob that holds its bytes.
- [Requirements on clients](clients.md)

## Purpose

A space holds files: the images, videos, text files and documents that people
put there, and that other parts of the space refer to, such as a chat message's
attachments. The bytes already have a home, the space's blob store
([files](../../common/capabilities/files.md)), which keeps each blob as a
content-addressed document of the space, addressed by the hash of its media
type and bytes. What the blob store doesn't offer is a _set_ of files: names a
person chose, a listing, a way to find a file by its name, and a way to take a
file out of the set. Each pattern that takes files today keeps its own list of
upload descriptors, so a space's files are scattered across its pieces and no
program can enumerate them.

FabriFile's store is that set, one per space. It is two patterns and one record:

- **The store** ([`FileStore.md`](FileStore.md)) is the set of files in one
  space. It finds a file by its name, takes new files, and removes, renames
  and lists them. It has no `[UI]`, and its module imports no rendering code.
- **The entry** ([`FileEntry.md`](FileEntry.md)) is one file: a name, a media
  type, and a reference to the blob holding its bytes. An entry is a record the
  store holds, a document of its own, so anything that refers to a file, an
  attachment included, links the entry.
- **The view** ([`FileStoreView.md`](FileStoreView.md)) renders a store for
  hosts that render VDOM, such as the shell. It is a separate pattern in a
  separate module, so a client that draws natively uses the store without
  loading any rendering code.

```text
  space
  ┌────────────────────────────────────────────────────────┐
  │ root ──fileStore──► FileStore                          │
  │                      entries: FileEntry, FileEntry, …  │
  │                        │                               │
  │                        │ blob: { space, id }           │
  │                        ▼                               │
  │                      blob store: cid:fid1:<hash>       │
  │                                                        │
  │ FileStoreView ──link──► FileStore     (VDOM hosts only)│
  └────────────────────────────────────────────────────────┘
```

[`clients.md`](clients.md) states what a separate program that uses a store must
do, and must not do, including one that draws files with its own toolkit and
one that mirrors a space's files to a local file tree.

## Status and interpretation

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are normative. Where this design depends on something the runtime does not yet
provide, the document says so, under the heading "Prerequisites".

## Reading order

1. [`FileStoreOutput.md`](FileStoreOutput.md): the contract: what a store's
   facts mean and what each request does.
2. [`FileEntry.md`](FileEntry.md): the record a store holds.
3. [`FileStore.md`](FileStore.md): how this implementation fills the contract,
   and where a space keeps it.
4. [`FileStoreView.md`](FileStoreView.md): rendering a store for hosts that
   render VDOM.
5. [`clients.md`](clients.md): the requirements on a separate program that uses
   a store.

## Terms

- **Store.** A space's set of files: a `FileStore` piece, named by the space's
  root.
- **Entry.** One file in a store: a [`FileEntry`](FileEntry.md).
- **Blob.** The bytes of a file, their media type, and optionally a name,
  kept by the space's blob store as the document `cid:fid1:<hash>`, where
  `<hash>` is the hash of all three. A blob is immutable, and nothing deletes
  one. The same bytes under two names are two blobs.
- **Blob reference.** The pair of a blob's space and its `fid1:` id, which is
  everything a reader needs to fetch the bytes.
- **Name.** The string a store finds an entry by. Within one store, names are
  unique.
- **Client.** A program that reads and writes a store on a person's behalf: the
  shell, or a separate application embedding the runtime.

## Decisions

1. **One store per space, named by the space's root.** A root that offers file
   storage links its store from a `fileStore` field, as a container names its
   own chat with `chatRoom`. A pattern in the space finds the store through
   `wish({ query: "#default" })`, and a client through the root it already
   reads.
2. **An entry refers to its bytes; it never holds them.** An entry is small,
   whatever the size of its file. The bytes stay in the blob store, and an
   entry names them by blob reference.
3. **A file is a record, not a piece.** An entry is an object pushed onto the
   store's list, a document of its own, identified by its cell. A link to it
   carries its label across a space boundary, which is what an attachment
   needs, and a piece per file would cost a pattern instance per file for
   nothing a record can't do.
4. **Names are flat and unique.** A store has no folders. A name is one segment,
   valid as a file name on the common file systems (see
   [`FileEntry`](FileEntry.md#names)), so a program can mirror a store to a
   directory with one file per entry and no renaming.
5. **An entry's blob carries the entry's name.** An entry and its blob name
   the file alike, so that the bytes, fetched by themselves, still say what
   they are called. A blob is immutable, so renaming a file stores its bytes
   again as a new blob under the new name, and the entry then names that blob.
   The store does that itself, and a person renaming a file sees only the
   rename. An entry's bytes and media type never change: a new version of a
   file is a new entry.
6. **Removing a file removes the entry, not the bytes.** The blob store deletes
   nothing, so a removed file's bytes stay reachable by anyone holding its
   blob reference (see [Privacy](#privacy)).
7. **The protocol surface is UI-free.** The store, the contract and the entry
   hold data and take requests. None of them carries rendering state, such as
   a selection, a sort order or an upload in progress: that belongs to whatever
   draws the store.
8. **Rendering code is never loaded to use a store.** The store's module, and
   every module it imports, imports no module that renders. The view's module
   imports the store's; the store's never imports the view's. A client that
   draws natively instantiates and reads the store with no rendering code
   loaded.

## Privacy

A store's entries are as private as its space: a reader the space's access list
refuses reads no entry. The bytes are not, today:

- **The blob routes are unauthenticated.** Anyone who holds a blob's space and
  id can fetch it, and anyone can upload into a space
  ([files](../../common/capabilities/files.md#what-the-store-provides)). The
  bytes are only as private as their reference is secret.
- **A reference is a hash of the content.** Anyone who already has a file, and
  knows its name, can compute its id, and so can learn whether a space holds
  it, by fetching it.
- **A blob says its name.** A download serves the blob's name with its bytes,
  so whoever can fetch a blob learns what the file is called, as well as what
  it holds.
- **Removal doesn't revoke.** A removed entry's blob reference still fetches
  its bytes, and so do the copies of it that attachments and other links hold.
  So does the blob a rename replaced, under the file's earlier name.

Some of this no design can prevent: anyone who can read a file can keep and
re-share its bytes, by reference or by copy. What the runtime can provide is
that a blob reference grants nothing on its own. See
[Prerequisites](#prerequisites).

## Non-goals

- Folders, or any hierarchy of names.
- Editing a file in place. A changed file is a new entry.
- Deleting bytes from the blob store.
- Uploading through the store. A client puts the bytes in the blob store
  itself, and then adds an entry for them (see [`clients.md`](clients.md)).
- Quotas and limits beyond the blob store's own.

## Prerequisites

The design depends on runtime capabilities that don't exist yet:

- **Authorized blob reads.** A blob read is admitted only for a principal the
  blob's space admits, as a read of any other document of the space is, and a
  blob write likewise. Until then, everything under [Privacy](#privacy)
  holds.
- **A blob reference a pattern can check, in full.** The store learns whether
  its space holds the blob a request names, since storing it under the entry's
  name reads its record, but not the media type or the size the blob was
  stored with, so it takes those as the request states them (see
  [`FileStoreOutput`](FileStoreOutput.md#add)).

## Implementation status

The patterns are in `packages/patterns/fabrifile/`: `schemas.tsx` holds the
contracts and records, `names.ts` the name rules, `store.tsx` the store, with
its stored records and the handlers that write them, and `view.tsx` its
rendering. `store.tsx` reaches no module that renders, which
`store-imports.test.ts` checks, and `integration/fabrifile-store.test.ts`
drives the store over blobs its space holds, as a pattern test cannot, since
nothing a pattern runs can write a blob's first record. A FabriChat room that
is its space's root and the Loom each keep their space's store, and a room in
the Loom's space uses the Loom's (see
[`FileStore.md`](FileStore.md#where-it-lives)).

- **The store and its core.** `FileStore` resolves the viewer's profile with
  `#profile` and hands it to `FileStoreCore`, which takes it as an input, so a
  test can name one.
- **Writers and labels.** An entry's write policy is the element's, at its
  position in the list, and names `commitAdd`, `commitRename` and
  `commitRemove`, since a removal is a write to the element removed. The
  `authored-by` label is the `addedBy` field's, written only by `commitAdd`,
  rather than the whole entry's, which a rename would restamp; `remove` and
  `rename` read the adder from it.
- **Who may write.** A request from a principal the store's space admits with
  `READ`, or not at all, is not admitted. A level not known yet is left to the
  space's own access list, which refuses the write where it doesn't admit it.
- **Blobs.** `add` and `rename` store the entry's bytes under its name with
  `nameBlob()` ([files](../../common/capabilities/files.md#renaming)), and an
  `add` naming a blob the space doesn't hold is refused with `no-blob`. An
  `add` reads the blob's record even when the
  names already agree, which loads its bytes into the adder's runtime.
- **Showing a blob.** A rendering shows an entry's blob with `cf-image` and
  offers it with `cf-blob-link`, which each take the blob reference and ask the
  runtime for the URL its space's host serves it at.
- **A root's store.** `FileStoreRecord`, `FileStoreRecordCell` and
  `ensureFileStore` are what a root keeps its store with
  ([`FileStore.md`](FileStore.md#where-it-lives)). A room offers its space's
  store, and a FabriChat message's attachments link its entries
  ([`ChatMessage`](../fabrichat/ChatMessage.md#fields)), which a room's
  composer adds to the store as it attaches them
  ([`FabriChatRoom`](../fabrichat/FabriChatRoom.md#state)).
