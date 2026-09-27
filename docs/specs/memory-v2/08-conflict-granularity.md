# Commit-conflict granularity

This note describes how Memory v2 decides whether a committing transaction's
**reads** conflict with concurrent **writes**, and the four refinements that
make distinct, non-interacting operations stop colliding.

## The model

A commit carries a read-set (`confirmed` / `pending`) and a set of write
operations. On commit the server checks, for each read, whether any write with a
higher `seq` on the same entity invalidates it (`findConflictSeq`). The check is
two-tier:

- **Tier-1** (`set` / `delete`): path-**blind**. A whole-document set or delete
  conflicts with *any* read of that entity — the document the reader observed no
  longer exists in the form it saw.
- **Tier-2** (`patch`): path-**aware**. A patch conflicts with a read only if a
  touched path overlaps the read path.

The conflict a read reports is the newest `set` or `delete` after its basis,
whatever its path, when there is one, and otherwise the newest overlapping
patch.

The reads of one commit commonly share a document and a basis — a per-key write
of K keys reads K paths of one map — so a scan of the patches after a basis
indexes their touched paths, newest first, and a scan that reaches the last of
them serves every later read of the same document, basis and exclusion. Such a
read is decided from the index in time proportional to its path's depth,
whatever the number of patches. A read that conflicts stops the scan at the
patch it conflicts with. The index decides exactly what the predicates the
sections below name, `patchOverlapsRead` and `patchOverlapsNonRecursiveRead`,
decide; they remain the definition of a Tier-2 conflict.

The bug this note addresses: two writers touching **different keys of the same
container** (e.g. `votes.alice` and `votes.bob`) collided at Tier-2 even though
neither logically depended on the other, exhausting the retry budget and dropping
writes under contention. Three independent sources of spurious dependencies
produced that collision; each is removed at its own seam.

## 1. Recursive reads use leaf-only touched paths

`touchedPathsForPatch` historically injected a patch's **parent** path for
`add`/`remove`/`move`, so a key add to `["value","map","k"]` also "touched"
`["value","map"]`. For a **recursive** read that parent path is:

- **redundant** — bidirectional `pathsOverlap` already matches a container reader
  (`["value","map"]`) against the leaf write (`["value","map","k"]`), because the
  container read is a *prefix of* the leaf; and
- **harmful** — the injected parent also prefix-matches every disjoint **sibling**
  reader (`["value","map","j"]`, a distinct-key writer's own-key/diff and
  link-resolution reads), whose value did not change.

