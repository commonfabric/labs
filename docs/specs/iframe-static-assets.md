# Static assets for iframe guests

## Status

Proposed. Nothing in this document is built. It covers files that ship with a
pattern: images, fonts, and audio. Files people add while using a pattern are
out of scope.

## The problem

An iframe guest (`docs/common/ai/iframe-pattern-guide.md`) draws its own page,
and a page often needs an image, a font, or a sound that the pattern's author
supplies. Three facts constrain how a guest can get one.

**The guest's policy admits few sources.** The guest runs under a Content
Security Policy that the embedding page sets. Labs' policy is `CSP` in
`base/iframe-sandbox/src/csp.ts`. Loom serves the sandbox's outer frame from a
URL of its own and gives it a stricter policy, `FRAME_CSP` in
`src/lib/loom_pattern_pane.py` in `commonfabric/loom`. The guest inherits
whichever applies:

| Resource | Labs guest | Loom guest |
| --- | --- | --- |
| `<img>`, CSS images | host origin, `data:` | `data:` |
| Fonts | host origin, `data:`, Google Fonts | `data:`, Google Fonts |
| `<audio>`, `<video>` | none | none |
| `fetch()` | `'self'` | none |

`data:` is the only image source both policies admit. Neither admits `blob:`
URLs, and neither admits `fetch()` of a `data:` URL, because that is a
`connect-src` request. A guest can also decode bytes it already holds, with
`createImageBitmap()`, `FontFace`, or Web Audio's `decodeAudioData()`, since
no fetch directive governs that.

**Data files hold text.** A pattern attaches files with `dataFile()`
(`DataFileFunction` in `base/api/index.ts`). `decodeDataFile` in
`base/text/src/utf8.ts` decodes every attached file as strict UTF-8 and refuses
one that is not, so a PNG cannot be attached today.

**A JSX prop is stored with every instance.** Setup writes a piece's result
document from the pattern's result template (`#nextResultProjection` in
`runtime/runner/src/runner.ts`), and a string passed as a JSX prop is written
into that document whole. An iframe pattern passes its guest as
`src={dataFile("./guest.html")}` and `script={dataFile("./guest.js")}`, so each
piece stores its own copy of both files. Measured on
`patterns/examples/iframe-verb-list/`, whose `guest.js` is 137 KB, each further
instance adds 147 KB of revision data, and the commit log holds the same again.
The program's source set already holds one copy of each file, as a code
document (`docs/specs/content-addressed-schemas.md`, "Code documents"), shared
by every piece in the space. Passing images the same way would add each image
to every piece.

## Design

Seven parts. The first stands on its own and removes the per-instance copy of
every guest that reads its files with `dataFile()`.

1. A string a `dataFile` reader returns is stored in a result document as a
   link to its code document.
2. A binary data file can be attached, and `dataFile.url()` reads any data file
   as a `data:` URL.
3. `dataFile.urls()` reads a directory of assets as a record of named URLs.
4. `cf-iframe` takes an `assets` prop, replaces each `cf-asset:<name>` in the
   guest's document with that asset's URL, and hands the guest the record.
5. The guest reads an asset with `fabric.asset(name)`, which also loads it as
   an image or a bitmap.
6. `scripts/write-iframe-wrapper.ts` writes the guest as two data files and
   generates the `assets` prop.
7. A client writes large data files ahead of the program, so assets are bounded
   per file rather than per program.

The author's side, end to end, for a pattern whose `assets/` directory holds
`glaze.png`, `menu.woff2`, and `bell.mp3`:

```tsx
// Shown for illustration only.
<cf-iframe
  src={dataFile("./guest.html")}
  script={dataFile("./guest.js")}
  assets={dataFile.urls("./assets")}
  $context={{ input, state, output }}
/>
```

```html
<style>
  @font-face {
    font-family: "Menu";
    src: url(cf-asset:menu) format("woff2");
  }
  .counter {
    background-image: url(cf-asset:glaze);
  }
</style>
<img src="cf-asset:glaze" alt="A glazed donut">
```

```ts
// Shown for illustration only.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
context.drawImage(await fabric.asset("glaze").image(), 0, 0);
const bell = await audio.decodeAudioData(fabric.asset("bell").bytes().buffer);
```

A guest whose document only shows assets needs no script at all: the
substitution in part 4 happens before the document is parsed.

## 1. Data-file strings are stored by reference

When setup writes a result projection, each string leaf that a `dataFile`
reader returned is written as a link to a code document holding that string.
The code document is staged in the same transaction with
`stageContentAddressedDocument` in
`runtime/runner/src/storage/extended-storage-transaction.ts`, which derives the
id from the content and skips the write once the server has confirmed the
document exists. For `dataFile()` the document is the one the source set
already holds. For a string built when it is read, such as an SVG file's
`data:` URL, the first piece set up in a space writes it and every later piece
links to it.

