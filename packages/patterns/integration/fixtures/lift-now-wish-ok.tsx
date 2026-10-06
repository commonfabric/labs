import {
  computed,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
  wish,
} from "commonfabric";

// Positive control for the enforceTimeCapability behavioral check. Reading the
// reactive #now clock (one-shot, coarsened to 1s) inside a computed is the
// sanctioned replacement for a raw clock read, and must NOT trip the gate.
interface Output {
  [NAME]: string;
  [UI]: VNode;
  label: string;
}

const LiftNowWishOk = pattern<void, Output>(() => {
  const nowCell = wish<number>({ query: "#now" });
  const nowCellValue = resultOf(nowCell.result);
  const label = computed(() => {
    const nowMs = nowCellValue;
    return `now:${Math.floor(nowMs / 1000)}`;
  });
  return {
    [NAME]: "lift-now-wish-ok",
    [UI]: <div>{label}</div>,
    label,
  };
});

export default LiftNowWishOk;
