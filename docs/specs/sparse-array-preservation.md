# Sparse Array Preservation

## What is a sparse array?

A sparse array is a JavaScript array with "holes" — indices that have no value
at all, not even `undefined`. They're created by `new Array(len)`, by `delete
arr[i]`, or by literal syntax like `[1, , 3]`.

```js
const sparse = [1, , 3];
sparse.length;    // 3
0 in sparse;      // true  — index 0 has a value
1 in sparse;      // false — index 1 is a hole
sparse[1];        // undefined (but so would an explicit undefined be)
```

The only reliable way to distinguish a hole from an explicit `undefined` is the
`in` operator: `i in arr` returns `false` for holes and `true` for present
values (including `undefined`).

## Why we care

Sparse arrays are a core data structure in our reactive pipeline. They represent
collections where some positions are intentionally empty — for example, a list
that uses stable indices as identity keys, where items can be removed without
shifting other elements.

When the `map` builtin processes a list, it creates one pattern run per element.
If holes are filled in with `undefined` or `null`, map creates pattern runs for
those positions too — wasting resources and producing incorrect output. The
correct behavior: `map([A, <hole>, B])` should produce `[f(A), <hole>, f(B)]`
with only two pattern runs.

## How JavaScript destroys sparseness

Many common array operations silently convert holes to `undefined`:

| Operation | Preserves holes? |
|-----------|-----------------|
| `[...arr]` (spread) | No — holes become `undefined` |
| `arr.map(fn)` | Skips holes in callback, but output has `undefined` at those positions |
| `Array.from(arr)` | No — holes become `undefined` |
| `for...of` | Yields `undefined` for holes |
| `arr.push(...other)` | Densifies `other` via spread |
| `arr.slice()` | Yes |
| `arr.forEach(fn)` | Yes — callback is only called for present indices |
| `for (let i = 0; i < len; i++)` with `arr[i]` | Reads `undefined` (indistinguishable from explicit `undefined`) |
| `for (let i = 0; i < len; i++)` with `i in arr` | Correctly detects holes |

The last two rows are the key techniques. We use `forEach` when we only need to
visit present elements. We use `for` + `i in arr` when we also need to detect
absent indices (e.g. to emit deletions in the diff engine).

## The two sparse-safe patterns

We use two patterns depending on the situation. Both produce the same result for
sparse arrays — only the style differs.

### `forEach` (preferred for iteration)

```ts
// Shown inside a pattern body.
const result = new Array(arr.length);       // pre-allocate with holes
arr.forEach((v, i) => {
  result[i] = transform(v);                // only called for present indices
});
```

`forEach` skips holes automatically — the callback is never called for absent
indices. This makes sparse-safety structural: you can't forget to check `i in
arr` because there's no check to write. Use this for copies, transforms, and any
iteration where you only care about present elements.

For a plain copy, `cloneIfNecessary({ frozen: false, deep: false })`
preserves sparseness internally -- see "v2-transaction write path" below
for the production usage shape.

### `for` + `i in arr` (when you need to detect absences)

```ts
// Shown inside a pattern body.
for (let i = 0; i < arr.length; i++) {
  if (!(i in arr)) continue;               // skip holes
  result[i] = transform(arr[i]);           // only touch populated indices
}
```

Use this when you need to compare two arrays and detect indices that are present
in one but absent in the other (e.g. the diff engine emitting deletions), when
you need early exit (`break`/`return`), or when you have complex loop state that
doesn't fit a callback.

## Where sparse arrays flow through the codebase

Data flows through the reactive pipeline in this order. Every layer preserves
sparseness:

```
Write path:  value → normalizeAndDiff (conversion + anchoring) → storage
Read path:   storage → traverseDAG → normalizeAndDiff → builtins (map, etc.)
```

### Storage and serialization (foundation)

These layers handle sparse arrays correctly and are less likely to regress
because their sparse support was part of the original design:

- **`packages/data-model/src/convertible-js.ts`** —
  `shallowFabricFromConvertibleJsValue` and `fabricFromConvertibleJsValue` use
  `i in arr` checks. An accepted array that needs a copy goes through
  `cloneHelper()`, which rebuilds it with `new Array(length)` and copies only
  the indices that are present; one that is already a valid deep-frozen
  `FabricValue` crosses by identity, holes and all.
- **`packages/data-model/src/codec-json/JsonCodecEngine.ts`** — Encodes a run of
  holes as a single hole-tagged count; decoding rebuilds them as true holes.
- **`packages/data-model/src/value-hash.ts`** — Feeds holes to the hash
  directly, coalescing each run into one hole entry.

### Value validation (`packages/data-model/src/types/validation.ts`)

`isValidFabricValueLayer()` and `isValidFabricValue()` accept sparse arrays —
holes are valid fabric structure. `isValidFabricValue()` uses `for` + `i in`
because it needs early return, skipping holes rather than validating them as
values.

### v2-transaction write path (`packages/runner/src/storage/v2-transaction.ts`)

The hot write path (since PR #3704) goes through `applyMutablePathWrite`,
which calls `cloneForMutation` (in
`packages/data-model/src/value-clone.ts`) to shallow-thaw the
spine and then mutates the leaf parent in place. `cloneForMutation`'s
shallow-thaw step uses `cloneIfNecessary({ frozen: false, deep: false })`
on each spine container, which for arrays preserves sparseness: it
pre-allocates `new Array(arr.length)` and copies elements via `i in arr`,
so holes survive.

The leaf write itself is one of:

- `parent[slot] = value` for array index value writes -- the rest of the
  array (including holes elsewhere) is untouched, so sparseness is
  preserved. Writing `undefined` stores `undefined` at the slot
  (present-but-undefined, `i in arr` returns `true`); it does NOT create
  a hole.
- `delete parent[slot]` for explicit array index deletes (requested via
  the write's `delete` option) -- creates a true hole (`i in arr`
  returns `false` afterwards).
- `parent.length = effective` for `.length` writes (see
  `applyArrayLengthWrite`) -- JS `length=` truncates the tail, leaving
  holes within the new bound intact.

### Cell write path (`packages/runner/src/data-updating.ts`)

Objects in arrays are anchored into entity documents inside
`normalizeAndDiff()`'s array branch, driven by the writer's anchor id source
(`DiffWalkState.nextAnchorId`, a builder frame's counter). The branch's
per-index loop skips hole→hole positions outright (`!inNew && !inCur →
continue`), so holes are preserved and draw no ids; the counter is consumed
only for present object elements.

The cell `push` method concatenates arrays using `forEach` on the original
(sparse) array, then a `for` loop for the appended (dense) values.

### Cell read path (`packages/runner/src/traverse.ts`)

`traverseDAG` reconstructs arrays from storage. It uses `forEach` on
`doc.value`, assigning populated elements by index into `new Array(len)`. The
result array is registered with the cycle tracker before population so that
circular references can return it early.

`traverseArrayWithSchema` (the schema-driven traversal path) uses `for` + `i in`
because it has early `return undefined` exits (broken redirects, schema
mismatches). It pre-allocates with `new Array(len)` and uses indexed assignment
instead of `push`.

### Diff engine (`packages/runner/src/data-updating.ts`)

`normalizeAndDiff` compares the new array against the current array to produce a
changeset. It uses `for` + `i in` (not `forEach`) because it needs to detect
indices present in the old array but absent in the new one. It handles four cases
for each index:

| `i in new` | `i in current` | Action |
|-----------|----------------|--------|
| No | No | Skip — hole unchanged |
| No | Yes | Emit explicit delete (`delete: true` on the change; the write layer creates a hole) |
| Yes | No | Diff as new value (an explicit `undefined` emits a value write, making the slot present-but-undefined) |
| Yes | Yes | Diff normally |

Note: a change whose `value` is `undefined` WITHOUT the `delete` flag is a
value write that stores `undefined`; only `delete: true` creates a hole.

The `hasPath` function uses `index in value` (not `value[index] !== undefined`)
to correctly report that a path through a hole does not exist.

### Map builtin (`packages/runner/src/builtins/map.ts`)

The identity-based reconciliation loop uses `for` + `i in list` to skip holes.
It pre-allocates `new Array(list.length)` and uses indexed assignment instead of
`push`, so holes are structurally preserved in the output. No pattern runs,
identity keys, or result cells are created for hole indices. When the input list
changes reactively:

- **Value becomes hole:** The output gets a hole at that index. The element is
  no longer one the list holds, so its entry leaves `elementRuns` and its
  pattern run is released.
- **Hole becomes value:** A pattern run is created, reused from `elementRuns`
  when the identity key matches an element the list still holds elsewhere. A
  value returning after its entry was released is set up again on the same
  result cell, whose id is deterministic, so it recovers what it persisted.

### Hashing boundary (`packages/data-model/src/value-hash.ts`)

Holes are hashed as themselves. `ValueHasher`'s `#feedArray()` walks the array
by index and, on reaching an absent one, coalesces the whole run of consecutive
holes into a single hole entry carrying its length. A hole is therefore distinct from a
`null` or an `undefined` element in the hash, exactly as it is in storage, so
two arrays that differ only in sparseness hash differently.

