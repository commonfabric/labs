import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface DynamicHandlerArgs {
  values: Default<number[], []>;
}

interface AdjustmentRecord {
  index: number;
  amount: number;
  nextValue: number;
}

type AdjustmentTracker = {
  lastAdjustment: Cell<AdjustmentRecord>;
  history: Cell<AdjustmentRecord[]>;
  sequence: Cell<number>;
};

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const bumpSequence = (sequence: Cell<number>): number => {
  const current = toInteger(sequence.get(), 0);
  const next = current + 1;
  sequence.set(next);
  return next;
};

const recordAdjustment = (
  tracker: AdjustmentTracker,
  record: AdjustmentRecord,
) => {
  tracker.lastAdjustment.set(record);
  tracker.history.push(record);
  bumpSequence(tracker.sequence);
};

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustmentTracker & {
      values: Cell<number[]>;
      slotIndex: number;
    },
  ) => {
    const collection = context.values.get();
    const list = Array.isArray(collection) ? collection : [];
    const size = list.length;
    const requested = toInteger(context.slotIndex, -1);
    if (requested < 0 || requested >= size) {
      return;
    }

    const amount = toInteger(event?.amount, 1);
    const target: Cell<number> = context.values.key(requested);
    const current = toInteger(target.get(), 0);
    const nextValue = current + amount;
    target.set(nextValue);

    recordAdjustment(context, { index: requested, amount, nextValue });
  },
);

const appendValue = handler(
  (
    event: { initial?: number } | undefined,
    context: AdjustmentTracker & {
      values: Cell<number[]>;
    },
  ) => {
    const collection = context.values.get();
    const nextIndex = Array.isArray(collection) ? collection.length : 0;
    const initial = toInteger(event?.initial, 0);

    context.values.push(initial);
    recordAdjustment(context, {
      index: nextIndex,
      amount: 0,
      nextValue: initial,
    });
  },
);

const liftNormalizedValues = lift((entries: number[] | undefined) => {
  if (!Array.isArray(entries)) return [] as number[];
  return entries.map((item) => toInteger(item, 0));
});
const liftAverage = lift((entries: number[] | undefined) => {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  const sum = list.reduce((acc, value) => acc + value, 0);
  const rawAverage = sum / list.length;
  return Math.round(rawAverage * 100) / 100;
});
const liftHistoryView = lift((entries: AdjustmentRecord[] | undefined) => {
  return Array.isArray(entries) ? entries : [];
});
const liftLastAdjustmentView = lift(
  (record: AdjustmentRecord | undefined) =>
    record ?? { index: -1, amount: 0, nextValue: 0 },
);
const liftSequenceView = lift((count: number | undefined) =>
  Math.max(0, toInteger(count, 0))
);

export const counterWithDynamicHandlerList = pattern<DynamicHandlerArgs>(
  ({ values }) => {
    const lastAdjustment = cell<AdjustmentRecord>({
      index: -1,
      amount: 0,
      nextValue: 0,
    });
    const history = cell<AdjustmentRecord[]>([]);
    const sequence = cell(0);

    const normalizedValues = liftNormalizedValues(values);

    const count = normalizedValues.length;
    const total = normalizedValues.reduce((sum, value) => sum + value, 0);
    const average = liftAverage(normalizedValues);

    const slots = computed(() =>
      normalizedValues.map((rawValue, index) => {
        const value = toInteger(rawValue, 0);
        const name = `Slot ${index + 1}`;
        return {
          index,
          value,
          label: `${name}: ${value}`,
          adjust: adjustValue({
            values,
            slotIndex: index,
            lastAdjustment,
            history,
            sequence,
          }),
        };
      })
    );

    const handlers = computed(() => slots.map((slot) => slot.adjust));

    const historyView = liftHistoryView(history);
    const lastAdjustmentView = liftLastAdjustmentView(lastAdjustment);
    const sequenceView = liftSequenceView(sequence);

    const summary = str`${count} counter slots total ${total}`;
    const averageLabel = str`Average ${average}`;
    const add = appendValue({
      values,
      lastAdjustment,
      history,
      sequence,
    });

    return {
      values: normalizedValues,
      slots,
      handlers,
      count,
      total,
      average,
      summary,
      averageLabel,
      lastAdjustment: lastAdjustmentView,
      history: historyView,
      sequence: sequenceView,
      controls: {
        add,
      },
    };
  },
);

export default counterWithDynamicHandlerList;
