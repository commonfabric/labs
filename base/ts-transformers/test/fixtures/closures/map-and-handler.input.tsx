import { Cell, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  discount: number;
  selectedIndex: Cell<number>;
}

// FIXTURE: map-and-handler
// Verifies: .map() in JSX is transformed to .mapWithPattern() and inline handler inside map body is extracted
//   state.items.map((item, index) => JSX) → state.key("items").mapWithPattern(pattern(...), { state: { discount, selectedIndex } })
//   onClick={() => state.selectedIndex.set(index)) → handler(false, { state: { selectedIndex: asCell }, index }, ...)
// Context: Combines reactive array mapping with handler extraction; map callback becomes a sub-pattern
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item, index) => (
          <div>
            <span>{item.price * state.discount}</span>
            <button type="button" onClick={() => state.selectedIndex.set(index)}>
              Select
            </button>
          </div>
        ))}
        <div>
          Selected: {state.items[state.selectedIndex.get()]?.price ?? 0} x {state.discount} ={" "}
          {(state.items[state.selectedIndex.get()]?.price ?? 0) * state.discount}
        </div>
      </div>
    ),
  };
});
