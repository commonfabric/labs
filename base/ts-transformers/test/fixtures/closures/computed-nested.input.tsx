import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-nested
// Verifies: chained computed() calls where the second captures the result of the first
//   computed(() => a.get() + b.get()) → lift(({ a, b }) => a.get() + b.get())({ a, b })
//   computed(() => sum * 2) → lift(({ sum }) => sum * 2)({ sum })
// Context: The first lift-applied computation captures cells (asCell: true), the second captures
//   the computed result (asOpaque: true) since it is a Reactive.
export default pattern(() => {
  const a = new Writable(10);
  const b = new Writable(20);

  const sum = computed(() => a.get() + b.get());
  const doubled = computed(() => sum * 2);

  return doubled;
});
