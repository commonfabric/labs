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

interface DerivedDifferenceArgs {
  primary: Default<number, 0>;
  secondary: Default<number, 0>;
  primaryStep: Default<number, 1>;
  secondaryStep: Default<number, 1>;
}

type AdjustmentDirection = "increase" | "decrease";
type DifferenceSource = "primary" | "secondary";

interface AdjustmentEvent {
  amount?: number;
  direction?: AdjustmentDirection;
}

interface DifferenceAudit {
  sequence: number;
  via: DifferenceSource;
  primary: number;
  secondary: number;
  difference: number;
}

const sanitizeInteger = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const sanitizeStep = (value: unknown, fallback: number): number => {
  const raw = sanitizeInteger(value, fallback);
  const normalized = Math.abs(raw);
  if (normalized === 0) {
    return Math.abs(fallback) || 1;
  }
  return normalized;
};

const resolveDelta = (
  event: AdjustmentEvent | number | undefined,
  fallback: number,
): number => {
  if (typeof event === "number") {
    return sanitizeInteger(event, fallback);
  }
  if (typeof event?.amount === "number") {
    return sanitizeInteger(event.amount, fallback);
  }
  if (event?.direction === "decrease") {
    return -fallback;
  }
  if (event?.direction === "increase") {
    return fallback;
  }
  return fallback;
};

const recordDifference = (
  state: {
    sequence: Cell<number>;
    log: Cell<DifferenceAudit[]>;
    history: Cell<number[]>;
    primary: Cell<number>;
    secondary: Cell<number>;
  },
  via: DifferenceSource,
): void => {
  const sequence = sanitizeInteger(state.sequence.get(), 0) + 1;
  state.sequence.set(sequence);
  const primaryValue = sanitizeInteger(state.primary.get(), 0);
  const secondaryValue = sanitizeInteger(state.secondary.get(), 0);
  const difference = primaryValue - secondaryValue;
  const entry: DifferenceAudit = {
    sequence,
    via,
    primary: primaryValue,
    secondary: secondaryValue,
    difference,
  };
  state.log.push(entry);
  state.history.push(difference);
};

interface AdjustHandlerContext {
  via: DifferenceSource;
  target: Cell<number>;
  step: Cell<number>;
  primary: Cell<number>;
  secondary: Cell<number>;
  sequence: Cell<number>;
  log: Cell<DifferenceAudit[]>;
  history: Cell<number[]>;
}

const adjustHandler = handler(
  (
    event: AdjustmentEvent | number | undefined,
    context: AdjustHandlerContext,
  ) => {
    const step = sanitizeStep(context.step.get(), 1);
    const delta = resolveDelta(event, step);
    const current = sanitizeInteger(context.target.get(), 0);
    context.target.set(current + delta);
    recordDifference(
      {
        sequence: context.sequence,
        log: context.log,
        history: context.history,
        primary: context.primary,
        secondary: context.secondary,
      },
      context.via,
    );
  },
);

const setStep = handler(
  (
    event: { step?: number } | number | undefined,
    context: { step: Cell<number> },
  ) => {
    const fallback = sanitizeStep(context.step.get(), 1);
    const raw = typeof event === "number"
      ? event
      : typeof event?.step === "number"
      ? event.step
      : fallback;
    const sanitized = sanitizeStep(raw, fallback);
    context.step.set(sanitized);
  },
);

const liftSanitizeInteger = lift((value: number | undefined) =>
  sanitizeInteger(value, 0)
);
const liftSanitizeStep = lift((value: number | undefined) =>
  sanitizeStep(value, 1)
);
const liftDifferenceSummary = lift<
  { primary: Writable<number>; secondary: Writable<number> }
>(({ primary, secondary }) => {
  const primaryValue = sanitizeInteger(primary.get(), 0);
  const secondaryValue = sanitizeInteger(secondary.get(), 0);
  return {
    primary: primaryValue,
    secondary: secondaryValue,
    difference: primaryValue - secondaryValue,
  };
});

export const counterWithDerivedDifference = pattern<DerivedDifferenceArgs>(
  ({ primary, secondary, primaryStep, secondaryStep }) => {
    const sequence = cell(0);
    const differenceHistory = cell<number[]>([], { type: "array" });
    const auditLog = cell<DifferenceAudit[]>([], { type: "array" });

    const primaryValue = liftSanitizeInteger(primary);
    const secondaryValue = liftSanitizeInteger(secondary);

    const primaryStepValue = liftSanitizeStep(primaryStep);
    const secondaryStepValue = liftSanitizeStep(secondaryStep);

    const differenceSummary = liftDifferenceSummary({
      primary: primaryValue,
      secondary: secondaryValue,
    });

    const differenceValue = differenceSummary.difference;
    const summaryLabel =
      str`Difference ${differenceValue} (primary ${primaryValue}, secondary ${secondaryValue})`;

    return {
      primaryValue,
      secondaryValue,
      primaryStepValue,
      secondaryStepValue,
      differenceValue,
      differenceSummary,
      summaryLabel,
      differenceHistory,
      auditLog,
      controls: {
        primary: {
          adjust: adjustHandler({
            via: "primary",
            target: primary,
            step: primaryStep,
            primary,
            secondary,
            sequence,
            log: auditLog,
            history: differenceHistory,
          }),
          setStep: setStep({ step: primaryStep }),
        },
        secondary: {
          adjust: adjustHandler({
            via: "secondary",
            target: secondary,
            step: secondaryStep,
            primary,
            secondary,
            sequence,
            log: auditLog,
            history: differenceHistory,
          }),
          setStep: setStep({ step: secondaryStep }),
        },
      },
    };
  },
);

export default counterWithDerivedDifference;
