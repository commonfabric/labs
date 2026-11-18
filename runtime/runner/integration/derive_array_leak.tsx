/**
 * An integration fixture: a counter whose increment and decrement handlers
 * each change the value by one `STEPS_PER_CLICK` times in one run, and a
 * computed array as long as the value, mapped into the view one element per
 * entry. One click therefore builds or tears down that many elements.
 */

import {
  Cell,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  str,
  Stream,
  UI,
} from "commonfabric";

// How many steps each click takes.
const STEPS_PER_CLICK = 50;

interface PatternState {
  value: Default<number, 0>;
}

interface PatternOutput {
  value: Default<number, 0>;
  stepsPerClick: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}

const increment = handler<
  void,
  { value: Cell<number> }
>(
  (_args, state) => {
    for (let i = 0; i < STEPS_PER_CLICK; i++) {
      state.value.set(state.value.get() + 1);
    }
  },
);

const decrement = handler<
  void,
  { value: Cell<number> }
>(
  (_args, state) => {
    for (let i = 0; i < STEPS_PER_CLICK; i++) {
      state.value.set(state.value.get() - 1);
    }
  },
);

function nth(value: number) {
  if (value === 1) return "1st";
  if (value === 2) return "2nd";
  if (value === 3) return "3rd";
  return `${value}th`;
}

export default pattern<PatternState, PatternOutput>((state) => {
  const array = computed(() => {
    // Clamp to prevent negative array length
    const length = Math.max(0, state.value);
    return new Array(length).fill(0);
  });
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <div>
          <cf-button onClick={decrement(state)}>
            dec to {state.value - STEPS_PER_CLICK}
          </cf-button>
          <span id="counter-result">
            Counter is the {nth(state.value)} number
          </span>
          <cf-button onClick={increment({ value: state.value })}>
            inc to {state.value + STEPS_PER_CLICK}
          </cf-button>
        </div>
        <div id="items">
          {array.map((v: number) => <i>{v % 10}</i>)}
        </div>
      </div>
    ),
    value: state.value,
    stepsPerClick: STEPS_PER_CLICK,
    increment: increment(state),
    decrement: decrement(state),
  };
});
