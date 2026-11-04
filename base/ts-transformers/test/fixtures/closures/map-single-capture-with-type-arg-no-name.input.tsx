import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  discount: number;
}

// FIXTURE: map-single-capture-with-type-arg-no-name
// Verifies: .map() transform with single capture works with type arg on pattern
//   .map(fn) → .mapWithPattern(pattern(...), {state: {discount: ...}})
// Context: Same as map-single-capture but exercises the type-arg-no-name code path
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