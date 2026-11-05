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

// FIXTURE: counter-pattern
// Verifies: full pattern with handlers, ternary, str template, and schema generation
//   handler<unknown, CounterState>(fn) → handler(true, stateSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<PatternState>(fn)          → pattern(fn, inputSchema, outputSchema)
//   state.value ? a : b (in JSX)      → __cfHelpers.ifElse(...schemas, state.key("value"), lift(...)({...}), "unknown")
//   state.value                        → state.key("value")
// Context: Combines handler schema injection, pattern schema generation, ternary-to-ifElse, and str template transforms
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
