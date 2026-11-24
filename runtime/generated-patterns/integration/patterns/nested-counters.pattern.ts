import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface NestedCounterArgs {
  counters: Default<
    {
      left: Default<number, 0>;
      right: Default<number, 0>;
    },
    { left: 0; right: 0 }
  >;
}

const adjustSingle = handler(
  (
    event: { amount?: number } | undefined,
    context: { target: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.target.set((context.target.get() ?? 0) + amount);
  },
);

const balanceCounters = handler(
  (_event: unknown, context: { left: Cell<number>; right: Cell<number> }) => {
    const leftValue = context.left.get() ?? 0;
    const rightValue = context.right.get() ?? 0;
    const average = Math.round((leftValue + rightValue) / 2);
    context.left.set(average);
    context.right.set(average);
  },
);

// Module-scope lift definitions
const liftTotal = lift((values: { left: number; right: number }) =>
  values.left + values.right
);

export const nestedCounters = pattern<NestedCounterArgs>(
  ({ counters }) => {
    const left = counters.left;
    const right = counters.right;

    const total = liftTotal({
      left,
      right,
    });

    return {
      label: str`Left ${left} • Right ${right}`,
      counters: { left, right },
      total,
      controls: {
        incrementLeft: adjustSingle({ target: left }),
        incrementRight: adjustSingle({ target: right }),
        balance: balanceCounters({ left, right }),
      },
    };
  },
);

export default nestedCounters;
