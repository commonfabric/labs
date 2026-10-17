# Immutable cell identifiers

An immutable cell names a frozen value without a stored document behind it.
`Runtime.getImmutableCell()` and inline array-element snapshots use compact
`snapshot:` URIs. The runtime also reads self-contained `data:` cell URIs.
Neither kind is an entity identifier, a write target, a replica document, or a
commit precondition.

## Native snapshots

`packages/runner/src/immutable-cell.ts` owns the native representation. An
`ImmutableCellStore` retains a frozen `FabricValue` and, optionally, the origin
against which links inside it resolve. The identifier contains the value's
standard Fabric content hash and, when present, the origin's hash:

```text
snapshot:<value hash>[:<origin hash>]
```

The payload and schemas are not embedded in the identifier. `cloneIfNecessary`
uses the data model's frozen-value machinery: a validated frozen graph passes
through by identity, a mutable container is copied and frozen, and its frozen
children are shared. `hashStringOf` uses the existing content hash and its
frozen-identity cache. The first hash of a fresh graph still visits its content;
subsequent creation from that frozen graph reuses the hash. Acyclic validation
uses the data model visitor and memoizes validated frozen roots; a frozen cycle
is rejected before registration.

Equal values and origins have equal identifiers, including across live runtimes.
This matters because a cell's identifier can participate in derived identity.
Object key insertion order does not affect identity. Origins do: identical raw
relative links in different documents can denote different values.

Each runtime and its transactions share an explicitly bound store. Graph query
transactions share the lifetime of their schema memo. An unbound transaction
cannot mint snapshots; transparent transaction wrappers inherit their owner's
store.

Explicit `getImmutableCell()` values remain owned until runtime disposal.
Array-element snapshots have a shorter ownership policy: their frozen source
value, live cells, annotated views, and exported link objects keep them alive.
Discarding a document version and its handles allows those snapshots to be
collected, even in a long-lived server runtime. Equal content and origin share a
snapshot. A bare URI string does not retain an element snapshot; use
`portableSnapshotId()` when the reference must outlive its source and handles.

A weak realm lookup lets link parsing and expansion resolve a URI without
retaining its runtime. Disposing one runtime does not invalidate another
runtime's adopted snapshot. Stores acquire dependencies in codec state, inline
schema defaults, available external schema closures, reader schemas passed to
`getImmutableCell()`, and saved origins. Registry registration notifies waiting
stores to acquire newly visible dependencies. The last owner's disposal or
collection invalidates the native identifier. Native IDs are not a persistence
or cross-process format.

## Relative-link origins

Creating an array-element snapshot stores the source's document ID, space, and
scope. It does not walk the value to rewrite links. The source path is omitted:
a primitive link's path is relative to its document's value root, not to the
array slot containing the link. Schemas remain in the frozen value.

`parseLinkPrimitive` substitutes the saved origin when resolving a link beneath
a snapshot. Nested snapshots inherit that same original origin. A relative link
therefore keeps pointing into the source document even when the snapshot is read
beneath its own identifier. An explicitly addressed link keeps its explicit
fields.

`Runtime.getImmutableCell()` takes data as given, without a source-document
origin. Builder artifacts and cells are converted through the usual intake, and
`fabricFromConvertibleJsValue` supplies the Fabric representation of JavaScript
instances. Identity-based renderer authority is not carried into an immutable
event snapshot. Marked events are copied using the existing data-model clone
machinery; ordinary frozen data remains shared.

Array traversal (`traverse.ts`), `resolveAsCell()` (`cell.ts`), and lazy schema
views (`schema-view.ts`) all create native snapshots. Their read dependencies
remain on the original mutable array element. Moving an inline element's value
behind an immutable ID changes its addressing, not what the computation depends
on. `resolveAsCell()` reads the containers on its way to an element for their
shape alone, so a transaction that resolves a cell inside a document depends on
that element and on the keys along the path, not on the rest of the document.
`resolveAsCell({ inlineArrayItemsInPlace: true })` names the element at its
stored address instead and mints nothing, for a caller that looks the target up
and keeps no handle to it. A link or an explicitly declared cell handle already
has its own identity.

Traversal snapshots inline object or array elements read as values. An element
requested as a cell keeps its array-slot address. A context with
`inlineArrayItemsInPlace` traverses inline elements at their stored addresses
without minting snapshots. `GraphQueryWalk` enables this for memory-server
schema queries, which select stored documents rather than return value-identity
objects.

## Schemas and outbound values

A snapshot retains a link's schema as given, including a content-addressed
`cid:` reference. One taken from storage is addressed in the source
document's space, whose schema documents arrived with the source, and a
reference inside it resolves there. One minted by `getImmutableCell()` from
unstored input has no origin, and no space holds the closure behind its
references; a reader resolves them in the schema registry, which minted them
(`mintedFromUnstoredValue`). An element snapshot read out of either is
classified by the document at the root of its origins. The portable
boundaries alone still put link schemas into inline form
(`inlineExternalSchemaRefsInValue`): a `data:` identifier, a value crossing
the runtime boundary, and the content identity two snapshots compare by.

