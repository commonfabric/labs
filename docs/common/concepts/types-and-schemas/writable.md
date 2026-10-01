# Writable<>

`Writable<>` in type signatures indicates **write intent** (`.set()`, `.push()`,
`.update()`), not reactivity — everything is reactive by default, including
plain `number` or `Item[]` inputs. See [Reactivity and Write Access](../reactivity.md).

## Writable Methods

With `Writable<T>` in your signature:

| Method | Purpose |
|--------|---------|
| `.get()` | Read current value |
| `.set(value)` | Replace entire value |
| `.update({ key: value })` | Partial update (objects) |
| `.push(...items)` | Append to an array (mergeable — see below) |
| `.pushAll(items)` | Append every item of a list, however long, as one `push` (mergeable) |
| `.addUnique(...items)` | Append each item only if not already present (mergeable) |
| `.increment(by?)` | Add a number (default `+1`, may be negative) to a number cell (mergeable) |
| `.remove(item)` | Remove first `item` from array |
| `.removeAll(item)` | Remove all `item` from array |
| `.removeByValue(item)` | Remove every element equal to `item` by stored value (mergeable) |
| `.key(...keys)` | Navigate nested data, e.g. `.key("property")` |
| `.elementById(idKey)` | Cell for one array element addressed by a stable key (see below) |

