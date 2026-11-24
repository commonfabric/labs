import { Cell, Default, handler, pattern, str } from "commonfabric";

interface NestedStreamArgs {
  value: Default<number, 0>;
}

const nestedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithNestedStream = pattern<NestedStreamArgs>(
  ({ value }) => {
    return {
      value,
      label: str`Counter ${value}`,
      streams: {
        increment: nestedIncrement({ value }),
      },
    };
  },
);

export default counterWithNestedStream;
