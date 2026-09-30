# `data:` cell identifiers

A `data:` identifier is a cell identifier that carries a frozen value inside
the identifier string itself. A cell identified this way is read by decoding
its own identifier. There is no document stored in a space behind it, so there
is nothing to fetch, nothing to sync, nothing to write, and no commit
precondition to state about it.

Code in `packages/runner` branches on this distinction in many places — in the
storage transaction, in the sync layer, in link resolution, in query traversal,
and in the confidentiality-contract checks. This document explains what the
distinction means, so that meeting one of those branches does not require
reconstructing the concept from the branch itself.

## How it differs from an entity identifier

An ordinary cell is named by an entity identifier: a content-derived hash
carried under an entity URI scheme. `packages/runner/src/entity-kind.ts`
defines the set of those schemes in `ENTITY_URI_SCHEMES` — `of:` for the
unkinded default, and `computed:` for entities whose contents the runtime that
minted them can re-derive. Both name a document that lives in a space, is
fetched from a replica, participates in conflict validation, and can be written
to.

A `data:` identifier is not an entity identifier and carries no entity kind.
`hasEntityUriScheme` returns false for it, and `entityKindOfIdString` returns
`undefined`. Two helpers in `packages/runner/src/uri-utils.ts` treat it
specially rather than by scheme-stripping: `toURI` accepts an already-schemed
`data:` string as a valid URI, and `fromURI` returns the hash of the whole URI
string rather than trying to strip a scheme off it.

The practical difference is that everything a document identifier implies —
a replica to pull from, a sequence number, a conflict domain, a write target —
is absent. The identifier is the content.

## The shape of the identifier

The single media type this codebase mints is
`application/vnd.common-fabric.data`, exported as `DATA_URI_MEDIA_TYPE` from
`packages/data-model/src/codec-data-uri.ts`. A minted identifier looks like
this:

```text
data:application/vnd.common-fabric.data,<payload>
```

The payload is base64url of UTF-8 text, and that text is the standard
`data-model` JSON-embedded encoding of a `FabricValue`, which carries the
`fvj1:` prefix tag. There are no media-type parameters: no `;charset=` and no
`;base64`, because the payload encoding is fixed. `extractDataUriPayloadText`
takes the surface syntax apart, returning everything between `data:` and the
first comma verbatim as the media type. Per the URL grammar, a raw `?` or `#`
after the comma starts a query or fragment; everything from that delimiter
onward is ignored.

## Minting one

There are two mint functions, and they differ in whether they prepare the value
first.

`dataUriFromValue(value)` in `packages/data-model/src/codec-data-uri.ts` is the
single place the identifier's shape is assembled: scheme, media type, and
base64url payload. It does no preparation of the value at all; callers hand it
a ready `FabricValue`.

`dataUriFromValueWithResolvedLinks(data, base?)` in
`packages/runner/src/data-uri.ts` prepares the value first, then calls
`dataUriFromValue`. Its preparation is a walk that rewrites each primitive cell
link within `data` into a full sigil link, resolving relative links against
`base`. That rewriting is what makes the resulting identifier self-contained:
the identifiers it embeds no longer depend on where the value was minted, so
the identifier denotes the same value wherever it is later read. The walk
throws if `data` contains a reference cycle. It lives in the runner rather than
in the codec because it needs the cell and link machinery, which `data-model`
does not have.

The walk rebuilds a container only when a link under it was rewritten;
everything else it hands back by identity, so a value carrying no link at all
reaches `dataUriFromValue` as the objects the caller passed in. A value that
has no fabric representation, such as a `Date` or a `Cell`, therefore reaches
the encoder intact and is refused there, instead of arriving as a plain object
with none of its content.

Because the standard encoding canonicalizes plain-object key order, two
runtimes holding the same value mint the same identifier regardless of the
order in which the keys were inserted. That is the property that makes this
content addressing rather than merely content embedding.

Representative places that mint one:

- `Runtime.getImmutableCell()` in `packages/runner/src/runtime.ts` boxes a
  caller-supplied value into a cell. It calls `dataUriFromValue` directly on
  the result of `fabricFromConvertibleJsValue(data)`, deliberately skipping the
  link-rewriting walk, because the data is immutable as given.
- `undefinedDataLink()` in `packages/runner/src/link-resolution.ts` produces
  the link that a blocked or dead-ended link chain resolves to: an identifier
  encoding `undefined`, so the chain ends in undefined data in place.
- `resolveAsCell()` in `packages/runner/src/cell.ts` re-roots a link whose path
  passes through an array element. Its helper
  `maybeConvertArrayPathToDataURILink` encodes that element's value into a
  `data:` identifier and keeps the rest of the path. The read dependency remains
  on that mutable inline element, because its content determines the snapshot's
  identity. Changes to the element cause a reactive reader to resolve it again;
  changes to another array element do not require that reader to rerun.
- Query traversal in `packages/runner/src/traverse.ts` substitutes a `data:`
  document for an array element it needs to read recursively.
- The lazy schema view in `packages/runner/src/schema-view.ts` does the same for
  an array element that is an inline object, when the reader touches it. The
  element's value is already in hand, so the identifier costs no read. Without
  it `toCell` on such an element would name the array's INDEX, and writing that
  link anywhere else would follow whatever landed at that index next.

## Reading one

`valueFromDataUri(uri)` in `packages/data-model/src/codec-data-uri.ts` extracts
and decodes the payload. It accepts exactly the shape `dataUriFromValue`
writes, and throws for anything else — a different media type, a payload that
is not base64url, an empty payload, or bare JSON where the `fvj1:`-tagged
encoding is required. The two halves are also exported separately:
`extractDataUriPayloadText` splits the identifier and base64url-decodes it, and
`valueFromDataUriPayloadText` decodes that text into a value. Decoded results
are deep-frozen.

