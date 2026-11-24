import { Cell, Default, handler, pattern, UI } from "commonfabric";

interface Item {
  text: Default<string, "">;
}

interface InputSchema {
  items: Default<Item[], []>;
}

const removeItem = handler<unknown, { items: Cell<Item[]>; index: number }>(
  (_, _2) => {
    // Not relevant for repro
  },
);

// FIXTURE: map-capture-cell-param
// Verifies: destructured pattern param closed over in .map() is captured as opaque
//   .map(fn) → .mapWithPattern(pattern(...), { items: items })
//   items (from pattern destructuring) → params.items with asOpaque: true
// Context: Captures the parent array as opaque to pass to a handler alongside the map index
export default pattern<InputSchema>(
  ({ items }) => {
    return {
      [UI]: (
        <ul>
          {items.map((_, index) => (
            <li key={index}>
              <cf-button onClick={removeItem({ items, index })}>
                Remove
              </cf-button>
            </li>
          ))}
        </ul>
      ),
    };
  },
);
