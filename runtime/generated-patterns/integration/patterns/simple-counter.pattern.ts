import { Cell, Default, handler, pattern, str } from "commonfabric";

interface CounterState {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

const increment = handler(
  (event: IncrementEvent | undefined, context: { value: Cell<number> }) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

export const simpleCounter = pattern<CounterState>(
  ({ value }) => {
    return {
      label: str`Counter value: ${value}`,
      value,
      increment: increment({ value }),
    };
  },
);

export default simpleCounter;
