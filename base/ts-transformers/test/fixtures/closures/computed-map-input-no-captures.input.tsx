/**
 * Edge case: a computed whose body maps over a captured cell's array value
 * (NO outer captures beyond the cell itself) and reads `.length`.
 *
 * This tests the scenario where:
 * 1. The captured `items` cell is unwrapped via .get() inside the computed body
 * 2. The inner .map() runs on the plain array, so it is NOT rewritten to .mapWithPattern()
 * 3. SchemaInjectionTransformer infers the result type from the computed body
 */

import { Cell, computed, pattern } from "commonfabric";

interface Item {
  id: number;
  value: string;
}

// FIXTURE: computed-map-input-no-captures
// Verifies: a computed over a captured cell array uses a plain .map() (not .mapWithPattern)
//   computed(() => items.get().map(...).length) → lift(...)({ items })
// Context: tests schema injection for a computed whose result derives from a captured cell's array
export default pattern<{ items: Cell<Item[]> }>(({ items }) => {
  // items is a captured cell; .get() yields a plain array, so .map() stays plain.
  const count = computed(() => items.get().map((item) => item.value).length);

  return { count };
});