- **Which strings.** The readers record each string they return in a
  per-runtime set, keyed by content. The projection write looks up each string
  leaf of at least 1 KiB; a shorter one stays inline, since a link would cost
  as much. The rule applies to the result projection only. A computed value
  derived from a data file is written by its computation, inline, as today.
- **Why it is keyed to `dataFile`.** A code document carries no CFC envelope.
  Program files are already stored that way, so linking to one exposes nothing
  the space did not already hold unlabeled. A rule that moved every long
  string into a code document would take labeled values out from under their
  labels.
- **Reading.** Readers of the result document follow the link as they follow
  any sigil link, and the code-document reader checks the string against the
  id. The worker reconciler subscribes to a prop whose value is a cell
  (`runtime/html/src/worker/reconciler.ts`, the `isCell(value)` branch of prop
  updates), so a top-level prop such as `script` reaches the element as its
  string either way.
- **Comparison.** The projection's no-op check compares what a write would
  store, so a stored link compares equal to the link a later setup builds. A
  piece whose stored projection holds the string inline differs from the new
  projection, and its next setup rewrites it with the link.
- **CFC.** The change alters stored bytes and relies on two rules
  `content-addressed-schemas.md` already states: a code document carries no
  envelope, and a link to one in a labeled record records no link-write policy
  input. The expected classification under
  `docs/development/cfc-spec-correspondence.md` is a host arrangement, which
  the implementing pull request confirms.

## 2. Binary data files and `dataFile.url()`

### Media types

A closed table maps an extension to a media type and says how the file is
stored:

| Extensions | Media type | Stored as |
| --- | --- | --- |
| `.png` | `image/png` | `data:` URL |
| `.jpg`, `.jpeg` | `image/jpeg` | `data:` URL |
| `.gif` | `image/gif` | `data:` URL |
| `.webp` | `image/webp` | `data:` URL |
| `.avif` | `image/avif` | `data:` URL |
| `.woff2` | `font/woff2` | `data:` URL |
| `.woff` | `font/woff` | `data:` URL |
| `.ttf` | `font/ttf` | `data:` URL |
| `.otf` | `font/otf` | `data:` URL |
| `.mp3` | `audio/mpeg` | `data:` URL |
| `.ogg` | `audio/ogg` | `data:` URL |
| `.wav` | `audio/wav` | `data:` URL |
| `.svg` | `image/svg+xml` | text |

The extension decides, not the bytes: a decision made by trying UTF-8 would
store a file differently depending on its contents. Every URL is base64, SVG's
included, so a URL contains no quote, no `<`, and no `)`, and can be written
into an attribute, a CSS `url()`, or JSON as it is.

### Attaching

`decodeDataFile` gains the branch: a file whose extension the table stores as a
`data:` URL is stored as `data:<media type>;base64,<bytes>`, and every other
file is decoded as strict UTF-8, as now. Every reader of a local or served data
file already goes through it: the three in `base/js-compiler/program.ts` and
the one in `runtime/runner/src/harness/patterns-route.deno.ts`. Because the
stored form is text, code documents, identity hashing (a data document is
hashed as a leaf over its stored contents and name), the compile cache, the CLI
and `setsrc` are unchanged.

Whatever writes a source package back to disk inverts the encoding.
`writeSourcePackage` in `runtime/cli/lib/piece.ts`, which `cf piece getsrc`
uses, writes each file with `Deno.writeTextFile`; it writes a file the table
stores as a `data:` URL as its decoded bytes instead. The inverse lives beside
`decodeDataFile`, so a `getsrc` followed by a `setsrc` attaches the same bytes.

### Size

Nothing here caps a file on its own. What bounds assets is the request that
carries the program. Under server execution, `upload` and `setsrc` send the
whole program in one request, which takes at most 8 MiB, and 4 MiB on a
connection through the memory router; the client refuses a larger one with
`payload-too-large` before sending
(`docs/features/server-pattern-lifecycle.md`). A binary file counts at four
thirds of its size, so on a routed deployment a program's code and assets
together have room for about 3 MiB of image, font, and audio bytes. Part 7
turns that into a bound per file.

### Reading

- `dataFile(path)` returns a text file's contents, as now. On a file the table
  stores as a `data:` URL it throws, naming the file and `dataFile.url()`.
- `dataFile.url(path)` returns a base64 `data:` URL for any file in the table:
  the stored string for a binary file, and a URL built from the text for SVG. A
  file outside the table throws, listing the table.

`DataFileFunction` becomes a function with `url` and `urls` members (part 3).
The builder's placeholder in `runtime/runner/src/builder/factory.ts` and the
per-module reader in `dataFileBinding`
(`runtime/runner/src/sandbox/module-record-compiler.ts`) each gain them, and
`deno task gen-commonfabric-types` regenerates the declarations the pattern
compiler reads.

