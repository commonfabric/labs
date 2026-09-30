---
status: historical
created: 2026-09-12
archived: 2026-09-12
reason: "Adoption assessment and implementation lessons at the close of the #7155 computation-cost arc."
---

# Computation cost: mechanisms, adoption, and announcement readiness

This brief assesses the completed #7155 arc at Labs commit
`eea8b459b3cce482febdb8550d5f06e26f850073`. It is for pattern authors choosing
collection operations and runtime developers extending their implementation.
Recommendations below are proposed work, not completed migrations. The linked
feature documents are the maintained API contracts.

The useful result is a way to express maintained collection computations,
measure the work a real consumer demands, and prevent regressions with read
budgets. The operators can reduce repeated scans, but add maintained state and
reactive graph structure. Choose them for a measured access pattern; fewer reads
alone do not establish lower latency, memory use, or network traffic.

## What to use, and when

| Mechanism                                      | Use it when                                                                                          | Why it helps; important boundary                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-attributed read accounting              | A pattern becomes slower as its collections grow, or an optimization needs evidence.                 | Attributes accesses, link traversals, and document/dependency counts to action bodies. It is opt-in; it does not measure all CPU, storage, or network work.                |
| Total and per-run read budgets                 | A representative action has a known acceptable scaling envelope.                                     | Total budgets catch work spread across many actions; per-run budgets catch one oversized computation. Tests must demand the relevant UI or output.                         |
| `groupBy(selector)` and `lookup(key)`          | Many consumers repeatedly filter the same collection by a stable key.                                | Shares membership maintenance and lets consumers read their matching group. Group order is occurrence-identity order, not source-array order.                              |
| `keyBy(selector)` and `lookup(key)`            | Consumers need one matching record, including repeated joins against a shared right-hand collection. | Avoids each consumer searching the whole collection. Duplicate keys choose the smallest occurrence identity in UTF-8 order, not the latest write.                          |
| `keys()` and `keyEntries()`                    | The UI actually needs to enumerate distinct groups.                                                  | Enumeration has its own demand and cost. Mixed primitive/Cell keys need tagged `keyEntries()` to preserve their distinction.                                               |
| `count`, `sum`, `min`, `max`, `minBy`, `maxBy` | A linked collection needs a maintained scalar or extremal member.                                    | Named operations have defined incremental and deterministic semantics. They do not make arbitrary `reduce` callbacks incremental.                                          |
| Reactive per-row computations and stable links | One row changes while sibling rows should retain their values and interactions.                      | Gives each row an independently reactive computation and preserves identity through rendering. A helper wrapped around a whole-array loop does not achieve this by itself. |
| `collection:nested-scan` diagnostic            | A callback scans a captured collection inside another collection operation.                          | Offers an early prompt to investigate a possible repeated scan. It is a nonfatal syntax heuristic, not a complexity proof.                                                 |

The contracts and supported call shapes are in
[read accounting](../../../features/read-accounting.md),
[collection indexes](../../../features/collection-indexes.md), and
[collection aggregates](../../../features/collection-aggregates.md).

### Call shapes and semantic choices matter

Index and aggregate methods belong to explicit array `Cell`/`Writable`
receivers. They are not methods on ordinary JavaScript arrays. In particular,
the public `Reactive<T>` typing does not make `rows.map(score).sum()` a
supported chain. Use the documented explicit receiver boundary, as lunch poll
does with its `indexVotesByOption` subpattern. Callback lowering is part of the
pattern compiler; an unlowered callback passed directly through the builder is
not interchangeable.

Build an index once outside its consumers' callbacks. A left join is a
composition: map the left collection and look up each key in one shared index of
the right collection. There is no separate join method. Keep unmatched left rows
and decide whether duplicate right keys should mean a group or a deterministic
single winner.

Index keys can be supported primitives or Cell references. Nullish selector
results omit membership. Cell keys use resolved space, document, path, and scope
identity; reading a reference's contents is not necessary to identify it. Do not
substitute JSON serialization, a title, or a document ID alone for the runtime's
canonical identity. For mixed keys, branch on `keyEntries()`'s tag and perform
the lookup within that branch.

Aggregates also require an explicit semantic choice. `sum()` accumulates finite
binary64 values exactly and rounds once, so the sequence `1e16, 1, -1e16` sums
to 1 rather than the 0 produced by that JavaScript addition order. Empty sums
are positive zero; empty minima/maxima are positive/negative infinity; empty
`minBy`/`maxBy` results are undefined. NaNs, infinities, signed zero, and tied
members have defined behavior. Ties for selected members use occurrence
identity, not array position. These are valuable replay guarantees, not
incidental details to hide in a migration.

