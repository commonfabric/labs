# Chapter 2 — Cells: Reactive, Durable State

Everything in Common Fabric is built from cells, so this chapter is the
foundation for all the others. The good news: as a pattern author you mostly
*don't* handle cells explicitly. You declare ordinary-looking types, and the
framework hands you values that happen to be reactive. The skill is knowing
when you need more than that.

## The core principle: everything is reactive; `Writable<>` is about writes

This is the single most important rule in the system, and the one newcomers
trip on (it's the first thing `docs/common/concepts/reactivity.md` says):

> Everything in Common Fabric is reactive by default. The `Writable<>`
> wrapper in type signatures doesn't enable reactivity — it indicates
> **write intent**.

A pattern declares its inputs as an interface. Plain types give you reactive
*read* access; wrapping a field in `Writable<>` additionally gives you the
mutation methods.

```tsx
// Shown at module scope.
interface ReadOnlyInput {
  count: number;        // reactive — display it, derive from it
  items: Item[];        // reactive — .map() over it
}

interface WritableInput {
  count: Writable<number>;   // also lets you call count.set(...)
  items: Writable<Item[]>;   // also lets you call items.push(...)
}
```

Why does the type system carry this? Two reasons, one practical and one
deep:

- Practical: the methods have to come from somewhere. `count.set(1)` only
  typechecks if `count` is `Writable<number>`.
- Deep: as Chapter 7 explains, **types are compiled into JSON schemas**, and
  the schema is what the runtime uses to subscribe to data and to decide
  what a handler is allowed to touch. Declaring write intent in the type is
  declaring it to the runtime, not just to the compiler.

The write-capable surface (`docs/common/concepts/types-and-schemas/writable.md`):

```ts
// Shown inside a pattern body.
value.get()              // current value (inside computations: also subscribes)
value.set(next)          // replace (last-write-wins)
value.update({ k: v })   // shallow merge into an object
value.increment(1)       // add to a number — mergeable: concurrent increments sum
items.push(item)         // append — mergeable: disjoint appends merge
items.pushAll(list)      // append every element of a list — mergeable
items.addUnique(item)    // append if not already present — mergeable
items.remove(item)       // remove the first matching element
items.removeByValue(item) // remove elements equal to a value — mergeable
items.elementById("id")  // cell for one element, addressed by a stable key
obj.key("field")         // navigate to a sub-cell: a Writable of one field
```

`.key()` deserves a highlight: it gives you a *cell for a part of a cell*.
`item.key("title")` is a `Writable<string>` that reads and writes
`item.title` — which is exactly what you hand to a two-way-bound input
(Chapter 4). Reactivity is path-granular: a computation that read only
`item.title` does not re-run when `item.done` changes.

The methods marked *mergeable* matter for collaboration: they commit the
*intent* of the write (append this, add one) rather than the resulting
value, so two users pushing to the same list — or incrementing the same
counter — both land, merged by the server, instead of one clobbering the
other. `writable.md` spells out the authoring contract, including when a
write is *not* mergeable (a push whose value depends on reading the same
list is a read-modify-write, and the compiler warns about it).

## Defaults: `Default<>`

Cells are durable documents; a brand-new piece has *no* data yet. Any input
field without a default is `undefined` at runtime until someone writes it.
So the convention (`docs/common/concepts/types-and-schemas/default.md`) is:

> Use `Default<>` for any field that will be displayed in UI or used in
> computations.

```ts
// Shown at module scope.
interface TodoItem {
  title: string;                       // required
  done: boolean | Default<false>;      // defaults to false
}

interface TodoListInput {
  items?: Writable<TodoItem[] | Default<[]>>;
}
```

Note the composition in the last line — this is the most common shape for
mutable collections, and each part earns its place:

- `TodoItem[]` — the value type;
- `| Default<[]>` — a new piece starts with an empty list instead of
  `undefined`;
- `Writable<...>` — the pattern intends to `.push()` to it;
- `?` — callers may omit it (the default fills it in).

`Default<>` is a *branded type*: it exists only at the type level, and the
compiler turns it into a `default:` annotation in the generated JSON schema.
The runtime applies it when the underlying document is missing.

## Where does a cell live? Spaces and scopes

Every cell lives in a **space** — a durable store named by a DID. When a
piece is instantiated in a space, its argument and result cells are created
there, and everyone with access to the space shares them. That's the default
and it's what makes a todo list collaborative with zero effort.

But not all state should be shared that widely. Is the *currently selected
tab* shared by all users of the space? Obviously not. Common Fabric makes
this an explicit, declarative choice with **scope wrappers**
(`skills/pattern-dev/SKILL.md`):

```ts
// Shown at module scope.
interface ChatInput {
  conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  name?:         PerUser<string | Default<"">>;
  selectedRoom?: PerSession<SelectedRoom | Default<EMPTY_ROOM>>;
}
```

- `PerSpace<T>` — one value shared by everyone in the space (the default
  semantics; the wrapper makes it explicit).
- `PerUser<T>` — one value per authenticated user, following them across
  devices and sessions. Display names, drafts, preferences.
- `PerSession<T>` — one value per session/tab, ephemeral. Selection,
  filters, open modals. The litmus test from the skill doc: *"if the user
  opens the same instance in a new tab, should this state carry over? If
  not, it is probably `PerSession<>`."*

The crucial discipline: **never simulate isolation by keying ordinary data
on user or session ids.** The runtime implements scopes by physically
partitioning storage per principal/session (Chapter 9), which means
isolation is enforced below your code, not by your code remembering to
filter.

## Creating cells inside a pattern

Pattern inputs are the normal way state enters a pattern. Occasionally a
pattern needs private state that isn't part of its interface — say, a
"currently editing" buffer. You can create a cell directly:

```ts
// Shown inside a pattern body.
const editedName = new Writable("");                    // pattern-scoped
const selectedItem = new Writable.perSession<string | null>(null);
const sharedBoard = new Writable.perSpace(DEFAULT_BOARD);
```

Two rules, both rooted in how patterns execute (Chapter 3 and 8):

1. **This is rare — prefer inputs.** Inputs are visible, linkable, and
   testable; private cells are not (`docs/common/patterns/new-cells.md`).
2. **Initialize with static values only.** The pattern body runs once, at
   graph-construction time, when reactive inputs have no values yet.
   `new Writable(deck.name)` throws ("reactive reference outside context");
   instead initialize empty and copy inside an event handler:

```ts
// Shown inside a pattern body.
const editedName = new Writable("");
const startEditing = action(() => {
  editedName.set(deck.name);   // fine: handlers run at event time
});
```

(You may see `cell()` in older patterns; it's deprecated in favor of
`new Writable()` — `packages/patterns/DEPRECATED_IDIOMS.md`.)

## Identity: comparing cells, not values

Cells are references into a store, so "is this the same item?" means
reference identity, not structural equality. When you need to find or remove
a specific element, use the framework's `equals()`:

```ts
// Shown at module scope.
import { equals } from "commonfabric";
const idx = items.get().findIndex((el) => equals(item, el));
```

Don't invent `id` fields to work around this — the reference *is* the
identity, and it stays correct when two users hold the same item.

## What you can rely on (the contract)

Summarizing the guarantees the rest of the system is built to provide —
mechanisms in Chapters 8 and 9:

- **Reads are subscriptions.** Any value you read inside a `computed()`, a
  JSX expression, or a handler's reactive context re-runs that computation
  when the value changes — even if the change came from another machine.
- **Writes are transactional.** All writes from one handler invocation go
  into one transaction — which by default targets a single space — and
  commit atomically, or not at all. (A handler *can* end up writing a
  second space, e.g. by instantiating a pattern there via a factory's
  `.inSpace()`; such transactions commit per-space, sequentially, with no
  cross-space atomicity.)
- **Updates are optimistic and converge — by one of three routes.** Your
  own writes always apply locally and instantly. What happens when two
  users race depends on the kind of write: *mergeable* operations (`push`,
  `pushAll`, `addUnique`, `increment`, `removeByValue`) are merged by the
  server, so concurrent writers all land; plain scalar `set`s — including
  the writes two-way UI bindings make — are last-write-wins, the later
  write simply sticks; and read-modify-write commits carry their read set,
  so a genuine conflict rolls the loser back and retries it against fresh
  state. In all three cases you don't write merge code.
- **Durability is automatic.** There is no save button anywhere in this
  system. If it committed, it's in SQLite on the server.

---

**Next:** [Chapter 3 — Patterns](03-patterns.md): the programs that give
cells behavior.
**Under the hood:** what a cell actually is (a typed link into a space, plus
a scheduler) — [Chapter 8](08-runtime-internals.md); how durability and sync
work — [Chapter 9](09-storage-and-sync.md).
