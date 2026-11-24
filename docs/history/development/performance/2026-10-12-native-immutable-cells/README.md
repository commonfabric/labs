---
status: historical
created: 2026-10-12
archived: 2026-10-12
reason: "Initial measurement record; sharesFrozenGraph did not describe measured inputs. Use the 2026-10-13 feedback report for corrected sharing evidence. Runtime-lifetime element retention is superseded by weak source-and-handle ownership."
superseded-by: "../2026-10-13-immutable-cell-feedback/README.md"
---

# Native immutable cells: implementation and measurements

This change replaces newly minted immutable-cell payload URIs with compact
`snapshot:` identifiers backed by frozen values. Already frozen input is shared,
mutable input uses the canonical clone-and-freeze machinery, and array snapshots
save their relative-link origin. Export expands snapshots to values; legacy
Fabric data URIs remain readable. The live contract is
[Immutable cell identifiers](../../../../features/immutable-cell-identifiers.md).

The checkout started at `13845915081539396bbede3a57ec6d4877bee35c`. These are
local measurements of the implementation, not a production rollout or an
end-to-end pattern speedup claim.

## Representation and choices

The ID is `snapshot:<Fabric value hash>[:<origin hash>]`, 52 characters without
an origin and 96 with one. It contains no payload or schema. It uses the
existing Fabric hash, including its frozen-identity cache. Content identity
remains stable when a computation reconstructs an equal value, which matters
when cell addresses participate in derived identities. The first hash of a fresh
graph still visits its contents.

The origin is the source document's ID, space, and scope. A relative link's path
starts at that document's value root, so an array index is not part of this
origin. Traversal resolves relative links against the saved origin. Raw reads
that can leave this context and outbound writes materialize the links then.
Creation does not rewrite the value's links or decode a payload string.

The store belongs to the runtime and is shared with its transactions, including
capture proxies. A weak realm lookup supports link parsing without retaining
runtimes. A live owner retains each distinct snapshot strongly: a bare URI
string cannot signal that its last reader has disappeared. Disposal or
collection of the last owner releases those entries. Equal content and origin
share an entry. This is a deliberate retention tradeoff, quantified below; there
is no bounded cache whose eviction could silently invalidate an address still in
use.

The shared data-model converter preserves frozen children inside mutable input.
Acyclic validation uses the existing visitor, rejects cycles through codec
state, and memoizes validated frozen roots. Mutable unknown/problematic codec
values use the canonical cloning machinery for their state. Frozen instances
remain shared. Renderer event authority, which is attached to object identity,
is removed by copying the marked event before immutable intake.

Stored writes and stream sends expand native links recursively, including links
in schema defaults and carried codec state. Storage treats both immutable
schemes as read-only and excludes them from fetches and commit preconditions.
Offline traversal captures and SQLite cell-link strings convert native links to
portable data URIs. Replay's existing golden oracles remain unchanged.

## Measurement method

The codec benchmark was written and run before changing runtime creation. The
final harnesses are:

- `packages/runner/test/immutable-cell-measure.ts`: seven measured pairs after
  two warm-up pairs, alternating arm order. Each fresh arm receives an equal,
  independently created graph. Construction/freezing of fixtures and semantic
  checks are outside timing. Reused cases run ten operations per sample.
- `packages/runner/test/immutable-cell-codec.bench.ts`: Deno benchmarks for fresh
  creation plus reading, repeated creation, and repeated reading at 1, 100, and
  1,000 rows. Raw codec encode/decode is compared with native create/get.
- `packages/runner/test/immutable-cell-retention.ts`: post-GC heap for changing
  values, with and without callers retaining their IDs. It warms both paths and
  their canonical hash/string caches before sampling, and yields between forced
  collections so WeakRef job retention does not masquerade as live ownership.

The paired baseline calls the existing `dataUriSnapshotWithResolvedLinks`, the
array-traversal seam that resolves links and encodes an ID. It does not add a
separate decode cost. Each row carries a relative link and a 30-property schema;
we cover inline schemas and the content-addressed reference form used in stored
links. Checks compare materialized native content with decoded baseline content,
including schemas, undefined, negative zero, infinity, and Unicode. Frozen graph
sharing is checked by identity.

Machine: Apple M3 Max, macOS arm64, Deno 2.9.4 / V8 15.0.245.2-rusty. The host
was heavily contended by other work: observed load averages ranged roughly from
370 to 504. Raw samples show substantial variance. Paired medians support the
reuse conclusion; absolute throughput and cold-case ratios should not be
generalized to an idle machine.

## Paired construction results

