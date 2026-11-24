import { pattern } from "commonfabric";

// FIXTURE: pattern-object-binary-add
// Verifies: top-level non-JSX arithmetic in an object property is lowered after
//   closure normalization into a direct lift-applied computation rather than left
//   as raw arithmetic over opaque values.
//   return { next: state.count + 1 }
//   → return { next: lift(({ state }) => state.count + 1)({ state }) }
export default pattern<{ count: number }>((state) => ({
  next: state.count + 1,
}));
