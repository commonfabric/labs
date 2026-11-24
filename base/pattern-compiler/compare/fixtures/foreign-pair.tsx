/**
 * A computation that reads a field of each of two documents its argument
 * refers to. A test hands references to two documents of one entity, one
 * in the space of the piece and one in another space.
 */
import { computed, pattern } from "commonfabric";

interface Source {
  name: string;
}

export const Paired = pattern<
  { here: Source; there: Source },
  { both: string }
>(
  ({ here, there }) => ({
    both: computed(() => `${here.name} and ${there.name}`),
  }),
);