The compile-time scan attaches the files a module's source names. It already
recognizes `dataFile("…")` and `ns.dataFile("…")` with a string literal
(`dataFileReadPath` in `base/js-compiler/typescript/resolver.ts`); it also
recognizes `.url("…")` and `.urls("…")` on either.

## 3. `dataFile.urls()`: a directory of assets

`dataFile.urls(path)` returns a record from a name to a `data:` URL, for every
file directly inside the directory `path` names whose extension is in the
table. A file's name in the record is its file name without the extension:
`glaze.png` is `glaze`. Files outside the table, such as a README, are left
out, and subdirectories are not read.

- An asset name matches `[A-Za-z0-9_-]+`, the grammar part 4's references use.
  A file whose name without its extension does not, such as
  `glaze.small.png`, throws, naming the file.
- Two files that would get the same name, such as `glaze.png` and
  `glaze.webp`, throw, naming both.
- The scan reports the directory, and the resolver lists it and attaches each
  file it holds in the table. A resolver over a file system or over a stored
  source set can list a directory. One that reads over HTTP cannot, and refuses
  the call, naming it.

A record mixes with single files by spreading:
`assets={{ ...dataFile.urls("./sprites"), logo: dataFile.url("./logo.svg") }}`.

## 4. `cf-iframe`'s `assets` prop

`assets` is a record from a name to a base64 `data:` URL. A name matches
`[A-Za-z0-9_-]+`. A value that is not a base64 `data:` URL is refused when the
view is built, as `$context` refuses a field that is not a cell.

It is a prop of its own rather than a `$context` field. A `$context` field is a
live cell the guest is granted, with a kind in `resourceKinds` and a
subscription behind it. An asset is a constant of the program: nothing grants
it, nothing writes it, and nothing changes it while the guest is loaded.

The host assembles the guest's document in `guestDocument`
(`base/iframe-sandbox/src/guest-document.ts`), and does two things there with
the assets.

**It replaces each reference.** Every occurrence of `cf-asset:` followed by a
name in the guest's document (`src`) is replaced with that asset's URL. The
name runs to the first character outside `[A-Za-z0-9_-]`, so a reference ends
at the quote of an attribute or the parenthesis of a CSS `url()`. That covers
`<img src>`, `<link rel="icon" href>`, SVG's `<image href>`, `poster`, and
`url()` in a `<style>` element or a `style` attribute, an author's own
`@font-face` included. The whole document is searched, an inline `<script>` in
it too, where a string `"cf-asset:glaze"` becomes the URL. The guest's bundle,
passed as `script`, is not searched.

A reference to a name the record lacks is left in place, and the host reports
an error that names it and lists the record's names. `cf-asset:` is therefore
reserved in a guest's document; prose that needs those characters writes the
colon as `&#58;`.

The substitution is plain text, made before anything parses the document. Two
other places were considered and do not work. The outer frame parses the
document but deliberately never serializes it again, since `DOMParser` parses
with scripting disabled and serializing changes `<noscript>` content
(`presentedDocument` in `base/iframe-sandbox/src/outer-frame-script.js`). A
script in the guest that rewrote references would run after the parser had
already tried to load them, and each attempt would be a policy violation.

**It hands the guest the record.** The host writes it into the document ahead
of the guest's script, as an element that is not executed, so `script-src`
does not govern it:

```html
<script type="application/json" data-cf-assets>{"glaze": "data:image/png;base64,…"}</script>
```

Writing assets into the document, rather than sending them over the bridge,
makes them available synchronously, before the bridge connects and before the
guest's initial `pull()`.

## 5. The guest's `fabric.asset()`

`FabricClient` in `base/iframe-sandbox/src/guest.ts` gains:

```ts
// Shown for illustration only.
interface GuestAsset {
  /** The media type the URL carries. */
  mediaType: string;
  /** The size of the decoded bytes. */
  size: number;
  /** The asset as a `data:` URL, for an element or style the script sets. */
  url: string;
  /** The decoded bytes, for `FontFace`, `decodeAudioData()`, or WebGL. */
  bytes(): Uint8Array;
  /** The decoded bytes as a `Blob`. */
  blob(): Blob;
  /** The decoded bytes as UTF-8, for an SVG the script inlines. */
  text(): string;
  /** An image element with the asset loaded and decoded. */
  image(): Promise<HTMLImageElement>;
  /** The asset decoded with `createImageBitmap()`. */
  bitmap(): Promise<ImageBitmap>;
}

asset(name: string): GuestAsset;
```

