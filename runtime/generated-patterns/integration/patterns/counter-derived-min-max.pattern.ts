import {
  type Cell,
  Default,
  handler,
  lift,
  pattern,
  str,
  type Writable,
} from "commonfabric";

interface DerivedMinMaxArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const resolveAmount = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 1;
  }
  return Math.trunc(input);
};

const sanitizeHistory = (entries: number[] | undefined): number[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const entry of entries) {
    sanitized.push(toInteger(entry));
  }
  return sanitized;
};

const minimumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let min = values[0];
  for (const value of values) {
    if (value < min) {
      min = value;
    }
  }
  return min;
};

const maximumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let max = values[0];
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  return max;
};

const adjustCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const current = toInteger(context.value.get());
    const next = current + amount;
    context.value.set(next);
    context.history.push(next);
  },
);

const computeLimits = lift<
  { values: Writable<number[]>; current: Writable<number> }
>(({ values, current }) => {
  const entries = sanitizeHistory([...values.get()]);
  const baseline = toInteger(current.get());
  if (entries.length === 0) {
    return { min: baseline, max: baseline };
  }
  return {
    min: minimumOf(entries),
    max: maximumOf(entries),
  };
});

const liftToInteger = lift((input: number | undefined) => toInteger(input));
const liftSanitizeHistory = lift(sanitizeHistory);

export const counterWithDerivedMinMax = pattern<DerivedMinMaxArgs>(
  ({ value, history }) => {
    const currentValue = liftToInteger(value);
    const historyValues = liftSanitizeHistory(history);
    const limits = computeLimits({
      values: historyValues,
      current: currentValue,
    });
    const minValue = limits.min;
    const maxValue = limits.max;
    const label = str`Min: ${minValue}, Max: ${maxValue}`;

    return {
      value,
      history: historyValues,
      minValue,
      maxValue,
      label,
      adjust: adjustCounter({ value, history }),
    };
  },
);

export default counterWithDerivedMinMax;
