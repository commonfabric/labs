import { computed, pattern } from "commonfabric";

interface MyInput {
  value: number;
}

// FIXTURE: pattern-with-name-and-type
// Verifies: pattern with inline typed parameter generates input and output schemas
//   pattern((input: MyInput) => ...)   → pattern((input) => ..., inputSchema, outputSchema)
//   input.value                        → input.key("value")
// Context: Type comes from inline parameter annotation, not generic type argument
export default pattern((input: MyInput) => {
  return {
    result: computed(() => input.value * 2),
  };
});
