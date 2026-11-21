/// <cts-enable />
import { computed, pattern } from "commonfabric";

// The left operand of `??` is the condition of a selector: a `shape` slot
// that no value code reads apart from the read of its value.
export default pattern<{ name?: string }>(({ name }) => ({
  shout: computed(() => (name ?? "").toUpperCase()),
}));
