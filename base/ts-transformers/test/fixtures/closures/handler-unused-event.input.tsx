import { Cell, pattern, UI } from "commonfabric";

interface State {
  counter: Cell<number>;
}

// FIXTURE: handler-unused-event
// Verifies: inline handler with an unused event param (_) still generates an event schema placeholder
//   onClick={(_: unknown) => state.counter.set(...)) → handler(event schema, capture schema, (_, { state }) => ...)({ state })
// Context: Event param is named _ (unused); transformer emits a generic event schema placeholder
export default pattern<State>((state) => {
  return {
    [UI]: (
      <button type="button" onClick={(_: unknown) => state.counter.set(state.counter.get() + 1)}>
        Increment (ignore event)
      </button>
    ),
  };
});
