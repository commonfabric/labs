import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface SharedAliasArgs {
  value: Default<number, 0>;
}

const liftSafeValue = lift((count: number | undefined) =>
  typeof count === "number" ? count : 0
);

const sharedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithSharedAlias = pattern<SharedAliasArgs>(
  ({ value }) => {
    const safeValue = liftSafeValue(value);
    const label = str`Value ${safeValue}`;

    return {
      value,
      label,
      current: safeValue,
      mirrors: {
        left: safeValue,
        right: safeValue,
      },
      increment: sharedIncrement({ value }),
    };
  },
);

export default counterWithSharedAlias;
