import { computed, pattern } from "commonfabric";

// FIXTURE: computed-no-captures
// Verifies: computed(() => expr) with no external captures is transformed to
// lift(false, fn)() with no input object.
export default pattern(() => {
  const result = computed(() => 42);

  return result;
});
