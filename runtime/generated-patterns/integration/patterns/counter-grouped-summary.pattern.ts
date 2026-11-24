import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface GroupedSummaryArgs {
  entries: Default<GroupEntryInput[], []>;
  defaultAmount: Default<number, 1>;
}

interface GroupEntryInput {
  id?: string;
  group?: string;
  value?: number;
}

interface GroupEntry {
  id: string;
  group: string;
  value: number;
}

interface GroupSummary {
  group: string;
  total: number;
  count: number;
}

interface RecordGroupEvent {
  id?: string;
  group?: string;
  delta?: number;
  value?: number;
}

const sanitizeNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.round(input * 100) / 100;
};

const sanitizeIdentifier = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeGroup = (input: unknown, fallback = "general"): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeEntries = (value: unknown): GroupEntry[] => {
  if (!Array.isArray(value)) return [];
  const sanitized: GroupEntry[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as GroupEntryInput | undefined;
    const fallbackId = `entry-${index + 1}`;
    const id = sanitizeIdentifier(raw?.id, fallbackId);
    const group = sanitizeGroup(raw?.group);
    const entryValue = sanitizeNumber(raw?.value, 0);
    sanitized.push({ id, group, value: entryValue });
  }
  return sanitized;
};

const uniqueGeneratedId = (entries: readonly GroupEntry[]): string => {
  const used = new Set(entries.map((entry) => entry.id));
  let index = entries.length + 1;
  let candidate = `entry-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `entry-${index}`;
  }
  return candidate;
};

const computeSummaries = (entries: readonly GroupEntry[]): GroupSummary[] => {
  const grouped = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    const group = sanitizeGroup(entry.group);
    const snapshot = grouped.get(group) ?? { total: 0, count: 0 };
    snapshot.total += entry.value;
    snapshot.count += 1;
    grouped.set(group, snapshot);
  }
  const summaries = Array.from(grouped.entries()).map(([group, stats]) => ({
    group,
    total: Math.round(stats.total * 100) / 100,
    count: stats.count,
  }));
  summaries.sort((left, right) => left.group.localeCompare(right.group));
  return summaries;
};

const totalsRecord = (
  summaries: readonly GroupSummary[],
): Record<string, number> => {
  const output: Record<string, number> = {};
  for (const summary of summaries) {
    output[summary.group] = summary.total;
  }
  return output;
};

const dominantSummary = (summaries: readonly GroupSummary[]): GroupSummary => {
  if (summaries.length === 0) {
    return { group: "none", total: 0, count: 0 };
  }
  let best = { ...summaries[0] };
  for (let index = 1; index < summaries.length; index++) {
    const current = summaries[index];
    if (current.total > best.total) {
      best = { ...current };
      continue;
    }
    if (current.total === best.total) {
      if (current.group.localeCompare(best.group) < 0) {
        best = { ...current };
      }
    }
  }
  return best;
};

const formatTotal = (value: number): string => {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const summaryLabelText = (summaries: readonly GroupSummary[]): string => {
  if (summaries.length === 0) return "none";
  return summaries.map((item) => {
    const total = formatTotal(item.total);
    return `${item.group}: ${total} (${item.count})`;
  }).join(" • ");
};

const recordGroupMeasurement = handler(
  (
    event: RecordGroupEvent | undefined,
    context: {
      entries: Cell<GroupEntryInput[]>;
      defaultAmount: Cell<number>;
    },
  ) => {
    const list = sanitizeEntries(context.entries.get());
    const fallbackAmount = (() => {
      const value = context.defaultAmount.get();
      return sanitizeNumber(value, 1) || 1;
    })();

    const requestedId = sanitizeIdentifier(
      event?.id,
      uniqueGeneratedId(list),
    );
    const index = list.findIndex((entry) => entry.id === requestedId);

    const delta = sanitizeNumber(event?.delta, fallbackAmount);
    const override = event?.value;
    const hasOverride = typeof override === "number" &&
      Number.isFinite(override);
    const absolute = hasOverride
      ? sanitizeNumber(override, fallbackAmount)
      : undefined;

    if (index >= 0) {
      const existing = list[index];
      const group = sanitizeGroup(event?.group, existing.group);
      const nextValue = absolute ?? existing.value + delta;
      list[index] = { id: existing.id, group, value: nextValue };
    } else {
      const group = sanitizeGroup(event?.group);
      const value = absolute ?? delta;
      list.push({ id: requestedId, group, value });
    }

    context.entries.set(list);
  },
);

const liftDefaultAmountValue = lift((value: number | undefined) => {
  const sanitized = sanitizeNumber(value, 1);
  return sanitized === 0 ? 1 : sanitized;
});

const liftEntryList = lift((value: GroupEntryInput[] | undefined) =>
  sanitizeEntries(value)
);

const liftLabelPieces = lift(summaryLabelText);

export const counterWithGroupedSummary = pattern<GroupedSummaryArgs>(
  ({ entries, defaultAmount }) => {
    const defaultAmountValue = liftDefaultAmountValue(defaultAmount);

    const entryList = liftEntryList(entries);
    const summaries = computeSummaries(entryList);
    const totals = totalsRecord(summaries);
    const dominant = dominantSummary(summaries);
    const overallTotal = summaries.reduce(
      (sum, entry) => sum + entry.total,
      0,
    );
    const groupCount = summaries.length;
    const labelPieces = liftLabelPieces(summaries);
    const summaryLabel = str`Group totals ${labelPieces}`;

    return {
      entries: entryList,
      summaries,
      groupTotals: totals,
      overallTotal,
      groupCount,
      dominantGroup: dominant,
      summaryLabel,
      controls: {
        record: recordGroupMeasurement({
          entries,
          defaultAmount: defaultAmountValue,
        }),
      },
    };
  },
);

export default counterWithGroupedSummary;
