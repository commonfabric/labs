import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-local-variable
// Verifies: callback-local variables are not captured, but outer cells are
//   computed(() => { const sum = a.get() + b.get(); return sum * c.get() }) → lift(...)({ a, b, c })
// Context: `sum` is a local const inside the callback and must not appear in captures
export default pattern(() => {
  const a = new Writable(10);
  const b = new Writable(20);
  const c = new Writable(30);

  const result = computed(() => {
    const sum = a.get() + b.get();
    return sum * c.get();
  });

  return result;
});
