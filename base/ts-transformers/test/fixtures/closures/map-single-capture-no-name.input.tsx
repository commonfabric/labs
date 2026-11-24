import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

// FIXTURE: map-single-capture-no-name
// Verifies: .map() transform with single capture works when pattern uses inline type annotation
//   .map(fn) → .mapWithPattern(pattern(...), {state: {discount: ...}})
// Context: pattern((state: State) => ...) form without <State> generic type arg
export default pattern((state: State) => {
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
