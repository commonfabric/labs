import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-pattern-param-mixed
// Verifies: computed() capturing a mix of cells, pattern params, and plain locals
//   computed(() => (value.get() + config.base + offset) * config.multiplier + threshold.get()) → lift(...)({ value, config: { base, multiplier }, offset, threshold })
// Context: Captures four different variable types: cell (value, threshold with
//   asCell), pattern param (config with .key() rewriting), and plain local
//   (offset as plain number). All coexist in a single capture object.
export default pattern((config: { base: number; multiplier: number }) => {
  const value = new Writable(10);
  const offset = 5; // non-cell local
  const threshold = new Writable(15); // cell local

  const result = computed(() =>
    (value.get() + config.base + offset) * config.multiplier + threshold.get()
  );

  return result;
});
