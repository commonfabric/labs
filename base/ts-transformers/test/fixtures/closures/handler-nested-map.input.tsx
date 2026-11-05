import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ value: number }>;
  multiplier: number;
}

// FIXTURE: handler-nested-map
// Verifies: .map() inside a handler body is NOT transformed to .mapWithPattern()
//   onClick={() => { state.items.map(...) }) → handler(..., (_, { state }) => { state.items.map(...) })
// Context: .map() on a plain array inside a handler remains a normal JS .map(), not a reactive transform
export default pattern<State>((state) => {
  return {
    [UI]: (
      <button
        type="button"
        onClick={() => {
          const scaled = state.items.map((item) => item.value * state.multiplier);
          console.log(scaled);
        }}
      >
        Compute
      </button>
    ),
  };
});
