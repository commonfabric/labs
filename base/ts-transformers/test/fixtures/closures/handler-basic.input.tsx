import { Cell, pattern, UI } from "commonfabric";

interface State {
  counter: Cell<number>;
}

// FIXTURE: handler-basic
// Verifies: inline arrow function in JSX onClick is extracted into a handler with captures
//   onClick={() => state.counter.set(...)} → onClick={handler(false, { state: { counter: asCell } }, (_, { state }) => ...)({ state: { counter } })}
export default pattern<State>((state) => {
  return {
    [UI]: (
      <button type="button" onClick={() => state.counter.set(state.counter.get() + 1)}>
        Increment
      </button>
    ),
  };
});
