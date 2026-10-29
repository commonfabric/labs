import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface RingBufferCounterArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  capacity: Default<number, 3>;
}

const normalizeCapacityValue = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 3;
  }
  const normalized = Math.floor(raw);
  return normalized > 0 ? normalized : 1;
};

const incrementAndTrim = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      history: Cell<number[]>;
      limit: Cell<number>;
    },
  ) => {
    const delta = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get();
    const base = typeof current === "number" ? current : 0;
    const next = base + delta;
    context.value.set(next);

    const capacity = normalizeCapacityValue(context.limit.get());
    const existing = context.history.get();
    const list = Array.isArray(existing) ? existing : [];
    const trimmed = [
      ...list.slice(-Math.max(capacity - 1, 0)),
      next,
    ];
    context.history.set(trimmed);
  },
);

const resizeBuffer = handler(
  (
    event: { capacity?: number } | undefined,
    context: { capacity: Cell<number>; history: Cell<number[]> },
  ) => {
    if (
      typeof event?.capacity !== "number" ||
      !Number.isFinite(event.capacity)
    ) {
      return;
    }
    const nextCapacity = normalizeCapacityValue(event.capacity);
    context.capacity.set(nextCapacity);

    const existing = context.history.get();
    const list = Array.isArray(existing) ? existing : [];
    context.history.set(list.slice(-nextCapacity));
  },
);

const liftCurrentValue = lift((count: number | undefined) =>
  typeof count === "number" ? count : 0
);

const liftHistoryView = lift((entries: number[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

const liftLimit = lift((raw: number | undefined) =>
  normalizeCapacityValue(raw)
);

export const counterWithRingBufferHistory = pattern<RingBufferCounterArgs>(
  ({ value, history, capacity }) => {
    const currentValue = liftCurrentValue(value);

    const historyView = liftHistoryView(history);

    const limit = liftLimit(capacity);

    const label = str`Value ${currentValue} | limit ${limit}`;

    return {
      value,
      history,
      capacity,
      currentValue,
      historyView,
      limit,
      label,
      increment: incrementAndTrim({ value, history, limit }),
      resize: resizeBuffer({ capacity, history }),
    };
  },
);

export default counterWithRingBufferHistory;
