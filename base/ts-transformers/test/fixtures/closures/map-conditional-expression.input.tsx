import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
  discount: number;
  threshold: number;
}

// FIXTURE: map-conditional-expression
// Verifies: ternary expression in .map() callback is transformed to ifElse() with lift-applied branches
//   item.price > state.threshold ? ... : ... → ifElse(lift(...)(condition), lift(...)(trueBranch), falseBranch)
//   .map(fn) → .mapWithPattern(pattern(...).curry({ state: { threshold, discount } }))
// Context: Captures state.threshold (for condition) and state.discount (for true branch) from outer scope
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Ternary with captures in map callback */}
        {state.items.map((item) => (
          <div>
            Price: ${item.price > state.threshold
              ? item.price * (1 - state.discount)
              : item.price}
          </div>
        ))}
      </div>
    ),
  };
});
