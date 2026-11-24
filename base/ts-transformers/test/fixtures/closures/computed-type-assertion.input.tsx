import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-type-assertion
// Verifies: a type assertion (`as number`) in the callback body is preserved after capture extraction
//   computed(() => (value.get() * multiplier.get()) as number) → lift(...)({ value, multiplier })
// Context: the `as number` cast remains intact in the transformed callback expression
export default pattern(() => {
  const value = new Writable(10);
  const multiplier = new Writable(2);

  const result = computed(() => (value.get() * multiplier.get()) as number);

  return result;
});
