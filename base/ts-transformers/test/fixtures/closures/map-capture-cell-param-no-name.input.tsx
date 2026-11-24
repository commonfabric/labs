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

// FIXTURE: map-capture-cell-param-no-name
// Verifies: pattern without generic type param still captures destructured bindings correctly
//   .map(fn) → .mapWithPattern(pattern(...), { items: items })
//   items capture → params.items (no asOpaque when schema is inferred from annotation)
// Context: Same as map-capture-cell-param but uses inline type annotation instead of generic
export default pattern(
  ({ items }: InputSchema) => {
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
