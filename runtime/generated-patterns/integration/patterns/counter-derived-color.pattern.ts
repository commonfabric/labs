import { Cell, Default, handler, pattern } from "commonfabric";

interface DerivedColorArgs {
  value: Default<number, 0>;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

function getColor(count: number): string {
  if (count < 0) return "blue";
  if (count < 5) return "green";
  if (count < 10) return "orange";
  return "red";
}

export const counterWithDerivedColor = pattern<DerivedColorArgs>(
  ({ value }) => {
    const color = getColor(value ?? 0);

    return {
      value,
      color,
      adjust: adjustValue({ value }),
    };
  },
);

export default counterWithDerivedColor;