## Implementation details worth carrying forward

### Measure completion, with a precise ownership boundary

The read-accounting implementation distinguishes an action's body from its
transaction attempt. Bodies include argument materialization and result
construction. Attempts cover the wider transaction lifetime, including work such
as preparation and retries. Their totals must not be added together as though
independent. A test's total budget counts completed attempts; its per-run budget
bounds the largest completed body.

Completion events capture work from actions that disappear before settlement.
Subtracting two final scheduler-stat snapshots would miss removed nodes and
would make a smaller final graph look artificially cheap. Instrumentation stays
owned by the transaction across asynchronous work and does not create new demand
or writes. These principles apply to future CPU and allocation probes too.

Budget the operation through actual settlement and demand the same outputs in
both comparison arms. Merely declaring a budget does not mount the UI. An
explicit render step or continuous UI demand can expose work a headless state
assertion never triggers. Use both total and per-run limits, plus functional
assertions; a cheap computation producing stale output is not a success.

### Incrementality depends on identity and lifecycle

Index buckets retain links to original members. Payload changes can reach a
consumer without rebuilding membership, and consumers preserve the identity
needed for editing. Materializer write envelopes keep members outside the
current bucket demanded so a later key change can move them into it. A
subscription only to today's matches would miss tomorrow's arrivals.

Cold reads, resumption, lookup retargeting, cross-space links, pending values,
principal/session ownership, and teardown are part of the operator contract.
Pending data cannot silently become confirmed absence. A stopped materializer
must not rearm itself, and a failed confirmation must retain an actionable
cause. Test these transitions, not just warm insert/remove examples.

The cost boundaries remain real. Source membership changes reconcile identities
across the collection. Group result construction depends on bucket size;
removing a `keyBy` winner can scan its bucket. Enumerating all keys adds sorting
work. Aggregates use an identity-ordered tree with leaf blocks of at most 32
members: a linked scalar edit can update a block and its ancestors, while
membership changes can require broad reconciliation and sorting. Inline
primitive edits can take that membership path. Neither mechanism promises
constant-time insertion into every collection.

### Lazy reads and shared work improve the substrate

Lazy lift argument materialization is enabled by default in the evaluated
runtime. It narrows what a computation actually reads; it does not turn a loop
into a maintained operation. The matched
[computed/lift experiment](2026-09-11-computed-lift-collection-loops.md) found
the same read counts for equivalent `computed`, broad-parameter `lift`, and
narrow-parameter `lift` loops. At 512 linked rows, the relevant edit still cost
1,025 accesses and 515 link traversals in each arm. An unread-field edit did not
invalidate those computations.

Consequently, do not rewrite module-scope lifts just to change the spelling.
Narrow schemas remain useful contracts at helper, hydration, and caller-demand
boundaries. They also matter for compatibility with stored generations of a
pattern. Handler argument materialization is a separate remaining task.

[Lazy views](../../../features/lazy-cell-materialization.md) validate
descendants when touched. An unread malformed subtree no longer prevents an
otherwise valid read, while a touched mismatch follows the required/optional
boundary. Missing values and defaults must still register dependencies so later
arrivals wake the reader. Extending laziness to handlers therefore needs a
deliberate validation contract, not just enabling the lift flag around another
callback.

Shared downstream traversal and scoped snapshot reuse remove repeated runtime
work without requiring authors to add caches. The associated storage
patch-replay optimization illustrates the same lesson: preserve immutable values
and reuse canonical machinery, but publish cached state only after a successful
commit. Cache ownership, rollback, scope, and invalidation are correctness
properties. A reduction in reactive reads does not excuse expensive work below
that boundary.

### Validate the observer as well as the computation

The copy rehearsal exposed stale attribute observation in the headless `MockDoc`
adapter. Its fix needed a negative control and HTML tests, not a change to the
pattern's intended state. Compare visible behavior as well as counters between
browser and headless runs. Use counters to locate work, timing to assess user
impact, and graph/storage measurements to understand what maintenance costs.

## What the lunch-poll evidence establishes

The
[representative copy rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md)
compared the deployed source with the maintained-group candidate on a fixed
runtime. The writable copy had 14 options, 10 participants, and 77 stored votes,
with only three votes in the current-day workload. Nine original profile spaces
were unavailable; a local cross-space test profile was present. Two migration
passes preserved the authored-data hashes. The real poll was not modified.

