import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ price: number }>;
  checkout: { discount: number };
  upsell: { discount: number };
}

// FIXTURE: map-multiple-similar-captures
// Verifies: .map() correctly captures multiple state properties with the same leaf name
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {checkout: {discount}, upsell: {discount}}}))
//   expression → lift(...)(...) with both discount paths distinguished
// Context: state.checkout.discount and state.upsell.discount share the name "discount" but are separate captures
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>
            {item.price * state.checkout.discount * state.upsell.discount}
          </span>
        ))}
      </div>
    ),
  };
});