`asset()` is synchronous. A name the document carries no asset for throws,
listing the names it does carry. `bytes()`, `blob()`, and `text()` decode the
base64 in the guest, because `fetch(url)` is refused under both policies; each
call returns a fresh copy. `image()` sets the URL on a new image element and
waits for `decode()`, which is what a 2D canvas, Phaser's texture manager, and
most other engines take. `bitmap()` suits drawing to a canvas or uploading a
WebGL texture without an element.

## 6. The wrapper generator

`scripts/write-iframe-wrapper.ts` bundles the guest, puts the bundle into the
HTML document in place of a marker, and writes the whole document into the
generated wrapper as one string literal, `GUEST_HTML`, passed as `src` with no
`script`. That literal is not a `dataFile` string, so part 1 does not reach it,
and each piece stores the whole guest. Ring Loops, in labs and in Loom, and
three of Loom's foundation patterns are built this way.

The generator changes in two ways:

- It writes `guest.html` and the bundle as `guest.js` beside the wrapper, and
  the wrapper reads them with `dataFile()` and passes them as `src` and
  `script`, the shape hand-written patterns already use.
- `IFRAME_PATTERN` takes `assets`: a directory path, which the wrapper passes
  as `dataFile.urls(path)`, or a record from a name to a file path, which it
  passes as `dataFile.url(path)` for each. Paths are relative to the contract.

## 7. Assets beyond one request

A data document is a code document: content-addressed, verified against its id
when the server stores it, and written with an idempotent blind write. A
client can therefore write each data document larger than some threshold in a
request of its own before the program, and send the program with a reference
to that document in place of the file's contents. The server reads a file sent
that way from the document the reference names, after checking that the space
holds it.

Each asset is then bounded by one request, about 3 MiB of bytes on a routed
deployment, and a program's assets together are not bounded by the program's
request. A single file larger than one request would need a document stored in
parts, which this spec does not propose.

This needs a change to the program a lifecycle request carries, which
`docs/features/server-pattern-lifecycle.md` describes, and to the path a client
uses when it writes a source set itself. The details are open.

## Not covered

- **Files people add.** A file a person picks or drops while using a pattern
  is runtime data, not program content, and is out of scope.
- **`<audio>` and `<video>`.** Neither policy admits media elements. Audio
  plays through Web Audio from `bytes()`. Video has no route.
- **A single file larger than one request.** See part 7.
- **References from script.** Part 4 replaces references in the guest's
  document only. A script that builds an element uses `fabric.asset(name).url`.

## Alternatives considered

- **Importing assets into the guest bundle.** `deno bundle
  --unstable-raw-imports` inlines `import x from "./x.png" with { type:
  "bytes" }` as base64 with a decoder. It needs no platform change and stays
  available to authors. As the platform's answer it has four costs: the image
  rides inside `guest.js` at a third over its size, every guest change rebuilds
  and stores it again, `<img>` needs the guest to build a `data:` URL itself,
  and a generated wrapper inlines it into each piece.
- **`dataFile()` returning a `data:` URL for a binary file.** One reader would
  return contents for some files and a URL for others, and SVG, which is text,
  would need a rule of its own. A separate reader keeps one meaning per call.
- **Assets as `$context` fields.** See part 4.
- **A CSS custom property per asset.** It would give CSS a second way to name
  an asset beside `cf-asset:`, and a custom property cannot appear in an
  `@font-face` `src`, so fonts would need a third.
- **An `@font-face` the host writes for each font asset.** The family's
  weight, style, and range are the author's to state, and `cf-asset:` in the
  author's own `@font-face` lets them.
- **Serving data files over HTTP from the host.** Loom's policy names no host
  for images, and the host origin differs by embedding.
- **Storing every long string in a result document by reference.** See part 1,
  "Why it is keyed to `dataFile`".

## Open questions

- Whether the view-tree read hands a linked prop to the reconciler as a cell or
  as the resolved string. Either works for a top-level prop. A link nested in
  the `assets` record may reach `cf-iframe` as a cell inside an object, which
  `cf-iframe` would then resolve itself.
- How `runtime/fuse` presents a binary data file in a piece's source: as its
  decoded bytes, or read-only in its stored form. It presents and accepts text
  today.
- How `cf-iframe` shows a reference to a missing asset: in its error state,
  which hides the guest, or as a reported error beside a guest that still
  loads.
- Part 7's threshold, and how a lifecycle request names a file it does not
  carry.

## Order of work

1. Part 1. It needs nothing else, and it removes the per-instance copy of
   `guest.html` and `guest.js` from every hand-written iframe pattern.
2. Part 2, with the inverse in `writeSourcePackage`.
3. Parts 4 and 5, with single files from `dataFile.url()`.
4. Part 3.
5. Part 6.
6. Part 7.
7. The live documents the change makes out of date: the five iframe guides
   under `docs/common/ai/`, `skills/pattern-iframe/SKILL.md`, the doc comment
   on `DataFileFunction`, and the data-file passages of
   `docs/specs/module-loading.md`.
