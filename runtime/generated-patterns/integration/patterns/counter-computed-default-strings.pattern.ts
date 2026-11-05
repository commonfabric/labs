import {
  Cell,
  cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

interface ComputedDefaultStringsArgs {
  value: Default<number, 0>;
  prefix: Default<string, "Count">;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get();
    const base = typeof current === "number" ? current : 0;
    context.value.set(base + amount);
  },
);

const setOverrideLabel = handler(
  (
    event: { text?: string } | undefined,
    context: { label: Cell<string | null> },
  ) => {
    const next = typeof event?.text === "string" && event.text.length > 0
      ? event.text
      : null;
    context.label.set(next);
  },
);

export const counterWithComputedDefaultStrings = pattern<
  ComputedDefaultStringsArgs
>(
  ({ value, prefix }) => {
    const override = cell<string | null>(null);
    const normalizedValue = typeof value === "number" ? value : 0;

    const fallbackLabel = computed(() => {
      const prefixValue = typeof prefix === "string" && prefix.length > 0
        ? prefix
        : "Count";
      return `${prefixValue} ${normalizedValue}`;
    });

    const label = computed(() => {
      const overrideValue = override.get();
      return typeof overrideValue === "string" ? overrideValue : fallbackLabel;
    });

    const summary = str`${label} (current: ${normalizedValue})`;

    return {
      value,
      prefix,
      current: normalizedValue,
      label,
      fallbackLabel,
      summary,
      overrides: {
        label: override,
      },
      increment: adjustValue({ value }),
      setLabel: setOverrideLabel({ label: override }),
    };
  },
);

export default counterWithComputedDefaultStrings;
