# Reactive collections

Use collection operations to describe derived lists, per-member computations,
lookups, and summaries. In a pattern body, the compiler turns eligible
operations on reactive collections into runtime computations. An ordinary
JavaScript array inside a `computed()` or `lift()` callback still uses ordinary
array operations; when that computation is invalidated, its loop runs again.

## Choose an operation

| Need                                       | Operation                                                     | Work and semantics                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transform or render each member            | `map(callback)`                                               | Reactive callbacks have per-occurrence computations. Preserve linked member identity when passing records to consumers.                                  |
| Keep matching members                      | `filter(predicate)`                                           | Reactive filtering evaluates a predicate per member and returns original member links in source order. The result is dense, including for sparse inputs. |
| Produce zero or more results per member    | `flatMap(callback)`                                           | Reactive per-member results are flattened into a list.                                                                                                   |
| An arbitrary, order-dependent summary      | `reduce(callback, initialValue)` inside a derived computation | The whole reduction runs when its dependencies change. It is not a maintained incremental fold.                                                          |
| Repeatedly select members by one key       | `groupBy(selector).lookup(key)`                               | One shared index maintains all occurrences for each key. Groups use occurrence-identity order, not source order.                                         |
| Repeatedly select one member by key        | `keyBy(selector).lookup(key)`                                 | Duplicate keys choose the smallest occurrence identity in UTF-8 order; this is not a uniqueness check or latest-write rule.                              |
| Count, numeric summary, or extremal member | `count`, `sum`, `min`, `max`, `minBy`, `maxBy`                | Named aggregates maintain results with defined numeric and identity contracts. Membership changes can still require broad reconciliation.                |

Reactive `map`, `filter`, and `flatMap` callbacks receive the element and, when
the callback's parameter list names them, its reactive index and the source
array; a parameter the callback leaves out is not passed. Captured reactive
values remain inputs to the callback. Reading a shared collection inside every callback can make a
change invalidate every member's computation; per-member callbacks alone do not
remove repeated scans.

