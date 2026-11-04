import { pattern } from "commonfabric";

const identity = <T,>(value: T) => value;

// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level ordinary helper calls with reactive arguments are lifted
//   as whole calls rather than lowering only the inner argument expression.
//   const label = identity(state.done ? "Done" : "Pending")
//   → const label = lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })
export default pattern<{ done: boolean }>((state) => {
  const label = identity(state.done ? "Done" : "Pending");
  return { label };
});
