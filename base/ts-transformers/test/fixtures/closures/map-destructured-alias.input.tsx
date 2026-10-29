import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

// FIXTURE: map-destructured-alias
// Verifies: object destructuring with alias in .map() param is lowered to key() on the original name
//   .map(({ price: cost }) => ...) → key("element", "price") assigned to cost
//   cost * state.discount → lift(...)(...) with both element key and captured state
// Context: Captures state.discount from outer scope; alias uses the original property name for key access
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ price: cost }) => (
          <span>{cost * state.discount}</span>
        ))}
      </div>
    ),
  };
});
