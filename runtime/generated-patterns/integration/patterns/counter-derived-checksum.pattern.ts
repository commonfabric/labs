import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface CounterChecksumArgs {
  value: Default<number, 0>;
  values: Default<number[], []>;
  prefix: Default<string, "Checksum">;
}

interface ChecksumSnapshot {
  amount: number;
  nextValue: number;
  checksum: number;
}

interface ChecksumAudit {
  updates: number;
  checksum: number;
}

const normalizeNumber = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 0;
  }
  return Math.trunc(input);
};

const sanitizeNumbers = (input: readonly number[]): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const item of input) {
    if (typeof item === "number" && Number.isFinite(item)) {
      sanitized.push(Math.trunc(item));
    }
  }
  return sanitized;
};

const computeChecksum = (numbers: readonly number[]): number => {
  let checksum = 0;
  for (let index = 0; index < numbers.length; index++) {
    const normalized = Math.abs(numbers[index]) & 0xff;
    const weight = (index % 7) + 1;
    checksum = (checksum + normalized * weight) % 65535;
  }
  return checksum;
};

const recordValue = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      values: Cell<number[]>;
      updateCount: Cell<number>;
      lastEvent: Cell<ChecksumSnapshot>;
      audit: Cell<ChecksumAudit>;
    },
  ) => {
    const rawAmount = event?.amount;
    const amount = typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? Math.trunc(rawAmount)
      : 1;

    const current = normalizeNumber(context.value.get());
    const nextValue = current + amount;
    context.value.set(nextValue);

    const existing = sanitizeNumbers(context.values.get());
    existing.push(nextValue);
    context.values.set(existing);

    const updates = context.updateCount.get() ?? 0;
    const updateTotal = updates + 1;
    context.updateCount.set(updateTotal);

    const checksum = computeChecksum(existing);
    const snapshot: ChecksumSnapshot = {
      amount,
      nextValue,
      checksum,
    };
    const auditState: ChecksumAudit = {
      updates: updateTotal,
      checksum,
    };

    context.lastEvent.set(snapshot);
    context.audit.set(auditState);
  },
);

const liftSanitizeNumbers = lift(sanitizeNumbers);
const liftDefaultNumber = lift((value: number | undefined) => value ?? 0);
const liftDefaultSnapshot = lift(
  (snapshot: ChecksumSnapshot | undefined) =>
    snapshot ?? { amount: 0, nextValue: 0, checksum: 0 },
);
const liftPrefixLabel = lift((text: string | undefined) =>
  typeof text === "string" && text.length > 0 ? text : "Checksum"
);

/** Pattern computing checksum of recorded counter values. */
export const counterWithDerivedChecksum = pattern<CounterChecksumArgs>(
  ({ value, values, prefix }) => {
    const updateCount = cell(0);

    const lastEvent = cell<ChecksumSnapshot>({
      amount: 0,
      nextValue: 0,
      checksum: 0,
    });
    const auditView = cell<ChecksumAudit>({
      updates: 0,
      checksum: 0,
    });

    const valuesView = liftSanitizeNumbers(values);
    const checksum = computeChecksum(valuesView);
    const checksumView = liftDefaultNumber(checksum);
    const updatesView = liftDefaultNumber(updateCount);
    const lastEventView = liftDefaultSnapshot(lastEvent);
    const prefixLabel = liftPrefixLabel(prefix);
    const label = str`${prefixLabel} ${checksumView}`;
    const summary = str`${prefixLabel} ${checksumView} after ${updatesView}`;
    const record = recordValue({
      value,
      values,
      updateCount,
      lastEvent,
      audit: auditView,
    });

    return {
      value,
      values: valuesView,
      checksum: checksumView,
      updates: updatesView,
      lastEvent: lastEventView,
      label,
      summary,
      audit: auditView,
      record,
    };
  },
);

export default counterWithDerivedChecksum;
