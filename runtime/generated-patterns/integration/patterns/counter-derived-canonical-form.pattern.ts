import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface CanonicalEntryInput {
  id?: string;
  label?: string;
  value?: number;
}

interface CanonicalGroupInput {
  name?: string;
  counters?: CanonicalEntryInput[];
}

interface CanonicalFormArgs {
  groups: Default<CanonicalGroupInput[], []>;
}

interface CanonicalEntry {
  id: string;
  label: string;
  value: number;
}

interface CanonicalGroup {
  name: string;
  counters: CanonicalEntry[];
}

interface CanonicalGroupSummary extends CanonicalGroup {
  total: number;
}

interface CanonicalForm {
  groups: CanonicalGroupSummary[];
  totalValue: number;
  signature: string[];
}

const toInteger = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const sanitizeString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
};

const sanitizeEntry = (
  entry: CanonicalEntryInput | undefined,
  index: number,
  groupName: string,
): CanonicalEntry => {
  const defaultLabel = `Entry ${index + 1}`;
  const label = sanitizeString(entry?.label, defaultLabel);
  const fallbackId = `${groupName}-${index + 1}`;
  const preferredId = entry?.id ?? label;
  const id = sanitizeString(preferredId, fallbackId);
  const value = toInteger(entry?.value, 0);
  return { id, label, value };
};

const sanitizeGroup = (
  group: CanonicalGroupInput | undefined,
  index: number,
): CanonicalGroup => {
  const name = sanitizeString(group?.name, `Group ${index + 1}`);
  const countersInput = Array.isArray(group?.counters)
    ? group?.counters as readonly CanonicalEntryInput[]
    : [];
  const counters = countersInput.map((entry, entryIndex) =>
    sanitizeEntry(entry, entryIndex, name)
  );
  return { name, counters };
};

const sanitizeGroups = (
  groups: readonly CanonicalGroupInput[] | undefined,
): CanonicalGroup[] => {
  if (!Array.isArray(groups)) return [];
  return groups.map((group, index) => sanitizeGroup(group, index));
};

const toInputShape = (groups: CanonicalGroup[]): CanonicalGroupInput[] =>
  groups.map((group) => ({
    name: group.name,
    counters: group.counters.map((entry) => ({
      id: entry.id,
      label: entry.label,
      value: entry.value,
    })),
  }));

const canonicalizeGroups = (groups: CanonicalGroup[]): CanonicalForm => {
  const sortedGroups = groups.map((group) => ({
    name: group.name,
    counters: group.counters.map((entry) => ({ ...entry })),
  }));

  sortedGroups.sort((left, right) =>
    left.name.localeCompare(right.name, "en", { sensitivity: "base" })
  );

  const summaryGroups: CanonicalGroupSummary[] = sortedGroups.map((group) => {
    const counters = [...group.counters].sort((left, right) => {
      const labelCompare = left.label.localeCompare(right.label, "en", {
        sensitivity: "base",
      });
      if (labelCompare !== 0) return labelCompare;
      return left.id.localeCompare(right.id, "en", { sensitivity: "base" });
    });
    const total = counters.reduce((sum, entry) => sum + entry.value, 0);
    return { name: group.name, counters, total };
  });

  const totalValue = summaryGroups.reduce(
    (sum, group) => sum + group.total,
    0,
  );
  const signature = summaryGroups.flatMap((group) =>
    group.counters.map((entry) => `${group.name}:${entry.label}:${entry.value}`)
  );

  return { groups: summaryGroups, totalValue, signature };
};

const sanitizeStringList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input.map((value, index) =>
    sanitizeString(value, `record-${index + 1}`)
  );
};

const _safeKey = (group: string, entry: string): string => {
  const compactGroup = group.replace(/\W+/g, "-");
  const compactEntry = entry.replace(/\W+/g, "-");
  return `canonical-${compactGroup}-${compactEntry}`;
};

interface AdjustEvent {
  group?: string;
  id?: string;
  label?: string;
  delta?: number;
  set?: number;
}

