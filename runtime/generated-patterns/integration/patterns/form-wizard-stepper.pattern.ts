import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type FieldValueMap = Record<string, Record<string, string>>;

type StepStatus = "pending" | "active" | "complete";

interface WizardFieldConfig {
  id?: string;
  label?: string;
  required?: boolean;
}

interface WizardStepConfig {
  id?: string;
  label?: string;
  fields?: WizardFieldConfig[];
}

interface WizardField {
  id: string;
  label: string;
  required: boolean;
}

interface WizardStep {
  id: string;
  label: string;
  fields: WizardField[];
}

interface WizardFieldState extends WizardField {
  value: string;
  valid: boolean;
}

interface WizardStepState {
  id: string;
  label: string;
  status: StepStatus;
  complete: boolean;
  remaining: string[];
  fields: WizardFieldState[];
}

const defaultWizardSteps: WizardStepConfig[] = [
  {
    id: "profile",
    label: "Profile",
    fields: [
      { id: "name", label: "Full Name", required: true },
      { id: "email", label: "Email", required: true },
    ],
  },
  {
    id: "details",
    label: "Details",
    fields: [
      { id: "address", label: "Address", required: true },
      { id: "city", label: "City", required: true },
    ],
  },
  {
    id: "confirmation",
    label: "Confirmation",
    fields: [
      { id: "agreement", label: "Agreement", required: true },
    ],
  },
];

interface FormWizardStepperArgs {
  steps: Default<WizardStepConfig[], typeof defaultWizardSteps>;
  currentStepIndex: Default<number, 0>;
  fieldValues: Default<FieldValueMap, {}>;
}

interface UpdateFieldEvent {
  stepId?: string;
  fieldId?: string;
  value?: string;
}

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeIdentifier = (value: unknown): string | null => {
  const text = sanitizeText(value);
  if (!text) return null;
  return text.toLowerCase().replaceAll(/[^a-z0-9-]/gi, "-");
};

const buildFallbackFieldId = (stepId: string, index: number): string => {
  return `${stepId}-field-${index + 1}`;
};

const sanitizeFieldConfig = (
  config: WizardFieldConfig | undefined,
  stepId: string,
  index: number,
): WizardField | null => {
  const fallbackId = buildFallbackFieldId(stepId, index);
  const id = sanitizeIdentifier(config?.id) ?? fallbackId;
  const label = sanitizeText(config?.label) ?? id;
  const required = config?.required === true;
  return { id, label, required };
};

const sanitizeFields = (
  fields: WizardFieldConfig[] | undefined,
  stepId: string,
): WizardField[] => {
  if (!Array.isArray(fields)) {
    return [
      { id: `${stepId}-confirmation`, label: "Confirmation", required: false },
    ];
  }
  const sanitized: WizardField[] = [];
  const seen = new Set<string>();
  fields.forEach((entry, index) => {
    const result = sanitizeFieldConfig(entry, stepId, index);
    if (!result) return;
    if (seen.has(result.id)) return;
    seen.add(result.id);
    sanitized.push(result);
  });
  if (sanitized.length === 0) {
    return [
      { id: `${stepId}-confirmation`, label: "Confirmation", required: false },
    ];
  }
  return sanitized;
};

const sanitizeSteps = (
  value: WizardStepConfig[] | undefined,
): WizardStep[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultWizardSteps;
  const steps: WizardStep[] = [];
  const seen = new Set<string>();
  source.forEach((entry, index) => {
    const fallbackId = `step-${index + 1}`;
    const id = sanitizeIdentifier(entry?.id) ?? fallbackId;
    if (seen.has(id)) return;
    seen.add(id);
    const label = sanitizeText(entry?.label) ?? id;
    const fields = sanitizeFields(entry?.fields, id);
    steps.push({ id, label, fields });
  });
  if (steps.length === 0 && source !== defaultWizardSteps) {
    return sanitizeSteps(defaultWizardSteps);
  }
  return steps;
};

const sanitizeFieldValue = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
};

