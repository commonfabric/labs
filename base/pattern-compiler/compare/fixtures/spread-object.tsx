/// <cts-enable />
import { computed, pattern } from "commonfabric";

// Value code that spreads a plain record input into a new record: the
// members it copies are read in place through the record.
export default pattern<{ box: { a: string } }>(({ box }) => ({
  spreadBox: computed(() => ({ ...box })),
}));
