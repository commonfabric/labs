import { pattern, UI } from "commonfabric";

type ItemTuple = [item: string, count: number];

interface State {
  items: ItemTuple[];
}

// FIXTURE: map-array-destructure-shorthand
// Verifies: array-destructured map params are not incorrectly captured as shorthand properties
//   .map(([item]) => ...) → .mapWithPattern(pattern(...), {}) with key("element", "0")
//   .map(([item, count], index) → key("element", "0"), key("element", "1"), key("index")
// Context: Shorthand JSX usage like {item} must not cause array-destructured bindings to be captured
export default pattern<State>(({ items }) => {
  return {
    [UI]: (
      <div>
        {/* Array destructured parameter - without fix, 'item' would be
            incorrectly captured in params due to shorthand usage in JSX */}
        {items.map(([item]) => (
          <div data-item={item}>{item}</div>
        ))}

        {/* Multiple array destructured params */}
        {items.map(([item, count], index) => (
          <div key={index}>
            {item}: {count}
          </div>
        ))}
      </div>
    ),
  };
});
