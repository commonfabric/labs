import { Cell, Default, handler, NAME, pattern, str, UI } from "commonfabric";

interface CounterState {
  value: Cell<number>;
}

interface PatternState {
  value: Default<number, 0>;
}

const increment = handler<unknown, CounterState>((_e, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

// FIXTURE: counter-pattern-no-name
// Verifies: same transforms as counter-pattern apply even when the file has no unique name
//   handler<unknown, CounterState>(fn) → handler(true, stateSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<PatternState>(fn)          → pattern(fn, inputSchema, outputSchema)
//   state.value ? a : b (in JSX)      → __cfHelpers.ifElse(...schemas, state.key("value"), lift(...)({...}), "unknown")
// Context: Identical to counter-pattern; verifies no-name patterns still transform correctly
export default pattern<PatternState>((state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <cf-button onClick={decrement(state)}>-</cf-button>
        <ul>
          <li>next number: {state.value ? state.value + 1 : "unknown"}</li>
        </ul>
        <cf-button onClick={increment({ value: state.value })}>+</cf-button>
      </div>
    ),
    value: state.value,
  };
});
