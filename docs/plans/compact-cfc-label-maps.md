# Compact CFC label maps

Status: proposed; the representation and reader migration below are
unimplemented.

## Goal and boundary

Preparation of a staged reference diamond should depend on the graph's distinct
label subtrees and the policy queries it answers, rather than the number of
root-to-leaf paths. Each path must retain exactly its confidentiality,
integrity, origin, and observation class. The
[reference initialization contract](../specs/cfc-protected-initialization.md)
also requires staging-order independence and finite views of valid object
cycles.

The shared-result cache avoids repeated recursive derivation within a metadata
snapshot. It still constructs and persists a flat list of paths. At depth 12, a
binary diamond has 25 staged references and 14 documents, but its prepared maps
contain 24,560 entries and serialize to approximately 3 MB. Increasing depth
adds paths exponentially. The
[measurement record](../history/development/performance/2026-09-25-staged-reference-cache/README.md)
separates preparation time from serialized map size.

This work requires both a shared internal representation and a versioned stored
representation. Encoding a compact map and eagerly decoding it to `entries[]`
would retain exponential preparation and read costs. It would also make a small
envelope capable of exhausting reader memory.

## Representation to prototype

Use an immutable path trie whose equal subtrees share nodes, forming an acyclic
graph. A node holds entries at its relative root and edges labeled with exact
path segments. Two edges, such as `p0` and `p1`, may point to the same child
node. Existing `*` segments retain their wildcard semantics; combining concrete
siblings never invents a wildcard. Labels, origin, and observation class all
participate in subtree equality. Empty labels and absent observation classes
retain their meanings.

Sharing captures a label snapshot. An edge refers to an immutable subtree in the
same label map, never to a source document's live metadata. Updating a source
must not retroactively change a receiver's persisted policy. Document identity,
space, scope, media type, writer evidence, and cross-space transformations
remain inputs to derivation. Structurally equal results may share only after
those checks complete.

Prototype a deterministic document-local node table with a root index, typed
entry payloads, and segment-to-child edges. Require each child to precede its
parent in the table, allowing iterative validation and excluding cycles. Reuse
the repository's canonical label and serialization machinery for subtree
equality. Preserve entry encounter order wherever policy code depends on it;
establish that contract before choosing the final encoding.

The representation holds finite label views. Object cycles in the value graph
continue to use the derivation walk's finite projection rules; they do not
create cycles in the node table.

## Query boundary before storage

Replace policy consumers' reliance on a fully expanded `labelMap.entries` with
operations over either a flat map or a shared map:

- Authoritative longest-prefix cover, including equal-depth alternatives and
  observation-class selection.
- Ancestor and descendant overlap for concrete and wildcard reads, preserving
  read depth and origin filtering.
- Prefix attachment, rebase, merge, and coalescing, preserving distinct labels
  and classes at the same path.
- Aggregate confidentiality and integrity queries without enumerating every
  equivalent path.
- Explicit path enumeration for display or export, with a limit or continuation.
  Policy queries never silently omit entries to meet a limit.

Memoize queries by immutable node identity plus their complete state: remaining
path, observation class, depth, and applicable origin rules. Memoize merges by
their node pair and complete merge context. Preparation must retain sharing
through prefixing and merging, rather than flattening between recursive calls.

Start at `ConsumedLabelIndex`, the verifier metadata resolver in `prepare.ts`,
and `label-view-core.ts`. Inventory every flat-map loop, including write floors,
carried-view validation, schema labels, flow persistence, label-metadata
introspection, and cross-space protection. A compact map is not ready to write
while a policy reader can turn it into an unbounded flat array.

## Stored format and deployment

Use a new envelope version, provisionally version 3, and a new label-map
version. Versions 1 and 2 keep their meanings. Centralize validation in
`metadata.ts` and retain the
[fail-closed envelope rule](../specs/cfc-stored-envelope.md). Unknown versions,
invalid indices, malformed or duplicate edges, invalid entries, and unresolvable
labels refuse the read. Define limits on input nodes, edges, and operation work;
exhaustion refuses explicitly rather than returning an empty map. Choose limits
using measured workloads and existing storage limits before enabling writes.

Reuse version 2's label-document references in node payloads where beneficial.
Update label-reference discovery and commit-closure validation to scan nodes
without expanding paths. In particular, `label-documents.ts` and
`packages/memory/v2/engine.ts` must agree on the complete referenced-document
set. Cold sync and cross-space copying must deliver that closure with the
envelope, independently of the author's in-memory label registry.

Ship readers before writers. Register an experimental writer option in
`EXPERIMENTAL_OPTIONS.md`, off by default until deployed readers and validators
support the format. Older readers refuse version 3, preserving policy while
making those documents unavailable to them. Disabling the writer stops new
version-3 writes; it does not make existing documents readable by older builds.
Do not down-convert a large shared map by expanding every path.

## Implementation sequence and acceptance

1. Implement shared-map operations behind the existing flat format. Compare each
   operation against its flat equivalent on bounded maps. Include literal
   `value`, escaped segments, wildcards, duplicate paths, empty labels, every
   origin and observation class, and label alternatives.
2. Move derivation and policy queries to that abstraction. Demonstrate bounded
   query and derivation work with structural counters. Keep the writer unchanged
   and expand only small graphs for the test oracle.
3. Add the versioned reader and validator with adversarial envelope tests.
   Verify label references through cold sync, commit closure, and cross-space
   copying.
4. Add the gated writer. Compare semantics against both existing formats in both
   staging orders. Exercise confidentiality, integrity floors, carried readers,
   object cycles, pointer cycles, metadata protection, and unreadable envelopes.
5. Measure size ladders beyond the flat format's practical range: preparation
   time, query time, visited nodes, serialized bytes, and retained memory
   separately. Require growth tied to distinct subtrees for homogeneous
   diamonds; graphs with distinct policies can remain large because their output
   is distinct. Keep chains and small transactions as controls. Enable
   production writing only after compatibility and performance gates pass.

Open decisions are the stable node encoding and entry order, resource budgets,
writer option and rollout ownership, and compact transport for link-carried
`CfcLabelView` payloads. Leaving carried views flat can reintroduce the same
growth outside the envelope and must be measured in the end-to-end gate.
