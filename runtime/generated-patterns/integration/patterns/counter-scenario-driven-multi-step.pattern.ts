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

interface MultiStepArgs {
  value: Default<number, 0>;
  phase: Default<string, "idle">;
}

interface StartSequenceEvent {
  label?: string;
}

interface StepEvent {
  amount?: number;
  note?: string;
}

interface CompleteEvent {
  note?: string;
}

interface StepEntry {
  index: number;
  delta: number;
  total: number;
  note: string;
}

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return fallback;
  }
  return input;
};

const toSafeString = (input: unknown, fallback: string): string => {
  if (typeof input !== "string" || input.trim().length === 0) {
    return fallback;
  }
  return input.trim();
};

const sanitizeStepEntries = (input: readonly StepEntry[]): StepEntry[] => {
  if (!Array.isArray(input)) return [];
  const result: StepEntry[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const index = toNumber((value as StepEntry).index, Number.NaN);
    const delta = toNumber((value as StepEntry).delta, Number.NaN);
    const total = toNumber((value as StepEntry).total, Number.NaN);
    const note = toSafeString((value as StepEntry).note, "step");
    if (
      Number.isFinite(index) &&
      Number.isFinite(delta) &&
      Number.isFinite(total)
    ) {
      result.push({
        index,
        delta,
        total,
        note,
      });
    }
  }
  return result;
};

const startSequence = handler(
  (
    event: StartSequenceEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const label = toSafeString(event?.label, "active");
    const currentValue = context.value.get();
    context.phase.set(label);
    context.value.set(toNumber(currentValue, 0));
    context.stepIndex.set(0);
    context.stepLog.set([]);
  },
);

const applyStep = handler(
  (
    event: StepEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const currentPhase = context.phase.get();
    const delta = toNumber(event?.amount, 1);
    const note = toSafeString(
      event?.note,
      `step ${toSafeString(currentPhase, "active")}`,
    );

    const rawValue = context.value.get();
    const current = toNumber(rawValue, 0);
    const next = current + delta;
    context.value.set(next);

    const rawIndex = context.stepIndex.get();
    const index = toNumber(rawIndex, 0) + 1;
    context.stepIndex.set(index);

    const log = sanitizeStepEntries(context.stepLog.get());
    log.push({ index, delta, total: next, note });
    context.stepLog.set(log);
  },
);

const liftCurrentValue = lift((input: number | undefined) =>
  toNumber(input, 0)
);

const liftCurrentPhase = lift((input: string | undefined) =>
  toSafeString(input, "idle")
);

const liftCompletedPhases = lift((input: string[] | undefined) => {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  for (const value of input) {
    result.push(toSafeString(value, "unknown phase"));
  }
  return result;
});

const liftSanitizeStepEntries = lift(sanitizeStepEntries);

const completeSequence = handler(
  (
    event: CompleteEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepLog: Cell<StepEntry[]>;
      phaseHistory: Cell<string[]>;
    },
  ) => {
    const phaseValue = toSafeString(context.phase.get(), "active");
    const note = toSafeString(event?.note, "complete");
    const steps = sanitizeStepEntries(context.stepLog.get());
    const total = toNumber(context.value.get(), 0);

    const history = Array.isArray(context.phaseHistory.get())
      ? context.phaseHistory.get()
      : [];
    const summary =
      `${phaseValue} (${note}) steps: ${steps.length} total: ${total}`;
    context.phaseHistory.set([...history, summary]);
  },
);

export const counterWithScenarioDrivenSteps = pattern<MultiStepArgs>(
  ({ value, phase }) => {
    const stepIndex = cell(0);
    const stepLog = cell<StepEntry[]>([]);
    const phaseHistory = cell<string[]>([]);

    const currentValue = liftCurrentValue(value);
    const currentPhase = liftCurrentPhase(phase);
    const steps = liftSanitizeStepEntries(stepLog);
    const completedPhases = liftCompletedPhases(phaseHistory);

    const stepCount = steps.length;
    const lastRecordedTotal = computed(() => {
      if (steps.length === 0) {
        return currentValue;
      }
      return steps[steps.length - 1].total;
    });

    const summary =
      str`Phase ${currentPhase} total ${currentValue} over ${stepCount} steps`;

    return {
      value,
      phase,
      currentValue,
      currentPhase,
      stepCount,
      steps,
      lastRecordedTotal,
      phases: completedPhases,
      summary,
      sequence: {
        start: startSequence({ phase, value, stepIndex, stepLog }),
        apply: applyStep({ phase, value, stepIndex, stepLog }),
        complete: completeSequence({
          phase,
          value,
          stepLog,
          phaseHistory,
        }),
      },
    };
  },
);

export default counterWithScenarioDrivenSteps;
