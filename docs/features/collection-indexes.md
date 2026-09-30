# Collection indexes

For authoring recipes alongside `map`, `filter`, and `reduce`, see
[reactive collections](../common/concepts/reactive-collections.md).

Array-valued Cells expose `groupBy(selector)` and `keyBy(selector)`. Each
selector receives one source element. The compiler lowers it to reactive key
extraction; the runtime owns membership maintenance for each source occurrence.

`groupBy` retains every occurrence under its selected key. `keyBy` retains the
occurrence with the smallest collection occurrence identity under UTF-8 ordering.
Reordering the same linked elements preserves this winner; removing it exposes
the next candidate. Groups use the same identity order, independent of source
position. Replacing an inline value follows ordinary collection identity rules.

Both operators return a typed handle. `lookup(key)` observes one bucket and
returns an ordinary reactive group or optional original element. Missing groups
are empty arrays; missing unique entries are `undefined`. `keys()` separately
observes occupied-key enumeration. Lookup does not read that enumeration or scan
the source collection.

The index's own scheduler action publishes the descriptor that `lookup(key)`,
`keys()`, and `keyEntries()` read, and a consumer can run before that action
commits. A receiver counts as an index when its stored descriptor says so or
when its own schema does, which is what separates an index that has not
published yet from ordinary data; a receiver that is neither is rejected. In
that window `keys()` and `keyEntries()` return the empty enumeration an index
with no occupants returns, and re-run once the descriptor arrives.

`lookup(key)` needs the mode as well, since an empty group and an absent unique
match differ. A published descriptor carries it. Before that, `lookup(key)`
takes it from the handle's type: `groupBy` produces a `GroupIndex` and `keyBy` a
`KeyIndex`, and each names its mode in the schema its handle carries, so a
lookup on one returns that mode's empty answer and re-runs once the descriptor
arrives. `CollectionIndexData` takes the mode as its third type argument and
defaults to both, so a handle spelled through that interface directly names
neither; `lookup(key)` on one fails saying so until its descriptor is
published.

## Authored lookup and joins

Build an index outside the callbacks that consume it. Use an explicit Cell or
Writable array receiver for `groupBy` and `keyBy`; ordinary array types do not
expose these operators. Selectors take one element, and cannot depend on its
array position. The compiler lowers authored `lookup` and `keys` calls into
reactive computations.

```ts
import { pattern, Writable } from "commonfabric";

export default pattern<{
  donuts: Writable<{ code: string; glaze: string; price: number }[]>;
  orders: Writable<{ donutCode: string; quantity: number }[]>;
}>(({ donuts, orders }) => {
  const byGlaze = donuts.groupBy((donut) => donut.glaze);
  const byCode = donuts.keyBy((donut) => donut.code);
  return {
    chocolatePrices: byGlaze.lookup("chocolate").map((donut) => donut.price),
    glazes: byGlaze.keys(),
    ordersWithDonuts: orders.map((order) => ({
      order,
      donut: byCode.lookup(order.donutCode),
    })),
  };
});
```

Each order remains present if its donut code has no match; its `donut` is
`undefined`. A group lookup observes that group's members, while `glazes`
requests the separate occupied-key enumeration. Duplicate codes follow the
identity-based winner rule above, so `keyBy` is not a last-write-wins table.

## Keys

Keys are strings, finite numbers, booleans, or Cell references. Primitive domains
are distinct, and positive and negative zero share a numeric key. Nullish keys
omit an occurrence. Unsupported keys fail through the shared key resolver.

`keys()` is the simple enumeration surface for homogeneous key domains. Use
`keyEntries()` for mixed primitive/Cell selectors. Each occupied key has either
`{ kind: "value", value: primitiveKey }` or `{ kind: "cell", cell: cellKey }`
shape. Branch on `kind` and pass the selected field to lookup within that branch.
Combining both fields into an untagged intermediate value reintroduces the
primitive/Cell union materialization boundary.

Public descriptors include both enumeration fields. Manually constructed
`CollectionIndexData` values must supply `keyEntries`; a descriptor stored without
it needs producer reconciliation or an explicit data migration before exposure
through the public handle. Producer reconciliation supplies the missing field
before publishing a recovered descriptor.

Both surfaces preserve deterministic typed-key order and observe occupied-key
membership independently of bucket lookup. Cell entries retain resolved identity,
including cross-space identity. As with other Cell-valued pattern results,
consumers need a Cell-bearing input schema to retain reference capabilities;
a value-only view materializes stored contents.