Without `Writable<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: Outside of JSX, filtering and transformations must be done in `computed()`.

## Mergeable writes (for shared, multi-user state)

The runtime applies a handler's write locally first, then commits it to the
server in the background, and undoes it if the server rejects the commit. The
server rejects a commit when one of the reads it recorded has gone stale —
someone else changed the same data since the read. A write written as
read-the-whole-value, change it, write-the-whole-value-back therefore conflicts
under concurrency: two people editing the same list at the same time, and the
second commit is rejected because its read of the list predates the first edit.
On a list whose value was read as empty during loading, the same shape can
overwrite the durable contents.

The methods marked *mergeable* above avoid this. Instead of carrying a
whole-value diff, the commit carries the operation's intent — "append these",
"add if absent", "add this number", "remove elements equal to this" — and the
server applies it against the current durable value rather than against the
value the handler happened to read. The methods also drop the reads they make
for themselves from the commit's conflict set, so two of them touching the same
collection do not conflict with each other. The practical effect:

- `push` / `pushAll` / `addUnique`: concurrent appends from different users
  all land. With `addUnique`, adding an item that is already present is a no-op
  (deduplicated on the server too), so re-adding the same item is safe.
- `increment`: concurrent increments sum instead of clobbering. A missing value
  counts as zero, so a counter needs no initialization; a zero amount is
  rejected.
- `removeByValue`: concurrent removals of different elements all land.

Use these for state that several users edit at once — a shared list, a vote
count, a participant roster. For a counter, prefer `count.increment(1)` over
`count.set(count.get() + 1)`; for a set-like list, prefer
`list.addUnique(item)` over read-then-`push`.

### When a write is NOT mergeable

A write whose correctness depends on what it first read — for example "append
only if this name is not already taken" — is not made safe by these methods. A
mergeable method drops only the reads it makes for *itself*, not a read your
handler makes explicitly. So if you call `list.get()` and then write based on
what you read, that read stays in the conflict set, and two such handlers still
conflict and retry — the protection an unconditional mergeable write gives up.
Rely on that: keep the explicit `.get()` for a content-dependent condition. If
the condition is uniqueness, prefer `addUnique`, which the server enforces
without a retry. Otherwise keep a read-modify-write `set`.

## Addressing one array element: `elementById`

`array.elementById(idKey)` returns a cell for the array element identified by a
stable string key, derived deterministically from the key (the same key always
names the same element, in any session). This lets a handler read or edit one
element, and add or remove it, without reading or rewriting the whole list:

```typescript
// Shown for illustration only.
const myVote = votes.elementById(`${voterName}:${optionId}`);
myVote.set({ voterName, optionId, color });   // set my vote
votes.addUnique(myVote);                       // add it to the list (dedup by key)
votes.removeByValue(myVote);                   // remove it later
myVote.key("color").set("green");              // edit one field of it
```

Editing a field of the element writes that element's own document, not the
list, so concurrent edits to different elements (or different fields of one
element) merge. Note that the element's document outlives its membership in the
list: removing it with `removeByValue` drops it from the list but does not clear
the element's stored value, so a handler that decides anything by reading the
element back must clear it when removing.

Keyed elements are stored as links to separate documents. Derive values from
those links in an explicit reactive computation or through a maintained index
lookup. A reactive `map` can keep a computation per member; it does not refresh a
plain snapshot captured when that member's callback was constructed. Preserve
original linked members when binding editing handlers, and make reads of other
collections reactive rather than relying on what is already materialized on one
replica.

See [reactive collections](../reactive-collections.md) for filtered views,
reactive row computations, shared lookups, and their cost boundaries. Verify
remote edits and cold loading as well as local updates when testing a derived
view of keyed members.

For the full model and trade-offs (including the add-wins-after-delete
ordering), see
[mergeable collection writes](../../../features/mergeable-collection-writes.md)
and [keyed collection writes](../../../features/keyed-collection-writes.md).

## Passing Values to Pattern Inputs

When calling a pattern, you have two options for providing input values:

**Plain values** create independent state for each pattern instance:

```typescript
// Shown inside a pattern body.
const counter1 = Counter({ count: 0 });
const counter2 = Counter({ count: 0 });
// counter1 and counter2 have separate state - incrementing one doesn't affect the other
```

**Cell references** share state across pattern instances:

```typescript
// Shown inside a pattern body.
const sharedCount = new Writable(0);
const counter1 = Counter({ count: sharedCount });
const counter2 = Counter({ count: sharedCount });
// counter1 and counter2 share state - incrementing one affects both
```

For most cases, pass plain values. Use `new Writable()` when you intentionally want multiple patterns to share the same underlying state.

Note: The `Writable<T>` annotation in a pattern's type signature indicates write intent within that pattern, but doesn't affect how input values are coerced. Plain values always become owned state that the pattern can modify—the pattern can pass these to handlers with `Writable<>` inputs, making them effectively writable regardless of the signature.

## Storing References to Cells

When storing a "pointer" to a Cell (e.g., tracking which item is selected), **box the reference** in an object:

```typescript
// Shown for illustration only.
// ✅ Correct - Boxed reference
interface Input {
  selected: Writable<{ item: Item }>;
}
selected.set({ item });
const { item } = selected.get();
```

Why: When you store a Cell directly, link chain resolution means `.set()` writes to the *target* instead of changing which item is referenced. Boxing breaks the chain.

See [Cell Reference Overwrite](../../../development/debugging/gotchas/cell-reference-overwrite.md) for details.

## Writable<T[]> vs Writable<Array<Writable<T>>>

**Use `Writable<T[]>` by default:**

```typescript
import { handler, Writable } from 'commonfabric';

interface Item {
  title: string;
  done: boolean;
}

const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New", done: false });
    items.set(items.get().filter(x => !x.done));
  }
);
```

**Use `Writable<Array<Writable<T>>>` only when you need identity comparison on
elements** (via `equals()` from `commonfabric`; cells also expose an
equivalent `.equals()` method):

```typescript
// Shown at module scope.
import { equals, handler, Writable } from 'commonfabric';

const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_, { items, item }) => {
  const index = items.get().findIndex(el => equals(el, item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

See [Object Identity and Equality](../identity.md) for the full `equals()` model.

## Schemas Filter Visibility

Schemas act as a visibility filter at runtime. When you read a reference typed
as `SomeInterface`, only properties declared in that interface are visible —
everything else is dropped, even if the underlying data contains it. This is a
common source of mysterious `undefined`s.

```typescript
// Shown at module scope.
// If Notebook.notes is typed as NotePiece[]...
interface NotePiece { title?: string; noteId?: string; }

// ...then parentNotebook is invisible when reading through notes,
// even though the Note's own data contains it.
notebook.notes[0].parentNotebook  // undefined (not in NotePiece)
```

**Fix:** Add the property to the shared interface so it's visible through the schema.
