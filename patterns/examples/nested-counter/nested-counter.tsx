import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

// ===== Types =====

interface CounterInput {
  value: Writable<number | Default<0>>;
}

// ===== Handlers at module scope =====

const increment = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.increment(1);
  },
);

const decrement = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.increment(-1);
  },
);

// ===== Helper functions =====

function ordinal(n: number): string {
  const num = n ?? 0;
  if (num === 1) return "1st";
  if (num === 2) return "2nd";
  if (num === 3) return "3rd";
  return `${num}th`;
}

// ===== Counter Pattern =====

export const Counter = pattern<CounterInput>((state) => {
  // Bind handlers with context
  const boundIncrement = increment({ value: state.value });
  const boundDecrement = decrement({ value: state.value });

  // Computed value for ordinal display
  const ordinalDisplay = computed(() => ordinal(state.value.get()));
  const prevValue = computed(() => state.value.get() - 1);
  const nextValue = computed(() => state.value.get() + 1);

  return {
    [NAME]: computed(() => `Simple counter: ${state.value}`),
    [UI]: (
      <div>
        <cf-button onClick={() => boundDecrement.send()}>
          dec to {prevValue}
        </cf-button>
        <span id="counter-result">
          Counter is the {ordinalDisplay} number
        </span>
        <cf-button onClick={() => boundIncrement.send()}>
          inc to {nextValue}
        </cf-button>
      </div>
    ),
    value: state.value,
  };
});

// ===== Nested Counter Pattern =====
/*
This demonstrates a pattern of passing a Cell to a sub-pattern and keeping
the value in sync between all locations. It also demonstrates that any
pattern can be invoked using JSX syntax.
*/

export default pattern<CounterInput>((state) => {
  // A pattern can be 'invoked' directly
  const counter = Counter({ value: state.value });

  return {
    [NAME]: computed(() => `Double counter: ${state.value}`),
    [UI]: (
      <div>
        {/* Patterns can also be 'invoked' via JSX */}
        {/* These methods of rendering are functionally equivalent */}
        <Counter value={state.value} />
        {counter}
      </div>
    ),
    value: state.value,
  };
});
