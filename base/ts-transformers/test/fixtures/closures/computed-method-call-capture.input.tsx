import { Writable, computed, pattern } from "commonfabric";

interface State {
  counter: { value: number };
}

// FIXTURE: computed-method-call-capture
// Verifies: a deep property access on a captured object is restructured into a nested capture object
//   computed(() => value.get() + state.counter.value) → lift(...)({ value, state: { counter: { value } } })
// Context: `state.counter.value` is captured as a nested object structure, not a flat binding
export default pattern((state: State) => {
  const value = new Writable(10);

  // Capture a deep property path on the pattern input
  const result = computed(() => value.get() + state.counter.value);

  return result;
});