Milliseconds per operation; medians of seven pairs. Every raw pair is in
[paired.json](paired.json).

| Schema form | Rows | Input         | Data URI | Native snapshot |
| ----------- | ---: | ------------- | -------: | --------------: |
| inline      |  100 | fresh frozen  |  16.6502 |          9.9779 |
| inline      |  100 | fresh mutable |  43.9255 |         14.9872 |
| inline      |  100 | reused frozen |   6.8541 |          0.0027 |
| inline      | 1000 | fresh frozen  |  23.3700 |         78.1335 |
| inline      | 1000 | fresh mutable | 515.3208 |        311.4860 |
| inline      | 1000 | reused frozen |  30.0482 |          0.0030 |
| reference   |  100 | fresh frozen  |   1.2619 |          1.3546 |
| reference   |  100 | fresh mutable |   1.2449 |          1.6732 |
| reference   |  100 | reused frozen |   4.1643 |          0.0025 |
| reference   | 1000 | fresh frozen  |  38.8288 |         23.5831 |
| reference   | 1000 | fresh mutable |  34.9071 |        101.1862 |
| reference   | 1000 | reused frozen |  39.4163 |          0.0028 |

The 1,000-row inline-schema ID shrinks from 458,287 to 96 characters while the
native snapshot shares the input graph. Reusing that frozen graph costs about 3
microseconds versus 30 milliseconds for rewriting and encoding it in this run.
The first creation is mixed: the fresh frozen inline-schema case takes about 78
ms versus 23 ms, while the fresh frozen reference-schema case takes about 24 ms
versus 39 ms. Fresh mutable reference-schema input is also slower in this run
(101 ms versus 35 ms). Native addressing is therefore not a universal
cold-creation improvement. Its strongest result is avoiding repeated encoding,
decoding, and payload-sized IDs once a frozen value is available.

The separate [microbenchmark results](micro.json) preserve Deno's raw
statistics. For 1,000 rows without links, fresh creation plus read averages 83.4
ms for encode/decode and 62.5 ms for native creation/read; repeated native
creation averages 1.66 microseconds and native lookup 0.14 microseconds. These
are unpaired benchmark means on the same contended host, a secondary observation
rather than a basis for an application speedup claim.

## Retention cost

The [retention probe](retention.json) constructs 100 distinct versions, each
holding 1,000 rows with a 256-character filler string. Figures are heap deltas
in MiB after forced collections, above each arm's warmed baseline.

| Caller keeps IDs | Data URI | Native snapshot |
| ---------------- | -------: | --------------: |
| No               |     0.83 |           34.55 |
| Yes              |    38.44 |           34.57 |

Dropping all caller IDs does not release native snapshots while their store is
alive. Disposing that store releases about 35.2 MiB in this workload; warmed
bounded hash/string caches remain. Keeping IDs retains about 40 million ID
characters in the legacy arm versus 5,200 in the native arm. Input graphs here
are independently created versions; real structurally shared graphs can retain
less additional data, but the store still retains every distinct version.

A long-lived runtime with an unbounded stream of distinct snapshots can
therefore grow without bound. This implementation chooses stable bare-URI
validity for the runtime lifetime. Any future reclamation scheme must establish
ownership of all outstanding identifiers before releasing their values.

## Validation

- Repository-wide `deno fmt --check`, `deno lint`, and `deno task check` passed
  (52 type-check groups). All 637 documentation code blocks passed, as did the
  history index, test-identity aliases, and package-cycle checks.
- Full data-model package run: 82 suites / 4,220 steps passed, including cycle
  validation, codec cloning, and visitor-first module initialization.
- Focused runtime/data-model regression run: 22 suites / 382 steps passed.
- Final schema-default, export, replay, and cycle regression run: 8 suites / 70
  steps passed, without changing replay golden files.
- Runner clock-preload run covering immutable cells, sync, renderer authority,
  and agent serving: 7 suites / 88 steps passed.
- SQLite encoding, real SQLite round-trip, and immutable-cell tests: 4 suites /
  20 steps passed, including decoding stored contents after snapshot disposal.
- Piece clone guards and harness identifier-boundary tests: 2 suites / 18 steps
  passed.
- Independent read-only `cf-review` found no remaining blocking findings after
  fixes for frozen cycles, piece preconditions, schema defaults, and capture
  transaction ownership.

Broad runner, piece, and harness package runs were started but stopped on the
heavily contended host. The earlier runner run had an agent-serving failure;
that test subsequently passed with the runner's clock preload after the sync
walk was fixed to visit shared values under each occurrence's schema. These runs
are not evidence of a clean full-package result. No commit, pull request, merge,
or deployment was performed.
