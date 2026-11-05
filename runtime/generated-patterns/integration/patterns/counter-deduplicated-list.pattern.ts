import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface DeduplicatedListArgs {
  value: Default<number, 0>;
  uniqueValues: Default<number[], []>;
}

interface DedupAudit {
  added: number;
  skipped: number;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const sanitizeNumberList = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const item of input) {
    sanitized.push(toInteger(item));
  }
  return sanitized;
};

const uniqueInOrder = (values: readonly number[]): number[] => {
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
};

const sortAscending = (values: readonly number[]): number[] => {
  return [...values].sort((left, right) => left - right);
};

const incrementAndRecordUnique = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      uniqueValues: Cell<number[]>;
      additions: Cell<number>;
      duplicates: Cell<number>;
      audit: Cell<DedupAudit>;
    },
  ) => {
    const rawAmount = event?.amount;
    const amount = typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? Math.trunc(rawAmount)
      : 1;

    const currentValue = toInteger(context.value.get());
    const nextValue = currentValue + amount;
    context.value.set(nextValue);

    const existing = sanitizeNumberList(context.uniqueValues.get());
    const unique = uniqueInOrder(existing);

    if (!unique.includes(nextValue)) {
      unique.push(nextValue);
      context.uniqueValues.set(unique);
      const recorded = toInteger(context.additions.get());
      context.additions.set(recorded + 1);
    } else {
      const skipped = toInteger(context.duplicates.get());
      context.duplicates.set(skipped + 1);
    }

    const added = toInteger(context.additions.get());
    const skipped = toInteger(context.duplicates.get());
    const auditRecord: DedupAudit = { added, skipped };
    context.audit.set(auditRecord);
  },
);

const liftUniqueInOrder = lift((entries: number[] | undefined) =>
  uniqueInOrder(sanitizeNumberList(entries))
);
const liftSortedLabel = lift((entries: number[] | undefined) => {
  const values = Array.isArray(entries) ? entries : [];
  return values.length === 0 ? "none" : values.join(", ");
});
const liftToInteger = lift((input: number | undefined) => toInteger(input));
const liftNonNegativeInteger = lift((count: number | undefined) =>
  Math.max(0, toInteger(count))
);
const liftAudit = lift((record: DedupAudit | undefined) =>
  record ?? { added: 0, skipped: 0 }
);

/** Pattern maintaining counter with deduplicated history and sorted view. */
export const counterWithDeduplicatedList = pattern<DeduplicatedListArgs>(
  ({ value, uniqueValues }) => {
    const additions = cell(0);
    const duplicates = cell(0);
    const audit = cell<DedupAudit>({ added: 0, skipped: 0 });

    const uniqueValuesView = liftUniqueInOrder(uniqueValues);
    const sortedUnique = sortAscending(uniqueValuesView);
    const sortedLabel = liftSortedLabel(sortedUnique);
    const currentValue = liftToInteger(value);
    const additionsView = liftNonNegativeInteger(additions);
    const duplicatesView = liftNonNegativeInteger(duplicates);
    const auditView = liftAudit(audit);

    const add = incrementAndRecordUnique({
      value,
      uniqueValues,
      additions,
      duplicates,
      audit,
    });

    return {
      value,
      currentValue,
      uniqueValues: uniqueValuesView,
      sortedUnique,
      uniqueLabel: str`Unique values: ${sortedLabel}`,
      additions: additionsView,
      duplicates: duplicatesView,
      audit: auditView,
      add,
    };
  },
);

export default counterWithDeduplicatedList;
