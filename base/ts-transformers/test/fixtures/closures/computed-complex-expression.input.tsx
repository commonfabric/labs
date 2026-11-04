import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-complex-expression
// Verifies: computed(() => expr) with three cell captures in an arithmetic expression
//   computed(() => (a.get() * b.get() + c.get()) / 2) → lift(({ a, b, c }) => ...)({ a, b, c })
//   All three cells (a, b, c) are captured with asCell: true in the schema.
export default pattern(() => {
  const a = new Writable(10);
  const b = new Writable(20);
  const c = new Writable(5);

  const result = computed(() => (a.get() * b.get() + c.get()) / 2);

  return result;
});