const sanitizeFieldValues = (
  value: FieldValueMap | undefined,
  steps: readonly WizardStep[],
): FieldValueMap => {
  const result: FieldValueMap = {};
  const input = (value && typeof value === "object") ? value : {};
  for (const step of steps) {
    const rawStep = (
        typeof input === "object" && input !== null
      )
      ? (input as Record<string, unknown>)[step.id]
      : undefined;
    const stepValues: Record<string, string> = {};
    for (const field of step.fields) {
      const rawValue = (
          typeof rawStep === "object" && rawStep !== null
        )
        ? (rawStep as Record<string, unknown>)[field.id]
        : undefined;
      stepValues[field.id] = sanitizeFieldValue(rawValue);
    }
    result[step.id] = stepValues;
  }
  return result;
};

const clampIndex = (value: number | undefined, size: number): number => {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value ?? 0);
  if (size <= 0) return 0;
  if (normalized < 0) return 0;
  const max = size - 1;
  return normalized > max ? max : normalized;
};

const evaluateStepStates = (
  steps: readonly WizardStep[],
  values: FieldValueMap,
  activeIndex: number,
): WizardStepState[] => {
  return steps.map((step, index) => {
    const stepValues = values[step.id] ?? {};
    const fields = step.fields.map((field) => {
      const value = stepValues[field.id] ?? "";
      const valid = field.required ? value.length > 0 : true;
      return { ...field, value, valid };
    });
    const remaining = fields
      .filter((field) => !field.valid)
      .map((field) => field.id);
    const complete = remaining.length === 0;
    const status: StepStatus = index < activeIndex
      ? "complete"
      : index === activeIndex
      ? "active"
      : "pending";
    return {
      id: step.id,
      label: step.label,
      status,
      complete,
      remaining,
      fields,
    };
  });
};

const formatBlockMessage = (
  step: WizardStep,
  missing: readonly WizardField[],
): string => {
  const labels = missing.map((field) => field.label).join(", ");
  return `${step.label} blocked: ${labels} required`;
};

const collectMissingFields = (
  step: WizardStep,
  values: FieldValueMap,
): WizardField[] => {
  const stepValues = values[step.id] ?? {};
  return step.fields.filter((field) => {
    const value = stepValues[field.id] ?? "";
    return field.required && value.length === 0;
  });
};

const buildProgressLabel = (
  step: WizardStep | undefined,
  index: number,
  count: number,
): string => {
  const total = count === 0 ? 0 : count;
  const position = count === 0 ? 0 : index + 1;
  const label = step?.label ?? "Step";
  return `${label} (${position} of ${total})`;
};

// Module-scope lift definitions
const liftSanitizeSteps = lift(sanitizeSteps);

const liftStepCount = lift((list: WizardStep[]) => list.length);

const liftActiveIndex = lift(
  (input: { index: number | undefined; count: number }) => {
    return clampIndex(input.index, input.count);
  },
);

const liftValuesView = lift(
  (input: { values: FieldValueMap | undefined; steps: WizardStep[] }) =>
    sanitizeFieldValues(input.values, input.steps),
);

const liftStepStates = lift(
  (
    input: {
      steps: WizardStep[];
      values: FieldValueMap;
      index: number;
    },
  ) => evaluateStepStates(input.steps, input.values, input.index),
);

const liftActiveStep = lift(
  (input: { steps: WizardStep[]; index: number }) => {
    if (input.steps.length === 0) return undefined;
    return input.steps[input.index];
  },
);

const liftCanAdvance = lift(
  (input: { states: WizardStepState[]; index: number }) => {
    const active = input.states[input.index];
    return active ? active.remaining.length === 0 : false;
  },
);

const liftProgress = lift(
  (input: { step?: WizardStep; index: number; count: number }) =>
    buildProgressLabel(input.step, input.index, input.count),
);

const liftBlockMessage = lift((value: string | null) => value ?? "");

