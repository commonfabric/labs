import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

// FIXTURE: map-single-capture
// Verifies: .map() on reactive array captures a single outer state property
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {discount: ...}}))
//   item.price * state.discount → lift(...)(...) combining element and captured state
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.price * state.discount}</span>
        ))}
      </div>
    ),
  };
});