const applyAdjustment = handler(
  (
    event: AdjustEvent | undefined,
    context: {
      groups: Cell<CanonicalGroupInput[]>;
      history: Cell<string[]>;
      lastMutation: Cell<string>;
      operations: Cell<number>;
    },
  ) => {
    const sanitizedGroups = sanitizeGroups(context.groups.get());

    const groupName = sanitizeString(event?.group, "Unsorted");
    const requestedLabel = event?.label ?? event?.id;
    const label = sanitizeString(requestedLabel, "Unnamed");
    const id = sanitizeString(event?.id ?? label, `${groupName}-${label}`);

    const existingGroup = sanitizedGroups.find((group) =>
      group.name.toLowerCase() === groupName.toLowerCase()
    );

    const targetGroup = existingGroup ?? {
      name: groupName,
      counters: [],
    };

    if (!existingGroup) sanitizedGroups.push(targetGroup);

    const existingEntry = targetGroup.counters.find((entry) =>
      entry.id.toLowerCase() === id.toLowerCase()
    );

    const entry = existingEntry ?? {
      id,
      label,
      value: 0,
    };

    if (!existingEntry) targetGroup.counters.push(entry);

    if (event?.label) {
      entry.label = label;
    }

    entry.id = id;

    if (typeof event?.set === "number" && Number.isFinite(event.set)) {
      entry.value = toInteger(event.set, entry.value);
    } else {
      const delta = toInteger(event?.delta, 1);
      entry.value = toInteger(entry.value + delta, entry.value);
    }

    const normalizedGroups = toInputShape(sanitizedGroups);
    context.groups.set(normalizedGroups);

    const mutationSummary = `${targetGroup.name}:${entry.label}:${entry.value}`;

    const historyRecords = sanitizeStringList(context.history.get());
    historyRecords.push(mutationSummary);
    context.history.set(historyRecords);

    const operations = toInteger(context.operations.get(), 0) + 1;
    context.operations.set(operations);

    context.lastMutation.set(mutationSummary);
  },
);

const liftSanitizeGroups = lift((input: CanonicalGroupInput[] | undefined) =>
  sanitizeGroups(input)
);
const liftSignatureText = lift((items: string[] | undefined) => {
  const entries = sanitizeStringList(items);
  return entries.length === 0 ? "none" : entries.join(" | ");
});
const liftSanitizeStringList = lift((entries: string[] | undefined) =>
  sanitizeStringList(entries)
);
const liftNonNegativeOperations = lift((count: number | undefined) =>
  Math.max(0, toInteger(count, 0))
);
const liftSanitizeString = lift((value: string | undefined) =>
  sanitizeString(value, "none")
);

/** Pattern computing canonical view of nested counters for stable assertions. */
export const counterWithDerivedCanonicalForm = pattern<CanonicalFormArgs>(
  ({ groups }) => {
    const history = cell<string[]>([]);
    const lastMutation = cell("none");
    const operations = cell(0);

    const groupsView = liftSanitizeGroups(groups);

    const canonical = canonicalizeGroups(groupsView);

    const totalValue = canonical.totalValue;
    const signatureList = canonical.signature;

    const signatureText = liftSignatureText(signatureList);

    const historyView = liftSanitizeStringList(history);

    const operationsView = liftNonNegativeOperations(operations);

    const lastMutationView = liftSanitizeString(lastMutation);

    const canonicalLabel =
      str`Canonical total ${totalValue} -> ${signatureText}`;
    const operationsLabel = str`Mutations: ${operationsView}`;

    return {
      groups: groupsView,
      canonical,
      canonicalLabel,
      canonicalSignatureText: signatureText,
      operations: operationsView,
      operationsLabel,
      lastMutation: lastMutationView,
      history: historyView,
      controls: {
        adjust: applyAdjustment({
          groups,
          history,
          lastMutation,
          operations,
        }),
      },
    };
  },
);

export default counterWithDerivedCanonicalForm;
