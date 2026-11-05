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

interface ParameterizedChildArgs {
  identity: Default<string, "child">;
  value: Default<number, 0>;
  step: Default<number, 1>;
  labelPrefix: Default<string, "Child">;
}

interface ChildConfig {
  id: string;
  start: number;
  step: number;
  labelPrefix: string;
}

type ChildConfigInput = Partial<ChildConfig> & { id?: string };

interface ChildSpecializationRecord {
  id: string;
  step: number;
  labelPrefix: string;
  start: number;
}

interface NestedParameterizedArgs {
  configs: Default<ChildConfigInput[], []>;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return input;
};

const toPositiveInteger = (input: unknown, fallback: number): number => {
  const value = Math.trunc(toFiniteNumber(input, fallback));
  return value > 0 ? value : fallback;
};

const normalizeStep = (input: unknown): number => {
  const value = toFiniteNumber(input, 1);
  if (value === 0) return 1;
  return Math.abs(value);
};

const sanitizeLabelPrefix = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeIdentity = (input: unknown, index: number): string => {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim();
  }
  return `child-${index + 1}`;
};

const sanitizeChildConfig = (
  entry: unknown,
  index: number,
): ChildConfig => {
  const value = typeof entry === "object" && entry !== null ? entry : {};
  const id = sanitizeIdentity((value as any).id, index);
  const start = Math.trunc(toFiniteNumber((value as any).start, 0));
  const step = normalizeStep((value as any).step);
  const labelPrefix = sanitizeLabelPrefix((value as any).labelPrefix, "Child");
  return { id, start, step, labelPrefix };
};

const sanitizeConfigEntries = (input: unknown): ChildConfig[] => {
  if (!Array.isArray(input)) return [];
  return input.map((entry, index) => sanitizeChildConfig(entry, index));
};

const childIncrement = handler(
  (
    event: { cycles?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const current = toFiniteNumber(context.value.get(), 0);
    const step = normalizeStep(context.step.get());
    const multiplier = toPositiveInteger(event?.cycles, 1);
    const next = current + step * multiplier;
    context.value.set(next);
  },
);

const liftSafeIdentity = lift((input: string | undefined) =>
  typeof input === "string" && input.trim().length > 0 ? input.trim() : "child"
);

const liftNormalizedStep = lift((input: number | undefined) =>
  normalizeStep(input)
);

const liftNormalizedValue = lift((input: number | undefined) =>
  toFiniteNumber(input, 0)
);

const liftSanitizedPrefix = lift((input: string | undefined) =>
  sanitizeLabelPrefix(input, "Child")
);

export const parameterizedChildCounter = pattern<ParameterizedChildArgs>(
  ({ identity, value, step, labelPrefix }) => {
    const safeIdentity = liftSafeIdentity(identity);

    const normalizedStep = liftNormalizedStep(step);

    const normalizedValue = liftNormalizedValue(value);

    const sanitizedPrefix = liftSanitizedPrefix(labelPrefix);

    const label =
      str`${sanitizedPrefix} (${safeIdentity}) value ${normalizedValue}`;
    const summary = str`${safeIdentity} step ${normalizedStep}`;

    const increment = childIncrement({
      value,
      step: normalizedStep,
    });

    return {
      identity: safeIdentity,
      value: normalizedValue,
      step: normalizedStep,
      label,
      summary,
      increment,
    };
  },
);

const toRecord = (config: ChildConfig): ChildSpecializationRecord => ({
  id: config.id,
  step: config.step,
  labelPrefix: config.labelPrefix,
  start: config.start,
});

const configureChildren = handler(
  (
    event: { configs?: ChildConfigInput[] } | undefined,
    context: {
      configs: Cell<ChildConfigInput[]>;
      version: Cell<number>;
    },
  ) => {
    if (!event || !("configs" in event)) return;
    const entries = sanitizeConfigEntries(event.configs);
    context.configs.set(entries);
    const current = toFiniteNumber(context.version.get(), 0);
    context.version.set(current + 1);
  },
);

const liftSanitizedConfigs = lift((entries: ChildConfigInput[] | undefined) =>
  sanitizeConfigEntries(entries)
);

const liftManifest = lift((entries: ChildConfig[]) => {
  const records = entries.map(toRecord);
  return records;
});

const liftChildren = lift((entries: ChildConfig[]) => {
  return entries.map((config) =>
    parameterizedChildCounter({
      identity: config.id,
      value: config.start,
      step: config.step,
      labelPrefix: config.labelPrefix,
    })
  );
});

export const counterNestedParameterized = pattern<NestedParameterizedArgs>(
  ({ configs }) => {
    const configurationVersion = cell(0);

    const sanitizedConfigs = liftSanitizedConfigs(configs);

    const manifest = liftManifest(sanitizedConfigs);

    const children = liftChildren(sanitizedConfigs);

    const childCount = sanitizedConfigs.length;

    const manifestLabels = computed(() => {
      if (manifest.length === 0) return "none";
      return manifest
        .map((record) => `${record.id}:${record.step}`)
        .join(", ");
    });

    const summary = str`Specializations ${manifestLabels}`;

    const configure = configureChildren({
      configs,
      version: configurationVersion,
    });

    return {
      configs,
      children,
      childCount,
      manifest,
      summary,
      configure,
      reconfigurations: configurationVersion,
    };
  },
);

export default counterNestedParameterized;
