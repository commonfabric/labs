import { computed, pattern, UI } from "commonfabric";

// FIXTURE: lift-result-type-cf-ref-normalized
// Verifies: a synthesized lift's RESULT type argument that is a commonfabric
// type (here JSXElement, the type of the returned JSX) is emitted as the
// canonical __cfHelpers.JSXElement form, NOT the inline TS import-type form
// the printer produces by default.
//
// Regression guard for the bug where lift result-type construction bypassed the
// qualifyCommonFabricTypeRefs normalizer. The companion invariant test
// (test/no-import-type-in-output.test.ts) guards every path globally; this
// fixture pins the specific JSX-returning-computed shape with a legible,
// minimal diff so a regression is obvious here too.
export default pattern<{ count: number }>(({ count }) => {
  return {
    [UI]: <div>{computed(() => <span>{count}</span>)}</div>,
  };
});
