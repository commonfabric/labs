import { Cell, Default, handler, lift, pattern } from "commonfabric";

interface LiftFormattingArgs {
  value: Default<number, 0>;
}

const addOne = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const liftFormatted = lift((count: number) => `Value: ${count.toFixed(2)}`);

export const counterWithLiftFormatting = pattern<LiftFormattingArgs>(
  ({ value }) => {
    const formatted = liftFormatted(value);

    return {
      value,
      formatted,
      increment: addOne({ value }),
    };
  },
);

export default counterWithLiftFormatting;
