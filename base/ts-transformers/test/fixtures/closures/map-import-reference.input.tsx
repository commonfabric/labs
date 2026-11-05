import { pattern, UI } from "commonfabric";

// Module-level constant - should NOT be captured
const TAX_RATE = 0.08;

// Module-level function - should NOT be captured
function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
}

// FIXTURE: map-import-reference
// Verifies: .map() on reactive array is transformed when callback references module-level constants and functions
//   .map(fn) → .mapWithPattern(pattern(...))
//   formatPrice(item.price * (1 + TAX_RATE)) → lift-applied computation wrapping the expression
// Context: Module-level constant (TAX_RATE) and function (formatPrice) are NOT captured as reactive params
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Should NOT capture module-level constant or function */}
        {state.items.map((item) => (
          <div>
            Item: {formatPrice(item.price * (1 + TAX_RATE))}
          </div>
        ))}
      </div>
    ),
  };
});
