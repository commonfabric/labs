/// <cts-enable />
import { computed, pattern } from "commonfabric";

// A pattern that computes an output, run alone and compiled into another:
// the atom its expression code mints is the same in both plans.
export const Row = pattern<{ title: string }>(({ title }) => ({
  shout: computed(() => title + "!"),
}));

export default pattern<{ title: string }>(({ title }) => {
  const row = Row({ title });
  return { row };
});