Compiler lowering depends on both context and receiver. In particular, calling
an array method on a value obtained with `.get()` inside a computation does not
make every inner loop a separate reactive builtin. Use the patterns below rather
than inferring incrementality from the method name. The precise compiler rules
are in the
[array-method lowering contract](../../specs/ts-transformer/ts_transformers_current_behavior_spec.md#94-array-method-strategy).

## Derive a view, then give each row its own computation

This pattern explicitly derives a filtered view and maps its members to row
results. The filtering computation scans when its dependencies change; the
mapped rows have their own reactive computations.

```ts
import { computed, pattern, Writable } from "commonfabric";

export default pattern<{
  donuts: Writable<{ name: string; price: number; available: boolean }[]>;
}>(({ donuts }) => {
  const available = computed(() =>
    donuts.get().filter((donut) => donut.available)
  );
  const cards = available.map((donut) => ({
    donut,
    label: computed(() => `${donut.name}: $${donut.price}`),
  }));
  const receipt = computed(() =>
    donuts.get().reduce((text, donut) => `${text}${donut.name}\n`, "")
  );
  return { cards, receipt };
});
```

When a callback derives a value from an external collection, put that read in an
explicit reactive computation or use a shared index lookup. Do not capture a
one-time plain snapshot and expect a cached row instance to refresh it. Keep
original linked records when identity matters for editing, selection, or child
pattern state. Use [canonical identity comparisons](identity.md) rather than
JavaScript object equality, and bind mutation handlers to stored inputs.

A module-level `lift()` is useful for reusing a derivation. Moving an unchanged
whole-array loop from `computed()` to `lift()` does not make that loop
incremental. See
[collection-loop cost](computed/computed.md#collection-loop-cost).

## Share an index across consumers

Use explicit array `Cell` or `Writable` inputs for the index and aggregate APIs.
Ordinary array types do not expose these methods, including array-typed pattern
inputs and the public result type of `map`. A chain such as
`donuts.map(score).sum()` is not supported by the public types.

```ts
import { pattern, Writable } from "commonfabric";

export default pattern<{
  donuts: Writable<{ code: string; glaze: string; price: number }[]>;
  orders: Writable<{ donutCode: string }[]>;
  prices: Writable<number[]>;
}>(({ donuts, orders, prices }) => {
  const byGlaze = donuts.groupBy((donut) => donut.glaze);
  const byCode = donuts.keyBy((donut) => donut.code);
  return {
    chocolate: byGlaze.lookup("chocolate"),
    ordersWithDonuts: orders.map((order) => ({
      order,
      donut: byCode.lookup(order.donutCode),
    })),
    affordableCount: donuts.count((donut) => donut.price < 5),
    cheapest: donuts.minBy((donut) => donut.price),
    totalPrice: prices.sum(),
  };
});
```

The indexes are built outside the order callback so all orders share their
maintenance. Each order remains present even when lookup returns `undefined`:
this composes a left join without a separate join method. Use `groupBy` instead
of `keyBy` if every matching right-hand occurrence is needed.

Selectors receive one member, without its array position. Keys may be supported
primitives or Cell references; nullish keys omit membership. Missing group
lookups return empty arrays. Cell keys use resolved identity, including space,
path, and scope, without requiring their payload contents as keys.

Request `keys()` only when a consumer needs all occupied keys: enumeration adds
its own demand and sorting work. For mixed primitive/Cell keys, use tagged
`keyEntries()` and perform lookup within the appropriate tag branch. See the
[full index contract](../../features/collection-indexes.md) for supported keys,
ordering, descriptor schemas, and cold/resume behavior.

## Choose aggregate semantics deliberately

`count()` counts present members; `count(predicate)` counts truthy predicate
results. `minBy(score)` and `maxBy(score)` return the selected original member,
or `undefined` for an empty collection. Tied members use occurrence identity,
not source position.

Numeric `sum()` accumulates finite binary64 values exactly and rounds once. It
can differ from a JavaScript reduction: summing `1e16`, `1`, and `-1e16`
returns 1. Empty sums return positive zero; empty `min()` and `max()` return
positive and negative infinity respectively. Check the
[aggregate contract](../../features/collection-aggregates.md) for NaN, infinity,
signed-zero, and tie behavior before replacing an existing reduction.

For a computed numeric list, introduce a subpattern with an explicit numeric
Cell input if it needs a named aggregate; do not cast an ordinary array into a
Cell to bypass the public typing. Keep ordinary reductions for order-dependent
operations or small workloads where maintaining additional state is unnecessary.

## Implementation patterns and cost boundaries

The runtime retains per-occurrence child computations for reactive list
operators. Index buckets retain original links, so payload reads can update
without requiring a membership rebuild. Aggregate predicate and score callbacks
reuse per-element mapping, and numeric results use an identity-ordered tree with
leaf blocks of at most 32 members. Updating an independently linked scalar can
recompute one block and its ancestors.

Membership changes still reconcile collection identities. Appending, removing,
or reordering can cause broad work; editing an inline primitive array also takes
the membership path. Large groups cost more to construct and order, and removing
an indexed winner can require searching its bucket. These operations trade
maintained graph/state for less repeated consumer work, not a universal
constant-time update guarantee.

When extending the runtime, reuse its identity, list reconciliation, child
ownership, and rollback machinery. Test cold initialization, key retargeting,
cross-space references, resumption, and teardown as well as warm edits. Members
outside a currently observed group must still be maintained so a later key edit
can make them enter that group. Detailed implementation entry points are linked
from the [index](../../features/collection-indexes.md) and
[aggregate](../../features/collection-aggregates.md) contracts.

## Verify the demanded workload

Start with `cf test --verbose --stats-threshold 0` and the
[read-accounting guide](../../features/read-accounting.md). Demand the relevant
outputs or rendered UI: read budgets alone do not mount consumers. Compare
initialization, member payload edits, membership changes, and lookup retargeting
at several collection sizes. Check behavior alongside counters.

Use both total and per-run budgets. Total budgets count completed transaction
attempts through settlement; per-run budgets bound the largest completed action
body. They catch different regressions. The nonfatal `collection:nested-scan`
warning can suggest a repeated captured-collection scan, but is not an
exhaustive complexity analysis.

Measure elapsed time and graph/storage costs separately before claiming a
speedup. Read counters do not measure network traffic. Preserve narrow
caller-demand schemas and compact projections when a linked result could expand
more data than a consumer needs.
