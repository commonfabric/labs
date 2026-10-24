# FileStore

`FileStore` is an implementation of [`FileStoreOutput`](FileStoreOutput.md),
which states everything a file store does: what its facts mean, and what each
request does. This document says how this implementation does it, where a space
keeps it, and how its modules are laid out.

## Where it lives

A store is a piece in the space whose files it holds, and the space's root names
it with a `fileStore` link, as a container names its own chat with `chatRoom`. A
root that offers file storage declares the link in its own output, and creates
the store the first time something needs it, from a handler of its own, such as
`ensureFileStore`. A root that declares no `fileStore` offers none, and a
pattern or client that needs one there has nowhere to put files.

`store.tsx` gives a root both halves. `FileStoreRecord` is where the root keeps
the link: a record holding it in `store`, absent until the store is created,
rather than the link itself, because a handler's cell for a field holding a
link writes through the link. `ensureFileStore`, bound to that record, creates
the store as a piece in the root's space and names it there, and changes
nothing when the record names one already, which is what keeps a root from
replacing its store.

The link is set once, when the store is created, and never changes. Two stores
in one space would be two sets of files with no rule for which a file belongs
in, so a root MUST NOT replace its store, and nothing else in the space creates
one.

Two roots keep one this way: a FabriChat room that is its space's root
([`FabriChatRoom`](../fabrichat/FabriChatRoom.md)), in its `fileStore` input,
and the Loom (`packages/patterns/loom/`), in its own. The two offer the same
shape: each links the store as `fileStore`, creates it with `ensureFileStore`,
and offers the record itself as `fileStoreRecord`, which FabriChat's
`ChatContainer` declares. A FabriChat room that isn't its space's root uses the
store its root keeps: it reads its store from the record its root offers, and
creates it there. A root that offers no record gives its room no store, and the
room's `ensureFileStore` does nothing. A root offers the record rather than a
stream to create the store with, because a declared stream reads as present
whether or not the root has one (see
[handlers](../../common/concepts/handler.md#exporting-handlers-as-streams)), so
only a value can say whether the root keeps a store.

A FabriChat room's attachments go in its space's store, the one its `fileStore`
links. A message's attachment links an entry of that store (see
[`clients.md`](clients.md#attaching-a-file)).

## State

The store keeps two values, both `PerSpace` in its space:

- **`entries`**: a list of [`FileEntry`](FileEntry.md) records. `add` pushes a
  new entry onto it, a document of its own, and `remove` takes one out. Nothing
  else changes the list.
- **`requests`**: the outcome of each request (see
  [`FileStoreOutput`](FileStoreOutput.md#facts)).

`byName` is computed from `entries`. A name check, for `add` and `rename`, reads
the names of every entry in `entries`.

## Writers

Every record names its writers. The entry list's write policy names `add` and
`remove`, and an entry's names `add`, `rename` and `remove`: `add` writes the
whole entry, `rename` its `name` and `blob`, and `remove` its `removedAt`. No
other code can write either, even code a member runs in the store's space.

The handlers learn the principal they act for with `currentPrincipal()`, and an
entry's adder from its `authored-by` label, which is how `remove` and `rename`
admit the adder. They learn whether the principal is an OWNER of the store's
space with `spaceAccess()`, and the space they run in with `spaceOf()`, which
is how `add` refuses another space's blob. `rename`, and an `add` that chooses
a free name, store the entry's bytes again under its new name with
`nameBlob()` ([files](../../common/capabilities/files.md#renaming)).

## Modules

The store's patterns are in `packages/patterns/fabrifile/`:

- `schemas.tsx`: `FileEntry`, `BlobRef`, `FileProfile`, the requests and
  their outcomes, `FileStoreFiles`, the store's files group, and
  `FileStoreOutput`.
- `names.ts`: the [name rules](FileEntry.md#names), and the choice of a free
  name for `onConflict: "rename"`, as plain functions with no pattern in them.
- `store.tsx`: `FileStore`, and the records it stores with the handlers that
  write them, in one module because each record's write policy names its
  writers. It has no `[UI]`.
- `view.tsx`: `FileStoreView` (see [`FileStoreView.md`](FileStoreView.md)).

`schemas.tsx`, `names.ts` and `store.tsx`, and every module they import, MUST
NOT import `view.tsx`, any other module that renders, or anything from
`packages/ui`. A root that offers file storage imports `store.tsx`, and imports
`view.tsx` only from its own rendering. A client that draws natively
instantiates the store, or reads it through a root, with no rendering code
loaded.

That rule is held by a test, beside the patterns, that walks the import graph
of `store.tsx` and fails on any module that renders.

## Prerequisites

- **A blob reference a pattern can check, in full**: the same as the
  contract's (see [`README.md`](README.md#prerequisites)).
