import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-pattern-typed
// Verifies: computed() inside a typed pattern with destructured params is closure-extracted
//   computed(() => value.get() * multiplier) → lift(({ value, multiplier }) => value.get() * multiplier)({ value, multiplier })
// Context: The pattern uses generic type params <{ multiplier: number }, number>.
//   Destructured `multiplier` is captured with asOpaque: true (it is a Reactive
//   from the pattern input), while `value` is captured with asCell: true.
export default pattern<{ multiplier: number }, number>(({ multiplier }) => {
  const value = new Writable(10);
  const result = computed(() => value.get() * multiplier);
  return result;
});
