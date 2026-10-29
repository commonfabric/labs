import { Cell, Default, handler, pattern, str } from "commonfabric";

interface BoundedCounterArgs {
  value: Default<number, 0>;
  min: Default<number, 0>;
  max: Default<number, 10>;
}

const clampValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; min: Cell<number>; max: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const minValue = context.min.get() ?? 0;
    const maxValue = context.max.get() ?? minValue;
    const current = context.value.get() ?? minValue;
    const next = Math.min(Math.max(current + amount, minValue), maxValue);
    context.value.set(next);
  },
);

export const boundedCounter = pattern<BoundedCounterArgs>(
  ({ value, min, max }) => {
    const label = str`Value ${value} (min ${min}, max ${max})`;

    return {
      value,
      bounds: { min, max },
      label,
      adjust: clampValue({ value, min, max }),
    };
  },
);

export default boundedCounter;
