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
| `.pinDocument()` | In a handler, commit only if this cell's document is unchanged (see below) |

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

A mergeable method that follows a `set()` of the same value in one handler is
not mergeable either. `list.set([])` and then `list.push(item)` says the list
holds exactly that one item, so the commit carries the list as the handler
left it and replaces whatever the server held, where an append would have
added to it. The same goes for a `set()` of an object and then a `push` into a
list inside it, and for `count.set(10)` and then `count.increment(1)`. Such a
write conflicts and retries like any whole-value write. Setting a different
field, or one element of the list, changes nothing on a document that already
exists: a `push` beside those is still mergeable. On a document the handler
is the first to write, a `push` and any other write to that document are
committed together as its whole value.

That holds for any write to a document the handler saw as absent, a plain
`set()` of one field included: the commit carries the whole document, and is
refused, and the handler run again, if another user created the document in
the meantime. The exception is a mergeable method that is the handler's only
write to it, which lands on whatever is there.

A `push` or `addUnique` onto a list that does not exist yet, or that was set
to `undefined`, starts the list with what it adds.

## Confirming what a handler read: `pinDocument`

With server execution on, a handler runs on the server, and its commit is
checked against the documents it writes. A document it only read is not
checked. So a handler that reads a document, decides something from it, and
writes the decision somewhere else — an outcome, a receipt, a reply — can
commit a decision that a concurrent change to that document has already made
stale. Writing the same value back does not help, since a write that changes
nothing is not committed.

`cell.pinDocument()` closes that gap. Called in a handler, it makes the commit
conditional on the document the cell lives in still holding, when the commit
lands, the value it holds now. If another commit has changed it, this one is
refused as a conflict and the handler runs again against the new value. With
server execution off, the server already refuses a commit whose reads went
stale, and the pin holds the same way there.

```tsx
// Shown at module scope.
import { handler, Writable } from "commonfabric";

type Entry = { state: string; revision: string };

export const confirm = handler<
  unknown,
  { entry: Writable<Entry>; outcome: Writable<{ revision?: string }> }
>((_event, { entry, outcome }) => {
  entry.pinDocument();
  outcome.set({ revision: entry.get().revision });
});
```

- **Pin first, then decide and write.** The first pin of a document holds for
  the rest of the run: a later call is a no-op, and a write after the pin does
  not move it. Pinning a document the handler has already written throws,
  since the run would read back its own uncommitted write and pin that. The
  write is no substitute for the pin: a handler's write to some fields of a
  document can be merged past a concurrent change to its other fields, which
  the pin refuses.
- **The whole document, and only it.** The pin covers the whole document,
  wherever in it the cell points, so `entry.key("state").pinDocument()` pins
  all of `entry`'s document. A cell that reaches its document through a link
  pins that document, not the ones holding the link.
- **Where it works.** Only in a handler, and only for a space-scoped document;
  anywhere else it throws. A handler's commit goes to one space, and a pin
  claims its document's space as a write does: pinning a document in another
  space than the handler has written throws, and so does a write to another
  space after a pin.
- **What it reads.** Pinning reads the whole document, so a confidentiality
  label anywhere in it applies to the handler as any read of it would.

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
