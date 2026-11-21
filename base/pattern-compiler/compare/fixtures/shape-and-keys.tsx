/// <cts-enable />
import { computed, pattern } from "commonfabric";

// One position read for its keys and for its shape: an `enumeration` slot
// and a `shape` slot with the same root and path.
export default pattern<{ box?: Record<string, number> }>(({ box }) => ({
  count: computed(() => box === undefined ? -1 : Object.keys(box).length),
}));
