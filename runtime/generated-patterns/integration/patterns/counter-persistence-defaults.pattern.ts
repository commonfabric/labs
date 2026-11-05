import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface PersistenceDefaultsArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

const applyIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number"
      ? event.amount
      : context.step.get() ?? 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const liftSafeStep = lift((input: number | undefined) =>
  typeof input === "number" ? input : 1
);

export const counterWithPersistenceDefaults = pattern<PersistenceDefaultsArgs>(
  ({ value, step }) => {
    const safeStep = liftSafeStep(step);

    return {
      value,
      step,
      currentStep: safeStep,
      label: str`Value ${value} (step ${safeStep})`,
      increment: applyIncrement({ value, step }),
    };
  },
);

export default counterWithPersistenceDefaults;
