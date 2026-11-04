## Optional properties

A property marked `?` is one that may be absent. It is not a property that may
hold `undefined`: patterns are type-checked with TypeScript's
`exactOptionalPropertyTypes`, and the schema generated for `title?: string` is
the schema for `string`, with `title` left out of `required`.

The two are different because `undefined` is a value the fabric stores. An
object whose `title` is `undefined` has a `title`, holding a value the schema
for `string` does not describe, even though reading it gives `undefined` just
as reading an absent one does.

### Leaving a property out

When a value may not exist, leave the key out instead of writing `undefined`
into it:

```typescript
// Shown at module scope.
interface Entry {
  title: string;
  note?: string;
}

// ❌ `note` is present and holds `undefined`
function entryWithUndefined(title: string, note: string | undefined): Entry {
  return { title, note };
}

// ✅ `note` is there only when there is one
function entryFor(title: string, note: string | undefined): Entry {
  return { title, ...(note !== undefined && { note }) };
}
```

### A property a cell already holds

A cell has no operation yet that removes one property. Writing `undefined` at
the property keeps it, holding `undefined`, which a reader whose schema leaves
`undefined` out reads as absent. Do not remove it by writing back what `get()`
returned without it: `get()` returns the value as the cell's schema shows it, so
writing that back as the whole object also deletes every stored field the schema
does not name, such as a subtype's.

```typescript
// Shown at module scope.
interface Entry {
  title: string;
  note?: string;
}

// ❌ deletes `note`, and with it every stored field `Entry` does not name
function dropNoteAndMore(entry: Writable<Entry>) {
  const { note: _note, ...rest } = entry.get();
  entry.set(rest);
}

// ✅ `note` holds `undefined`, and nothing else changes
function clearNote(entry: Writable<Entry>) {
  entry.key("note").set(undefined);
}
```

### Passing an optional input on

A pattern sees an optional property of its own input as `T | undefined`. That
value can be handed to another pattern's optional input as it is: what passes
is a reference to the property, which carries its absence with it.

```tsx
// Shown at module scope.
interface Detail {
  label?: string;
}

const DetailView = pattern<Detail>(({ label }) => ({
  [NAME]: "Detail",
  [UI]: <span>{label}</span>,
}));

export default pattern<Detail>(({ label }) => ({
  [NAME]: "Wrapper",
  [UI]: <div>{DetailView({ label })}</div>,
}));
```

A value a `computed()` returns is typed the same way, so the check accepts it
in the same place, but there it is not a reference to something absent: a
computation that returns `undefined` holds `undefined`. Give such a value a
type that says what "nothing" is, such as `null`, rather than relying on the
optional input.

### When `undefined` is a value you mean

If a property can hold `undefined` as a real state, distinct from absent, say
so in the type: `x?: T | undefined`. The schema then carries `undefined` as
one of the values the property admits. This is rarely what a pattern means: a
property that may not be there is `x?: T`, and one that can be cleared is
better typed `x?: T | null`.
