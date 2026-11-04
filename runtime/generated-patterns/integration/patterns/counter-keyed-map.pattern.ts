import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface KeyedMapArgs {
  counters: Default<Record<string, number>, { [key: string]: number }>;
}

const adjustKeyedCounter = handler(
  (
    event: { key?: string; amount?: number } | undefined,
    context: { counters: Cell<Record<string, number>> },
  ) => {
    const key = typeof event?.key === "string" ? event.key : "default";
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const entry: Cell<number> = context.counters.key(key);
    const current = entry.get() ?? 0;
    entry.set(current + amount);
  },
);

const liftKeys = lift((map: Record<string, number>) => Object.keys(map).sort());
const liftTotal = lift((map: Record<string, number>) =>
  Object.values(map).reduce((sum, value) => sum + value, 0)
);
const liftCount = lift((map: Record<string, number>) =>
  Object.keys(map).length
);

export const counterMapByKey = pattern<KeyedMapArgs>(
  ({ counters }) => {
    const keys = liftKeys(counters);
    const total = liftTotal(counters);
    const count = liftCount(counters);
    const summary = str`${count} keys total ${total}`;

    return {
      counters,
      keys,
      count,
      total,
      summary,
      adjust: adjustKeyedCounter({ counters }),
    };
  },
);

export default counterMapByKey;
