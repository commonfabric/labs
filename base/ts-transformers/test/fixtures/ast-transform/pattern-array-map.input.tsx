import { Cell, computed, handler, NAME, pattern, str, UI } from "commonfabric";

const adder = handler((_, state: { values: Cell<string[]> }) => {
  state.values.push(Math.random().toString(36).substring(2, 15));
});

// FIXTURE: pattern-array-map
// Verifies: .map() on a reactive array is transformed to .mapWithPattern()
//   values.map((value, index) => JSX)  → values.mapWithPattern(pattern(fn, elementSchema, outputSchema))
//   computed(() => { ... })            → captures `values` into lift(inputSchema, outputSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<{ values: string[] }>      → pattern(fn, inputSchema, outputSchema)
// Context: Destructured pattern parameter; combines array map transform with computed and handler schemas
export default pattern<{ values: string[] }>(
  ({ values }) => {
    computed(() => {
      console.log("values#", values?.length);
    });
    return {
      [NAME]: str`Simple Value: ${values.length}`,
      [UI]: (
        <div>
          <button type="button" onClick={adder({ values })}>Add Value</button>
          <div>
            {values.map((value, index) => (
              <div>
                {index}: {value}
              </div>
            ))}
          </div>
        </div>
      ),
      values,
    };
  },
);
