import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-conditional-expression
// Verifies: computed(() => expr) with four cell captures in a ternary expression
//   computed(() => value.get() > threshold.get() ? a.get() : b.get()) → lift(({ value, threshold, a, b }) => ...)({ value, threshold, a, b })
//   All four cells are captured with asCell: true in the schema.
export default pattern(() => {
  const value = new Writable(10);
  const threshold = new Writable(5);
  const a = new Writable(100);
  const b = new Writable(200);

  const result = computed(() =>
    value.get() > threshold.get() ? a.get() : b.get()
  );

  return result;
});
