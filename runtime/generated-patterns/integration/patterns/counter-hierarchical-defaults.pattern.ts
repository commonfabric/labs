import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface FormattingConfig {
  prefix?: string;
  suffix?: string;
}

interface SettingsConfig {
  label?: string;
  step?: number;
  formatting?: FormattingConfig;
}

interface HierarchicalDefaultsArgs {
  value: Default<number, 0>;
  settings: Default<
    SettingsConfig,
    {
      label: "Counter";
      step: 1;
      formatting: { prefix: "Count"; suffix: "items" };
    }
  >;
}

interface AdjustContext {
  value: Cell<number>;
  step: Cell<number>;
}

const adjustWithDefaults = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustContext,
  ) => {
    const stepValue = context.step.get();
    const base = typeof stepValue === "number" && Number.isFinite(stepValue)
      ? stepValue
      : 1;
    const amount = typeof event?.amount === "number" ? event.amount : base;
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

const defaults = {
  label: "Counter",
  step: 1,
  formatting: {
    prefix: "Count",
    suffix: "items",
  },
};

const normalizeSettings = (input: SettingsConfig | undefined) => {
  if (!input) {
    return defaults;
  }
  const formatting = typeof input.formatting === "object" && input.formatting
    ? input.formatting
    : {};
  return {
    label: typeof input.label === "string" && input.label.length > 0
      ? input.label
      : defaults.label,
    step: typeof input.step === "number" && Number.isFinite(input.step)
      ? input.step
      : defaults.step,
    formatting: {
      prefix: typeof formatting.prefix === "string" &&
          formatting.prefix.length > 0
        ? formatting.prefix
        : defaults.formatting.prefix,
      suffix: typeof formatting.suffix === "string" &&
          formatting.suffix.length > 0
        ? formatting.suffix
        : defaults.formatting.suffix,
    },
  };
};

const liftNormalizeSettings = lift(normalizeSettings);

export const counterWithHierarchicalDefaults = pattern<
  HierarchicalDefaultsArgs
>(
  ({ value, settings }) => {
    const resolvedSettings = liftNormalizeSettings(settings);
    const labelCell = resolvedSettings.label;
    const stepCell = resolvedSettings.step;
    const formattingCell = resolvedSettings.formatting;
    const prefixCell = formattingCell.prefix;
    const suffixCell = formattingCell.suffix;

    const display = str`${prefixCell} ${value} ${suffixCell}`;
    const summary = str`${labelCell}: ${value}`;

    return {
      value,
      settings,
      resolvedSettings,
      effectiveStep: stepCell,
      label: labelCell,
      prefix: prefixCell,
      suffix: suffixCell,
      display,
      summary,
      controls: {
        adjust: adjustWithDefaults({ value, step: stepCell }),
      },
    };
  },
);

export default counterWithHierarchicalDefaults;