A stored write (`normalizeAndDiff`) expands immutable links through
`findAndInlineDataUriLinks`, including immutable defaults inside an ordinary
document link's schema. Both `snapshot:` and the Fabric `data:` media type
expand to their contents; nested immutable links are
expanded in turn, including links held in schema defaults. Relative links are
materialized against the saved origin at this boundary. An ordinary
stored-document link stays a link. A path into an immutable value selects the
addressed subvalue; encountering another link on that path appends the remaining
path to it.

`Cell.getRawUntyped()` also materializes relative links before handing a native
snapshot's value to a caller. The raw value can then be written into a different
document without changing what its links denote. Containers are copied only
where a link is rewritten.

A `FabricPrimitive` remains a leaf. At the inlining boundary, a `FabricInstance`
supplied directly or as the entire immutable payload is refused. Below a
payload's root, codec-mediated traversal expands links in instance state before
a stored write. A stream send refuses a directly supplied instance during
cell-to-link conversion; an immutable link keeps its carried contents behind
the link.

Local stream delivery retains native immutable links so handlers can compare
array-element identities. With server execution enabled, `Cell.send` converts
those links to self-contained `data:` links before durable append, same-space
serving dispatch, or the client echo. The append and echo carry the same event.
`Cell.equals()` and link equality compare canonical content hashes after normalizing links and schema closures in both
native and legacy values
when two immutable IDs differ, preserving equality across native and portable
forms. Space, scope, and path must still agree. Relative links are resolved
against each snapshot's origin before this comparison, so equal raw links from
different origins need not compare equal.

Snapshot identifiers do not travel through stored values or across runtime
boundaries. Offline traversal capture converts native IDs and embedded snapshot
links to portable `data:` IDs before writing a fixture. A captured schema document
whose contents change receives a new content address, and the fixture's schema
references follow that address. Replay normalizes read IDs using the fixture
minting policy, so runtime lifetime does not affect the oracle. SQLite
`_cf_link` columns also store a self-contained `data:` link when given an
immutable cell: the column is a link string whose contents must survive runtime
disposal. These explicit string boundaries pay the encoding cost.

## Self-contained data URIs

`packages/data-model/src/codec-data-uri.ts` implements the portable encoding:

```text
data:application/vnd.common-fabric.data,<payload>
```

The payload is base64url of UTF-8 text containing the `fvj1:`-tagged Fabric JSON
encoding. The media type is `DATA_URI_MEDIA_TYPE`; there are no media-type
parameters. `dataUriFromValue` encodes a `FabricValue`, and `valueFromDataUri`
decodes and freezes it. It rejects other media types, malformed base64url, an
empty payload, and untagged JSON. A raw `?` or `#` starts a query or fragment
and is excluded from the payload.

`dataUriFromValueWithResolvedLinks` prepares a self-contained URI by rewriting
primitive links against a base before encoding. Its companion
`dataUriSnapshotWithResolvedLinks` also returns a value suitable for traversal
under that URI. `undefinedDataLink()` uses the portable encoding for its small,
constant undefined result. Native snapshots do not need either encoding walk.

## Storage and routing

The payload is always the cell's **value**, not its document. Storage readers
synthesize the frozen `{ value: payload }` document wrapper, which lets the
address grammar use `["value", …]` paths without allowing payload properties to
impersonate document facets such as `cfc` or `source`. Native reads retrieve the
frozen value directly. Portable reads decode through the attestation loader and
use its bounded decode cache.

Two runner predicates preserve distinct routing questions:

- `hasInlineCellScheme` accepts `snapshot:` and every `data:` media type. It
  answers whether an address is inline and must not be fetched, written, or
  validated as a replica document.
- `isInlineCellId` accepts `snapshot:` and only the Fabric `data:` media type.
  It answers whether the runtime can expand this identifier to a value.

The underlying legacy codec keeps `hasDataUriScheme` and `isFabricDataUri` for
callers that deal only with portable IDs. A foreign `data:` media type is left
alone by value expansion and is refused by the storage loader with
`UnsupportedMediaTypeError`. It is never sent to a replica as a document to
fetch. The inlining predicate and `normalizeAndDiff` agree so that a refused
foreign media type cannot cause endless recursive expansion.

Writes to either immutable scheme fail with `ReadOnlyAddressError`. Transaction
reads and batched read tracking exclude them from commit preconditions;
replication plans and server read sets exclude them as well. Sync walks their
embedded links and loads the referenced ordinary documents, using the snapshot
origin for relative links. Completed shared-subtree visits are memoized by
value, addressing context, reader schema, and principal; only active ancestors
are treated as cycles. There is no immutable document itself to sync.

`toURI` accepts either scheme. `fromURI` hashes the entire identifier instead of
stripping an entity scheme. `hasEntityUriScheme` returns false and
`entityKindOfIdString` returns undefined.

## Related documents

- [Computed cell identity](../specs/computed-cell-identity.md)
- [Identity and references](../specs/space-model/3-identity-and-references.md)
- [The memory protocol](../specs/memory-v2/04-protocol.md)
