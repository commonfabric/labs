import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  prefix: string;
}

// FIXTURE: map-element-computed
// Verifies: .map() on reactive array is transformed with computed element property access
//   .map(fn) → .mapWithPattern(pattern(...))
//   item.name.toUpperCase() → lift-applied computation wrapping the computed expression
// Context: Uses index param; computation on element property triggers a lift-applied wrapper
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Performs computation on element property - should wrap in computed() */}
        {state.items.map((item, index) => (
          <div>
            Item #{index}: {item.name.toUpperCase()}
          </div>
        ))}
      </div>
    ),
  };
});
