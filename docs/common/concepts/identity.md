# Object Identity and Equality

## The Mental Model: Object Graph, Not Database

In traditional web development, you often model data like a database: objects have `id` fields, and you look things up by ID. This works because you're constantly serializing and deserializing data—fetching from APIs, storing in localStorage, passing through JSON.

**Common Fabric works differently.** The reactive fabric is an in-memory object graph with direct references (pointers), not a database with keyed records. When you have a reference to an object, you *have* that object—you don't need an ID to find it later.

```tsx
// Shown at module scope.
// Object graph (no id!)
interface Todo {
  text: string;
  done: boolean;
}

// To delete, use the reference you already have
const deleteTodo = (todo: Todo) => {
  todos.set(todos.get().filter(t => !equals(todo, t)));
};
```

This shift has several benefits:

- **No ID generation** - No UUIDs, no incrementing counters, no collision worries
- **No stale references** - You work with live objects, not cached IDs that might be outdated
- **Simpler types** - Your data models are cleaner without synthetic keys
- **Natural composition** - Objects can reference other objects directly

### One object written at two positions

Writing the same plain object or array at two positions in one write links the
two: after `state.set({ a: EMPTY, b: EMPTY })`, `b` is stored as a link to `a`.
A change inside the value through either position, such as
`state.key("a").push(item)` or `state.key("b").key(0).set(item)`, is read at
both, across sessions. Replacing a position whole is different:
`state.key("b").set([])` replaces the link and ends the sharing, while
`state.key("a").set([])` replaces what the link points at, so `b` reads the new
array too.

Separate writes of an object never link: `state.key("a").set(EMPTY)` and then
`state.key("b").set(EMPTY)` store two independent values, even in one handler.
A cell is different, since a cell is a reference: written at two positions, it
is referenced at both, however many writes put it there. The object itself is
not changed by any of this: `EMPTY` stays as it was. When two positions should
start out equal but change independently, write each its own value (`[]` and
`[]`), or write them separately.

## The `equals()` Function

Use `equals()` to ask whether two things are the *same* thing. It resolves each side to what it points at in the graph — following links — and compares those referents. It never compares contents: two separately-created values are not `equals()` however identical they look, and a value with no place in the graph (a fresh object literal, say) has nothing to compare, so it is never `equals()` to anything but itself.

To compare *contents* instead, use `valueEqual()`, also exported from `commonfabric`.

```typescript
// Shown for illustration only.
import { equals, Writable } from 'commonfabric';

const data = new Writable({ name: "Ben" });

// Reference equality for cells
equals(data, data);                    // => true
equals(new Writable({ name: "Ben" }),
       new Writable({ name: "Ben" }));  // => false (different cells)

// Reference equality for values from a cell
equals(data, data.get());              // => true

// Does not compare cell values!
equals(new Writable({ name: "Gideon" }), { name: "Gideon" });  // => false

// Two object literals have no referents to compare
equals({ name: "Gideon" }, { name: "Gideon" });  // => false

// Works when navigating via .key()
const deepData = new Writable({ address: { street: "123 Main" } });
equals(deepData.key("address"), deepData.get().address); // => true

// But only for objects
equals(deepData.key("address", "street"), deepData.get().address.street); // => type error
```

### Using `equals()` in Array Operations

The most common use case is finding items in arrays:

```typescript
// Shown at module scope.
import { equals, handler, Writable } from 'commonfabric';

interface Item {
  name: string;
  quantity: number;
}

// Check if item exists
const hasItem = lift<{ item: Item, items: Item[] }>(
  ({ item, items }) => items.some(el => equals(item, el))
);
```

**Tip:** For removing items, use `array.remove(item)`, it uses the same `equals()` under the hood.

### In `.map()` Callbacks

When iterating with `.map()`, you have a reference to each item. Use that reference directly:

```tsx
// Shown inside a pattern body.
{items.map((item) => (
  <cf-card>
    <span>{item.name}</span>
    <cf-button onClick={() => {
      // Use the reference you already have
      const allItems = items.get(); // If items is a Writable<Item[]>, otherwise use directly
      const idx = allItems.findIndex(i => equals(item, i));
      if (idx >= 0) {
        selectedIndex.set(idx);
      }
    }}>
      Select
    </cf-button>
  </cf-card>
))}
```

Instead of fighting the reactive system with IDs, work with it using `equals()` and direct references.

See [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md) for more details and workarounds.
