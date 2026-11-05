import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  price: number;
  active: boolean;
}

interface State {
  items: Item[];
  taxRate: number;
}

// FIXTURE: filter-map-chain
// Verifies: filter+map chain with captured outer variables
//   .filter(fn) → .filterWithPattern(pattern(...))  — no captures
//   .map(fn)    → .mapWithPattern(pattern(...).curry({ state: { taxRate } }))
// Context: The map callback captures state.taxRate from outer scope, so it
//   appears in the private curry captures and the map body uses a lift-applied
//   computation for the reactive computation. The filter has no captures (only element properties).
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items
          .filter((item) => item.active)
          .map((item) => (
            <div>
              Total: {item.price * (1 + state.taxRate)}
            </div>
          ))}
      </div>
    ),
  };
});
