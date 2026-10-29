import { Cell, Default, handler, pattern, str } from "commonfabric";

interface ResetCounterArgs {
  value: Default<number, 0>;
  baseline: Default<number, 0>;
}

const applyDelta = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const resetCounter = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; baseline: Cell<number> },
  ) => {
    const target = context.baseline.get() ?? 0;
    context.value.set(target);
  },
);

export const counterWithReset = pattern<ResetCounterArgs>(
  ({ value, baseline }) => {
    return {
      value,
      baseline,
      label: str`Value ${value}`,
      increment: applyDelta({ value }),
      reset: resetCounter({ value, baseline }),
    };
  },
);

export default counterWithReset;
