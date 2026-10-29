import { Cell, handler } from "commonfabric";

interface Item {
  text: string;
}

interface ListState {
  items: Cell<Item[]>;
}

const removeItem = handler<unknown, ListState & { index: number }>(
  (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length) next.splice(index, 1);
    items.set(next);
  },
);

// alias-based intersection variant
type ListStateWithIndex = ListState & { index: number };
const removeItemAlias = handler<unknown, ListStateWithIndex>(
  (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length) next.splice(index, 1);
    items.set(next);
  },
);

// FIXTURE: array-cell-remove-intersection
// Verifies: handler context intersection types are flattened and Cell<T[]> generates array schema with asCell
//   handler<unknown, ListState & { index: number }>() → event: true, context: merged {items, index} schema
//   Cell<Item[]> → { type: "array", items: { $ref: ... }, asCell: true }
// Context: inline intersection vs type alias intersection; alias variant loses $defs (items: true)
export { removeItem, removeItemAlias };
