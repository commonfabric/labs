/**
 * A computation that reads a field of a document its argument refers to.
 * A test hands a reference to a document of another space than the
 * piece's.
 */
import { computed, pattern } from "commonfabric";

interface Source {
  name: string;
}

export const Greeted = pattern<{ source: Source }, { greeting: string }>(
  ({ source }) => ({
    greeting: computed(() => `hello ${source.name}`),
  }),
);
