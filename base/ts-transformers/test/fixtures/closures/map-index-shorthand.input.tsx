import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
}

// FIXTURE: map-index-shorthand
// Verifies: .map() on reactive array is transformed when index param uses shorthand names (i, idx)
//   .map((item, i) => ...) → .mapWithPattern(pattern(...), {})
//   .map((item, idx) => ...) → .mapWithPattern(pattern(...), {})
// Context: Two maps using different shorthand index names; no outer captures
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map with common shorthand index parameter names */}
        {state.items.map((item, i) => (
          <div key={i}>
            Item #{i}: {item.name}
          </div>
        ))}

        {/* Map with idx as index parameter */}
        {state.items.map((item, idx) => (
          <div key={idx}>
            Position {idx}: {item.name}
          </div>
        ))}
      </div>
    ),
  };
});
