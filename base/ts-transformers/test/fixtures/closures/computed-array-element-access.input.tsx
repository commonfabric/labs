import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-array-element-access
// Verifies: an array variable accessed by index inside a computed is captured as a whole array
//   computed(() => expr) → lift(schema, schema)({ value, factors })
// Context: `factors[1]!` uses bracket access; the entire `factors` array is captured
export default pattern(() => {
  const value = new Writable(10);
  const factors = [2, 3, 4];

  const result = computed(() => value.get() * factors[1]!);

  return result;
});