| Browser measurement for the tested update | Deployed source | Candidate |
| ----------------------------------------- | --------------: | --------: |
| Completed action bodies                   |              39 |        29 |
| Body accesses                             |             629 |       220 |
| Largest body's accesses                   |              84 |       139 |
| Graph nodes                               |           2,300 |     2,477 |
| Graph edges                               |           5,026 |     6,067 |
| Observed elapsed milliseconds             |          139.07 |    160.49 |

Headless access counts matched the browser within each source arm, but its
observed timing moved in the other direction, from 235.81 to 148.86 ms. These
are individual observations, not a latency distribution. The evidence supports
less repeated read work and preserved tested behavior, with more graph structure
and a larger maximum body. It does not support a universal speedup or a
production latency claim. The missing profiles and small current-day cohort
limit how representative this timing is.

## Suggested changes to existing patterns

### Lunch poll: finish the narrow consumers before adding more machinery

The merged [main pattern](../../../../packages/patterns/lunch-poll/main.tsx)
already filters votes to the current day, builds a shared `groupBy(optionId)`,
and computes each option's tally from its lookup. Keep that architecture and the
reactive row rendering. Preserve the local-calendar day boundary and the empty
state while the shared clock is unresolved.

The next concrete experiment is the
[option card](../../../../packages/patterns/lunch-poll/poll-option-card.tsx).
Each card still receives all of today's votes, and `myVoteFor` searches that
array for its option and viewer. Try passing the already-maintained option group
to this read-only display consumer. Keep vote mutation handlers bound to their
stored inputs. Check duplicate matching votes before doing this: `.find` over
source order and `.find` over occurrence-identity order can choose differently.
Either demonstrate uniqueness as an invariant or specify the intended winner.

Measure this change with continuous card demand, vote insertion/removal/color
changes, viewer changes, option removal, midnight rollover, cold loading, and
cross-space profiles. Assert button state, swatches, ranking, and handler
behavior as well as budgets. Do not infer success just from a lower tally cost.

Keep whole-option ranking and history summaries unless profiling identifies them
as significant. The shipped operators do not provide incremental sorting, and a
small history reduction may cost less than another maintained graph. Likewise, a
maintained count is not automatically better than an already-shared length.

Deployment is separate from the merged implementation. Rehearse further changes
on a fresh copy using the
[space-clone procedure](../../../development/space-clone-rehearsal.md), then
coordinate any live poll update with its owner. The completed arc does not
authorize changing the real poll.

### Topics and Topicboard: maintain the mention relation, preserve demand shape

The [board](../../../../packages/patterns/topics/main.tsx) already centralizes
backlink derivation. It materializes narrow mention lists once, then scans those
lists for each destination topic. This avoids repeatedly resolving reactive
proxies, but still repeats comparisons across the graph. Each
[topic](../../../../packages/patterns/topics/topic.tsx) also scans the resulting
table to find its own row.

The highest-value hypothesis is a shared maintained relation of source and
destination references, grouped by destination, followed by direct lookup for
backlinks. This requires a prototype; merely adding `groupBy` after
reconstructing all edges on every edit can retain the expensive producer.
Measure edge maintenance independently from lookup. A shared keyed lookup over
the existing cross-reference rows is a smaller first experiment that leaves the
pivot intact.

Preserve these semantics explicitly:

- Self-mentions are excluded by canonical identity, including aliases and scoped
  references.
- Several mentions from one source occurrence currently yield one inbound
  result, while duplicate source occurrences need separate consideration.
  Deduplicating every source globally would change the current filter semantics.
- Inbound results currently follow board source order. Group identity order is
  different; preserve the visible order or make its change an explicit decision.
- Cold or unresolved sources do not create rows with invalid identity. Stable
  cross-reference row addresses and linked topic results must survive
  resumption.
- Topics with no match still receive an empty backlink list.

For individual topics, start with simpler sharing: derive `hasComments` from
`commentCount`, and evaluate reusing the active-link view for `hasLinks` and
link resolution. For large threads, prototype `count(predicate)` over an
explicit comment Cell, preserving the optional `removedAt` projection for stored
topics. Do not mechanically replace the narrow compatibility lift with an opaque
read.

An activity aggregate is a later experiment. `lastActivityOf` includes comment
edits and retractions and link removals, even for records absent from the
visible thread. Dropping those records would let activity move backward.
Preserve every timestamp surface, its optional defaults, and the original linked
comment identity; the ordinary mapped-array chaining gap also applies here.

