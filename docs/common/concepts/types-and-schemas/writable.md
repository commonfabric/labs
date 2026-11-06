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
| `.applyChanges(changes)` | Edit a string cell by position, even while a collaborative editor has it open (see below) |
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

## Editing text a collaborative editor has open: `applyChanges`

A string field that a `cf-code-editor` with `collaborative` has edited is
merged on the server from the editors' keystrokes, and a `.set()` of it is
refused: a whole new value would bypass the edits the open editors merge
with their own typing. `.applyChanges()` is how a handler edits such a field.
It takes changes in the shape of a CodeMirror change spec, `{ from, to?,
insert? }`, whose positions refer to the value the handler read:

```typescript
// Shown for illustration only.
const append = handler<{ line: string }, { content: Writable<string> }>(
  ({ line }, { content }) => {
    const text = content.get();
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    content.applyChanges({ from: text.length, insert: separator + line });
  },
);
```

The changes land only while the field still holds the value the handler read.
If someone typed in the meantime, the commit is refused and the handler runs
again against the new text, so a position computed from what it read is never
applied to text it did not read. Several changes in one call run in ascending
order without overlap, all against the same value; a second call in the same
handler is against the value the first one left, which a `.get()` after the
call also returns. The method works on a field no editor has opened too: there
the first edit opens the field for collaboration, after which `.set()` of it is
refused like any other collaborative field's.

Because any keystroke anywhere in the field refuses the commit, a handler
editing a document several people type in at once may run more than once
before it lands. A write that must not wait on the typing belongs in a field of
its own.

## Anchoring text: `anchorsOf`

A comment, highlight or bookmark on a string field says which text it is
about with **anchors**: points in the field, each stored under an id the
pattern chooses. The runtime moves every anchor of a field through every
edit, whoever makes it, so the pattern stores its anchors' ids and never a
position of its own. A range of text is two anchors, one where it starts and
one where it ends.

`anchorsOf(field)` returns the field's anchors as a cell. Its value is a map
from anchor id to offset, counted in UTF-16 code units as string indexes are,
or `undefined` until something writes it. A handler changes the anchors by
writing that cell, as it writes any other:

```typescript
// Shown at module scope.
interface Comment {
  id: string;
  text: string;
}

type Anchors = Writable<FieldAnchors | undefined>;

// `from`, `to` and `quote` are an editor's selection, as `cf-selection-change`
// reports it.
const addComment = handler<
  { id: string; text: string; from: number; to: number; quote: string },
  {
    content: Writable<string>;
    anchors: Anchors;
    comments: Writable<Comment[]>;
  }
>(({ id, text, from, to, quote }, { content, anchors, comments }) => {
  if (content.get().slice(from, to) !== quote) {
    throw new Error("The text changed under the selection.");
  }
  anchors.set({ ...anchors.get(), [`${id}:from`]: from, [`${id}:to`]: to });
  comments.push({ id, text });
});

const deleteComment = handler<
  { id: string },
  { anchors: Anchors; comments: Writable<Comment[]> }
>(({ id }, { anchors, comments }) => {
  const { [`${id}:from`]: _from, [`${id}:to`]: _to, ...others } =
    anchors.get() ?? {};
  anchors.set(others);
  comments.set(comments.get().filter((c) => c.id !== id));
});

export default pattern<
  { content: Writable<string>; comments: Writable<Comment[]> }
>(({ content, comments }) => {
  const anchors = anchorsOf(content);
  const quoted = computed(() =>
    comments.get().map(({ id }) => ({
      id,
      quote: content.get().slice(
        anchors?.[`${id}:from`] ?? 0,
        anchors?.[`${id}:to`] ?? 0,
      ),
    }))
  );
  return {
    quoted,
    addComment: addComment({ content, anchors, comments }),
    deleteComment: deleteComment({ anchors, comments }),
  };
});
```

A handler that places an anchor reads the field and the anchors, then writes
the anchors. Its commit lands only while the field and the anchors are still
what it read. Where someone has edited the field since, or another handler has
changed the anchors, the commit is refused and the handler runs again against
what they hold now, so an offset a handler computed from the text it read is
never applied to different text.

An offset that comes from outside the handler needs a check of its own. A
range taken from an editor's selection refers to the text the editor showed,
which may be older than what the field holds by the time the handler runs. The
selection carries the text it covered, and the handler compares that with what
the field holds at the range, as `addComment` does above, before it anchors
the range. The comparison catches every edit but one that leaves the same text
at the same offsets, such as a repeated word deleted just ahead of the
selection; the anchors then land on the other copy.

Every anchor moves the way a cursor does. Text inserted at an anchor lands
after it, and an anchor inside deleted text lands where the deletion began. So
a range from one anchor to another takes in text inserted at its start, leaves
out text inserted at its end, and stays over a replacement of exactly its
text. When an edit deletes the text of a range, both anchors land on the same
offset; show that as a comment on text no longer in the field.

Anchors move only with edits made in an editor or through `.applyChanges()`.
A `.set()` of a field that is not open for collaboration, because no editor
has edited it or because it has been released, replaces the text and moves no
anchor. A handler that rewrites the text that way, as an agent rewording a
note does, reads the anchors and writes each one where the new text puts it,
in the same handler.

What a reader of the anchors may learn is decided as for any other cell, by
the label of what was written to it. A handler that reads the field before
writing the anchors writes them under the field's confidentiality. One that
writes anchors without reading the field does not, since an offset its writer
chose says nothing about the field. Once an edit moves such an anchor, its
offset follows the field, and it becomes as confidential as the field was at
that edit; it stays so until a handler writes that anchor again. The field's
write policy does not cover the anchors; a pattern that wants only certain
handlers to move them declares a write policy on the anchors cell's type.

[Collaborative fields](../../../features/collaborative-fields.md#anchors)
describes how anchors are stored and moved.

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
