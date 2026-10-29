import { computed, NAME, pattern, UI, type VNode } from "commonfabric";

// Negative control for the enforceTimeCapability behavioral check. This pattern
// deliberately reads the wall clock inside a computed — a lift/pure context, not
// a handler — by calling the gated ambient `Date.now()`. Under the gate that
// call throws a TimeCapabilityError when the computed materializes, which is what
// the behavioral-verification test relies on to prove it can catch a real
// violation.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  stamp: number;
}

const LiftClockViolation = pattern<void, Output>(() => {
  const stamp = computed(() => Date.now());
  return {
    [NAME]: "lift-clock-violation",
    [UI]: <div>{stamp}</div>,
    stamp,
  };
});

export default LiftClockViolation;
