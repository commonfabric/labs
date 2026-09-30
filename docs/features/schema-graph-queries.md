# Schema graph queries, and the memory–runner seam

A schema graph query names a root document and a JSON Schema, and asks which
documents that schema reaches by following the links between them. Both halves
of the system ask that question. A client asks it to decide what to read and
what to keep watching. A memory server asks it to decide which documents a
subscriber's watch set covers, and which of them a write has invalidated.

The two must give the same answer. If a server thinks a schema reaches five
documents and a client thinks it reaches six, the sixth never arrives and the
client waits on a document nobody will send. So there is one implementation of
graph traversal, in `packages/runner/src/traverse.ts`, and the memory server
calls it. That is the reason for the import edge from `memory` to `runner`, and
it is the reason the edge is not going away.

## What the two packages exchange

`packages/memory/v2/query.ts` is the only file in `memory` that imports `runner`
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
  from the acting identity. The walk builds the read-only transaction the
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
- The rest is vocabulary the two sides name in common:
  `MapSetStringToPathSelectors` (the tracker), `schemaTrackerCoversSelector`
  (whether a tracker already covers a selector), `createSchemaMemo` and
  `SchemaMemo` (traversal results reused across walks), and the address and
  selector types.

Everything else about a query — the engine reads, the entity snapshots, the
watch bookkeeping, the branch and sequence handling — stays in `memory`.

## Sharing a tracker and a memo across walks

A walk owns its pointer-cycle tracker, which is what makes a cycle of documents
that link to each other terminate. It does not own the schema tracker or the
schema memo: those are handed in, so they can outlive any one walk and
accumulate across a whole query. A tracked graph keeps both — the tracker is
the query's accumulated reach, and the memo holds traversal results a later
walk can skip recomputing.

`trackGraph` gives every root of a query one shared walk. Re-evaluating a
document after a write gives that document a walk of its own, over the query's
existing tracker. A write-triggered refresh takes a fresh memo, so a retarget is
not answered from a memoized result computed before it; the memo keys on a
document address and a schema rather than on a value, so a memo carried across a
write can still answer with what that document used to reach.

## What this coupling costs

The edge is one import statement, but the module behind it is not a leaf.
`runner/src/graph-query.ts` imports `traverse.ts` and the extended storage
transaction, and those reach `cell.ts`, which reaches the runtime and its
builtins. Loading `packages/memory/v2/server.ts` therefore loads 459 modules and
210,000 lines, 267 of those modules from `runner` and the rest reached through
it — `js-compiler`, `llm`, and `html` among the packages that arrive this way.
Counting dynamic imports as well takes it to 596 modules.

The transactional core does not: `packages/memory/v2/engine.ts` reaches 124
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
