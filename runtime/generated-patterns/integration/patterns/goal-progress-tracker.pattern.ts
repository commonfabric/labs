import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface MilestoneInput {
  label?: string;
  weight?: number;
  completed?: boolean;
}

type MilestoneInputRecord = Record<string, MilestoneInput>;

interface MilestoneState {
  label: string;
  weight: number;
  completed: boolean;
}

type MilestoneRecord = Record<string, MilestoneState>;

interface TotalsSnapshot {
  total: number;
  completed: number;
  remaining: number;
  percent: number;
}

interface CompletionEvent {
  id?: string;
  completed?: boolean;
}

interface ReweightEvent {
  id?: string;
  weight?: number;
  delta?: number;
}

const defaultMilestones: MilestoneInputRecord = {
  kickoff: { label: "Kickoff review", weight: 30, completed: true },
  design: { label: "Design lock", weight: 40, completed: false },
  launch: { label: "Launch readiness", weight: 30, completed: false },
};

interface GoalProgressArgs {
  milestones: Default<MilestoneInputRecord, typeof defaultMilestones>;
}

const roundToTwoDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const roundToOneDecimal = (value: number): number => {
  return Math.round(value * 10) / 10;
};

const sanitizeWeight = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundToTwoDecimals(Math.max(0, fallback));
  }
  return roundToTwoDecimals(Math.max(0, value));
};

const sanitizeKey = (raw: string, fallback: string): string => {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const fallbackLabelFromKey = (key: string): string => {
  const parts = key.split(/[-_ ]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "Milestone";
  return parts
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeMilestone = (
  value: MilestoneInput | undefined,
  fallbackLabel: string,
): MilestoneState => {
  const label =
    typeof value?.label === "string" && value.label.trim().length > 0
      ? value.label.trim()
      : fallbackLabel;
  const weight = sanitizeWeight(value?.weight, 1);
  const completed = typeof value?.completed === "boolean"
    ? value.completed
    : false;
  return { label, weight, completed };
};

const sanitizeMilestoneMap = (value: unknown): MilestoneRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const rawEntries = Object.entries(value as Record<string, unknown>);
  rawEntries.sort((left, right) => left[0].localeCompare(right[0]));
  const used = new Set<string>();
  const result: MilestoneRecord = {};
  for (let index = 0; index < rawEntries.length; index += 1) {
    const [rawKey, rawValue] = rawEntries[index];
    const fallbackKey = `milestone-${index + 1}`;
    let key = sanitizeKey(rawKey, fallbackKey);
    if (used.has(key)) {
      let suffix = 2;
      while (used.has(`${key}-${suffix}`)) {
        suffix += 1;
      }
      key = `${key}-${suffix}`;
    }
    used.add(key);
    const label = fallbackLabelFromKey(key);
    const entry = sanitizeMilestone(
      rawValue as MilestoneInput | undefined,
      label,
    );
    result[key] = entry;
  }
  return result;
};

const normalizeEventId = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const updateMilestoneCompletion = handler(
  (
    event: CompletionEvent | undefined,
    context: { milestones: Cell<MilestoneInputRecord> },
  ) => {
    const id = normalizeEventId(event?.id);
    if (!id) return;
    const current = sanitizeMilestoneMap(context.milestones.get());
    const target = current[id];
    if (!target) return;
    const nextCompleted = typeof event?.completed === "boolean"
      ? event.completed
      : !target.completed;
    const updated: MilestoneInputRecord = { ...current };
    updated[id] = { ...target, completed: nextCompleted };
    context.milestones.set(updated);
  },
);

const adjustMilestoneWeight = handler(
  (
    event: ReweightEvent | undefined,
    context: { milestones: Cell<MilestoneInputRecord> },
  ) => {
    const id = normalizeEventId(event?.id);
    if (!id) return;
    const current = sanitizeMilestoneMap(context.milestones.get());
    const target = current[id];
    if (!target) return;
    const hasWeight = typeof event?.weight === "number" &&
      Number.isFinite(event.weight);
    const hasDelta = typeof event?.delta === "number" &&
      Number.isFinite(event.delta);
    if (!hasWeight && !hasDelta) return;
    const nextWeight = hasWeight
      ? sanitizeWeight(event?.weight, target.weight)
      : sanitizeWeight(target.weight + (event?.delta ?? 0), target.weight);
    const updated: MilestoneInputRecord = { ...current };
    updated[id] = { ...target, weight: nextWeight };
    context.milestones.set(updated);
  },
);

// Module-scope lift definitions
const liftSanitizeMilestoneMap = lift(sanitizeMilestoneMap);

const liftTotals = lift((records: MilestoneRecord): TotalsSnapshot => {
  const entries = Object.values(records);
  let total = 0;
  let completed = 0;
  for (const entry of entries) {
    total += entry.weight;
    if (entry.completed) {
      completed += entry.weight;
    }
  }
  const roundedTotal = roundToTwoDecimals(total);
  const roundedCompleted = roundToTwoDecimals(completed);
  const remaining = roundToTwoDecimals(roundedTotal - roundedCompleted);
  const percent = roundedTotal === 0
    ? 0
    : roundToOneDecimal((roundedCompleted / roundedTotal) * 100);
  return {
    total: roundedTotal,
    completed: roundedCompleted,
    remaining,
    percent,
  };
});

const liftTotalWeight = lift((snapshot: TotalsSnapshot) => snapshot.total);
const liftCompletedWeight = lift((snapshot: TotalsSnapshot) =>
  snapshot.completed
);
const liftRemainingWeight = lift((snapshot: TotalsSnapshot) =>
  snapshot.remaining
);
const liftCompletionPercent = lift((snapshot: TotalsSnapshot) =>
  snapshot.percent
);

const liftMilestoneList = lift((inputs: {
  records: MilestoneRecord;
  total: number;
}) => {
  const entries = Object.entries(inputs.records).map(([id, data]) => {
    const percentOfTotal = inputs.total === 0
      ? 0
      : roundToOneDecimal((data.weight / inputs.total) * 100);
    const completedShare = data.completed ? percentOfTotal : 0;
    return {
      id,
      label: data.label,
      weight: data.weight,
      completed: data.completed,
      percentOfTotal,
      completedShare,
    };
  });
  entries.sort((left, right) => left.label.localeCompare(right.label));
  return entries;
});

const liftFormattedPercent = lift((value: number) => value.toFixed(1));

export const goalProgressTracker = pattern<GoalProgressArgs>(
  ({ milestones }) => {
    const sanitized = liftSanitizeMilestoneMap(milestones);
    const totals = liftTotals(sanitized);
    const totalWeight = liftTotalWeight(totals);
    const completedWeight = liftCompletedWeight(totals);
    const remainingWeight = liftRemainingWeight(totals);
    const completionPercent = liftCompletionPercent(totals);

    const milestoneList = liftMilestoneList({
      records: sanitized,
      total: totalWeight,
    });

    const formattedPercent = liftFormattedPercent(completionPercent);

    const summary =
      str`${formattedPercent}% complete (${completedWeight}/${totalWeight})`;

    return {
      milestones: sanitized,
      milestoneList,
      totalWeight,
      completedWeight,
      remainingWeight,
      completionPercent,
      summary,
      complete: updateMilestoneCompletion({ milestones }),
      reweight: adjustMilestoneWeight({ milestones }),
    };
  },
);

export default goalProgressTracker;
