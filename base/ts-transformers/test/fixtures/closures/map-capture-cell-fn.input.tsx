import { cell, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-cell-fn
// Verifies: cell() variable closed over in .map() is captured with asCell schema annotation
//   .map(fn) → .mapWithPattern(pattern(...), { count: count })
//   cell(0) capture → params.count with { type: "number", asCell: true }
export default pattern<State>((state) => {
  const count = cell(0);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} #{count}</span>
        ))}
      </div>
    ),
  };
});
