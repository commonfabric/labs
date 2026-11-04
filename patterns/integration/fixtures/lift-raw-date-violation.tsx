import { computed, NAME, pattern, UI, type VNode } from "commonfabric";

// W6 negative control: a raw `new Date()` read inside a computed (a lift) must
// throw a TimeCapabilityError now that the sandbox `Date` is the gated intrinsic.
// Complements lift-clock-violation.tsx, which exercises the `Date.now()` accessor
// of the same gated intrinsic.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  stamp: number;
}

const LiftRawDateViolation = pattern<void, Output>(() => {
  const stamp = computed(() => new Date().getTime());
  return {
    [NAME]: "lift-raw-date-violation",
    [UI]: <div>{stamp}</div>,
    stamp,
  };
});

export default LiftRawDateViolation;
