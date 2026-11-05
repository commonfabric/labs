---
status: historical
created: 2026-09-10
archived: 2026-09-11
reason: "Executed B1/B2 contract; index producers, tagged enumeration, joins, and phase measurements shipped."
superseded-by: docs/features/collection-indexes.md
---

# Collection indexes and keyed lookup

The B1/B2 implementation and acceptance contract was executed through
[PR #7323](https://github.com/commontoolsinc/labs/pull/7323), with the separate
phase-count probe in [PR #7362](https://github.com/commontoolsinc/labs/pull/7362).
The publication gates passed before those PRs merged. The
[feature documentation](../../features/collection-indexes.md) describes the
current index producers, lookup, and enumeration APIs.

## Key domain and equality

Keys are strings, finite numbers, booleans, or Cell references. Null and
undefined mean that an element has no key and does not enter an index. NaN,
infinities, plain objects, arrays, symbols, and functions are invalid keys.
Number and string keys occupy different domains; positive and negative zero
share a numeric key. Reject invalid keys with an authored-source diagnostic.

Cell keys compare by resolved Cell identity, using the same address equality as
`Cell.equals`: space, document ID, path, and scope. Schema and stored contents
do not define identity. Two different Cells storing equal values remain separate
keys. Cross-space keys are supported subject to ordinary read access.

Resolve key references in ordinary reactive transactions. Record dependencies on
each link traversal so retargeting a key moves membership without requiring an
edit to its containing element. Changing only the target's contents does not
change index membership. Missing, loading, denied, or cyclic references must
follow the runtime's existing resolution and error behavior; a provisional
missing read is not evidence that a durable group should be cleared.

Reuse `resolveLink`, normalized link equality, and the collection identity
helpers. Any durable bucket address must be derived with canonical data-model
hashing from the owning index instance and a typed key representation.
Separate indexes must not share bucket state merely because their keys match. A serialized key is internal routing
data, not a public substitute for the original Cell key.

## Grouping and unique-key selection

`groupBy` retains every source occurrence with a valid key. `keyBy` returns at
most one source occurrence for each key. For duplicate keys, `keyBy` chooses the
smallest existing collection element-occurrence identity under UTF-8 ordering.
Reordering the same linked elements does not change that winner. Removing the
winner exposes the next candidate. Authors who need all matches use `groupBy`.

Groups use the same deterministic identity order, rather than source position.
Repeated occurrences remain repeated, following `listElementKeys`. Inline values
inherit the identity behavior of the source collection machinery; there is no
promise of stable identity for a replacement inline value.

An absent group lookup returns an empty collection. An absent unique lookup
returns undefined. A lookup with a missing key has the corresponding absent
result. An invalid lookup key produces the same diagnostic as an invalid
extracted key.

## Tagged enumeration acceptance

Q7 is resolved: provide an explicit tagged enumeration API for mixed keys,
with `{ kind: "value", value: primitiveKey }` and
`{ kind: "cell", cell: cellKey }` entries. Preserve homogeneous `keys()` usage.
The [decision record](../features/2026-09-11-index-key-enumeration-decision.md)
records the context, consequences, and alternatives. Tagged enumeration and its
focused acceptance tests are implemented. Publication gates are recorded separately
from the implementation items below.

- [x] Approve explicit tagged enumeration and record the decision.
- [x] Add the public tagged type, enumeration method, and compiler/runtime wiring.
- [x] Verify compiled consumers preserve primitive values and Cell identities,
      including equal contents, distinct Cells, and lookup round trips.
- [x] Verify cross-space references, removal/reinsertion, cold resume, and
      demand-only enumeration without broadening lookup dependencies.
- [x] Update current API documentation and demonstrations.
- [x] Complete publication gates: final integration tests, current-head CI,
      antagonistic review, and Cubic review.

General runtime union materialization changes are outside this implementation.


Group enumeration contains occupied keys only and has deterministic typed-key
order: booleans, numbers, strings, then Cell addresses. Within a domain use
boolean order, numeric order, UTF-8 string order, or UTF-8 canonical address
order respectively. Empty groups disappear from enumeration, but an existing
lookup must remain subscribed so later insertion becomes visible.

## Lookup and join surface

Provide `groupBy(selector)` and `keyBy(selector)` on collection Cells, with
transformer lowering for ordinary authored array syntax. A selector receives one
element and must retain Cell identity when returning a reference. Avoid index or
whole-array callback arguments in the first API: they would make source
reordering a dependency of every key extractor.

The result is a typed index handle. Its `lookup(key)` returns an ordinary
reactive value containing a group or an optional original element. A Cell passed
as the key always denotes its identity; callers use an explicit value read when
its stored primitive should be the key. This keeps Cell identity unambiguous
when an index accepts both primitive and Cell keys. A separate
`keys()` operation observes homogeneous occupied keys; `keyEntries()` exposes
explicit tags for mixed primitive/Cell keys. Each lookup subscribes to
one key's bucket and the lookup key's resolution path; it must not subscribe to
index enumeration.

The typed-handle prototype uses a read-only Cell descriptor with separately
addressed buckets and occupied keys. Compiled lookup delegates to the descriptor
Cell and returns an ordinary reactive value. Its acceptance tests cover
primitive/Cell key separation, link retargeting, unrelated-bucket isolation,
missing-key insertion, linked row contents, and durable lookup resume. Index
construction uses owned per-occurrence extraction and bucket maintenance.

The first join is a left lookup join against a `keyBy` index: one output per
left occurrence, with its original left element and an optional right element.
Unmatched left rows remain present. Duplicate right keys use `keyBy`'s winner.
Output order and occurrence identity follow the left collection's existing `map`
contract. A right update affects only matching left rows; a left key change
retargets only that row. Both key extractors and lookup keys retain
link-retargeting dependencies.

Many-to-many joins are deferred. They require a separate cardinality and
output-identity contract; `groupBy(...).lookup(...)` exposes all matches without
claiming an incremental many-to-many join.

## Ownership and work bounds

Index membership, per-element key extraction, bucket results, and lookup results
use ordinary reactive child runs and transaction rollback. Follow
[runner child ownership](../../specs/runner-child-run-ownership.md) for removal,
independent readers, teardown, and reload. Reusing a key after removal should
address the same deterministic bucket; retired children must not leak merely
because another key remains populated.

Per-element maintenance must remain demanded when only an unrelated or absent
bucket is observed. Ordinary child ownership establishes lifetime, not demand:
a selector currently assigned to B must still run when its key changes to A and
only A has a reader. Use the scheduler's existing materializer write envelopes
for owned maintenance children, with selector outputs as their reactive inputs.
Do not make lookup read every selector or occupied-key enumeration to establish
that demand.

Materializer envelopes must cover possible destination buckets before a key
changes, while each transaction writes only affected buckets. Broad envelopes
may introduce O(N) scheduler ordering edges per lookup; measure that topology
cost separately from callback and consumer run counts. Teardown releases the
maintenance registrations. Acceptance includes B-to-A movement with only A
observed, insertion into an initially absent watched bucket, rejected maintenance,
and cold resume.

The implementation must distinguish these costs:

| Operation                                | Required bound or explicit limitation                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Initialization                           | Reads each source occurrence and extracts each key once; sorting may cost O(N log N).                                       |
| Membership edit                          | May reconcile O(N) source identities, as current list builtins do. Report this separately from value updates.               |
| Independently linked element changes key | Reevaluate that extractor and maintain its old and new buckets; do not reevaluate unrelated extractors or lookup consumers. |
| Non-key element field changes            | Keep bucket membership unchanged; consumers reading that field react through the original element link.                     |
| Lookup                                   | Resolve its key and address one bucket; no source or key-enumeration scan.                                                  |
| Group materialization                    | Reading a group with M members costs at least O(M). Do not describe returning a group as constant-cost materialization.     |
| Join update                              | Reevaluate affected left rows; a popular right key can legitimately affect many rows.                                       |
| Retained state                           | O(N + K + L) membership, buckets, and active lookups, excluding source payloads; explain any persistent tombstones.         |

No exact logarithmic update guarantee is asserted until the bucket-maintenance
prototype demonstrates it. Rebuilding an affected bucket can cost its group size
even while unrelated-key invalidation remains bounded. The motivating roster
uses unique keys, so its lookup benchmark must separately cover skewed duplicate
groups.

## Implementation sequence and acceptance

- [x] Prototype the typed index handle and its transformer/schema boundary. Keep
      key lookup separate from ordinary object-property `Cell.key`.
- [x] Implement shared key resolution and per-element extraction, reusing
      runtime identity and ownership machinery.
- [x] Implement `groupBy`, unique-key selection, and per-key lookup.
- [x] Test primitive domains, missing/invalid keys, duplicate occurrences,
      source reorder, key edits, link-only retargeting, and cross-space keys.
      Verified in #7323 by the collection-index key, producer, and tagged-entry
      runner tests.
- [x] Test absent lookup before insertion, last-member removal, reinsertion,
      rejected transactions, teardown, cold resume, and independent readers.
      Verified in #7323 by the builtin, serving, resume-sync, and lookup tests.
- [x] Count callback and consumer runs. A change to key A must leave a key B
      lookup's run count unchanged when its declared dependencies are unchanged.
      The collection-index invalidation tests in #7323 assert both the idle
      unrelated consumer and its later response to a matching change.
- [x] Implement the left lookup join; cover both-side updates and unmatched
      rows. The local/cross-space join tests in #7323 also cover restart.
- [x] Benchmark initialization, membership reconciliation, one linked-row edit,
      lookup, and skewed duplicates as separate phases at increasing sizes.
      PR #7362 completes 12 cases and 96 phases with output assertions and a
      failing negative control. Phases share an evolving fixture per case;
      counts cover completed action bodies, not all runtime work.
- [x] Implement contracts, measured limits, and a synthetic roster/tally demo.
      The feature documentation and local dashboard expose the operator
      contracts, join behavior, and measurements; PRs #7323 and #7362 carry
      repository publication through the completed gates above.
      Live poll migration remains subject to coordination with Mike.
