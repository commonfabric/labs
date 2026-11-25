# Schema graph queries, and the memory–runner seam

A schema graph query names a root document and a JSON Schema, and asks which
documents that schema reaches by following the links between them. Both halves
of the system ask that question. A client asks it to decide what to read and
what to keep watching. A memory server asks it to decide which documents a
subscriber's watch set covers, and which of them a write has invalidated.

The two must give the same answer. If a server thinks a schema reaches five
documents and a client thinks it reaches six, the sixth never arrives and the
client waits on a document nobody will send. So there is one implementation of
graph traversal, in `runtime/runner/src/traverse.ts`, and the memory server
calls it. That is the reason for the import edge from `memory` to `runner`, and
it is the reason the edge is not going away.

## What the two packages exchange

`runtime/memory/v2/query.ts` is the only file in `memory` that imports `runner`
for the graph query, and everything that query needs comes from one place:
`@commonfabric/runner/graph-query`.

`memory` reaches `runner` for one other thing, and reaches it by relative path
rather than through a package export: `query.ts` imports `schema-registry.ts`,
the realm-wide registry of verified schema documents that result assembly
registers into. The vocabulary of content-addressed schema references — the
reference form and its scan, the grammar of the `schema` metadata member, the
subschema walk, and the walk over a document's `$ref` closure — lives in
`@commonfabric/data-model-schema`, below both packages, and `query.ts` and
`v2/engine.ts` take it from there.

The registry is a different subject from graph traversal, and it is what is
left to fold in — by exporting it, or by moving it below both packages. The
traversal seam described below is already narrow.

The graph-query module holds the driver: it takes documents from wherever the
caller keeps them, walks them under a schema, and records what it reached.

- `ObjectStorageManager` is the whole of what the caller must provide — one
  method, `load(address)`, returning a document or `null`. `memory`'s
  `EngineObjectManager` implements it over the SQLite engine, reading at a
  branch, a sequence number, and a principal.
