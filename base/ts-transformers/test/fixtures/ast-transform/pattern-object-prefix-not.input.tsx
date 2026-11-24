import { pattern } from "commonfabric";

// FIXTURE: pattern-object-prefix-not
// Verifies: top-level non-JSX unary boolean negation in an object property is
//   lowered after closure normalization into a direct lift-applied computation.
//   return { hidden: !state.done }
//   → return { hidden: lift(({ state }) => !state.done)({ state }) }
export default pattern<{ done: boolean }>((state) => ({
  hidden: !state.done,
}));