`patchOverlapsRead` now uses **leaf-only** touched paths (`touchedLeafPathsForPatch`)
— the same discipline already applied to the scheduler reader-dirty index
(CT-1623). Same-key writes still conflict (the leaf exactly matches an own-key
read); whole-container and keyset readers still conflict (their read prefixes the
leaf). Only the spurious sibling match is dropped. The one shape where leaf-only could
miss a conflict — an array **index shift** — never arises from the runner; see
[Array writes and the leaf-only matcher](#array-writes-and-the-leaf-only-matcher)
below.

### Array writes and the leaf-only matcher

Leaf-only matching has exactly one blind spot: an `add`/`remove`/`move` whose
target is an **array index**. Such an op *shifts* sibling elements, but its leaf
path captures only the touched index — so a recursive reader of a shifted sibling
(`arr/5` after an insert at `arr/2`) would neither conflict on commit nor
re-trigger via the (also leaf-only) reader-dirty index. That would be a silent
stale read.

This is safe because **the runner never emits an indexed-array
`add`/`remove`/`move`**. `buildArrayPatchCandidates`
(runner `storage/v2-transaction.ts`) encodes every array change as one of three
shapes, all of which both the leaf-only commit matcher and the leaf-only
reader-dirty index handle conservatively:

- **in-place element change** → `replace` at `arr/i` (leaf-exact; no shift);
- **tail grow / shrink** → a `splice` whose path **is the array** (`arr`), which
  prefix-matches every index reader below it; and
- **messy cases** (mid-array presence change, sparse growth) → a whole-array
  `replace` at `arr` (same conservative coverage).

`move` is never generated at all. So an array index shift always reaches the
engine as a `splice` or whole-array `replace` on the array path — never as an
indexed structural op.

Because the safety of leaf-only matching *depends* on this — and it is a
whole-system property of the producer rather than something the engine enforces —
it is guarded two ways:

- a runtime assertion, `assertNoIndexedArrayStructuralOps`, runs at the sole
  patch-generator chokepoint (`buildPatchOperation`) and throws if a future
  regression ever emits an indexed-array `add`/`remove`/`move`; and
- a generator test (`packages/runner/test/memory-v2-native-commit.test.ts`,
  "v2 patch generator never emits indexed-array add/remove/move") drives every
  array idiom through real cell writes and asserts the emitted ops.

The engine still *accepts* indexed-array structural ops — they remain
protocol-legal (the nonRecursive matcher handles them via parent injection, and
stacked-commit tests exercise committed `move`s). The guarantee is narrower and
lives on the producer side: the **runner** never emits one, which is what keeps
the recursive leaf-only matcher free of false-negatives in production.

## 2. Shape (nonRecursive) reads conflict only at-or-above the read path

A read can be **shape-only**: the reader observed a container's key-set /
existence but not the deep values beneath it (QueryResultProxy creation,
`ownKeys`, `getOwnPropertyDescriptor`, `has`, array `length`). Such reads are now
tagged `nonRecursive` and carried through to the engine (previously the flag was
stripped at the client boundary).

For a nonRecursive read, `patchOverlapsNonRecursiveRead` conflicts only with a
write touching the read path **itself or an ancestor** — `isPrefixPath(touched,
readPath)`. This keeps the **parent-injecting** `touchedPathsForPatch`, so a key
`add`/`remove` (which injects the container's path) still conflicts with a keyset
reader — the shape it observed changed. A disjoint deep-value `replace` strictly
*below* the read path does not conflict.

The shallow predicate is not a subset of the recursive one. The parent a key
`add` or `remove` injects lies above every sibling of that key, so a shallow
read of a sibling conflicts with it — an `add` at `/value/c` against a shallow
read of `/value/b` — where a recursive read of the sibling, matched on leaf
paths alone (§1), does not. The shape reader pays a retry for a key set it did
not observe.

What a shape read observed changes only by a write at or above its path, or by
a change to its path's key set, which a patch reports by injecting the path as a
parent: `add`, `remove` and `move` always, and a mergeable op when it carries
`createsKey` (below). Whether a patch changes a key set is decided by its
writer, from the writer's base — `add` rather than `replace` for a key the base
lacks, `createsKey` on a mergeable op whose path the base lacks — so the match
is exact where that base is current for the key. It is not where a key was
removed durably after the writer's base was taken and the writer, not reading
the key, writes it again: its `replace`, or its mergeable op without
`createsKey`, creates the key, and a shallow read of the parent taken after the
removal does not conflict with it. That is an under-approximation, of the kind
INV-2 in [09-invariants.md](09-invariants.md) rules out.

### Mergeable creates and parent shape readers

Parent injection is keyed off `patchOpChangesParentKeySet`, not the static
`structural` flag alone. `structural` (`add` / `remove` / `move`) marks ops that
restructure a container's key set on *every* apply. The mergeable ops `append` /
`add-unique` / `increment` are not structural, because on an existing target they
only change a value (an already-present array's contents, or a number), and
marking them structural would over-conflict every parent shape reader against an
ordinary append — the write-contention the mergeable ops exist to avoid.

But those three ops also change the parent's key set in one case: when their
apply **materializes a previously-absent path** (creating the array/scalar and
the path to it — e.g. a first `push` to a not-yet-existing list). Whether a
create happened is value-dependent, so the static op tag cannot express it. The
writer records it instead: the mergeable-op build stamps the wire op's
`createsKey` flag when its transaction base held no value at the path (see
`runner storage/mergeable-ops.ts` and the `createsKey` field in
`packages/memory/v2.ts`), and `patchOpChangesParentKeySet` injects the parent for
a flagged op. So a cross-session shape-only reader of the parent now conflicts
with a create-from-absent mergeable op, but not with an append to an
already-present child.

The *first* commit to create a key necessarily saw it absent and sets the flag,
so a shape reader whose base predates the create always conflicts; a later
append to the now-present key does not carry the flag. A stale base can set the
flag when the key already existed durably, which over-conflicts a parent shape
reader conservatively (an extra retry). A stale base can also hold a key that
has since been removed, and an append re-creating it then carries no flag: the
under-approximation the section above describes.

(Recursive readers of the parent already conflict via the leaf-only matcher —
the read path prefixes the created leaf — independent of `createsKey`; the flag
only affects the shape/nonRecursive path.)

## 3. asCell reference-resolution reads are not value dependencies

Materializing an `asCell` argument **resolves a reference**: it follows the arg's
write-redirect and reads the target container's *shape* to construct the `Cell`.
That read does not consume a value — the holder depends on the referent only when
it reads **through** the cell in its body. Such reference-resolution reads are
tagged `excludeReadFromConflict` at the traversal seam
(`traverseObjectWithSchema`, gated on `hasAsCell(propSchema)`), and
`SpaceReplica.#buildReads()` drops them from the conflict set when they are
`nonRecursive`. They remain in the journal for reactivity. A **by-value**
argument (`hasAsCell` false) is a genuine dependency and is never marked; the
gate ensures by-value scalar reads — which are also recorded `nonRecursive` —
keep their dependency.

## 4. Runtime-internal CFC metadata reads are not value dependencies

Resolving a label reads the document's `["cfc"]` envelope. The runtime issues
that read itself, marked `internalVerifierRead`, and
`SpaceReplica.#buildReads()` drops it from
the conflict set. It stays in the journal, so reactivity still re-runs when the
envelope changes.

The CFC specification places these reads outside the attempt's consumed set
(§18.6.2, read exclusions for runtime-internal reads), and it makes a derived
label a record of the join the attempt observed rather than a subscription to
its sources (§8.9.4, point-in-time semantics). A label derived from a source
whose own label has since grown keeps the label it derived, which the
specification names as the intended outcome.

Persisting flow labels makes an append to a labeled collection rewrite that
collection's `["cfc"]` member alongside the appended element. The drop is what
lets a transaction resolve a label against a collection another session is
appending to.

Handler-initiated label introspection (`inspectConfLabel`) consumes through an
explicit observation record rather than through the raw read, so its result
carries a label independently of this drop.

## Composition

The four are orthogonal and compose at one matcher:

| read kind | matched by | touched paths |
|---|---|---|
| recursive value read | `patchOverlapsRead` | leaf-only |
| nonRecursive shape read | `patchOverlapsNonRecursiveRead` | parent-injected |
| asCell reference-resolution read | excluded from conflict | — |
| runtime-internal `["cfc"]` read | excluded from conflict | — |

Net effect: disjoint-key writers no longer collide; same-key RMW, whole-container
reads, keyset readers, and genuine value dependencies all still conflict.

## Related history

This supersedes / composes prior spike PRs:

- **#4199** (exclude a write's own machinery reads): superseded by §1 — fixing the
  matcher (no read deletion) avoids #4199's cross-space regression and preserves
  same-key RMW conflicts.
- **#4200** (honor nonRecursive shape reads): incorporated as §2.
- **#4210** (reactive computes don't immediately re-queue on conflict): orthogonal
  (reduces retry-storm cost rather than conflict count); lands independently.

Out of scope (separate lever): whole-document reads by output-derivation computes
that re-derive and replace a shared result document, and genuine shared-leaf
read-modify-write (array push) — neither is a granularity artifact.
