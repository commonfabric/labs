# computed()

`computed()` derives reactive data — strings, numbers, arrays, objects — from
other reactive values. Anything referenced inside the body is automatically
tracked as a dependency, and the result updates when its inputs change.

```tsx
// Shown inside a pattern body.
// ✅ computed() derives data, outside JSX
const filteredItems = computed(() => {
  const query = searchQuery.get().toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(query));
});

// ❌ computed() does NOT gate UI — use plain ternaries in JSX instead
{showForm ? <div>Form content</div> : null}
```

**Rule of thumb:** `computed()` is for deriving data. For conditional
rendering or other simple conditional values in normal pattern code, use plain
ternaries — see [Conditional Rendering](../../patterns/conditional.md).

The compiler's [nested-scan warning](../../../features/read-accounting.md#compiler-hints-for-nested-scans)
points out some repeated scans of captured collections. It is a hint to measure
and examine the computation's structure, not a failing budget or a complete
complexity analysis.

## When NOT to Use computed()

**Never inside JSX for interpolation or property access** — reactivity is
automatic there:

```tsx
// Shown for illustration only.
// ❌ Unnecessary
<div>{computed(() => `Hello, ${userName}`)}</div>
<div>{computed(() => user.name)}</div>

// ✅ Just reference directly
<div>Hello, {userName}</div>
<div>{user.name}</div>
```

**Never inside JSX to gate sections.** Inside a `computed()` body, ternaries
and logical operators are **not** transformed — they execute as plain JS where
a `Writable<boolean>` is always truthy. This is the most common source of
"conditional section always renders" bugs:

```tsx
// Shown inside a pattern body.
// ❌ WRONG - the ternary inside the computed body is plain JS;
// `showForm` is a Writable object (always truthy), so the form always renders
{computed(() => {
  if (!adminMode.get()) return null;
  return <>{showForm ? <div>ALWAYS renders!</div> : null}</>;
})}

// ✅ RIGHT - plain ternaries at lowered sites, including nested ones
{adminMode
  ? <>{showForm ? <div>Form content</div> : null}</>
  : null}
```

See [Conditional Rendering](../../patterns/conditional.md) for which sites the
transformer lowers and the eager-branch-evaluation caveat.

**Never nested.** The inner `computed()` returns a cell reference, not a
value, which breaks reactivity:

```typescript
// Shown inside a pattern body.
// ❌ WRONG - never nest computed()
const badValue = computed(() => 123 + computed(() => myCell.get() * 2));

// ✅ CORRECT - declare separately
const doubled = computed(() => myCell.get() * 2);
const goodValue = computed(() => 123 + doubled);
```

## Dynamic `[NAME]`