## Writing new code that handles arrays

When you write code that iterates, copies, or transforms arrays anywhere in the
reactive pipeline:

1. **Prefer `forEach`** for iteration, copies, and transforms. It skips holes
   automatically, making sparse-safety the default.
2. **Use `for` + `i in arr`** when you need to detect absent indices, need early
   exit, or have complex loop state.
3. **Never use** `for...of`, `.map()`, spread (`[...arr]`), or `Array.from()` on
   arrays that might be sparse.
4. **Pre-allocate with `new Array(len)`**, not `[]`. An empty array that you
   `push` into will never have holes.
5. **Use indexed assignment** (`result[i] = ...`), not `push`.
6. **Test with sparse arrays.** Create them with `[1, , 3]` (note the lint
   directive `// deno-lint-ignore no-sparse-arrays`) and verify holes survive
   with `i in result`.

If you're writing a plain array copy, `cloneIfNecessary` with
`{ frozen: false, deep: false }` preserves sparseness internally and is
the preferred entry point in runner code.

## How we ensure this stays correct

Test coverage verifies sparse preservation at each layer:

- **`packages/data-model/test/types/validation.test.ts`** —
  `isValidFabricValueLayer()` accepts sparse arrays.
- **`packages/data-model/test/convertible-js.test.ts`** — 
  `fabricFromConvertibleJsValue()` preserves holes.
- **`packages/runner/test/cell-core.test.ts`** — sparse-array writes through
  the full Cell write path (which lands in `applyMutablePathWrite`) preserve
  holes; the helper's `cloneForMutation` + leaf-mutation steps round-trip
  sparseness.
- **`packages/runner/test/array-push-mergeable.test.ts`** — `push` onto a
  sparse array preserves the existing holes, including when the cell had no
  prior value and when a concurrent edit touches a hole.
- **`packages/runner/test/traverse.test.ts`** — Sparse array roundtrip through
  `traverse` preserves holes (both `traverseDAG` and schema-driven
  `traverseArrayWithSchema` paths).
- **`packages/runner/test/data-updating.test.ts`** — All four hole transition
  cases (hole-to-hole, value-to-hole, hole-to-value, value-to-value); `hasPath`
  returns false through holes.
- **`packages/runner/test/patterns-core.test.ts`** — End-to-end test: maps over
  `[10, <hole>, 30]` and verifies output is `[20, <hole>, 60]` with holes
  preserved through the full pipeline.

These tests use the `in` operator to assert true sparseness (`1 in result`
should be `false`), not just value equality. A regression that densifies arrays
will fail these assertions.
