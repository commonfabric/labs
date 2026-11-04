import { Cell, cell, Default, handler, lift, pattern, str } from "commonfabric";

interface NoOpCounterArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: {
      value: Cell<number>;
      updates: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const amount = event?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return;
    }

    const currentRaw = context.value.get();
    const currentValue =
      typeof currentRaw === "number" && Number.isFinite(currentRaw)
        ? currentRaw
        : 0;
    const next = currentValue + amount;
    context.value.set(next);

    const updateRaw = context.updates.get();
    const applied = typeof updateRaw === "number" && Number.isFinite(updateRaw)
      ? updateRaw + 1
      : 1;
    context.updates.set(applied);
    context.lastEvent.set(`applied ${amount}`);
  },
);

const liftCurrentValue = lift((input: number | undefined) =>
  typeof input === "number" && Number.isFinite(input) ? input : 0
);

const liftUpdateCount = lift((count: number | undefined) =>
  typeof count === "number" && Number.isFinite(count) ? count : 0
);

const liftLastEventView = lift((label: string | undefined) =>
  typeof label === "string" && label.length > 0 ? label : "none"
);

export const counterNoOpEvents = pattern<NoOpCounterArgs>(
  ({ value }) => {
    const updates = cell(0);
    const lastEvent = cell("none");

    const currentValue = liftCurrentValue(value);
    const updateCount = liftUpdateCount(updates);
    const lastEventView = liftLastEventView(lastEvent);
    const hasChanges = updateCount > 0;
    const status = hasChanges ? "changed" : "no changes";
    const label = str`Counter value ${currentValue} (${status})`;

    return {
      value,
      currentValue,
      updateCount,
      hasChanges,
      status,
      label,
      lastEvent: lastEventView,
      increment: applyIncrement({ value, updates, lastEvent }),
    };
  },
);

export default counterNoOpEvents;
