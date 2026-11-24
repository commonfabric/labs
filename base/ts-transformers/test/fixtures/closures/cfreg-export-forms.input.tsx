import { lift, pattern } from "commonfabric";

// FIXTURE: cfreg-export-forms
// Verifies which top-level builder artifacts are routed through `__cfReg`:
// - a NON-exported top-level builder const IS registered (by its binding name);
// - artifacts that leave via ANY export form are NOT (they are addressable
//   through the module namespace by their export name): inline `export const`,
//   a separate `export { ... }`, and a default export.
// The trailing `__cfReg({ ... })` should therefore contain only `internalHelper`
// and the synthetic `__cfPattern_1` (the `.map` op) — never `exportedLift`,
// `reexportedLift`, or the default pattern.

const internalHelper = lift((x: number) => x + 1);

export const exportedLift = lift((x: number) => x * 2);

const reexportedLift = lift((x: number) => x - 1);
export { reexportedLift };

export default pattern<{ items: number[] }>(({ items }) => ({
  vs: items.map((x) => internalHelper(x)),
}));
