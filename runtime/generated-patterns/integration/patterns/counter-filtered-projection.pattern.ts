import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface FilteredProjectionArgs {
  counters: Default<number[], []>;
  threshold: Default<number, 0>;
}

const asNumber = (input: unknown): number | undefined => {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  return input;
};

const readThreshold = (input: unknown, fallback: number): number => {
  const value = asNumber(input);
  if (typeof value === "number") return value;
  return fallback;
};

const appendCounter = handler(
  (
    event: { value?: number } | number | undefined,
    context: { counters: Cell<number[]> },
  ) => {
    const nextValue = asNumber(
      typeof event === "number" ? event : event?.value,
    ) ?? 0;
    const current = context.counters.get();
    const list = Array.isArray(current) ? current.slice() : [];
    list.push(nextValue);
    context.counters.set(list);
  },
);

const replaceCounter = handler(
  (
    event: { index?: number; value?: number } | undefined,
    context: { counters: Cell<number[]> },
  ) => {
    if (typeof event?.index !== "number") return;
    const rawIndex = Math.trunc(event.index);
    if (!Number.isFinite(rawIndex) || rawIndex < 0) return;
    const current = context.counters.get();
    if (!Array.isArray(current)) return;
    if (rawIndex >= current.length) return;
    const list = current.slice();
    list[rawIndex] = asNumber(event?.value) ?? 0;
    context.counters.set(list);
  },
);

const updateThreshold = handler(
  (
    event: { value?: number; threshold?: number } | number | undefined,
    context: { threshold: Cell<number> },
  ) => {
    const current = asNumber(context.threshold.get()) ?? 0;
    const resolved = typeof event === "number"
      ? event
      : event?.value ?? event?.threshold;
    const nextThreshold = readThreshold(resolved, current);
    context.threshold.set(nextThreshold);
  },
);

const liftSanitizedCounters = lift((entries: number[] | undefined) => {
  if (!Array.isArray(entries)) return [] as number[];
  return entries.map((entry) => asNumber(entry) ?? 0);
});

const liftThresholdValue = lift((input: number | undefined) =>
  readThreshold(input, 0)
);

const liftFiltered = lift(
  (inputs: { values: number[]; threshold: number }): number[] =>
    inputs.values.filter((value) => value >= inputs.threshold),
);

const liftExcluded = lift(
  (inputs: { values: number[]; threshold: number }): number[] =>
    inputs.values.filter((value) => value < inputs.threshold),
);

const liftJoinedValues = lift((values: number[]) => values.join(", "));

export const counterWithFilteredProjection = pattern<FilteredProjectionArgs>(
  ({ counters, threshold }) => {
    const sanitizedCounters = liftSanitizedCounters(counters);

    const thresholdValue = liftThresholdValue(threshold);

    const filtered = liftFiltered({
      values: sanitizedCounters,
      threshold: thresholdValue,
    });

    const excluded = liftExcluded({
      values: sanitizedCounters,
      threshold: thresholdValue,
    });

    const totalCount = sanitizedCounters.length;
    const filteredCount = filtered.length;
    const excludedCount = excluded.length;

    const filteredLabel = liftJoinedValues(filtered);
    const excludedLabel = liftJoinedValues(excluded);

    const summary =
      str`Filtered ${filteredCount} of ${totalCount} >= ${thresholdValue}`;

    return {
      counters,
      threshold,
      sanitizedCounters,
      thresholdValue,
      filtered,
      excluded,
      filteredCount,
      excludedCount,
      totalCount,
      filteredLabel,
      excludedLabel,
      summary,
      append: appendCounter({ counters }),
      replace: replaceCounter({ counters }),
      setThreshold: updateThreshold({ threshold }),
    };
  },
);

export default counterWithFilteredProjection;
