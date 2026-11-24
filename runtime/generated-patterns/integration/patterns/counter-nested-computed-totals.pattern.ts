import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface SubtotalGroupSeed {
  label?: string;
  values?: number[];
}

interface NestedComputedTotalsArgs {
  groups: Default<SubtotalGroupSeed[], []>;
}

interface SubtotalGroupArgs {
  label?: Default<string, "">;
  values?: Default<number[], []>;
  index?: Default<number, 0>;
}

interface AppendGroupValueEvent {
  index?: number;
  label?: string;
  value?: number;
}

type AppendValueEvent = { value?: number } | number | undefined;

type ReplaceValuesEvent = { values?: number[] } | undefined;

const sanitizeNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
};

const sanitizeValues = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const entry of value) {
    sanitized.push(sanitizeNumber(entry));
  }
  return sanitized;
};

const sanitizeIndex = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  const normalized = Math.trunc(value);
  return normalized < 0 ? -1 : normalized;
};

const resolveLabel = (raw: unknown, index: number): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `Group ${index + 1}`;
};

const appendValueToList = handler(
  (event: AppendValueEvent, context: { values: Cell<number[]> }) => {
    const rawValue = typeof event === "number" ? event : event?.value;
    if (rawValue === undefined) {
      return;
    }
    const amount = sanitizeNumber(rawValue);
    context.values.push(amount);
  },
);

const replaceValuesList = handler(
  (event: ReplaceValuesEvent, context: { values: Cell<number[]> }) => {
    if (!event || !Array.isArray(event.values)) {
      return;
    }
    context.values.set(sanitizeValues(event.values));
  },
);

const liftNormalizedIndex = lift((value: number | undefined) => {
  const candidate = sanitizeIndex(value);
  return candidate >= 0 ? candidate : 0;
});

const liftItems = lift(sanitizeValues);

const liftSubtotal = lift((entries: number[]) => {
  return entries.reduce((sum, value) => sum + value, 0);
});

const liftItemCount = lift((entries: number[]) => entries.length);

const liftResolvedLabel = lift(
  (
    state: { raw: string | undefined; idx: number },
  ): string => {
    return resolveLabel(state.raw, state.idx);
  },
);

const subtotalGroup = pattern<SubtotalGroupArgs>(
  ({ label, values, index }) => {
    const normalizedIndex = liftNormalizedIndex(index);

    const items = liftItems(values);

    const subtotal = liftSubtotal(items);

    const itemCount = liftItemCount(items);

    const resolvedLabel = liftResolvedLabel({
      raw: label,
      idx: normalizedIndex,
    });

    const subtotalLabel = str`${resolvedLabel} subtotal ${subtotal}`;

    return {
      index: normalizedIndex,
      label: resolvedLabel,
      items,
      itemCount,
      subtotal,
      subtotalLabel,
      append: appendValueToList({ values }),
      replace: replaceValuesList({ values }),
    };
  },
);

const instantiateGroups = lift<
  { groups: Cell<SubtotalGroupSeed[]> },
  ReturnType<typeof subtotalGroup>[]
>(
  ({ groups }) => {
    const raw = groups.get();
    const list = Array.isArray(raw) ? raw : [];
    const children = [];
    for (let index = 0; index < list.length; index++) {
      const groupCell = groups.key(index);
      const labelCell = groupCell.key("label");
      const valuesCell = groupCell.key("values");
      const child = subtotalGroup({
        label: labelCell,
        values: valuesCell,
        index,
      }).for(index);
      children.push(child);
    }
    return children;
  },
);

const appendToGroup = handler(
  (
    event: AppendGroupValueEvent | undefined,
    context: { groups: Cell<SubtotalGroupSeed[]> },
  ) => {
    if (!event || event.value === undefined) {
      return;
    }

    const raw = context.groups.get();
    const list = Array.isArray(raw) ? raw : [];
    if (list.length === 0) {
      return;
    }

    let index = sanitizeIndex(event.index);

    if (index < 0 && typeof event.label === "string") {
      const trimmed = event.label.trim();
      if (trimmed.length > 0) {
        index = list.findIndex((entry, idx) => {
          return resolveLabel(entry?.label, idx) === trimmed;
        });
      }
    }

    if (index < 0 || index >= list.length) {
      return;
    }

    const groupCell: Cell<SubtotalGroupSeed> = context.groups.key(index);
    const valuesCell: Cell<number[] | undefined> = groupCell.key("values");
    const current = sanitizeValues(valuesCell.get());
    const amount = sanitizeNumber(event.value);
    valuesCell.set([...current, amount]);
  },
);

const liftGroupTotals = lift((entries: { subtotal: number }[] | undefined) => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => {
    const subtotal = (entry as { subtotal?: unknown }).subtotal;
    return typeof subtotal === "number" ? subtotal : sanitizeNumber(subtotal);
  });
});

const liftGrandTotal = lift((totals: number[]) => {
  return totals.reduce((sum, value) => sum + value, 0);
});

const liftGroupLabels = lift((entries: { label: string }[] | undefined) => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry, index) => {
    const label = (entry as { label?: unknown }).label;
    return typeof label === "string" ? label : resolveLabel(label, index);
  });
});

const liftGroupSummaries = lift(
  (
    state: { labels: string[]; totals: number[] },
  ): string[] => {
    const limit = Math.min(state.labels.length, state.totals.length);
    if (limit === 0) {
      return ["none"];
    }
    const summaries: string[] = [];
    for (let index = 0; index < limit; index++) {
      const label = state.labels[index];
      const value = state.totals[index];
      summaries.push(`${label}: ${value}`);
    }
    return summaries;
  },
);

const liftMainSummary = lift((state: { parts: string[]; total: number }) => {
  const visible = state.parts.length > 0 ? state.parts.join(" | ") : "none";
  return `${visible} => total ${state.total}`;
});

const liftGroupCount = lift((entries: unknown[] | undefined) => {
  return Array.isArray(entries) ? entries.length : 0;
});

const liftTotalItems = lift((entries: { itemCount: number }[]) => {
  if (!Array.isArray(entries)) {
    return 0;
  }
  return entries.reduce((sum, entry) => {
    const count = entry.itemCount;
    return typeof count === "number" ? sum + count : sum;
  }, 0);
});

export const counterWithNestedComputedTotals = pattern<
  NestedComputedTotalsArgs
>(
  ({ groups: groupSeeds }) => {
    const groups = instantiateGroups({ groups: groupSeeds });

    const groupTotals = liftGroupTotals(groups);

    const grandTotal = liftGrandTotal(groupTotals);

    const groupLabels = liftGroupLabels(groups);

    const groupSummaries = liftGroupSummaries({
      labels: groupLabels,
      totals: groupTotals,
    });

    const summary = liftMainSummary({
      parts: groupSummaries,
      total: grandTotal,
    });

    const groupCount = liftGroupCount(groups);

    const totalItems = liftTotalItems(groups);

    return {
      seeds: groupSeeds,
      groups,
      groupTotals,
      groupLabels,
      groupSummaries,
      groupCount,
      totalItems,
      grandTotal,
      summary,
      appendToGroup: appendToGroup({ groups: groupSeeds }),
    };
  },
);

export default counterWithNestedComputedTotals;
