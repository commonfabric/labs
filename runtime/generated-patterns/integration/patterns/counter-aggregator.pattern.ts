import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface CounterEntry {
  id?: string;
  label?: string;
  value?: number;
}

interface AggregatedCounter {
  id: string;
  label: string;
  value: number;
}

interface CounterAggregatorArgs {
  counters: Default<CounterEntry[], []>;
}

type AdjustEvent = {
  id?: string;
  index?: number;
  delta?: number;
  set?: number;
};

type AppendEvent = {
  id?: string;
  label?: string;
  value?: number;
};

const adjustCounter = handler(
  (
    event: AdjustEvent | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    if (!event) {
      return;
    }

    const list = context.counters.get() ?? [];
    let index = -1;

    if (event.id) {
      index = list.findIndex((entry) => entry.id === event.id);
    }

    if (index === -1 && typeof event.index === "number") {
      index = event.index;
    }

    if (index === -1) {
      return;
    }

    const entryCell: Cell<CounterEntry> = context.counters.key(index);
    const valueCell: Cell<number | undefined> = entryCell.key("value");
    const value = valueCell.get();
    const current = typeof value === "number" ? value : 0;
    const delta = typeof event.delta === "number" ? event.delta : 0;
    const nextValue = typeof event.set === "number"
      ? event.set
      : current + delta;

    valueCell.set(nextValue);
  },
);

const appendCounter = handler(
  (
    event: AppendEvent | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    const list = context.counters.get() ?? [];
    const id = event?.id && event.id.length > 0
      ? event.id
      : `counter-${list.length + 1}`;

    if (list.some((entry) => entry.id === id)) {
      return;
    }

    const value = typeof event?.value === "number" ? event.value : 0;
    const label = event?.label ?? `Counter ${list.length + 1}`;

    context.counters.set([
      ...list,
      { id, label, value },
    ]);
  },
);

const liftSanitizedCounters = lift((entries: CounterEntry[]) =>
  entries.map((entry, index) => ({
    id: entry.id && entry.id.length > 0 ? entry.id : `counter-${index + 1}`,
    label: entry.label ?? `Counter ${index + 1}`,
    value: typeof entry.value === "number" ? entry.value : 0,
  }))
);

const liftValues = lift((entries: AggregatedCounter[]) =>
  entries.map((entry) => entry.value)
);

const liftTotal = lift((numbers: number[]) =>
  numbers.reduce((sum, value) => sum + value, 0)
);

const liftCount = lift((numbers: number[]) => numbers.length);

const liftLargest = lift((numbers: number[]) => {
  if (numbers.length === 0) {
    return 0;
  }

  return numbers.reduce(
    (max, value) => value > max ? value : max,
    numbers[0],
  );
});

const liftLabels = lift((entries: AggregatedCounter[]) =>
  entries.map((entry) => entry.label)
);

export const counterAggregator = pattern<CounterAggregatorArgs>(
  ({ counters }) => {
    const sanitizedCounters = liftSanitizedCounters(counters);

    const values = liftValues(sanitizedCounters);

    const total = liftTotal(values);

    const count = liftCount(values);

    const largest = liftLargest(values);

    const summary = str`Aggregate total ${total} across ${count} counters`;

    const labels = liftLabels(sanitizedCounters);

    return {
      counters: sanitizedCounters,
      values,
      total,
      count,
      largest,
      labels,
      summary,
      adjust: adjustCounter({ counters }),
      append: appendCounter({ counters }),
    };
  },
);

export default counterAggregator;
