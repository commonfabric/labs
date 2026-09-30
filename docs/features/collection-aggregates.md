# Incremental collection aggregates

For authoring recipes alongside `map`, `filter`, and `reduce`, see
[reactive collections](../common/concepts/reactive-collections.md).

Array-valued `Cell` and `Writable` inputs expose named aggregates. These methods
build reactive computations in a pattern body. Predicate and score callbacks
receive an element, its reactive index, and the source array; captured values
remain reactive, using the same callback lowering as `map`.

| Method | Result | Empty array |
| --- | --- | --- |
| `items.count()` | Number of present members | `0` |
| `items.count(predicate)` | Number of truthy predicate results | `0` |
| `numbers.sum()` | Exactly accumulated numeric sum, rounded once | Positive `0` |
| `numbers.min()` | Smallest number | `Infinity` |
| `numbers.max()` | Largest number | `-Infinity` |
| `items.minBy(score)` | Element with the smallest numeric score | `undefined` |
| `items.maxBy(score)` | Element with the largest numeric score | `undefined` |

The public type surface requires an explicit cell receiver. `Reactive<T>` is an
alias for `T`, so ordinary array-typed pattern inputs and the array returned by
`map` do not expose these additional methods through TypeScript. In particular,
`rows.map(score).sum()` is not supported by the public types. Broadening that
surface is separate from the aggregate runtime implementation.

Direct builder callers use `countWithPattern`, `minByWithPattern`, and
`maxByWithPattern` with a score or predicate pattern and its captured parameters.
The transformer emits those forms for authored callbacks, including explicit
cell receivers inside `computed`. Calling a callback form directly without
lowering throws, as it does for `map`.

Reactive proxies expose aggregate methods on receivers whose resolved schema
has the top-level type `array`. Direct builder construction must supply that
schema; union-only schemas do not expose these methods through a reactive
proxy. Raw Cell methods are unaffected. On object and schemaless receivers,
names such as `sum` and `count` remain ordinary data fields.

## Determinism and numeric behavior

Finite sums accumulate signed integer multiples of the smallest binary64
subnormal. Combining partial sums loses no finite precision. The final result
rounds once to binary64, with ties to even and positive zero. Collection order,
tree shape, and intermediate edits cannot change the result for the same finite
members. A sum can therefore differ from a left-to-right JavaScript reduction:
`1e16 + 1 - 1e16` yields `1` under this contract.

Any NaN input makes the sum NaN. Positive and negative infinity together also
produce NaN; either infinity alone dominates finite contributions. A finite
exact total that overflows during final rounding produces signed infinity.

`min` and `max` propagate NaN. Minimum prefers negative zero and maximum prefers
positive zero. The By forms select a NaN-scored element when one exists. Equal
scores, including two NaNs or signed zeros, select by stable source identity in
UTF-8 order. Reordering the same linked elements preserves the winner. Duplicate
occurrences use the collection identity machinery's occurrence keys. A By result
remains a link to the selected element, retaining its schema and scope.

The By forms carry acquired references through leaf and intermediate results.
Selection retains reference confidentiality and scope restrictions, including
nested immutable references, across persisted tree nodes. Confidential score
reads label the selection; target content labels enter the flow when that
content is read. Numeric-only aggregates do not acquire element references they
do not return.

Sparse holes contribute nothing. For argument-free `count`, `sum`, `min`, and
`max`, a confirmed source transition to `undefined` clears the result and
releases its children. Callback forms inherit `map`'s treatment of an undefined
source as an empty collection: predicate count yields `0`, and the By forms
yield `undefined`. Numeric aggregates require numbers, and score callbacks
require numeric results.

## Why order and grouping cannot change a result

The tree combines members in identity order and splits them into blocks by
collection size, so a membership change moves members between blocks and
regroups the combines above them. A result stays independent of that
arrangement because every combine is associative and commutative over the
partial results it receives.

Binary64 addition is commutative but not associative, because each addition
rounds: `(0.1 + 0.2) + 0.3` is `0.6000000000000001`, while `0.1 + (0.2 + 0.3)`
is `0.6`. Partial sums rounded at each tree node would make a total depend on
identity order and collection size.

