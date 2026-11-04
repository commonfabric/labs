import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface AggregatorArgs {
  counters: Default<number[], []>;
}

const adjustCounter = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: { counters: Cell<number[]> },
  ) => {
    const index = event?.index ?? 0;
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target: Cell<number> = context.counters.key(index);
    const current = target.get() ?? 0;
    target.set(current + amount);
  },
);

const liftTotal = lift((values: number[]) =>
  values.reduce((sum, value) => sum + value, 0)
);

const liftCount = lift((values: number[]) => values.length);

export const counterAggregator = pattern<AggregatorArgs>(
  ({ counters }) => {
    const total = liftTotal(counters);
    const count = liftCount(counters);
    const summary = str`Total ${total} across ${count}`;

    return {
      counters,
      total,
      count,
      summary,
      adjust: adjustCounter({ counters }),
    };
  },
);

export default counterAggregator;
