import { Cell, Default, handler, pattern, str } from "commonfabric";

interface RichLabelArgs {
  value: Default<number, 0>;
  prefix: Default<string, "Count">;
  step: Default<number, 2>;
  unit: Default<string, "items">;
}

const adjustWithStep = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const step = context.step.get() ?? 1;
    const amount = typeof event?.amount === "number" ? event.amount : step;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithRichLabel = pattern<RichLabelArgs>(
  ({ value, prefix, step, unit }) => {
    const detail = str`step ${step} ${unit}`;
    const label = str`${prefix}: ${value} (${detail})`;

    return {
      value,
      prefix,
      settings: { step, unit },
      settingsView: { step, unit },
      current: value,
      heading: prefix,
      detail,
      label,
      increment: adjustWithStep({ value, step }),
    };
  },
);

export default counterWithRichLabel;