The [decision record](../history/features/2026-09-11-index-key-enumeration-decision.md)
records the selected representation and alternatives. The
[executed acceptance contract](../history/plans/collection-index-contract.md#tagged-enumeration-acceptance)
records the implementation checks.

A Cell key denotes its resolved space, document, path, and scope. Its schema and
stored contents do not participate in equality. Selecting a Cell preserves that
identity before serialization; selecting a primitive field reads the field's
value. Changing only a selected Cell's contents does not rerun key extraction.
Link retargeting remains reactive.

## Ownership and recovery

Each index owns its bucket descriptor and maintenance records. Bucket values
retain links to original source elements, so consumers can observe non-key
fields directly. Removing the last member deletes the bucket and its occupied
key; an existing lookup can observe subsequent reinsertion. A confirmed absent
source or selector collection clears membership and releases member children.
Restoring both collections rebuilds membership from their current occurrences.

Maintenance children declare materializer write envelopes covering possible
bucket destinations. This keeps a source assigned to B demanded when only A is
observed and the source may move to A. Each maintenance transaction updates its
old and new buckets and participates in ordinary conflict and policy checks.

Coordinator setup state belongs to one serving principal and session. On resume,
the coordinator confirms its source, selector collection, descriptor, and
maintenance records before reconciling membership. Child setup propagates the
resume synchronization requirement. Pending selector tags preserve existing
membership. Teardown releases owned children and prevents pending synchronization
from rearming a released coordinator. A rejected confirmation reaches the
runtime's error handlers with its cause and owning action, while membership
remains intact. Error reporting does not schedule another attempt; a later
input change can start confirmation again. Failures from canceled or superseded
confirmations are ignored.

## Work and limitations

Member setup watches retain Cell references to the selector result, source
element, shared descriptor, and maintenance records. Each member resolves its
selector and reads the concrete maintenance slots it needs; setting up one member
does not materialize every bucket through its input schema. Selector reads remain
reactive, including omitted keys.

Membership reconciliation scans source occurrence identities. `groupBy` writes
one member entry and uses a cached occurrence order to locate its published
slot. Unchanged slots retain their original source links. Copying the order and
result arrays still requires O(M) work for a bucket with M members. A missing
order cache or published group is rebuilt from durable membership with
O(M log M) sorting work. Cache and group updates share the membership
transaction, including rollback and empty-bucket cleanup.

`keyBy` writes one member entry and compares an inserted occurrence with
the cached winner. Non-winning updates avoid enumerating the bucket. Removing
the winner scans the remaining members in O(M) work to choose its replacement.
A missing winner cache is reconstructed from durable membership, and a missing
published bucket is restored from its selected member.

Occupied-key metadata is maintained with membership. A separate child enumerates
and sorts K occupied keys when `keys()` is demanded, which can
require O(K log K) work. Lookup-only demand does not rebuild this enumeration
for membership updates. Retained live membership records are proportional
to source occurrences and occupied keys; storage history follows the ordinary
storage retention policy.

Materializer envelopes can introduce scheduler ordering edges proportional to
source size even when an unrelated lookup does not rerun. These operators make
no constant-time update guarantee. Group consumers also pay for the members they
read. The [benchmark guide](../development/BENCHMARKS.md) describes the
reproducible maintenance-phase probe, which separates initialization, linked-row
changes, membership edits, and lookup retargeting across sizes and key
distributions.

## Left lookup joins

A left lookup join composes a `keyBy` index of the right collection with a `map`
over the left collection. Each left callback returns its original row and
`index.lookup(row.key)` as an optional right match. There is one output per left
occurrence, including unmatched rows; output ordering follows the left `map`.
Duplicate right keys use the index's deterministic winner.

A right-side key edit changes only lookups of the old and new keys. Consumers
read right payload fields through the original linked row, so a payload-only
edit need not rebuild membership. A left-side key edit retargets that left
occurrence's lookup. Removing a shared right match makes every participating
left output unmatched while retaining those left occurrences.

The [join acceptance tests](../../packages/runner/test/collection-index-join.test.ts)
exercise these transitions with local and cross-space right rows, and restart
the composed join in an independent
runtime before editing its right collection. Their observer counts demonstrate
which row consumers rerun; they do not bound all scheduler or storage work.
