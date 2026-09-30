### Creating Writable Cells with new Writable()

Use `new Writable()` to create NEW writable cells in your pattern body or return values.

This is rare. Generally prefer to add additional input parameters instead of
creating internal cells.

**When to use new Writable():**

- Creating new cells inside a pattern that can't be input parameters.
- Creating local state that handlers will mutate

**When NOT to use new Writable():**

- Input parameters (they're already writable if declared with `Writable<>`)
- Values you won't mutate

**IMPORTANT: Initialize with static values only**

You cannot initialize a cell with a reactive value (like an input prop) because `new Writable()` runs at pattern initialization time, outside a reactive context:

```tsx
// Shown for illustration only.
// WRONG - deck.name is reactive, causes "reactive reference outside context" error
export default pattern<Input>(({ deck }) => {
  const editedName = new Writable(deck.name);  // ERROR!
  ...
});

// CORRECT - initialize with static value, set from event handler
export default pattern<Input>(({ deck }) => {
  const editedName = new Writable("");  // Static initial value

  const startEditing = action(() => {
    editedName.set(deck.name);  // OK - event handlers run at click time
    editingMode.set(true);
  });
  ...
});
```

Derived data belongs in `computed()`, not a writable cell — a
`new Writable()` you fill from other values goes stale the moment its inputs
change. Legitimate pattern-owned cells hold UI state that only handlers write:

```typescript
// Shown for illustration only.
// Creating new cells in pattern body
export default pattern(({ items }) => {
  // Pattern-owned UI state, mutated by handlers
  const editingMode = new Writable(false);
  const searchQuery = new Writable("");
  const selectedItem = new Writable<Item | null>(null);

  // Derived data: computed(), never a writable cell.
  // computed() bodies are plain JavaScript — read cells with .get()
  const filteredItems = computed(() => {
    const query = searchQuery.get();
    return items.get().filter((item) => item.title.includes(query));
  });

  return {
    [UI]: <div>...</div>,
    // Return cells so they're reactive and mutable
    editingMode,
    searchQuery,
    selectedItem,
  };
});

// Common patterns
const count = new Writable(0);                           // Number
const name = new Writable("Alice");                      // String
const items = new Writable<Item[]>([]);                  // Empty array with type
const user = new Writable<User>();                       // Optional value
const config = new Writable<Config>({ theme: "dark" });  // Object with initial value
```

### Representing values that are not available yet

Use a discriminated union when a value is not available at first and later
becomes a writable cell.

This makes each state explicit. It also lets TypeScript narrow the value before
code passes it to a handler or provider client.

```typescript
import { Writable } from "commonfabric";

type AuthData = { token: string };

type AuthAvailability =
  | { state: "loading"; auth: null }
  | { state: "ready"; auth: Writable<AuthData> };

const availability: AuthAvailability = {
  state: "ready",
  auth: new Writable({ token: "token" }),
};

const authReady = availability.state === "ready";
const auth = availability.state === "ready" ? availability.auth : null;
```

This shape follows the same state-machine style as `FetchState` in the program
fetch cache.

A readiness predicate over the union gives code a shared boolean for a disabled
state or a status panel. Code that needs to write still needs the cell itself,
so keep the `availability.state === "ready" ? availability.auth : null`
selection next to the handler or component that uses it.

Do not move that selection into a plain function. The function can run outside
the reactive transform and hide the `state` read. Do not use `lift()` to return
`Writable<AuthData> | null` either: `lift()` receives a read-only view of cell
input, so it is the right tool for the boolean readiness check and the wrong
tool for exporting write access.
