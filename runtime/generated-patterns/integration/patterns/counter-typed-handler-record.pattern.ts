import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
  type Writable,
} from "commonfabric";

type HandlerKey = "increment" | "decrement" | "setExact";

interface TypedHandlerRecordArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface CounterChange {
  action: HandlerKey | "init";
  previous: number;
  next: number;
}

type HandlerInvocationCounts = Record<HandlerKey, number>;

interface HandlerDescriptor {
  key: HandlerKey;
  label: string;
  calls: number;
}

const sanitizeNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? rounded : fallback;
};

const sanitizeCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : 0;
};

const sanitizeCounts = (
  record: HandlerInvocationCounts | undefined,
): HandlerInvocationCounts => {
  const typed = record ?? {
    increment: 0,
    decrement: 0,
    setExact: 0,
  };
  return {
    increment: sanitizeCount(typed.increment),
    decrement: sanitizeCount(typed.decrement),
    setExact: sanitizeCount(typed.setExact),
  };
};

const sanitizeChange = (value: CounterChange | undefined): CounterChange => {
  if (!value) {
    return { action: "init", previous: 0, next: 0 };
  }
  const action: HandlerKey | "init" = value.action === "increment" ||
      value.action === "decrement" || value.action === "setExact"
    ? value.action
    : "init";
  return {
    action,
    previous: sanitizeNumber(value.previous, 0),
    next: sanitizeNumber(value.next, 0),
  };
};

const sanitizeHistory = (
  entries: CounterChange[] | undefined,
): CounterChange[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => sanitizeChange(entry));
};

const normalizeStep = (value: unknown): number => {
  const next = Math.abs(sanitizeNumber(value, 1));
  return next > 0 ? next : 1;
};

const recordInvocation = (
  action: HandlerKey,
  change: { previous: number; next: number },
  context: {
    history: Cell<CounterChange[]>;
    lastChange: Cell<CounterChange>;
    counts: Cell<HandlerInvocationCounts>;
    snapshotId: Cell<number>;
  },
) => {
  const entry: CounterChange = {
    action,
    previous: sanitizeNumber(change.previous, 0),
    next: sanitizeNumber(change.next, 0),
  };

  const history = context.history.get();
  const list = Array.isArray(history) ? [...history, entry] : [entry];

  context.history.set(list);
  context.lastChange.set(entry);

  const currentCounts = sanitizeCounts(context.counts.get());
  context.counts.set({
    ...currentCounts,
    [action]: currentCounts[action] + 1,
  });

  const idSeed = sanitizeCount(context.snapshotId.get());
  const nextSeed = idSeed + 1;
  context.snapshotId.set(nextSeed);
};

const incrementCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const baseStep = normalizeStep(context.step.get());
    const requested = sanitizeNumber(event?.amount, baseStep);
    const amount = requested === 0 ? baseStep : Math.abs(requested);
    const next = previous + amount;

    context.value.set(next);
    recordInvocation("increment", { previous, next }, context);
  },
);

const decrementCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const baseStep = normalizeStep(context.step.get());
    const requested = sanitizeNumber(event?.amount, baseStep);
    const amount = requested === 0 ? baseStep : Math.abs(requested);
    const next = previous - amount;

    context.value.set(next);
    recordInvocation("decrement", { previous, next }, context);
  },
);

const setExactCounter = handler(
  (
    event: { value?: number } | undefined,
    context: {
      value: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const next = typeof event?.value === "number"
      ? sanitizeNumber(event.value, previous)
      : previous;

    context.value.set(next);
    recordInvocation("setExact", { previous, next }, context);
  },
);

type CounterHandlerRecord = {
  increment: ReturnType<typeof incrementCounter>;
  decrement: ReturnType<typeof decrementCounter>;
  setExact: ReturnType<typeof setExactCounter>;
};

const liftCountsLabel = lift((record: HandlerInvocationCounts | undefined) => {
  const sanitized = sanitizeCounts(record);
  return `inc:${sanitized.increment} dec:${sanitized.decrement} ` +
    `set:${sanitized.setExact}`;
});

const liftLastChangeLabel = lift((change: CounterChange | undefined) => {
  const sanitized = sanitizeChange(change);
  return `${sanitized.action}:${sanitized.previous}->${sanitized.next}`;
});

const liftHandlerCatalog = lift<{
  counts: Writable<HandlerInvocationCounts>;
  step: Writable<number>;
}>(({ counts, step }) => {
  const record = sanitizeCounts(counts.get());
  const stepValue = normalizeStep(step.get());
  return [
    {
      key: "increment" as const,
      label: `Increment by ${stepValue}`,
      calls: record.increment,
    },
    {
      key: "decrement" as const,
      label: `Decrement by ${stepValue}`,
      calls: record.decrement,
    },
    {
      key: "setExact" as const,
      label: "Set exact value",
      calls: record.setExact,
    },
  ];
});

const liftNormalizeStep = lift(normalizeStep);
const liftSanitizeCounts = lift(sanitizeCounts);
const liftSanitizeHistory = lift(sanitizeHistory);
const liftSanitizeChange = lift(sanitizeChange);

export const counterWithTypedHandlerRecord = pattern<TypedHandlerRecordArgs>(
  ({ value, step }) => {
    const history = cell<CounterChange[]>([]);
    const lastChange = cell<CounterChange>({
      action: "init",
      previous: 0,
      next: 0,
    });
    const counts = cell<HandlerInvocationCounts>({
      increment: 0,
      decrement: 0,
      setExact: 0,
    });
    const snapshotId = cell(0);
    const sanitizedStep = liftNormalizeStep(step);

    const countsView = liftSanitizeCounts(counts);
    const historyView = liftSanitizeHistory(history);
    const lastChangeView = liftSanitizeChange(lastChange);
    const countsLabel = liftCountsLabel(counts);
    const lastChangeLabel = liftLastChangeLabel(lastChange);

    const handlerCatalog = liftHandlerCatalog({ counts, step: sanitizedStep });

    const handlers: CounterHandlerRecord = {
      increment: incrementCounter({
        value,
        step: sanitizedStep,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
      decrement: decrementCounter({
        value,
        step: sanitizedStep,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
      setExact: setExactCounter({
        value,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
    };

    const summary = str`Value ${value} :: ${countsLabel}`;

    return {
      value,
      step: sanitizedStep,
      summary,
      lastChange: lastChangeView,
      lastChangeLabel,
      history: historyView,
      counts: countsView,
      handlerCatalog,
      handlers,
    };
  },
);

export default counterWithTypedHandlerRecord;