`findAndInlineDataUriLinks(value)` in `packages/runner/src/data-uri.ts` works
the other direction from minting: it walks a value looking for links whose
identifier is a `data:` URI of this codebase's media type, and replaces each
with the value that identifier carries. If the decoded payload has another link
on the way to the link's path, that link is followed instead, with the
remaining path segments appended to it. A link carrying any other media type is
returned as it came in, on the same footing as a link naming a document in a
space.

### The payload is the value, not the document

The payload encodes the cell's **value**. The document view that the address
grammar requires — paths rooted at `["value", …]`, plus the document's facet
paths — is not in the payload. It is synthesized on read, by `load()` in
`packages/runner/src/storage/transaction/attestation.ts`, which is the one
reader that thinks in documents. `load()` decodes the payload and wraps it as
`{ value: <decoded> }`, frozen. Because the wrapper is built here rather than
taken from the payload, payload content can never alias a document facet such
as `cfc` or `source`. Results are cached by identifier, so decoding the same
identifier repeatedly costs one parse.

## The two tests, and why both exist

Two predicates in `packages/data-model/src/codec-data-uri.ts` answer different
questions, and they are used at different points of the same path. Swapping one
for the other changes behavior.

`hasDataUriScheme(id)` is the **broad** test. It examines only the scheme, so
every media type counts and the payload is neither decoded nor validated. It
answers the storage layer's question: is there a document to fetch at all? Any
`data:` identifier means no, whatever the media type says.

`isFabricDataUri(id)` is the **narrow** test. It accepts only
`data:application/vnd.common-fabric.data`, the one media type this codebase
mints. It answers a reader's question, asked immediately before decoding: is
this mine to decode? A reader that decodes without screening does not get a
wrong value, because `valueFromDataUri` checks the media type itself and
throws. Screening first is what lets a reader tell "not mine" apart from
"mine but malformed", and report each differently.

The load path shows both in sequence. `loadRoot` in
`packages/runner/src/storage/v2-transaction.ts` uses the broad test: any
`data:` identifier is routed to the attestation loader (imported there as
`loadInline`) instead of to `branch.replica.getDocument()`. The loader then
applies the narrow test, and turns anything that is not this codebase's media
type into an `UnsupportedMediaTypeError`; a payload that fails to decode
becomes an `InvalidDataURIError`. Using the narrow test at the routing step
instead would send, say, a `data:text/plain,…` identifier to the replica to be
fetched as though a document existed for it, rather than reporting an
unsupported media type. Using the broad test inside the loader instead would
have it try to decode payloads in encodings it does not speak.

The confidentiality contract code makes the same split. `eventEnvelopePayloads`
in `packages/runner/src/cfc/ui-contract.ts` screens an event link with the
narrow test before calling `valueFromDataUri` on it, so a `data:` link of some
other media type simply contributes no authoring context.

The inlining path uses the narrow test at two points that have to agree.
`findAndInlineDataUriLinks` screens with it before decoding.
`normalizeAndDiff` in `packages/runner/src/data-updating.ts` screens with it
before re-entering itself on that call's result, which is progress only when
the call replaced the link with the content behind it. Using the broad test at
either point breaks the agreement. At the first, the decode throws on a media
type it does not speak, and the throw escapes the whole walk rather than
leaving one link alone. At the second, the re-entry repeats on a link the
inlining call handed back unchanged, until the stack runs out. Both screening
narrowly, a foreign media type is simply an ordinary link: a write stores it
as one, and a read through it reports the media type as the loader's
`UnsupportedMediaTypeError`.

As a rule of thumb: the broad test belongs anywhere the question is about
documents — fetching, syncing, writing, recording a read, stating a commit
precondition. The narrow test belongs at the point where a payload is about to
be decoded.

## `data:` addresses are read-only

Writing to a `data:` address fails with `ReadOnlyAddressError` (defined in
`packages/runner/src/storage/transaction-errors.ts`). `writeWithinBranch` in
`packages/runner/src/storage/v2-transaction.ts` returns that error before doing
anything else, and every write on a `data:` address funnels through it. There
is no way to change what such an identifier denotes: a different value is a
different identifier.

## No document, no sync, no precondition

The rest of the branching follows from there.

Reads are not recorded as commit preconditions. `read` and `trackReadPaths` in
`packages/runner/src/storage/v2-transaction.ts` skip pushing a read activity
for a `data:` identifier and skip marking the document validated, and
`buildReads` in `packages/runner/src/storage/v2.ts` drops such reads from the
set it assembles. The memory protocol states the same rule on the wire:
inline `data:` document reads are local-only and must not be serialized into
`ClientCommit.reads`, because they have no server sequence and do not
participate in conflict validation (see
[the memory protocol spec](../specs/memory-v2/04-protocol.md)).

Nothing is pulled for one. `shouldPullDoc` in
`packages/runner/src/storage/v2.ts` returns false, and `syncCell` routes to
`syncDataURICell`. What that syncs is not the identifier — there is nothing to
fetch for it — but the documents that the links embedded in its decoded
payload point at.

The traverse capture and replay fixtures skip them too: `captureDoc` in
`packages/runner/src/traverse-recorder.ts` returns early, because replay
decodes the identifier directly rather than replaying a stored document.

## Related documents

- [Computed cell identity](../specs/computed-cell-identity.md) — the
  `computed:` entity URI scheme, and why an entity's URI string, scheme
  included, is its identity.
- [Identity and references](../specs/space-model/3-identity-and-references.md)
  — entity identifiers and the sigil link format that `data:` links use.
- [The memory protocol](../specs/memory-v2/04-protocol.md) — the wire rules,
  including the local-only treatment of inline document reads.