- `GraphQueryWalk` is the walk. Construct one over a manager, a space, a
  schema tracker, and the acting identity the walk's tracker keys resolve
  scoped addresses against; call `visit(document, selector)` for each root.
  A root that names an explicit scope instance passes its key as `visit`'s
  third argument, and records under THAT instance rather than one resolved
  from the acting identity. A link the walk follows resolves under the acting
  identity, and a walk acting as a principal with no session follows no
  session-scoped link; "One graph per acting identity" below says which
  identity `memory` walks a root under. The walk builds the read-only
  transaction the
  traverser reads through, carries the pointer-cycle tracker that stops a
  link loop, and loads, for every document it delivers, the schema document
  its `cfc` labels are stated against, which a reader needs in order to
  interpret what it found. No other metadata link is followed: a caller that
  wants the target of a document's `pattern`, `argument`, `result`, or
  `internal` link names it (`../specs/memory-v2/05-queries.md`, "Metadata /
  Provenance Resolution").
- `schemaTrackerKey(space, id, scope, identity)` is the key a walk records
  under: one entry per scope INSTANCE, the middle segment the shared
  `scope_key` vocabulary resolved from the scope and the acting identity
  (key-vocabulary.md §1 sites 5-6). Both packages need to build one —
  `memory` to look up what a write invalidated, `runner` to record what a
  traversal reached — so there is one function and both call it, including
  the coverage check in `isLinkedDocumentCovered` for links that declare a
  scope. An unscoped link refuses coverage explicitly instead of looking up
  a key no writer produces — deliberately preserving the pre-existing
  never-covered outcome for those links, because letting the coverage memo
  fire for them changes which documents a traversal re-walks and what
  consumers of traversed values observe; see the OFF-ARM NEUTRALITY note at
  that site for what gates enabling it.
- A walk reports each tracker record it makes, or finds the tracker already
  holding, to the `onTrackedDoc` hook of its options: the record's tracker
  key and selector, and the referrer whose walk needed it, which is the key
  (`trackedRecordKey`, one document under one selector) of the record
  walking the document that holds the link that was followed, or whose
  schema or `cfc` envelope named a schema document, or the referrer
  `visit()` was given for a root. A document is walked under the
  record a visit or a followed link entered it by while the traversal of
  the position that entered it lasts, which the traversal reports through
  `TraversalContext.records`. Misses and crossings are reported by record
  in the same way. `memory` attributes its tracker with that, so a
  document nothing reaches any more can leave a session's result
  (`../specs/memory-v2/04-protocol.md`, section 4.6.3), and a record that
  retires releases what its own walk reached without a walk.
- A memoized result keeps what its position reported to the record that was
  walking that position's document when the position began
  (`RecordWalk.positionOf()`), and names each memoized position a memo hit
  inside it stood for, so it stands for what those positions reached as
  well. A memo hit reports the same again for the record walking the
  document now (`RecordWalk.replay()`), so every record of a document that
  traverses a position is attributed that position's reach. A hit for the
  record that memoized the position, in the same visit, reports nothing,
  since what it attributed stands, and a replay reports to a record only
  what it has not made or stood for in that visit. A document visited again,
  as a root added again, a covered root walked on its own, or a document
  walked again for its attributions, is attributed all it reaches in the
  same way. A memo hit naming a record the tracker no longer holds is
  traversed instead, because that record's own reach left with it. Two kinds
  of position are replayed only for the record that memoized them, in the
  same visit, since their range lacks something another record's traversal
  of them would attribute: the first position of a record whose walk
  followed the document's own links before the position began, as resolving
  a link through to its target can, and a position whose traversal the
  cycle tracker cut short at a traversal that began outside it
  (`CompoundCycleTracker.openSpan()`). A position enclosing one of those
  hits is then of the same kind. A memo
  key names a document by its scope, so the positions of a scope instance a
  visit names explicitly are memoized under that instance as well
  (`RecordWalk.positionOf()`).
- The rest is vocabulary the two sides name in common:
  `MapSetStringToPathSelectors` (the tracker), `schemaTrackerCoversSelector`
  and `coveringSelector` (whether a tracker already covers a selector, and
  which record does), `createSchemaMemo` and `SchemaMemo` (traversal results
  reused across walks), and the address and selector types.

Everything else about a query — the engine reads, the entity snapshots, the
watch bookkeeping, the branch and sequence handling — stays in `memory`.

## Sharing a tracker and a memo across walks

A walk owns its pointer-cycle tracker, which is what makes a cycle of documents
that link to each other terminate. Walks within one evaluation share a schema
memo, so repeated visits can reuse their traversal results. The memo is released
when that evaluation finishes. Establishment, extension, root removal, and dirty
refresh each take a fresh memo.

A tracked graph keeps its tracker and the attributions that say which roots and
links keep each record alive. That is the state later operations need to
preserve delivery and retire unreachable documents. Coverage in this tracker
lets an extension skip already-covered links without retaining the narrowed
values computed by past evaluations.

Memo keys contain a document address and schema, not a document revision or the
current set of watch roots. Keeping those results across evaluations would
retain obsolete schemas and could reuse results whose traversal effects have
retired. A cache shared across evaluations must instead validate revisions and
replay effects; a bare schema memo has neither contract.

## One graph per acting identity

A serving session may name another identity's instances of scoped documents on
a root (`entityScopeKeys`; `../specs/server-side-execution/protocol.md`, §2's
read row). The map names an identity: the principal of its `user` entry, with
the session of its `session` entry where it holds one. `memory` splits a query
by the identity each root is walked under (`partitionGraphQuery()` in
`runtime/memory/v2/query.ts`). The roots whose maps name one identity that is
not the session's own are walked under that identity, in a tracked graph of
their own, and every other root is walked under the session's identity. A link
followed from such a root therefore resolves to the entry the root carries for
the link's scope, as it does in a walk that identity's own session runs.
`trackGraph()` and `extendTrackedGraph()` refuse a root whose map is malformed,
or names an identity other than the one they walk under, since walking it
there would record the document under that identity's own instance as well.

A session then holds one graph over a branch for each identity its roots are
walked under, keyed as `watchGraphGroups()` in
`runtime/memory/v2/server-sync.ts` keys them. Each graph has a tracker of its
own, so a document two of them reach is walked once in each and delivered
once, and a document one of them retires is retracted only when no other graph
of the session over that branch tracks it.

A map holding a `user` entry alone names a principal and no session, and so a
different identity from a map of the same principal that holds a `session`
entry. The walk of a root carrying one follows no session-scoped link, since
its identity resolves no instance of that scope, and counts each link it leaves
(`GraphQueryWalkStats.unresolvedLinkScopes`). An evaluation that left one is
not kept in the evaluation cache, since a walk under another identity would
reach more. A walk under an identity that names no principal fails at a
user- or session-scoped link.

## What this coupling costs

The edge is one import statement, but the module behind it is not a leaf.
`runner/src/graph-query.ts` imports `traverse.ts` and the extended storage
transaction, and those reach `cell.ts`, which reaches the runtime and its
builtins. Loading `runtime/memory/v2/server.ts` therefore loads 459 modules and
210,000 lines, 267 of those modules from `runner` and the rest reached through
it — `js-compiler`, `llm`, and `html` among the packages that arrive this way.
Counting dynamic imports as well takes it to 596 modules.

The transactional core does not: `runtime/memory/v2/engine.ts` reaches 124
modules and 35,000 lines, none of them from `runner`, since the
content-addressed schema vocabulary it validates commits with sits in
`@commonfabric/data-model-schema`. The engine is a runner-free store; what the
runtime's weight attaches to is the query and delivery layer above it, through
the seam this document describes.

Those figures are the static closure over value imports, which
`deno info --json <entry>` reports: walk `dependencies[].code` from the root,
skipping `isDynamic` edges, and count the `file://` modules. They drift upward
as the runtime grows, so measure again rather than quoting them.

That is the honest measure of the coupling, and it is larger than the traversal
seam this document is otherwise about: `memory` depends on the runtime to
resolve a query and to store a schema alike. Anyone weighing an extraction of
`memory` should start from those two dependencies rather than from the package
graph, which shows a single edge.

Narrowing it further means separating graph traversal from `cell.ts` and the
runtime, not moving the query driver around. Removing it altogether means
giving up the single-implementation guarantee this document opens with, and
that is not a trade worth making.
