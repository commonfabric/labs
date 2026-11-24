import { computed, pattern } from "commonfabric";

interface MyInput {
  value: number;
}

// FIXTURE: pattern-with-type
// Verifies: pattern with inline typed parameter generates input and output schemas
//   pattern((input: MyInput) => ...)   → pattern((input) => ..., inputSchema, outputSchema)
//   input.value                        → input.key("value")
// Context: Identical structure to pattern-with-name-and-type; confirms consistent behavior
export default pattern((input: MyInput) => {
  return {
    result: computed(() => input.value * 2),
  };
});
