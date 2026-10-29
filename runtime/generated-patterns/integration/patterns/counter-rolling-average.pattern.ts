import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface RollingAverageArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  window: Default<number, 5>;
}

const recordAndAverage = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      history: Cell<number[]>;
      window: Cell<number>;
    },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const currentValue = context.value.get();
    const next = (typeof currentValue === "number" ? currentValue : 0) +
      amount;
    context.value.set(next);

    const windowSize = context.window.get();
    const limit = typeof windowSize === "number" && windowSize > 0
      ? Math.floor(windowSize)
      : 5;
    const current = context.history.get();
    const currentList = Array.isArray(current) ? current : [];
    const updated = [...currentList, next].slice(-limit);
    context.history.set(updated);
  },
);

const liftAverage = lift((entries: number[] | undefined) => {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  const total = list.reduce((sum, item) => sum + item, 0);
  return total / list.length;
});

const liftCurrentValue = lift((count: number | undefined) =>
  typeof count === "number" ? count : 0
);

const liftHistoryView = lift((entries: number[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

export const counterWithRollingAverage = pattern<RollingAverageArgs>(
  ({ value, history, window }) => {
    const average = liftAverage(history);
    const currentValue = liftCurrentValue(value);
    const historyView = liftHistoryView(history);

    return {
      value,
      history,
      window,
      average,
      currentValue,
      historyView,
      label: str`Average ${average}`,
      increment: recordAndAverage({ value, history, window }),
    };
  },
);

export default counterWithRollingAverage;
