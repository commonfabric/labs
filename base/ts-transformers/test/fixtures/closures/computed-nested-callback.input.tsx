import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-nested-callback
// Verifies: capture extraction works with a nested .map() over a captured cell's array value
//   computed(() => numbers.get().map(n => n * multiplier.get())) → lift(...)({ numbers, multiplier })
//   inner numbers.get().map(fn) runs on a plain array → NOT rewritten to mapWithPattern
// Context: both `numbers` and `multiplier` are captured cells; the inner map reads `multiplier`
export default pattern(() => {
  const numbers = new Writable([1, 2, 3]);
  const multiplier = new Writable(2);

  // Nested callback - the inner array map runs on the unwrapped plain array
  const result = computed(() =>
    numbers.get().map((n) => n * multiplier.get())
  );

  return result;
});
