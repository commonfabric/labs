# Files

A file's bytes never live in a pattern's cells. A pattern that takes files
uploads them to the space's blob store through `cf-file-input`, keeps the small
descriptor the upload returns, and serves a download as a link to the
descriptor's URL. The store keeps each blob as a content-addressed document of
its own in the space, so the pattern's cells stay small however large the file
is, and the list syncs like any other list of records. `packages/patterns/file-share/main.tsx` is the whole
shape in one file.

## Uploading

`cf-file-input` opens the browser's file chooser, uploads each chosen file to
the blob store of the space the pattern runs in, and fires `cf-change` with
the files it just stored:

```tsx
// Shown for illustration only.
interface UploadedFile {
  id: string; // hash of the name, media type and bytes, prefixed `fid1:`
  name: string;
  mediaType: string;
  size: number;
  url: string; // absolute URL the bytes are served from
}

interface AddFilesEvent {
  detail?: { files?: UploadedFile[] };
}

<cf-file-input multiple showPreview={false} oncf-change={addFiles} />;
```

The event carries more fields than these; keep the ones the pattern reads and
push them into a shared list. Never keep the bytes or a data URL in a cell.
`includeData` on the input puts a base64 copy of the file into `data` for a
transient use such as sending an image to a model; a record that persists that
copy makes the cell as large as the file, and a large cell syncs slowly and can
fail to sync at all.

With previews enabled the input renders its own remove buttons, and a click on
one fires `cf-change` again with `files` holding every remaining file. A
handler that treats `files` as new uploads then re-adds them. Either turn
previews off, or handle `cf-remove` and read `allFiles` as the full list.

## Downloading

A download is an anchor: `<a href={file.url} download={file.name}>`. A blob
stored with a name, as `cf-file-input` stores every file it uploads, is served
with a `Content-Disposition` header naming the file, so the saved file has that
name whichever host serves the space. A blob stored with no name is served with
one naming no file. There the `download` attribute is what names the saved file,
and browsers honor it only when the link is same-origin with the page, so a
space served from another host saves the file under its hash instead. A URL
with `?download` is served as an attachment whatever the blob's type, which a
browser saves from any origin, under the blob's name.

A pattern that holds a blob's reference, its space's DID and its id there, rather
than its URL, offers it with `cf-blob-link`, as
`<cf-blob-link blob={file.blob} name={file.name}>`, which links to its
`?download` URL, and shows an image with `<cf-image blob={file.blob}>`. Each
asks the runtime for the URL the blob's space's host serves it at, which a
pattern has no way to form itself.

`cf-file-download` is not for stored files. It takes the content as a string
and builds the download in the browser, so using it means holding the bytes in
a cell.

## Renaming

A handler renames a file by naming its blob again: `nameBlob(target, blobId,
name)` returns the id of a blob holding the same bytes and media type under
`name`, in the space `target`'s value lives in, and the handler stores that id
where it kept the old one. It returns `undefined` when the space holds no blob
`blobId`, which the handler checks before storing anything. A blob never
changes, so the space then holds the bytes under both names. The new blob's
record is stored when the handler's transaction commits, and its bytes travel
with the commit: the handler loads them first, and is run again once they
arrive. The commit carries the bytes base64-encoded, so under the routed
transport, whose frames hold at most 8 MiB, a file well within the upload limit
can still be too large to rename.

## What the store provides

- One upload holds at most 10 MB; the server returns 413 above that.
- A blob is addressed by the hash of its media type, its bytes, and the name
  it was stored with, if any, so the same file uploaded twice under the same
  name has the same id, and under two names has two. The URL is that id plus a
  short suffix: the last extension of the name the upload is posted under,
  which `cf-file-input` takes from the file's name, or, for an upload posted
  under none, of the blob's name, when that extension is one to eight letters
  or digits; otherwise one chosen from the media type, or `bin`. Two uploads
  with the same id share a URL when they get the same suffix and have two URLs
  when they do not. Each URL is immutable and cacheable forever.
- A name is any non-empty string of well-formed Unicode of at most 1024 bytes
  as UTF-8. Every download's
  `Content-Disposition` is `inline` for a type served as itself, and
  `attachment` for every other, or for any type under `?download`, naming the
  file when the blob has a name.
- The bytes stay in the space's own store beside its cells. There is no
  offload to an object store, and no signed or expiring URL.
- GIF, JPEG, PNG, and WebP are served as their own media type, so an `<img>`
  can show them. Every other type is served as `application/octet-stream`, so
  a browser downloads it rather than rendering it inline. Every blob is served
  with `X-Content-Type-Options: nosniff`, so a browser takes the type as given
  rather than guessing one from the bytes.
- A record a handler stores with `nameBlob()` carries no label either, so the
  name it gives is readable by anyone who can fetch the blob.
- Nothing deletes a blob. Removing a record drops the reference; the bytes
  stay.
- The upload and download routes are not authenticated: anyone who holds a
  blob's URL can fetch it, and anyone can upload into a space.

The store is `packages/toolshed/routes/blobs/blobs.index.ts`.
