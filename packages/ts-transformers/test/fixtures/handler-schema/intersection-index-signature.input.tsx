import { Cell, handler } from "commonfabric";

interface Item {
  text: string;
}
interface ListState {
  items: Cell<Item[]>;
}

// The index signature merges beside the members of `ListState`.
type Indexed = { [k: string]: unknown };

const removeItem = handler<{ key: string }, ListState & Indexed>(
  (event, state) => {
    state.items.get();
    state[event.key];
  },
);

// FIXTURE: intersection-index-signature
// Verifies: an intersection with an index signature merges into one open object
//   handler<{key:string}, ListState & Indexed>() → context: { properties: { items }, additionalProperties: { type: "unknown" } }
// Context: the dynamic key read keeps the index signature's values beside
//   `items`; without it, shrinking can safely keep only `items`.
export { removeItem };
