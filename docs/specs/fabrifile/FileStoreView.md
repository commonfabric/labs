# FileStoreView

`FileStoreView` renders one store ([`FileStore.md`](FileStore.md)) for hosts
that render VDOM, such as the shell. It is the store's rendering, in a module of
its own, so that nothing that uses a store has to load it. It decides nothing
about the store's files that the store doesn't already say.

## What it holds

A view is a pattern taking one input, **`store`**: a store's files group
(`FileStoreFiles`), set when the view is instantiated. That is all it holds besides its own rendering state,
which is `PerSession`: a sort order, a selection, a rename in progress, and the
uploads it has started and not yet added. It MUST NOT hold anything read from
the store, or any copy of a file's bytes.

A root that offers file storage instantiates the view from its own rendering,
when it shows its files. A client that draws natively never instantiates it.

## What it shows

- Each entry in `entries`: its name, its media type, its size, and its adder,
  with `cf-profile-badge`. An image, a video or an audio file is shown inline,
  from its blob, and any other file as a link that downloads it.
- An upload control, `cf-file-input`, for a viewer the store's space admits with
  WRITE or OWNER. The control stores each chosen file's bytes in the store's
  space's blob store, and the view then sends the store's `add` for each, with
  `onConflict: "rename"`, the name the file had, and a `requestId` of its own.
  When the outcome's `name` differs from the file's, the view says which name
  the file was added under.
- For each entry the viewer may change, a control that removes it, and one that
  renames it, which sends `rename` with `onConflict: "refuse"`, and shows a
  refusal's reason beside the name.

## Outputs

- `store`: the link.
- `[UI]`: the rendering.
- `[VIEWS]`: the store's `files` group, re-exported by link. The view adds
  nothing to it.

A view offers no stream of its own. Every change reaches the store's own
streams.

## Prerequisites

None. An entry holds a blob reference and no URL (see
[`FileEntry`](FileEntry.md#fields)), and the view shows it with components that
take the reference: `cf-image`, given `blob`, shows an image, and
`cf-blob-link` links to the blob, saving it under a name. Each asks the runtime
for the URL the blob's space's host serves it at.
