import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface OptionalFallbackArgs {
  value: Default<number | null, null>;
  defaultValue: Default<number, 10>;
}

const bumpWithFallback = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number | null>; defaultValue: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const currentRaw = context?.value?.get();
    const fallback = context?.defaultValue?.get();
    const base = typeof currentRaw === "number"
      ? currentRaw
      : typeof fallback === "number"
      ? fallback
      : 10;
    context.value.set(base + amount);
  },
);

const liftSafeDefault = lift((fallback: number | null) =>
  typeof fallback === "number" ? fallback : 10
);

const liftSafeValue = lift(
  (inputs: { value?: number | null; fallback?: number }) => {
    if (typeof inputs.value === "number") return inputs.value;
    if (typeof inputs.fallback === "number") return inputs.fallback;
    return 10;
  },
);

export const counterWithOptionalFallback = pattern<OptionalFallbackArgs>(
  ({ value, defaultValue }) => {
    const safeDefault = liftSafeDefault(defaultValue);
    const safeValue = liftSafeValue({ value, fallback: defaultValue });

    return {
      value,
      defaultValue,
      current: safeValue,
      effectiveDefault: safeDefault,
      label: str`Value ${safeValue} (default ${safeDefault})`,
      increment: bumpWithFallback({ value, defaultValue }),
    };
  },
);

export default counterWithOptionalFallback;
