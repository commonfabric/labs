import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

interface CrossFieldValidationArgs {
  value: Default<number, 0>;
  limit: Default<number, 10>;
  step: Default<number, 1>;
}

type AdjustmentDirection = "increase" | "decrease";

interface AdjustmentEvent {
  amount?: number;
  direction?: AdjustmentDirection;
}

interface LimitEvent {
  limit?: number;
}

interface ValidationEntry {
  value: number;
  limit: number;
  hasError: boolean;
}

interface ValidationSnapshot extends ValidationEntry {
  difference: number;
}

interface ValidationContext {
  value: Cell<number>;
  limit: Cell<number>;
  audit: Cell<ValidationEntry[]>;
}

const toInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const toPositiveStep = (value: unknown, fallback: number): number => {
  const sanitized = Math.abs(toInteger(value, fallback));
  if (sanitized === 0) {
    const safeFallback = Math.abs(fallback) || 1;
    return safeFallback;
  }
  return sanitized;
};

const resolveAmount = (
  event: AdjustmentEvent | number | undefined,
  step: number,
): number => {
  if (typeof event === "number") {
    return toInteger(event, step);
  }
  if (typeof event?.amount === "number") {
    return toInteger(event.amount, step);
  }
  if (event?.direction === "decrease") {
    return -step;
  }
  if (event?.direction === "increase") {
    return step;
  }
  return step;
};

const recordSnapshot = (context: ValidationContext): void => {
  const currentValue = toInteger(context.value.get(), 0);
  const limitValue = toInteger(context.limit.get(), 10);
  context.audit.push({
    value: currentValue,
    limit: limitValue,
    hasError: currentValue > limitValue,
  });
};

const adjustValue = handler(
  (
    event: AdjustmentEvent | number | undefined,
    context: ValidationContext & { step: Cell<number> },
  ) => {
    const step = toPositiveStep(context.step.get(), 1);
    const delta = resolveAmount(event, step);
    const current = toInteger(context.value.get(), 0);
    context.value.set(current + delta);
    recordSnapshot(context);
  },
);

const updateLimit = handler(
  (
    event: LimitEvent | number | undefined,
    context: ValidationContext,
  ) => {
    const fallback = toInteger(context.limit.get(), 10);
    const raw = typeof event === "number" ? event : event?.limit;
    const next = toInteger(raw, fallback);
    context.limit.set(next);
    recordSnapshot(context);
  },
);

const liftToIntegerZero = (input: number | undefined): number =>
  toInteger(input, 0);

const liftToIntegerTen = (input: number | undefined): number =>
  toInteger(input, 10);

const liftToPositiveStepOne = (input: number | undefined): number =>
  toPositiveStep(input, 1);

const liftBuildValidationSnapshot = (input: {
  value: number;
  limit: number;
}): ValidationSnapshot => {
  const currentValue = toInteger(input.value, 0);
  const limitValue = toInteger(input.limit, 10);
  const difference = currentValue - limitValue;
  return {
    value: currentValue,
    limit: limitValue,
    difference,
    hasError: difference > 0,
  };
};

export const counterWithCrossFieldValidation = pattern<
  CrossFieldValidationArgs
>(
  ({ value, limit, step }) => {
    const auditTrail = cell<ValidationEntry[]>([], { type: "array" });
    const sanitizedValue = computed(() => liftToIntegerZero(value));
    const sanitizedLimit = computed(() => liftToIntegerTen(limit));
    const sanitizedStep = computed(() => liftToPositiveStepOne(step));

    const validationView = liftBuildValidationSnapshot({
      value: sanitizedValue,
      limit: sanitizedLimit,
    });

    const currentValueView = validationView.value;
    const limitValueView = validationView.limit;
    const differenceView = validationView.difference;
    const hasError = validationView.hasError;
    const summary =
      str`Value ${currentValueView} / Limit ${limitValueView} (Δ ${differenceView})`;

    return {
      currentValue: currentValueView,
      limitValue: limitValueView,
      stepSize: sanitizedStep,
      difference: differenceView,
      hasError,
      summary,
      auditTrail,
      adjustValue: adjustValue({
        value,
        limit,
        step,
        audit: auditTrail,
      }),
      updateLimit: updateLimit({
        value,
        limit,
        audit: auditTrail,
      }),
    };
  },
);

export default counterWithCrossFieldValidation;
