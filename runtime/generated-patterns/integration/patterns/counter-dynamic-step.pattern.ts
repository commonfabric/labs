import { Cell, Default, handler, pattern, str } from "commonfabric";

interface DynamicStepArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

const incrementWithStep = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const step = context.step.get() ?? 1;
    const next = (context.value.get() ?? 0) + step;
    context.value.set(next);
  },
);

const updateStep = handler(
  (
    event: { size?: number } | undefined,
    context: { step: Cell<number> },
  ) => {
    const size = typeof event?.size === "number" ? event.size : 1;
    context.step.set(size);
  },
);

export const counterWithDynamicStep = pattern<DynamicStepArgs>(
  ({ value, step }) => {
    return {
      value,
      step,
      label: str`Value ${value} (step ${step})`,
      controls: {
        increment: incrementWithStep({ value, step }),
        setStep: updateStep({ step }),
      },
    };
  },
);

export default counterWithDynamicStep;
