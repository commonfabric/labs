import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  type Writable,
} from "commonfabric";

interface BudgetCategoryInput {
  name?: string;
  target?: number;
  allocation?: number;
}

interface BudgetCategoryCatalog {
  id: string;
  name: string;
  target: number;
}

interface CategoryProjection extends BudgetCategoryCatalog {
  allocation: number;
  variance: number;
  share: number;
}

interface AllocationRecord {
  [categoryId: string]: number;
}

interface AllocationEvent {
  category?: string;
  amount?: number;
}

interface RebalanceEvent {
  mode?: "targets" | "even";
}

interface BudgetSummary {
  allocations: AllocationRecord;
  categories: CategoryProjection[];
  totalAllocated: number;
  remaining: number;
  overflow: number;
}

interface BudgetPlannerArgs {
  total: Default<number, typeof defaultTotalBudget>;
  categories: Default<BudgetCategoryInput[], typeof defaultCategories>;
}

const defaultTotalBudget = 4000;

const defaultCategories: BudgetCategoryInput[] = [
  { name: "Housing", target: 1800 },
  { name: "Food", target: 600 },
  { name: "Transportation", target: 400 },
  { name: "Savings", target: 800 },
  { name: "Leisure", target: 400 },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeTotalBudget = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultTotalBudget;
  }
  const rounded = roundCurrency(value);
  return rounded > 0 ? rounded : defaultTotalBudget;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(value, 0));
};

const normalizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const slugifyName = (value: string, fallback: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
};