Input props are reactive and can't be read at init time. Wrap derived names in
`computed()` (static strings don't need it):

```tsx
// Shown for illustration only.
// ❌ Error: reactive reference outside context
[NAME]: `Study: ${deck.name}`,

// ✅ computed() creates a reactive context
[NAME]: computed(() => `Study: ${deck.name}`),
```

## Side Effects in computed()

If your `computed()` has side effects (like setting another cell), they should be idempotent. Non-idempotent side effects cause the scheduler to re-run repeatedly until it hits the 101-iteration limit.

```typescript
// Shown inside a pattern body.
// ❌ Non-idempotent - appends on every run
const badComputed = computed(() => {
  const current = logArray.get();
  logArray.set([...current, { index: current.length }]); // Grows forever
  return items.length;
});

// ✅ Idempotent - check-before-write with deterministic key
const goodComputed = computed(() => {
  const current = cacheMap.get();
  const key = `items-${items.length}`;
  if (!(key in current)) {
    cacheMap.set({ ...current, [key]: items.length });
  }
  return items.length;
});
```

Reading the ambient clock or entropy inside a `computed()` — `Date.now()`,
no-argument `new Date()`, or `Math.random()` — throws a `TimeCapabilityError`:
those are reactive inputs that would themselves break the idempotency this
section is about. Capture a timestamp inside a handler (where `Date.now()` is
allowed, coarsened to one-second resolution), or read the interval `#now/N`
wish for a value that updates on its own (the bare `#now` wish is a durable
one-shot — the piece's first-ever load time — and never updates).

The scheduler re-runs computations when their dependencies change. If a computation modifies a cell it depends on, it triggers itself. With idempotent operations, the second run produces no change, so the system settles.

Prefer using handlers for mutations instead of side effects in `computed()`.

## Reusable Computations: lift()

`lift()` defines a reusable reactive computation at module scope. `computed()`
is almost always better — reach for `lift()` only when the same derivation is
used in multiple patterns or called multiple times in one pattern:

```typescript
// Shown for illustration only.
// Module scope - reusable across patterns
const getByDate = lift((args: { grouped: Record<string, Item[]>; date: string }) =>
  args.grouped[args.date]
);

// Inside pattern: bind reactive inputs
const result = getByDate({ grouped, date });

// For one-off use, prefer computed()
const result = computed(() => grouped[date]);
```

Like `handler()`, `lift()` must be defined at module scope, never inside the
pattern body — see [Module Scope Requirement](../handler.md#module-scope-requirement)
for why.

### Reading a Value Narrowly and Handing It Back Whole

A `lift()`'s parameter schema describes the view its body can read. With lazy
materialization enabled by default, accessing that view records dependencies
on the paths the body touches. A narrower declaration documents the required
input, but does not by itself make a collection scan incremental: the
[measured collection loops](#collection-loop-cost) read the same amount under
broad and narrow declarations. A body that visits every row still visits every
row when a used field changes.

A derivation can read a few fields and return the original element, preserving
the caller's access to its other fields.

Declare that with a type parameter. The result type is the element type, so the
caller gets back exactly what it passed in:

```typescript
// Shown at module scope.
const nonEmpty = lift(<T extends { key: string }>(
  { rows }: { rows: T[] | Default<[]> },
): T[] => rows.filter((row) => row.key !== ""));
```

```typescript
// Shown inside a pattern body.
// `kept` is Row[] — `payload` is readable through it, though `nonEmpty` never
// declared it and never became reactive to it.
const kept = nonEmpty({ rows });
```

The schema generated for the lift comes from the constraint, argument and result
alike. Here the predicate accesses `key`; it does not inspect each element's
payload. The elements
survive because a value forwarded out of a derivation is written as a reference,
and a reference resolves to its whole document however little the derivation
declared.

This works only for elements passed **through**. An element the body rebuilds —
`rows.map((row) => ({ key: row.key }))` — carries only what was read, and a
consumer declaring more finds the rest missing. The type parameter is what makes
that distinction checkable rather than a matter of care: a body cannot
manufacture a `T`, so the only `T` it can return is one it was given.

The same shape works when the parameter sits inside a cell wrapper, which is how
a derivation says it compares references without reading through them:

```typescript
// Shown at module scope.
const pivot = lift(<T extends { mentions: unknown[] }>(
  { sources }: { sources: ReadonlyCell<T>[] | Default<[]> },
): { source: ReadonlyCell<T>; count: number }[] =>
  sources.map((source) => ({
    source,
    count: source.get().mentions.length,
  })));
```

## Escape Hatches

- **`.sample()`** reads a cell **without creating a reactive dependency** —
  the computed won't re-run when that cell changes. Use it for config/initial
  values, breaking intentional reactive loops, or snapshotting. Overuse leads
  to stale data.
  ```typescript
  // Shown inside a pattern body.
  const result = computed(() => {
    const user = userCell.get(); // dependency - re-runs on change
    const initial = configCell.sample(); // NO dependency
    return doSomething(user, initial);
  });
  ```
- **Imperative code** (for-loops, accumulation, `let`) belongs inside
  `computed()` bodies, not at pattern scope. The body is plain JS over
  unwrapped values.

## Direct Property Access on Computed Objects

Properties of object-shaped computeds can be accessed directly, including in
JSX:

```tsx
// Shown for illustration only.
const data = computed(() => ({ users, posts, config }));

<div>{data.users.length} users</div>
<div>Theme: {data.config.theme}</div>
{data.users.map((user) => <div>{user.name}</div>)}
```

## Cookbook

**Group by:**

```tsx
// Shown inside a pattern body.
const groupedItems = computed(() => {
  const groups: Record<string, Item[]> = {};
  for (const item of items) {
    const cat = item.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  return groups;
});
const categories = computed(() => Object.keys(groupedItems).sort());

// In JSX:
{categories.map((cat) => (
  <div>
    <h3>{cat}</h3>
    {(groupedItems[cat] ?? []).map((item) => <div>{item.title}</div>)}
  </div>
))}
```

**Filter / search:**

```tsx
// Shown inside a pattern body.
const searchQuery = new Writable("");
const filteredItems = computed(() =>
  items.filter((item) =>
    item.title.toLowerCase().includes(searchQuery.get().toLowerCase())
  )
);

// <cf-input $value={searchQuery} placeholder="Search..." />
// {filteredItems.map((item) => <div>{item.title}</div>)}
```

**Statistics** (object-shaped computed; format with `.toFixed()` at the use
site):

```tsx
// Shown inside a pattern body.
const stats = computed(() => ({
  total: items.length,
  completed: items.filter((item) => item.done).length,
  completionRate: items.length > 0
    ? (items.filter((item) => item.done).length / items.length) * 100
    : 0,
}));

// <div>Progress: {stats.completionRate.toFixed(1)}%</div>
```

For the hierarchical summary string convention used by container patterns, see
[Summary Convention](../../conventions/summary.md).

## Collection-loop cost

For operation selection and examples, see
[reactive collections](../reactive-collections.md): `map`, `filter`, `reduce`,
shared indexes, and named aggregates.

Choose `computed` for an inline derivation and a module-level `lift` for a
reusable derivation. Changing that spelling alone does not make a collection
scan incremental. With lazy argument materialization enabled by default, the
callback reads the paths it touches; a broadly declared argument does not by
itself imply that every declared payload field is read.

The [collection-loop comparison](../../../history/development/performance/2026-09-11-computed-lift-collection-loops.md)
measured identical reductions under computed, broad lift, and narrow lift at
three sizes. All three ignored edits to an unread field, and all three scanned
the collection when a summed field changed. The measurement covers action-body
reads, not network traffic or elapsed-time equivalence.

A scan inside another scan can still perform work proportional to both
collection sizes. Measure the reads and update behavior of the demanded result.
For supported operations, consider the
[named incremental aggregates](../../../features/collection-aggregates.md),
checking their numeric, ordering, and membership-update contracts first.
Ordinary `reduce` remains appropriate when its order-dependent semantics are
required.
