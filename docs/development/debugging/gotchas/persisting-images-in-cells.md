# Persisting Images: store the blob `url`, not the inline `data`

**Symptom:** A pattern captures photos with `<cf-image-input>` and stores the
resulting `ImageData` in a persisted cell (e.g. a `PerSpace` array of records).
The data appears to save (CLI `cf cell get …/0/someField` works), but in the
browser the list **renders intermittently or not at all** — the same cell reads
as a populated array in one `computed()` and as `undefined`/`nil` in another
during the same render, with no console error. A full `cf cell get <cell>` may
return nothing (the payload is enormous).

**Cause:** `ImageData.data` is the full image as an inline base64 **data-URL**
(hundreds of KB to multiple MB). `<cf-image-input>` only populates `data` when
you pass the `includeData` attribute. Persisting a `data`-bearing `ImageData`
inside a cell means every sync of that cell ships the whole base64 blob through
the transport and storage write path. A normal-sized fact settles instantly; a
~700KB inline value widens the sync window enough that reactive reads race
against it (this compounds the rule in
[`scoped-cell-pitfalls.md`](./scoped-cell-pitfalls.md) that a scoped `.get()`
returns `undefined` until its first sync settles). The data-model spec also
[recommends size limits for inlined binary data](../../../specs/data-model/sigil.md).

```typescript
// Shown inside a pattern body.
// WRONG — persists the ~700KB inline base64 `data` in a PerSpace array.
// Destabilizes the cell's sync; the list renders unreliably.
const sightings = Writable.perSpace.of<{ image: ImageData; /* … */ }[]>([]);
// <cf-image-input includeData oncf-change={...} />   // includeData -> data set
// ...later:
sightings.set([...sightings.get(), { image, /* … */ }]); // `image` carries `data`
```

```typescript
// Shown at module scope.
// CORRECT — persist only the lightweight blob reference (`url`); the bytes
// live out-of-band in the blob store. `cf-image-input` always uploads them.
interface StoredImage { url: string; name: string }
const sightings = Writable.perSpace.of<{ image: StoredImage; /* … */ }[]>([]);
// ...when saving, strip to the reference:
const light = { url: image.url, name: image.name };
sightings.set([...sightings.get(), { image: light, /* … */ }]);
// Render thumbnails from `image.url` (a server blob URL), not `image.data`.
```

## The idiom

- `<cf-image-input>` / `<cf-file-input>` **always upload bytes to the blob
  store** and return an `ImageData` whose `url` points to them. `url` is the
  durable, lightweight reference — persist that.
- Pass `includeData` **only** when you need the inline base64 *transiently* —
  e.g. to feed `generateObject`/`generateText` for OCR/extraction — and hold it
  in a **session** cell (`new Writable<ImageData[]>([])`), never a persisted
  `PerSpace`/input cell. `patterns/apps/store-mapper/main.tsx` and
  `patterns/apps/image-analysis/main.tsx` do exactly this: photos are
  processed-and-discarded; only the *extracted* data persists.
- `group-chat-room.tsx` is the canonical persisted-image pattern: it omits
  `includeData`, and the message it stores carries only the image's `url`.
- Common flow for "capture → extract → keep the photo": use `includeData` on the
  draft (so the LLM can read `data`), then persist a stripped `{ url, name }`
  into the durable record.

**Verify with:** after saving, reload the piece and confirm the list still
renders. Reading a tiny field via `cf cell get <cell>/0/<field>` confirms the
record persisted; an enormous/empty full-cell read is the tell that you inlined
a blob.