const ensureUniqueId = (
  id: string,
  used: Set<string>,
  fallback: string,
): string => {
  let candidate = id.length > 0 ? id : fallback;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeCategoryList = (
  input: readonly BudgetCategoryInput[] | undefined,
  total: number,
): { catalog: BudgetCategoryCatalog[]; allocations: AllocationRecord } => {
  const source = Array.isArray(input) ? input : defaultCategories;
  const sanitizedCatalog: BudgetCategoryCatalog[] = [];
  const allocations: AllocationRecord = {};
  const usedIds = new Set<string>();
  const entries = source.filter((entry) =>
    typeof entry?.name === "string" || typeof entry?.target === "number"
  );
  const fallbackList = entries.length > 0 ? entries : defaultCategories;
  const fallbackTarget = fallbackList.length > 0
    ? roundCurrency(total / fallbackList.length)
    : roundCurrency(total);

  let remaining = roundCurrency(Math.max(total, 0));

  for (let index = 0; index < fallbackList.length; index++) {
    const raw = fallbackList[index];
    const fallbackName = defaultCategories[index]?.name ??
      `Category ${index + 1}`;
    const normalizedName = normalizeName(raw?.name, fallbackName);
    const fallbackId = slugifyName(fallbackName, `category-${index + 1}`);
    const id = ensureUniqueId(
      slugifyName(normalizedName, fallbackId),
      usedIds,
      fallbackId,
    );
    const targetFallback = defaultCategories[index]?.target ?? fallbackTarget;
    const target = sanitizeAmount(raw?.target, targetFallback);
    const desiredAllocation = sanitizeAmount(raw?.allocation, 0);
    const allocation = Math.min(desiredAllocation, remaining);
    const rounded = roundCurrency(allocation);
    remaining = roundCurrency(remaining - rounded);
    sanitizedCatalog.push({ id, name: normalizedName, target });
    allocations[id] = rounded;
  }

  if (sanitizedCatalog.length === 0) {
    return sanitizeCategoryList(defaultCategories, total);
  }

  return { catalog: sanitizedCatalog, allocations };
};

const enforceAllocationLimits = (
  raw: AllocationRecord | undefined,
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): BudgetSummary => {
  const record = raw ?? {};
  const sanitized: AllocationRecord = {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  let remaining = normalizedTotal;
  let overflow = 0;

  for (const category of catalog) {
    const desired = sanitizeAmount(record[category.id], 0);
    if (desired > remaining) {
      overflow = roundCurrency(overflow + desired - remaining);
    }
    const applied = Math.min(desired, remaining);
    const rounded = roundCurrency(applied);
    remaining = roundCurrency(remaining - rounded);
    sanitized[category.id] = rounded;
  }

  for (const key of Object.keys(record)) {
    if (catalog.some((category) => category.id === key)) continue;
    overflow = roundCurrency(overflow + sanitizeAmount(record[key], 0));
  }

  const allocatedTotal = roundCurrency(normalizedTotal - remaining);
  const projections: CategoryProjection[] = catalog.map((category) => {
    const allocation = sanitized[category.id] ?? 0;
    const variance = roundCurrency(allocation - category.target);
    const share = normalizedTotal > 0
      ? Math.round((allocation / normalizedTotal) * 1000) / 10
      : 0;
    return {
      id: category.id,
      name: category.name,
      target: category.target,
      allocation,
      variance,
      share,
    };
  });

  return {
    allocations: sanitized,
    categories: projections,
    totalAllocated: allocatedTotal,
    remaining,
    overflow,
  };
};

const computeTargetAllocations = (
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): AllocationRecord => {
  if (catalog.length === 0) return {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  const targets = catalog.map((entry) => sanitizeAmount(entry.target, 0));
  const targetSum = targets.reduce((sum, value) => sum + value, 0);
  const allocations: AllocationRecord = {};
  let remaining = normalizedTotal;

  if (targetSum <= 0) {
    return computeEvenAllocations(catalog, normalizedTotal);
  }

  for (let index = 0; index < catalog.length; index++) {
    const isLast = index === catalog.length - 1;
    const ratio = targets[index] / targetSum;
    const desired = roundCurrency(normalizedTotal * ratio);
    const applied = isLast ? remaining : Math.min(desired, remaining);
    const rounded = roundCurrency(applied);
    remaining = roundCurrency(remaining - rounded);
    allocations[catalog[index].id] = rounded;
  }

  return allocations;
};

const computeEvenAllocations = (
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): AllocationRecord => {
  if (catalog.length === 0) return {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  const allocations: AllocationRecord = {};
  const evenShare = normalizedTotal > 0
    ? roundCurrency(normalizedTotal / catalog.length)
    : 0;
  let remaining = normalizedTotal;

  for (let index = 0; index < catalog.length; index++) {
    const isLast = index === catalog.length - 1;
    const desired = isLast ? remaining : Math.min(evenShare, remaining);
    const rounded = roundCurrency(desired);
    remaining = roundCurrency(remaining - rounded);
    allocations[catalog[index].id] = rounded;
  }

  return allocations;
};

const resetAllocationsForCatalog = (
  catalog: readonly BudgetCategoryCatalog[],
): AllocationRecord => {
  const reset: AllocationRecord = {};
  for (const category of catalog) {
    reset[category.id] = 0;
  }
  return reset;
};

const formatAmount = (value: number): string => {
  return `$${value.toFixed(2)}`;
};

const appendHistory = (history: Cell<string[]>, entry: string) => {
  const previous = history.get();
  const list = Array.isArray(previous) ? previous.slice() : [];
  list.push(entry);
  const trimmed = list.length > 6 ? list.slice(-6) : list;
  history.set(trimmed);
};

const resolveCategoryId = (
  identifier: string | undefined,
  catalog: readonly BudgetCategoryCatalog[],
): BudgetCategoryCatalog | null => {
  if (!identifier) return null;
  const normalized = identifier.trim().toLowerCase();
  for (const category of catalog) {
    if (category.id === normalized) return category;
    if (category.name.toLowerCase() === normalized) return category;
  }
  return null;
};

const updateAllocation = handler(
  (
    event: AllocationEvent | undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());

    const targetCategory = resolveCategoryId(event?.category, catalog);
    if (!targetCategory) {
      const message = "Ignored allocation update for unknown category";
      context.lastAction.set(message);
      appendHistory(context.history, message);
      return;
    }

    const desired = sanitizeAmount(event?.amount, 0);
    const overrides = context.overrides.get();
    const currentAllocations = overrides
      ? { ...overrides }
      : { ...baseState.allocations };
    const previous = currentAllocations[targetCategory.id] ?? 0;
    let otherTotal = 0;
    for (const [id, amount] of Object.entries(currentAllocations)) {
      if (id === targetCategory.id) continue;
      otherTotal = roundCurrency(otherTotal + amount);
    }
    const available = Math.max(roundCurrency(total - otherTotal), 0);
    const capped = Math.min(desired, available);
    currentAllocations[targetCategory.id] = roundCurrency(capped);
    const enforced = enforceAllocationLimits(
      currentAllocations,
      catalog,
      total,
    );
    context.overrides.set(enforced.allocations);

    const applied = enforced.allocations[targetCategory.id] ?? 0;
    const delta = roundCurrency(applied - previous);
    const remaining = enforced.remaining;
    const message =
      `Allocated ${formatAmount(applied)} to ${targetCategory.name} ` +
      `(change ${formatAmount(delta)}). Remaining ` +
      formatAmount(remaining);

    context.lastAction.set(message);
    appendHistory(context.history, message);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const rebalanceAllocations = handler(
  (
    event: RebalanceEvent | undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());
    const draft = event?.mode === "even"
      ? computeEvenAllocations(catalog, total)
      : computeTargetAllocations(catalog, total);

    const applied = enforceAllocationLimits(draft, catalog, total);
    context.overrides.set(applied.allocations);
    const mode = event?.mode === "even" ? "even" : "target";
    const message = mode === "even"
      ? "Distributed budget evenly across categories"
      : "Distributed budget using target proportions";

    context.lastAction.set(message);
    appendHistory(context.history, message);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const resetAllocations = handler(
  (
    _event: undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());
    const resetMap = resetAllocationsForCatalog(catalog);
    const applied = enforceAllocationLimits(resetMap, catalog, total);
    context.overrides.set(applied.allocations);
    const message = "Reset all allocations to $0.00";
    context.lastAction.set(message);
    appendHistory(context.history, message);
    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const liftSanitizedTotal = lift((value: number | undefined) =>
  sanitizeTotalBudget(value)
);

const liftBaseState = lift<{
  categories: Writable<BudgetCategoryInput[]>;
  total: Writable<number>;
}>(({ categories, total }) =>
  sanitizeCategoryList(categories.get(), total.get())
);

const liftSummary = lift<{
  total: Writable<number>;
  base: Writable<{
    catalog: BudgetCategoryCatalog[];
    allocations: AllocationRecord;
  }>;
  overrides: Writable<AllocationRecord | null>;
}>(({ total, base, overrides }) => {
  const baseStateValue = base.get();
  const active = overrides.get() ?? baseStateValue.allocations;
  return enforceAllocationLimits(
    active,
    baseStateValue.catalog,
    sanitizeTotalBudget(total.get()),
  );
});

const liftSummaryLabel = lift<{
  total: Writable<number>;
  summary: Writable<BudgetSummary>;
}>(({ total, summary }) => {
  const totalValue = sanitizeTotalBudget(total.get());
  const state = summary.get();
  return `Allocated ${formatAmount(state.totalAllocated)} of ` +
    `${formatAmount(totalValue)} (${formatAmount(state.remaining)} ` +
    "remaining)";
});

const liftStatusMessage = lift((state: BudgetSummary) => {
  if (state.remaining <= 0.01) {
    return "Budget balanced";
  }
  return `Remaining allocation ${formatAmount(state.remaining)}`;
});

const liftHistoryView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries.slice() : []
);

export const budgetPlanner = pattern<BudgetPlannerArgs>(
  ({ total, categories }) => {
    const sanitizedTotal = liftSanitizedTotal(total);

    const baseState = liftBaseState({ categories, total: sanitizedTotal });

    const categoryCatalog = baseState.catalog;
    const overrides = cell<AllocationRecord | null>(null);
    const history = cell<string[]>(["Budget initialized"]);
    const lastAction = cell("Budget initialized");
    const sequence = cell(0);

    const summary = liftSummary({
      total: sanitizedTotal,
      base: baseState,
      overrides,
    });

    const categorySummary = summary.categories;
    const allocationView = summary.allocations;
    const allocatedTotal = summary.totalAllocated;
    const remainingBudget = summary.remaining;
    const overflowAmount = summary.overflow;
    const balanced = summary.remaining <= 0.01 && summary.overflow === 0;

    const summaryLabel = liftSummaryLabel({ total: sanitizedTotal, summary });

    const statusMessage = liftStatusMessage(summary);

    const historyView = liftHistoryView(history);

    return {
      totalBudget: sanitizedTotal,
      categoryCatalog,
      categorySummary,
      allocations: allocationView,
      allocatedTotal,
      remainingBudget,
      overflowAmount,
      balanced,
      summaryLabel,
      statusMessage,
      lastAction,
      history: historyView,
      allocate: updateAllocation({
        total: sanitizedTotal,
        base: baseState,
        overrides,
        history,
        lastAction,
        sequence,
      }),
      rebalance: rebalanceAllocations({
        total: sanitizedTotal,
        base: baseState,
        overrides,
        history,
        lastAction,
        sequence,
      }),
      reset: resetAllocations({
        overrides,
        base: baseState,
        total: sanitizedTotal,
        history,
        lastAction,
        sequence,
      }),
    };
  },
);

export default budgetPlanner;
