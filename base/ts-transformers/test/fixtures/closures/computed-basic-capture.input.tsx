import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-basic-capture
// Verifies: computed(() => expr) with two cell captures is closure-extracted into a lift-applied computation
//   computed(() => value.get() * multiplier.get()) → lift(({ value, multiplier }) => value.get() * multiplier.get())({ value, multiplier })
//   Captured cells are annotated with asCell: true in the capture schema.
export default pattern(() => {
  const value = new Writable(10);
  const multiplier = new Writable(2);

  const result = computed(() => value.get() * multiplier.get());

  return result;
});
