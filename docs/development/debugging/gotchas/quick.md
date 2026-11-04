# Quick Gotchas

One section per short runtime gotcha. Exact error strings are kept verbatim so
you can grep this file for them. Longer gotchas have their own files in this
directory; the full triage matrix is in the [debugging README](../README.md).

Contents:

- [.get() is not a function](#get-is-not-a-function)
- [filter, map, find is not a function](#filter-map-find-is-not-a-function)
- [[object Object] in a computed() string](#object-object-in-a-computed-string)
- [Handler binding error: unknown property](#handler-binding-error-unknown-property)
- [lift() returns stale or empty data](#lift-returns-stale-or-empty-data)
- [ifElse with composed pattern cells](#ifelse-with-composed-pattern-cells)
- [onClick inside computed()](#onclick-inside-computed)
- [Stream subscribe doesn't exist](#stream-subscribe-doesnt-exist)
- [Binding the whole item instead of a property](#binding-the-whole-item-instead-of-a-property)
- [Writable array element types](#writable-array-element-types)
- [Nested Writable types](#nested-writable-types)
- [Handler state typed any unwraps Writables](#handler-state-typed-any-unwraps-writables)
- [Style object declaration order](#style-object-declaration-order)
- [Performance quick tips](#performance-quick-tips)

## .get() is not a function

**Symptom:** `X.get is not a function`

**Why:** Calling `.get()` on a `computed()` or `lift()` result. Only
`Writable<>` types have `.get()`.

**Fix:**

```typescript
// Shown inside a pattern body.
// Given:
const filteredItems = computed(() => items.filter(item => !item.done));

// ✅ Access computed results directly
const count = filteredItems.length;
const paulinaItems = filteredItems.filter(item => item.owner === "paulina");

// ✅ Also correct for lift() results
const formattedValue = getFormattedDate(date);  // Access directly
```

| Type | Has `.get()`? |
|------|---------------|
| `Writable<>` (pattern inputs with write access) | Yes |
| `computed()` results | No — access directly |
| `lift()` results | No — access directly |

See [@writable](../../../common/concepts/types-and-schemas/writable.md).

## filter, map, find is not a function

**Symptom:** `X.filter is not a function` (or `.map`, `.find`, `.reduce`, etc.)

**Why:** Tempting but wrong diagnosis: "I need to unwrap with `.get()`". The
actual cause is that the value isn't an array (yet):

1. The array hasn't been initialized (missing `T[] | Default<[]>`)
2. You're accessing a nested property that doesn't exist
3. A computed is returning the wrong type

**Fix:**

```typescript
// Shown at module scope.
// ✅ Ensure array has a default value
interface Input {
  items: Item[] | Default<[]>;  // Defaults to empty array
}

// ✅ Inside computed(), just use the value directly
const activeItems = computed(() => items.filter(item => !item.done));

// ✅ Writable<T[]> requires .get() to access the array
const handleClear = handler<never, { items: Writable<Item[]> }>(
  (_, { items }) => {
    const done = items.get().filter(item => item.done);  // .get() because items is Writable<>
    // ...
  }
);
```

Diagnostic questions:

1. Is the source a `Writable<>`? → Use `.get()` to read the value
2. Is it a `computed()` or `lift()` result? → Access directly, no `.get()`
3. Is the value possibly undefined? → Add `T[] | Default<[]>` to the interface

## [object Object] in a computed() string

**Symptom:** Pattern NAME or computed string shows `[object Object]` instead of
the actual value.

**Why:** Interpolating a whole reactive object into a template string where a
single field was meant. The object gets coerced to string instead of the field
value being extracted. The same coercion happens when rendering the object in
JSX text position or passing it to a string-typed component attribute —
anywhere a string is expected, an object value stringifies to
`[object Object]`.

**Fix:**

```tsx
// Shown for illustration only.
const selectedPlace = computed(() =>
  places[selectedIndex] ?? null
);

// ❌ selectedPlace is an object, not a string
[NAME]: computed(() => `Location: ${selectedPlace}`),  // Shows "Location: [object Object]"

// ✅ Interpolate the field, not the object
[NAME]: computed(() => `Location: ${selectedPlace?.name ?? "Unknown"}`),
```

**Diagnosis:** Find the template string (or string-position render) and check
what each interpolated expression actually is. If it's an object — a whole
input, a computed that returns an object, an array element — you need a field
access, not the value itself. Derive the display string in a `computed()` that
reads the specific fields (`?.` guards for nullable values), and if the object
can legitimately be absent, provide a string fallback (`?? "Unknown"`) so the
fallback path is also a string.

## Handler binding error: unknown property

**Symptom:** `Object literal may only specify known properties, and 'X' does not exist in type 'Opaque<{ state: unknown; }>'`
when trying to pass event data while binding a handler.

**Why:** Handlers have two-step binding: you pass **state only** when binding.
Event data comes **at runtime** from the UI component. For test buttons with
hardcoded data, use inline handlers instead.

**Fix:**

```typescript
// Shown for illustration only.
const addItem = handler<
  { title: string },               // Event type
  { items: Writable<Item[]> }      // State type
>(({ title }, { items }) => { items.push({ title }); });

// ❌ Passing event data at binding time
<button onClick={addItem({ title: "Test", items })}>Add</button>  // Error!

// ✅ For test buttons, use inline handler
<button onClick={() => items.push({ title: "Test" })}>Add</button>

// ✅ For real handlers, bind with state only
<cf-message-input oncf-send={addItem({ items })} />
// Event data ({ title }) comes from component at runtime
```

## lift() returns stale or empty data

**Symptom:** `lift()` returns 0, empty object, or stale values even when the
source cell has data.

**Why:** `lift()` creates a new frame, and cells cannot be accessed via closure
across frames. `computed()` gets automatic closure extraction by the CTS
transformer; `lift()` does not. Use `computed()` by default in patterns.

**Fix:**

```typescript
// Shown as alternative snippets.
// ❌ Passing cell directly to lift()
const calcTotal = lift((expenses: Expense[]): number => {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal(expenses);  // Returns 0!

// ✅ Use computed() instead
const total = computed(() => {
  const exp = expenses.get();
  return exp.reduce((sum, e) => sum + e.amount, 0);
});

// ✅ If using lift(), pass as object parameter
const calcTotal = lift((args: { expenses: Expense[] }): number => {
  return args.expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal({ expenses });
```

## ifElse with composed pattern cells

**Symptom:** Piece never renders, no errors, blank UI.

**Why:** When using cells from composed patterns directly with `ifElse()`, the
reactivity chain may not be properly established. Wrapping in a local
`computed()` ensures proper reactive context.

**Fix:**

```typescript
// Shown as alternative snippets.
// ❌ May hang — cell from composed pattern
const showDetails = subPattern.isExpanded;
{ifElse(showDetails, <div>Details</div>, null)}

// ✅ Use local computed cell
const showDetails = computed(() => subPattern.isExpanded);
{ifElse(showDetails, <div>Details</div>, null)}
```

## onClick inside computed()

**Symptom:** "ReadOnlyAddressError: Cannot write to read-only address" when a
button rendered inside `computed()` is clicked.

**Why:** `computed()` creates read-only inline data addresses. Always render
buttons at the top level and control visibility with `disabled` or `ifElse`.

**Fix:**

```typescript
// Shown inside a pattern body.
// ❌ Buttons inside computed() fail when clicked
{computed(() =>
  showAdd ? <cf-button onClick={addItem({ items })}>Add</cf-button> : null
)}

// ✅ Move button outside, use disabled attribute
<cf-button onClick={addItem({ items })} disabled={computed(() => !showAdd)}>
  Add
</cf-button>

// ✅ Or use ifElse instead of computed
{ifElse(showAdd, <cf-button onClick={addItem({ items })}>Add</cf-button>, null)}
```

## Stream subscribe doesn't exist

**Symptom:** `Property 'subscribe' does not exist on type 'Stream<...>'` when
trying to create or receive handler events by subscribing to a `Stream`.

**Why:** Streams aren't created directly — they're the result of binding a
handler with state. The bound handler IS the stream that can receive events.

**Fix:**

```typescript
// Shown for illustration only.
// ❌ Streams are not subscribed to directly
const addItem: Stream<{ title: string }> = new Stream();
addItem.subscribe(({ title }) => {
  items.push({ title });
});

// ✅ A bound handler IS the stream
const addItemHandler = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => { items.push({ title }); }
);
const addItem = addItemHandler({ items });  // This IS Stream<{ title: string }>

// Export it directly
return { addItem };
```

## Binding the whole item instead of a property

**Symptom:** Type mismatch when binding to `$checked` or similar.

**Why:** Trying to bind the whole item instead of the specific property.

**Fix:**

```typescript
// Shown as JSX element children.
// ❌ Trying to bind entire item
<cf-checkbox $checked={item} />

// ✅ Bind the boolean property
<cf-checkbox $checked={item.done} />
```

## Writable array element types

Use `Writable<T[]>` by default. Only use `Writable<Array<Writable<T>>>` when
you need Writable methods (like `.equals()`) on individual elements:

```typescript
// Shown inside a pattern body.
// ✅ Standard — Writable<T[]>
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => items.push({ title: "New" })
);

// ✅ Advanced — Writable<Array<Writable<T>>> for .equals()
const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_event, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

See [@writable](../../../common/concepts/types-and-schemas/writable.md).

## Nested Writable types

**Symptom:** A field typed `Writable<Writable<T>>` doesn't behave as a
writable holding a writable — reads and writes land on the wrong layer.

**Why:** Directly nesting `Writable` in `Writable` is not a supported shape.
(This is distinct from `Writable<Array<Writable<T>>>`, which is supported —
see [Writable array element types](#writable-array-element-types).)

**Fix:** Box the inner writable in an object:

```typescript
// Shown for illustration only.
// ❌ Directly nested
current: Writable<Writable<Item> | null>;

// ✅ Boxed in an object
current: Writable<{ active: Writable<Item> | null }>;
// initialized with { active: null }
```

## Handler state typed any unwraps Writables

**Symptom:** Inside a handler, `.get()`/`.set()` fail on a state field that is
a `Writable<>` at the binding site — the handler received the plain value.

**Why:** The transformer generates a schema from the handler's declared state
type. `any` yields a schema with no shape, so the runtime cannot tell which
fields are writable references and resolves everything to plain values.

**Fix:** Give handler state a precise type. If the handler mutates, name the
field `Writable<T>` (or `Cell<T>` for links); `any` never preserves cell-ness.

## Style object declaration order

**Symptom:** Two declarations of a `style={{ ... }}` object set the same
property, and the one listed last is not the one that takes effect. With
`{ borderTop: "2px solid", borderColor: "red" }` the top border comes out in
the text color.

**Why:** A style object's declarations are written to the `style` attribute in
the UTF-8 order of their keys, not in the order the object lists them. Stored
data keeps no order for an object's keys, so the renderer has none to follow.
CSS lets the later of two declarations of one property win, so the winner is
the one whose key sorts later, wherever the object lists it. Here
`border-top` is written after `border-color` and resets the color, and listing
`borderColor` first instead changes nothing.

**Fix:** Write the style so that the result does not depend on which
declaration comes last.

```tsx
// Shown for illustration only.
// ❌ `border-top` is written after `border-color`, and resets the color
<div style={{ borderTop: "2px solid", borderColor: "red" }} />

// ✅ One declaration carries the whole value
<div style={{ borderTop: "2px solid red" }} />
```

A shorthand whose name is a prefix of its longhand, as `padding` is of
`paddingTop`, is written first, so the longhand still applies. A `style` given
as a string is written as it is.

## Performance quick tips

For lists with 100+ items that feel slow:

```typescript
// Shown for illustration only.
// ❌ Creates a handler per item per render
{items.map(item => {
  const remove = handler(() => { ... });
  return <cf-button onClick={remove}>x</cf-button>;
})}

// ✅ Create once at module scope, bind per item
const removeItem = handler((_, { items, item }) => { ... });
{items.map(item => <cf-button onClick={removeItem({ items, item })}>x</cf-button>)}
```

```typescript
// Shown for illustration only.
// ❌ Expensive computed per item in the loop
{items.map(item => <div>{computed(() => expensive(item))}</div>)}

// ✅ Compute once, then map the result
const processed = computed(() => items.map(expensive));
{processed.map(result => <div>{result}</div>)}
```

If the UI churns or never settles, that's not a tuning problem — see
[non-idempotent-detection](../non-idempotent-detection.md).

## See Also

- [@reactivity](../../../common/concepts/reactivity.md) — reactivity system
- [@writable](../../../common/concepts/types-and-schemas/writable.md) — Writable type system
- [@COMPONENTS](../../../common/components/COMPONENTS.md) — UI components and event handling
- [@computed](../../../common/concepts/computed/computed.md) — when to use computed()
