import { Default, NAME, pattern, UI } from "commonfabric";

interface PatternState {
  value: Default<number, 0>;
}

// FIXTURE: ternary_computed
// Verifies: ternary with expressions on both sides produces ifElse() with a lift-applied computation for each branch
//   state.value + 1 ? state.value + 2 : "undefined" → ifElse(...schemas, lift(...)({...}), lift(...)({...}), "undefined")
//   pattern<PatternState>(fn)                        → pattern(fn, inputSchema, outputSchema)
// Context: Both condition and consequent contain state expressions that must be individually lift-applied
export default pattern<PatternState>((state) => {
  return {
    [NAME]: "test ternary with computed",
    [UI]: (
      <div>
        {state.value + 1 ? state.value + 2 : "undefined"}
      </div>
    ),
  };
});
