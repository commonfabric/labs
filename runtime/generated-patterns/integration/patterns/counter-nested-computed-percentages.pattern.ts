import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface ContributionItemSeed {
  label?: string;
  value?: number;
}

interface ContributionGroupSeed {
  label?: string;
  items?: ContributionItemSeed[];
}

interface NestedComputedPercentagesArgs {
  groups: Default<ContributionGroupSeed[], []>;
}

interface ContributionUpdateEvent {
  groupIndex?: number;
  itemIndex?: number;
  value?: number;
  itemLabel?: string;
  groupLabel?: string;
}

interface SanitizedContributionItem {
  label: string;
  value: number;
}

interface SanitizedContributionGroup {
  label: string;
  items: SanitizedContributionItem[];
  total: number;
}

const sanitizeNumber = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.round(raw * 100) / 100;
};

const sanitizeIndex = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return -1;
  }
  const index = Math.trunc(raw);
  return index < 0 ? -1 : index;
};

const sanitizeLabel = (raw: unknown, fallback: string): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeGroups = (
  value: ContributionGroupSeed[] | undefined,
): SanitizedContributionGroup[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized: SanitizedContributionGroup[] = [];
  for (let groupIndex = 0; groupIndex < value.length; groupIndex++) {
    const group = value[groupIndex];
    const label = sanitizeLabel(group?.label, `Group ${groupIndex + 1}`);
    const rawItems = Array.isArray(group?.items) ? group.items : [];
    const items: SanitizedContributionItem[] = [];
    for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex++) {
      const item = rawItems[itemIndex];
      const itemLabel = sanitizeLabel(
        item?.label,
        `Item ${itemIndex + 1}`,
      );
      items.push({
        label: itemLabel,
        value: sanitizeNumber(item?.value),
      });
    }
    const total = items.reduce((sum, item) => sum + item.value, 0);
    sanitized.push({ label, items, total });
  }
  return sanitized;
};

const recordContribution = handler(
  (
    event: ContributionUpdateEvent | undefined,
    context: { groups: Cell<ContributionGroupSeed[]> },
  ) => {
    if (!event) {
      return;
    }

    const groupIndex = sanitizeIndex(event.groupIndex);
    if (groupIndex < 0) {
      return;
    }

    const groupsValue = context.groups.get();
    if (!Array.isArray(groupsValue) || groupIndex >= groupsValue.length) {
      return;
    }

    const groupCell: Cell<ContributionGroupSeed> = context.groups.key(
      groupIndex,
    );
    if (typeof event.groupLabel === "string") {
      groupCell.key("label").set(event.groupLabel.trim());
    }

    if (event.value === undefined && event.itemLabel === undefined) {
      return;
    }

    const itemsCell: Cell<ContributionItemSeed[] | undefined> = groupCell.key(
      "items",
    );
    const current = itemsCell.get();
    const items = Array.isArray(current) ? [...current] : [];

    let itemIndex = sanitizeIndex(event.itemIndex);
    const hasValue = event.value !== undefined;
    const sanitizedValue = hasValue ? sanitizeNumber(event.value) : undefined;

    if (itemIndex < 0) {
      if (!hasValue) {
        return;
      }
      items.push({ value: sanitizedValue });
      itemIndex = items.length - 1;
    } else if (itemIndex >= items.length) {
      if (!hasValue) {
        return;
      }
      const fillers = itemIndex - items.length;
      for (let index = 0; index < fillers; index++) {
        items.push({ value: 0 });
      }
      items.push({ value: sanitizedValue });
    }

    const existing = items[itemIndex] ?? {};
    const nextLabel = event.itemLabel !== undefined
      ? event.itemLabel
      : existing.label;
    items[itemIndex] = {
      label: typeof nextLabel === "string" ? nextLabel.trim() : existing.label,
      value: hasValue
        ? sanitizedValue ?? sanitizeNumber(existing?.value)
        : sanitizeNumber(existing?.value),
    };

    itemsCell.set(items);
  },
);

const calculatePercent = (value: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }
  const ratio = (value / total) * 100;
  return Math.round(ratio * 100) / 100;
};

const liftSanitizeGroups = lift(sanitizeGroups);

const liftGrandTotal = lift((entries: SanitizedContributionGroup[]) => {
  return entries.reduce((sum, group) => sum + group.total, 0);
});

const liftGroupBreakdown = lift(
  (
    state: {
      groups: SanitizedContributionGroup[];
      total: number;
    },
  ) => {
    const breakdown: Array<{
      label: string;
      total: number;
      percentOfTotal: number;
      items: Array<{
        label: string;
        value: number;
        percentOfGroup: number;
        percentOfTotal: number;
      }>;
    }> = [];
    for (const group of state.groups) {
      const percentOfTotal = calculatePercent(group.total, state.total);
      const items: Array<{
        label: string;
        value: number;
        percentOfGroup: number;
        percentOfTotal: number;
      }> = [];
      for (const item of group.items) {
        const percentOfGroup = calculatePercent(item.value, group.total);
        const percentItemTotal = calculatePercent(item.value, state.total);
        items.push({
          label: item.label,
          value: item.value,
          percentOfGroup,
          percentOfTotal: percentItemTotal,
        });
      }
      breakdown.push({
        label: group.label,
        total: group.total,
        percentOfTotal,
        items,
      });
    }
    return breakdown;
  },
);

const liftGroupSummaries = lift(
  (
    state: {
      groups: Array<{
        label: string;
        total: number;
        percentOfTotal: number;
      }>;
    },
  ) => {
    if (state.groups.length === 0) {
      return ["no groups"];
    }
    const summaries: string[] = [];
    for (const group of state.groups) {
      summaries.push(
        `${group.label}: ${group.total} (${group.percentOfTotal}%)`,
      );
    }
    return summaries;
  },
);

const liftSummary = lift(
  (state: { total: number; parts: string[] }): string => {
    const visible = state.parts.length > 0
      ? state.parts.join(" | ")
      : "no groups";
    return `Grand total ${state.total}: ${visible}`;
  },
);

const liftHighlightedGroup = lift(
  (
    state: {
      groups: Array<{
        label: string;
        percentOfTotal: number;
      }>;
    },
  ) => {
    if (state.groups.length === 0) {
      return "none";
    }
    const sorted = [...state.groups].sort((left, right) => {
      return right.percentOfTotal - left.percentOfTotal;
    });
    return `${sorted[0].label} is ${sorted[0].percentOfTotal}%`;
  },
);

export const counterWithNestedComputedPercentages = pattern<
  NestedComputedPercentagesArgs
>(
  ({ groups }) => {
    const sanitizedGroups = liftSanitizeGroups(groups);

    const grandTotal = liftGrandTotal(sanitizedGroups);

    const groupBreakdown = liftGroupBreakdown({
      groups: sanitizedGroups,
      total: grandTotal,
    });

    const groupSummaries = liftGroupSummaries({
      groups: groupBreakdown,
    });

    const summary = liftSummary({ total: grandTotal, parts: groupSummaries });

    const highlightedGroup = liftHighlightedGroup({ groups: groupBreakdown });

    return {
      groups,
      sanitizedGroups,
      grandTotal,
      groupBreakdown,
      groupSummaries,
      summary,
      highlightedGroup,
      label: str`${summary} | Top ${highlightedGroup}`,
      recordContribution: recordContribution({ groups }),
    };
  },
);

export default counterWithNestedComputedPercentages;
