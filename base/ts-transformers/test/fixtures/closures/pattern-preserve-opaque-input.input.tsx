import { pattern, type Writable, UI } from "commonfabric";

interface State {
  foo: string;
  bar: string;
}

// FIXTURE: pattern-preserve-opaque-input
// Verifies: Writable<T> pattern input is preserved as an opaque ref, with JSX .get() wrapped in a lift-applied computation
//   input.key("foo").get() in JSX → lift(({ input }) => input.key("foo").get())({ input })
// Context: When the pattern parameter is typed as Writable<State>, the input
//   schema carries `asCell: ["opaque"]`. The .get() call inside JSX is not in a
//   safe reactive context, so it gets wrapped in a lift-applied computation.
export default pattern((input: Writable<State>) => {
  return {
    [UI]: <div>{input.key("foo").get()}</div>,
  };
});
