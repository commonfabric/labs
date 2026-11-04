import { pattern, UI } from "commonfabric";

interface State {
  items: number[];
  highlight: string;
}

// FIXTURE: map-outer-element
// Verifies: .map() on reactive array captures a local variable aliased from state
//   .map(fn) → .mapWithPattern(pattern(...), {element: ...})
// Context: Local const "element" aliases state.highlight; captured as params.element inside the map pattern
export default pattern<State>((state) => {
  const element = state.highlight;
  return {
    [UI]: (
      <div>
        {state.items.map((_, index) => (
          <span key={index}>{element}</span>
        ))}
      </div>
    ),
  };
});
