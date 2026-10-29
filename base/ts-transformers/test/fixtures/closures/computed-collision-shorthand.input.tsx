import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-collision-shorthand
// Verifies: a shorthand property `{ multiplier }` over a captured cell expands correctly
//   computed(() => ({ value, data: { multiplier } })) → lift(...)({ multiplier })
// Context: shorthand must keep the property name while binding to the captured value
export default pattern(() => {
  const multiplier = new Writable(2);

  // The callback uses shorthand property { multiplier } over the captured cell.
  const result = computed(() => ({
    value: multiplier.get() * 3,
    data: { multiplier },
  }));

  return result;
});
