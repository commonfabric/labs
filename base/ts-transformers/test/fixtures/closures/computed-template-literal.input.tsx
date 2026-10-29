import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-template-literal
// Verifies: captured cells used inside a template literal expression are extracted
//   computed(() => `${prefix.get()}${value.get()}`) → lift(...)({ value, prefix })
export default pattern(() => {
  const value = new Writable(10);
  const prefix = new Writable("Value: ");

  const result = computed(() => `${prefix.get()}${value.get()}`);

  return result;
});
