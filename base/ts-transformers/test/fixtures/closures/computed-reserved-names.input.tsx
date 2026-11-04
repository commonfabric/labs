import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-reserved-names
// Verifies: variables with __cf_ prefixed names are captured without special treatment
//   computed(() => value.get() * __cf_reserved.get()) → lift(...)({ value, __cf_reserved })
export default pattern(() => {
  const value = new Writable(10);
  // A __cf_-prefixed variable name should be captured like any other
  const __cf_reserved = new Writable(2);

  const result = computed(() => value.get() * __cf_reserved.get());

  return result;
});
