import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface OpaqueMapArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  labelPrefix: Default<string, "Value">;
}

interface RecordEvent {
  delta?: number;
}

interface RewriteEvent {
  index?: number;
  value?: number;
}

const recordValue = handler(
  (
    event: RecordEvent | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const delta = typeof event?.delta === "number" ? event.delta : 1;
    const current = context.value.get() ?? 0;
    const next = current + delta;
    context.value.set(next);
    context.history.push(next);
  },
);

const rewriteHistoryEntry = handler(
  (
    event: RewriteEvent | undefined,
    context: { history: Cell<number[]> },
  ) => {
    if (typeof event?.value !== "number") return;
    const targetIndex = typeof event.index === "number" ? event.index : 0;
    const values = context.history.get();
    if (!Array.isArray(values)) return;
    if (targetIndex < 0 || targetIndex >= values.length) return;

    const entryCell: Cell<number> = context.history.key(targetIndex);
    entryCell.set(event.value);
  },
);

const clampToNumberArray = (entries: number[] | undefined) => {
  if (!Array.isArray(entries)) return [] as number[];
  return entries.filter((item): item is number => typeof item === "number");
};

const liftClampToNumberArray = lift(clampToNumberArray);

export const counterWithReactiveMap = pattern<OpaqueMapArgs>(
  ({ value, history, labelPrefix }) => {
    const safeHistory = liftClampToNumberArray(history);
    const labels = safeHistory.map((entry, index) => str`#${index}: ${entry}`);

    const count = clampToNumberArray(history).length;
    const total = clampToNumberArray(history).reduce(
      (sum, item) => sum + item,
      0,
    );
    const headline = str`${labelPrefix} ${value} (${count} entries)`;

    return {
      value,
      history,
      count,
      total,
      headline,
      labels,
      record: recordValue({ value, history }),
      rewrite: rewriteHistoryEntry({ history }),
    };
  },
);

export default counterWithReactiveMap;