Keep the board's original topic links when sorting cards. There is no shipped
incremental sort/top-K operation. Keep its compact copied `mentionableIndex` and
narrow headless `index`: returning linked bucket members does not itself limit
network expansion. A keyed lookup may accelerate short-name resolution, but it
must not replace the persistent name allocator or its never-reuse contract.

Before landing a Topics migration, vary topic count and mention-edge count
independently. Include same-count mention retargeting, duplicate mentions,
rename-only edits, comment edits/retractions, unrelated sibling edits, aliases,
cold resume, and multiplayer observation. Measure producer work, lookup work,
read budgets, graph size, and elapsed time separately. Use bytes/subscriptions
for any network claim. Run the existing naming, rendering-identity, rejection,
and multi-user tests, plus a stored-space copy rehearsal.

## What should land before announcing this?

A focused announcement of maintained indexes, named aggregates, and read budgets
can proceed after publishing the adoption guidance and confirming the target
runtime includes the merged work. This assessment found no additional core
correctness fix that must block that scoped announcement. It did not audit the
currently deployed runtime version.

| Work or claim                                             | Recommendation                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public guidance and examples                              | Publish the supported explicit-Cell examples from the maintained feature docs with ordering, duplicate, numeric, and cost caveats. Link a reproducible demanded-UI workload. This is announcement preparation. |
| “Available on our deployment”                             | Confirm the deployed runtime/compiler version includes the arc before making this claim. Merged source alone is insufficient.                                                                                  |
| “Lunch poll is faster”                                    | Obtain repeated matched timings with the intended profile data and deployment. Until then announce the demonstrated reduction in reads and disclose maintenance costs.                                         |
| Topics adoption                                           | Land a measured prototype and compatibility tests before describing Topics as migrated. It is an adopter follow-up, not a prerequisite for announcing the runtime APIs.                                        |
| Aggregate chaining ergonomics                             | A useful fast-follow before encouraging broad mechanical replacement of `.map(...).reduce(...)`. Explicit-Cell APIs can be announced now with their actual typing.                                             |
| Handler laziness and lazy flag retirement                 | Execute the separate [lazy-materialization fast-follow](../../plans/lazy-materialization-fast-follow.md). Q9 deliberately separates it from the completed arc; it does not block the narrower announcement. |
| Restricted append folds or arbitrary incremental `reduce` | Remain outside the shipped claim. The restricted fold work was explicitly deferred; named aggregates are not a substitute contract for arbitrary reducers.                                                     |
| Reduced client replication/network demand                 | Qualify separately through [shaped reads](../../../plans/shaped-reads-and-verb-results.md) and replication work. Local read accounting cannot establish this benefit.                                          |

At this assessment,
[Topics stored-state migration #7345](https://github.com/commontoolsinc/labs/pull/7345)
and
[active-view replication #7349](https://github.com/commontoolsinc/labs/pull/7349)
were open. Coordinate a Topics source update with the former's compatibility
work. Do not present the latter's behavior as part of this completed arc.
Neither is automatically a blocker for announcing the scoped collection APIs.

A useful demonstration sequence is: show a repeated-filter workload; demand its
rendered result; replace the repeated searches with one maintained group; edit a
member; compare source-attributed reads and visible output; then show startup
and graph costs too. Follow with a read budget that rejects the scan regression.
Use synthetic data or the isolated poll copy, not writes to the live poll.

Suggested announcement scope: **Maintained grouping, keyed lookup, and named
aggregates are available in the runtime, alongside source-attributed read
accounting and test budgets. They help authors control repeated collection work;
choose them using measured workloads and their documented identity, ordering,
and maintenance contracts.**

## Implementation entry points

For extending these mechanisms, start with the maintained feature documents,
then these sources and their neighboring tests:

- [Index builtins](../../../../packages/runner/src/builtins/collection-index.ts):
  membership, lookup, enumeration, and lifecycle ownership.
- [Aggregate builtin](../../../../packages/runner/src/builtins/aggregate.ts):
  tree maintenance and result ownership.
- [Lazy schema views](../../../../packages/runner/src/schema-view.ts): per-path
  materialization and read dependencies.
- [Memory engine](../../../../packages/memory/v2/engine.ts): revision-cache
  identity, staged publication, and patch replay.
- [Completed implementation tracker](../../plans/pattern-computation-cost-implementation.md):
  landing and validation provenance for the arc, including explicit deferrals.
