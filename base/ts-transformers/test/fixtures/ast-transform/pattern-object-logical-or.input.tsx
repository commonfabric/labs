import { pattern } from "commonfabric";

// FIXTURE: pattern-object-logical-or
// Verifies: top-level non-JSX logical-or in an object property is lowered after
//   closure normalization rather than being left as raw JS short-circuiting.
//   return { label: state.label || "Pending" }
//   → return { label: unless(state.label, "Pending") }
export default pattern<{ label?: string }>((state) => ({
  label: state.label || "Pending",
}));
