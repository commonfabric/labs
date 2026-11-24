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

interface SummaryArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
  history: Default<number[], []>;
}

type CounterTrend = "up" | "down" | "flat";
type CounterParity = "even" | "odd";

interface AdjustmentRecord {
  sequence: number;
  delta: number;
  resulting: number;
  label: string;
}

interface SummaryInputs {
  current: Writable<number>;
  history: Writable<number[]>;
  step: Writable<number>;
  adjustments: Writable<AdjustmentRecord[]>;
}

interface SummarySnapshot {
  current: number;
  previous: number;
  delta: number;
  trend: CounterTrend;
  parity: CounterParity;
  average: number;
  historyCount: number;
  adjustmentCount: number;
  step: number;
  latestHistory: number;
  label: string;
}

interface CounterAdjustmentEvent {
  amount?: number;
  direction?: "increase" | "decrease";
  label?: string;
}

const toInteger = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const sanitizeStep = (input: unknown): number => {
  const raw = toInteger(input, 1);
  const normalized = raw === 0 ? 1 : raw;
  return Math.abs(normalized);
};

const sanitizeHistory = (entries: number[] | undefined): number[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((item) => toInteger(item, 0));
};

const sanitizeAdjustments = (
  entries: AdjustmentRecord[] | undefined,
): AdjustmentRecord[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const sequence = toInteger(entry?.sequence, 0);
    const delta = toInteger(entry?.delta, 0);
    const resulting = toInteger(entry?.resulting, 0);
    const label = typeof entry?.label === "string"
      ? entry.label
      : `Adjustment ${sequence}`;
    return { sequence, delta, resulting, label };
  });
};

const resolveAdjustment = (
  event: CounterAdjustmentEvent | undefined,
  fallbackStep: number,
): number => {
  if (!event) return fallbackStep;
  if (typeof event.amount === "number" && Number.isFinite(event.amount)) {
    return toInteger(event.amount, fallbackStep);
  }
  if (event.direction === "decrease") return -fallbackStep;
  if (event.direction === "increase") return fallbackStep;
  return fallbackStep;
};

const deriveTrend = (delta: number): CounterTrend => {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
};

const deriveParity = (value: number): CounterParity =>
  Math.abs(value % 2) === 0 ? "even" : "odd";

const applyAdjustment = handler(
  (
    event: CounterAdjustmentEvent | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<number[]>;
      sequence: Cell<number>;
      adjustments: Cell<AdjustmentRecord[]>;
    },
  ) => {
    const base = toInteger(context.value.get(), 0);
    const stepValue = sanitizeStep(context.step.get());
    const delta = resolveAdjustment(event, stepValue);
    const next = base + delta;
    context.value.set(next);

    const historyValue = context.history.get();
    if (Array.isArray(historyValue)) {
      context.history.push(next);
    } else {
      context.history.set([next]);
    }

    const currentSequence = toInteger(context.sequence.get(), 0) + 1;
    context.sequence.set(currentSequence);

    const record: AdjustmentRecord = {
      sequence: currentSequence,
      delta,
      resulting: next,
      label: typeof event?.label === "string"
        ? event.label
        : `Adjustment ${currentSequence}`,
    };

    context.adjustments.push(record);
  },
);

const updateStep = handler(
  (
    event: { step?: number } | number | undefined,
    context: { step: Cell<number> },
  ) => {
    const raw = typeof event === "number"
      ? event
      : typeof event?.step === "number"
      ? event.step
      : context.step.get();
    const sanitized = sanitizeStep(raw);
    context.step.set(sanitized);
  },
);

const liftToInteger = lift((input: number | undefined) => toInteger(input, 0));
const liftSanitizeStep = lift((input: number | undefined) =>
  sanitizeStep(input)
);
const liftSanitizeHistory = lift(sanitizeHistory);
const liftSanitizeAdjustments = lift(sanitizeAdjustments);
const liftSummary = lift<SummaryInputs>(
  ({ current, history, step, adjustments }) => {
    const currentNumber = toInteger(current.get(), 0);
    const historyList = sanitizeHistory([...history.get()]);
    const adjustmentList = sanitizeAdjustments([...adjustments.get()]);
    const lastAdjustment = adjustmentList.at(-1);
    const delta = lastAdjustment?.delta ?? 0;
    const previous = currentNumber - delta;
    const latestHistory = historyList.at(-1) ?? currentNumber;
    const recordsTotal = historyList.reduce(
      (sum, entry) => sum + entry,
      0,
    );
    const divisor = historyList.length === 0 ? 1 : historyList.length;
    const averageBase = historyList.length === 0
      ? currentNumber
      : recordsTotal / divisor;
    const average = Math.round(averageBase * 100) / 100;
    const sanitizedStep = sanitizeStep(step.get());
    const trend = deriveTrend(delta);
    const parity = deriveParity(currentNumber);
    const label =
      `Current ${currentNumber} (${trend}) avg ${average} step ${sanitizedStep}`;

    return {
      current: currentNumber,
      previous,
      delta,
      trend,
      parity,
      average,
      historyCount: historyList.length,
      adjustmentCount: adjustmentList.length,
      step: sanitizedStep,
      latestHistory,
      label,
    };
  },
);

export const counterWithDerivedSummary = pattern<SummaryArgs>(
  ({ value, step, history }) => {
    const sequence = cell(0);
    const adjustments = cell<AdjustmentRecord[]>([]);

    const currentValue = liftToInteger(value);
    const stepValue = liftSanitizeStep(step);
    const historyView = liftSanitizeHistory(history);
    const adjustmentsView = liftSanitizeAdjustments(adjustments);
    const sequenceView = toInteger(sequence.get() ?? 0, 0);

    const summary = liftSummary({
      current: currentValue,
      history: historyView,
      step: stepValue,
      adjustments: adjustmentsView,
    });

    const trendText = summary.trend;
    const parityText = summary.parity;
    const detail = str`Step ${stepValue} trend ${trendText}`;
    const summaryLabel = summary.label;

    return {
      value,
      step,
      history: historyView,
      adjustments: adjustmentsView,
      currentValue,
      stepValue,
      sequence: sequenceView,
      summary,
      summaryLabel,
      trend: trendText,
      parity: parityText,
      detail,
      controls: {
        adjust: applyAdjustment({
          value,
          step,
          history,
          sequence,
          adjustments,
        }),
        setStep: updateStep({ step }),
      },
    };
  },
);

export default counterWithDerivedSummary;
