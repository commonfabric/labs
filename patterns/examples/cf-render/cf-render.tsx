import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface PatternState {
  value: number | Default<0>;
}

// In this case we do not have to type our event parameter because it is not used in the body.
// By requesting a Writable<number> we get a mutable handle when our handler is invoked.
const increment = handler<unknown, { value: Writable<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

// This can also be done with inline types + inference
const decrement = handler((_, state: { value: Writable<number> }) => {
  state.value.set(state.value.get() - 1);
});

function previous(value: number) {
  return value - 1;
}

function nth(value: number) {
  if (value === 1) {
    return "1st";
  }
  if (value === 2) {
    return "2nd";
  }
  if (value === 3) {
    return "3rd";
  }
  return `${value}th`;
}

export const Counter = pattern<PatternState>((state) => {
  return {
    // computed() is used to create reactive derived values
    [NAME]: computed(() => `Simple counter: ${state.value}`),
    [UI]: (
      <div>
        {
          /* Even though we could end up passing extra data to decrement, our schema prevents that actually reaching the handler.
          In fact, we are passing `value` as a Reactive<number> here but it becomes a Writable<number> at invocation time */
        }
        <cf-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </cf-button>
        <span id="counter-result">
          {/* CTS transforms pure functions (like nth) into the `derive(c, nth)` equivalent */}
          Counter is the {nth(state.value)} number
        </span>
        <cf-button onClick={increment({ value: state.value })}>
          inc to {state.value + 1}
        </cf-button>
      </div>
    ),
    value: state.value,
  };
});

export default pattern<PatternState>((state) => {
  const counter = Counter({ value: state.value });

  return {
    [NAME]: computed(() => `Counters: ${state.value}`),
    // These three methods are all functionally equivalent
    [UI]: (
      <div>
        <div>Inline: {counter}</div>
        <div>
          Component: <Counter value={state.value} />
        </div>
        {/* cf-render will NOT usually appear in a pattern, rather, it's used within other cf- component internals */}
        <div>
          cf-render: <cf-render $cell={counter} />
        </div>
      </div>
    ),
    value: state.value,
  };
});
