import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-collision-property
// Verifies: a captured cell named the same as a returned object property does not rename the property
//   computed(() => ({ multiplier: multiplier.get(), value: ... })) → lift(...)({ multiplier })
// Context: returned object literal `{ multiplier: ... }` property name stays unchanged while the
//   captured variable reference resolves to the capture binding
export default pattern(() => {
  const multiplier = new Writable(2);

  // The callback returns an object with a property named 'multiplier'.
  // Only the variable reference should resolve to the capture, NOT the property name.
  const result = computed(() => ({
    multiplier: multiplier.get(),
    value: multiplier.get() * 3,
  }));

  return result;
});
