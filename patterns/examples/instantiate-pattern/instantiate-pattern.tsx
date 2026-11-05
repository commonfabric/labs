import {
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface PatternState {
  value: number | Default<0>;
}

const increment = handler<unknown, { value: Writable<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

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
    [NAME]: computed(() => `Simple counter: ${state.value}`),
    [UI]: (
      <div>
        <cf-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </cf-button>
        <span id="counter-result">
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

interface FactoryInput {
  // Provided by the shell; not used directly here
  pieceRegistry: unknown[] | Default<[]>;
}

// No additional outputs beyond name and UI
export type FactoryOutput = {
  [NAME]: string;
  [UI]: any;
};

type InputEvent = { detail: { message: string } };

const newCounter = handler<InputEvent, Record<string, never>>((_, __) => {
  const piece = Counter({ value: Math.round(Math.random() * 10) });
  return navigateTo(piece);
});

export default pattern<FactoryInput, FactoryOutput>((_) => {
  return {
    [NAME]: "Counter Factory",
    [UI]: (
      <div>
        <cf-message-input
          button-text="Add"
          placeholder="New counter"
          appearance="rounded"
          oncf-send={newCounter({})}
        />
      </div>
    ),
  };
});
