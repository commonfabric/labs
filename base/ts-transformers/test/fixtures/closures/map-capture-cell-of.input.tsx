import { Cell, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-cell-of
// Verifies: new Cell() variable closed over in .map() is captured with asCell schema annotation
//   .map(fn) → .mapWithPattern(pattern(...).curry({ counter: counter }))
//   new Cell(0) capture → params.counter with { type: "number", asCell: true }
export default pattern<State>((state) => {
  const counter = new Cell(0);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} #{counter}</span>
        ))}
      </div>
    ),
  };
});