const advanceStep = handler(
  (
    _event: unknown,
    context: {
      stepsView: Cell<WizardStep[]>;
      fieldValues: Cell<FieldValueMap>;
      currentStepIndex: Cell<number>;
      blockReason: Cell<string | null>;
    },
  ) => {
    const stepsList = context.stepsView.get();
    if (stepsList.length === 0) return;
    const sanitizedValues = sanitizeFieldValues(
      context.fieldValues.get(),
      stepsList,
    );
    const currentIndex = clampIndex(
      context.currentStepIndex.get(),
      stepsList.length,
    );
    const step = stepsList[currentIndex];
    const missing = collectMissingFields(step, sanitizedValues);
    if (missing.length > 0) {
      context.fieldValues.set(sanitizedValues);
      context.currentStepIndex.set(currentIndex);
      context.blockReason.set(formatBlockMessage(step, missing));
      return;
    }
    const nextIndex = Math.min(currentIndex + 1, stepsList.length - 1);
    context.fieldValues.set(sanitizedValues);
    context.currentStepIndex.set(nextIndex);
    context.blockReason.set(null);
  },
);

const retreatStep = handler(
  (
    _event: unknown,
    context: {
      stepsView: Cell<WizardStep[]>;
      currentStepIndex: Cell<number>;
      blockReason: Cell<string | null>;
    },
  ) => {
    const stepsList = context.stepsView.get();
    if (stepsList.length === 0) return;
    const currentIndex = clampIndex(
      context.currentStepIndex.get(),
      stepsList.length,
    );
    const previousIndex = Math.max(currentIndex - 1, 0);
    context.currentStepIndex.set(previousIndex);
    context.blockReason.set(null);
  },
);

const updateField = handler(
  (
    event: UpdateFieldEvent | undefined,
    context: {
      stepsView: Cell<WizardStep[]>;
      fieldValues: Cell<FieldValueMap>;
      currentStepIndex: Cell<number>;
      blockReason: Cell<string | null>;
    },
  ) => {
    const stepsList = context.stepsView.get();
    if (stepsList.length === 0) return;
    const sanitizedValues = sanitizeFieldValues(
      context.fieldValues.get(),
      stepsList,
    );
    const fallbackIndex = clampIndex(
      context.currentStepIndex.get(),
      stepsList.length,
    );
    const fallbackStep = stepsList[fallbackIndex];
    const explicitStepId = sanitizeIdentifier(event?.stepId);
    const targetStep = stepsList.find((entry) => entry.id === explicitStepId) ??
      fallbackStep;
    if (!targetStep) return;
    const fieldId = sanitizeIdentifier(event?.fieldId);
    if (!fieldId) return;
    const field = targetStep.fields.find((entry) => entry.id === fieldId);
    if (!field) return;
    const value = sanitizeFieldValue(event?.value);
    const nextValues = sanitizeFieldValues(sanitizedValues, stepsList);
    nextValues[targetStep.id][field.id] = value;
    context.fieldValues.set(nextValues);
    context.blockReason.set(null);
  },
);

export const formWizardStepper = pattern<FormWizardStepperArgs>(
  ({ steps, currentStepIndex, fieldValues }) => {
    const blockReason = cell<string | null>(null);

    const stepsView = liftSanitizeSteps(steps);
    const stepCount = liftStepCount(stepsView);

    const activeIndex = liftActiveIndex({
      index: currentStepIndex,
      count: stepCount,
    });

    const valuesView = liftValuesView({
      values: fieldValues,
      steps: stepsView,
    });

    const stepStates = liftStepStates({
      steps: stepsView,
      values: valuesView,
      index: activeIndex,
    });

    const activeStep = liftActiveStep({ steps: stepsView, index: activeIndex });

    const canAdvance = liftCanAdvance({
      states: stepStates,
      index: activeIndex,
    });

    const progress = liftProgress({
      step: activeStep,
      index: activeIndex,
      count: stepCount,
    });

    const progressSummary = str`${progress}`;

    const blockMessage = liftBlockMessage(blockReason);

    return {
      steps,
      fieldValues,
      currentStepIndex,
      stepsView,
      valuesView,
      activeIndex,
      activeStep,
      stepStates,
      canAdvance,
      progressSummary,
      blockMessage,
      advanceStep: advanceStep({
        stepsView,
        fieldValues,
        currentStepIndex,
        blockReason,
      }),
      retreatStep: retreatStep({
        stepsView,
        currentStepIndex,
        blockReason,
      }),
      updateField: updateField({
        stepsView,
        fieldValues,
        currentStepIndex,
        blockReason,
      }),
    };
  },
);

export default formWizardStepper;