`sum` rounds only at the root. Every finite binary64 value is an integer
multiple of `2 ** -1074`, so a partial sum holds its finite total as a `bigint`
count of that unit, and combining two partial sums adds integers. NaN and the
two infinities are flags combined with `||`. Integer addition and `||` are
associative and commutative, so every arrangement of the same members reaches
the same exact total and rounds it once, the same way. Predicate `count` adds
integer counts, which binary64 represents exactly below `2 ** 53`.

The extrema involve no arithmetic. Each selects the first candidate in one
order: a NaN score first, then the smaller score for a minimum or the larger
for a maximum, then for `min` and `max` the preferred zero sign, then the
smaller identity key in UTF-8 order. Identity keys include the occurrence
number, so no two candidates in one aggregate tie under that order. Selecting
the first element of a totally ordered set is associative and commutative.

[`aggregate-sum.test.ts`](../../packages/runner/test/aggregate-sum.test.ts) and
[`chooseAggregateCandidate.test.ts`](../../packages/runner/test/builtins/chooseAggregateCandidate.test.ts)
check both properties over seeded inputs in shuffled orders and random
groupings. A seeded search finds the counterexamples it draws; it does not show
that none exists.

## Choosing a collection computation

Use `computed` for an inline derivation or module-level `lift` to reuse one.
Moving the same loop between them does not make it incremental. The
[collection-loop measurements](../history/development/performance/2026-09-11-computed-lift-collection-loops.md)
compared computed, broad lift, and narrow lift on 32, 128, and 512 linked rows.
All three skipped an unread-field edit and scanned the collection for an edit
to the summed field. At 512 rows that update performed 1,025 proxy reads and
515 link hops in completed action bodies. These counters exclude setup,
network traffic, and other runtime work; they do not establish equal latency.

For an operation in the table above, compare its contract with the computation
you need. In particular, `sum` rounds an exact accumulated total once, so it
can differ from an ordered JavaScript reduction. Use an explicit cell receiver;
`rows.map(score).sum()` is not an available replacement.

A captured collection scanned separately for each row can multiply work by
both collection sizes. Move work shared by all rows outside the row callback
when that preserves dependencies and output identity. Measure the demanded
result, including initialization, membership changes, and committed updates
through settlement. A named aggregate whose callback reads a shared collection
can still invalidate every callback.

## Work and ownership

The runtime sorts element identity keys and builds a balanced tree with at most
32 elements in a leaf block. A change to an independently linked member reads
one block and recomputes its ancestors. Predicate and score evaluation use the
existing per-element `map` machinery. A callback that reads the entire array or
a captured value shared by every element can invalidate every callback.

Initialization and membership changes reconcile the collection: O(N) identity
reads and O(N log N) sorting. Appending, removing, or reordering can rebuild many
blocks. Inline primitive arrays store their values in the membership document,
so changing one of those values also takes this reconciliation path. This is
not a cheap-append implementation.

Tree nodes are ordinary child runs with transaction rollback and child-lifetime
ownership. Only the result container belongs to the coordinator for its whole
lifetime. Cold initialization confirms stored inputs and the result container
before interpreting defaults or replacing a durable result. The map scope probe
observes link structure; scalar result changes do not resubscribe its coordinator
to every element's content.

Generic `reduce` remains the full-rerun option for order-dependent folds. Lower
read counts alone do not establish a speedup: compare committed updates through
settlement with `packages/runner/test/aggregate.bench.ts`. The benchmark covers
all six names at 10, 100, and 1,000 linked rows, including predicate/score
maintenance, and excludes fixture construction and disposal from update timing.

For a paired comparison, run the standalone report:

```sh
ENV=test deno run --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders packages/runner/test/aggregate-comparison.ts
```

It emits JSON lines with initialization counters, update counters, and twelve
timed updates after one warmup. Timing alternates the two implementations and
disables read accounting; a separate update collects counters. Extrema updates
alternate the winning element. Initialization timing includes read accounting
and source commits, but excludes pattern compilation and source construction.
