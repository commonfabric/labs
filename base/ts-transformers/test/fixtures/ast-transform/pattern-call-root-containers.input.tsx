import { pattern } from "commonfabric";

const identity = <T,>(value: T) => value;

// FIXTURE: pattern-call-root-containers
// Verifies: top-level ordinary call roots whole-wrap consistently across
//   non-JSX container kinds instead of lowering only their nested conditional
//   arguments.
//   { value: identity(state.done ? "Done" : "Pending") }
//   → { value: lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state }) }
//   [identity(state.done ? "Done" : "Pending")]
//   → [lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })]
//   return identity(state.done ? "Done" : "Pending")
//   → return lift(({ state }) => identity(state.done ? "Done" : "Pending"))({ state })
export const objectAndArray = pattern<{ done: boolean }>((state) => {
  const view = {
    value: identity(state.done ? "Done" : "Pending"),
    list: [identity(state.done ? "Done" : "Pending")],
  };

  return view;
});

export default pattern<{ done: boolean }, string>((state) =>
  identity(state.done ? "Done" : "Pending")
);
