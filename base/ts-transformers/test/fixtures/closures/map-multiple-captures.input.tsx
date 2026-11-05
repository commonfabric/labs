import { pattern, UI } from "commonfabric";

interface Item {
  price: number;
  quantity: number;
}

interface State {
  items: Item[];
  discount: number;
  taxRate: number;
}

const shippingCost = 5.99;

// FIXTURE: map-multiple-captures
// Verifies: .map() on reactive array captures multiple outer variables (state + local)
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {discount, taxRate}, multiplier}))
//   expression → lift(...)(...) combining item + state reactively with `multiplier`
//     wired in as an explicit input (not via lexical closure)
// Context: state.discount and state.taxRate are explicit lift-applied inputs;
//   `multiplier` (a plain-JS value declared in the enclosing pattern callback)
//   is also wired in as an explicit lift-applied input so the callback stays
//   self-contained; module-level `shippingCost` is left lexical (module-scope
//   bindings are stable across hoist boundaries).
export default pattern<State>((state) => {
  const multiplier = 2;

  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>
            Total: {item.price * item.quantity * state.discount * state.taxRate * multiplier + shippingCost}
          </span>
        ))}
      </div>
    ),
  };
});
