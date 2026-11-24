import { computed, NAME, pattern, UI, type VNode } from "commonfabric";

// W6 positive control: `new Date(value)` with an argument is a deterministic
// format of a known timestamp, not an ambient clock read, so the gated intrinsic
// leaves it untouched — it must NOT throw even inside a lift.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  label: string;
}

const LiftDateWithArgOk = pattern<void, Output>(() => {
  const label = computed(() => new Date(1718000000000).toISOString());
  return {
    [NAME]: "lift-date-with-arg-ok",
    [UI]: <div>{label}</div>,
    label,
  };
});

export default LiftDateWithArgOk;
