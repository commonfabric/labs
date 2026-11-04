import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const statusOrder = [
  "pending",
  "in_progress",
  "complete",
  "waived",
] as const;

type ComplianceStatus = typeof statusOrder[number];

type ComplianceState = "compliant" | "at_risk" | "non_compliant";

const statusSet = new Set<ComplianceStatus>(statusOrder);

const statusLabels: Record<ComplianceStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  complete: "Complete",
  waived: "Waived",
};

const complianceLabels: Record<ComplianceState, string> = {
  compliant: "Compliant",
  at_risk: "At Risk",
  non_compliant: "Non-Compliant",
};

interface ChecklistTaskInput {
  id?: string;
  taskId?: string;
  reference?: string;
  label?: string;
  category?: string;
  mandatory?: boolean;
  status?: string;
  owner?: string | null;
  evidence?: string | null;
  note?: string | null;
  state?: string | null;
}

interface ComplianceTask {
  id: string;
  label: string;
  category: string;
  mandatory: boolean;
  status: ComplianceStatus;
  owner: string | null;
  evidence: string | null;
}

interface CategorySummary {
  category: string;
  total: number;
  mandatory: number;
  satisfied: number;
  outstanding: number;
  coverage: number;
  label: string;
}

interface ComplianceGap {
  id: string;
  label: string;
  category: string;
  owner: string | null;
  status: ComplianceStatus;
  mandatory: boolean;
}

interface ComplianceChecklistArgs {
  tasks: Default<ChecklistTaskInput[], typeof defaultTasks>;
}

interface TaskProgressEvent {
  id?: string;
  taskId?: string;
  reference?: string;
  status?: string;
  state?: string;
  owner?: string | null;
  evidence?: string | null;
  note?: string | null;
}

interface ComplianceInsights {
  coveragePercent: number;
  mandatoryTotal: number;
  mandatorySatisfied: number;
  gapList: ComplianceGap[];
  categories: CategorySummary[];
  status: ComplianceState;
}

interface CategoryAccumulator {
  category: string;
  total: number;
  mandatory: number;
  satisfied: number;
  outstanding: number;
}

type TaskOverrideMap = Record<string, ComplianceTask>;

const defaultTasks: ComplianceTask[] = [
  {
    id: "data-retention",
    label: "Data Retention Policy",
    category: "Policy",
    mandatory: true,
    status: "complete",
    owner: "Morgan Patel",
    evidence: "Executive approval logged",
  },
  {
    id: "security-awareness",
    label: "Security Awareness Training",
    category: "Training",
    mandatory: true,
    status: "pending",
    owner: null,
    evidence: null,
  },
  {
    id: "access-review",
    label: "Access Review Audit",
    category: "Audit",
    mandatory: true,
    status: "in_progress",
    owner: "Jordan Lee",
    evidence: null,
  },
  {
    id: "vendor-assessment",
    label: "Vendor Risk Assessment",
    category: "Third-Party",
    mandatory: false,
    status: "pending",
    owner: null,
    evidence: null,
  },
];

const cloneTask = (task: ComplianceTask): ComplianceTask => ({
  id: task.id,
  label: task.label,
  category: task.category,
  mandatory: task.mandatory,
  status: task.status,
  owner: task.owner ?? null,
  evidence: task.evidence ?? null,
});

const cloneTasks = (entries: readonly ComplianceTask[]): ComplianceTask[] =>
  entries.map((entry) => cloneTask(entry));

const compareTasks = (left: ComplianceTask, right: ComplianceTask): number => {
  const categoryCompare = left.category.localeCompare(right.category);
  if (categoryCompare !== 0) return categoryCompare;
  if (left.mandatory !== right.mandatory) {
    return left.mandatory ? -1 : 1;
  }
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) return labelCompare;
  return left.id.localeCompare(right.id);
};

const sanitizeTaskList = (value: unknown): ComplianceTask[] => {
  if (!Array.isArray(value)) {
    return cloneTasks(defaultTasks);
  }
  const seen = new Set<string>();
  const sanitized: ComplianceTask[] = [];
  for (const raw of value) {
    const task = sanitizeTask(raw);
    if (!task) continue;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    sanitized.push(task);
  }
  if (sanitized.length === 0) {
    return cloneTasks(defaultTasks);
  }
  sanitized.sort(compareTasks);
  return sanitized;
};

const sanitizeTask = (value: unknown): ComplianceTask | null => {
  const input = value as ChecklistTaskInput | undefined;
  const id = resolveSanitizedId(input);
  if (!id) return null;
  const label = sanitizeLabel(input?.label, id);
  const category = sanitizeCategory(input?.category);
  const mandatory = typeof input?.mandatory === "boolean"
    ? input.mandatory
    : true;
  const status = sanitizeStatus(input?.status ?? input?.state, "pending");
  const owner = sanitizeOwnerInput(input?.owner);
  const evidence = sanitizeEvidence(input?.evidence ?? input?.note);
  return { id, label, category, mandatory, status, owner, evidence };
};

const resolveSanitizedId = (
  input: ChecklistTaskInput | undefined,
): string | null => {
  const candidates = [input?.id, input?.taskId, input?.reference];
  for (const candidate of candidates) {
    const id = sanitizeTaskId(candidate);
    if (id) return id;
  }
  return null;
};

const sanitizeTaskId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized : null;
};

const formatLabelFromId = (id: string): string =>
  id.split(/[-_]/).map(normalizeWord).join(" ");

const normalizeWord = (value: string): string => {
  if (!value) return value;
  // Handle hyphenated compound words like "Third-Party"
  if (value.includes("-")) {
    return value.split("-").map((part) => {
      const lower = part.toLowerCase();
      return lower.slice(0, 1).toUpperCase() + lower.slice(1);
    }).join("-");
  }
  const lower = value.toLowerCase();
  return lower.slice(0, 1).toUpperCase() + lower.slice(1);
};

const normalizeWords = (value: string): string =>
  value.split(/[\s_]+/).filter(Boolean).map(normalizeWord).join(" ");

const sanitizeLabel = (value: unknown, fallbackId: string): string => {
  if (typeof value !== "string") {
    return formatLabelFromId(fallbackId);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return formatLabelFromId(fallbackId);
  }
  return normalizeWords(trimmed);
};

const sanitizeCategory = (value: unknown): string => {
  if (typeof value !== "string") return "General";
  const trimmed = value.trim();
  if (!trimmed) return "General";
  return normalizeWords(trimmed);
};

const sanitizeOwnerInput = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return normalizeWords(trimmed);
};

const sanitizeEvidence = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const sanitizeStatus = (
  value: unknown,
  fallback: ComplianceStatus,
): ComplianceStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "inprogress") {
    return "in_progress";
  }
  if (statusSet.has(normalized as ComplianceStatus)) {
    return normalized as ComplianceStatus;
  }
  return fallback;
};

const isSatisfied = (status: ComplianceStatus): boolean =>
  status === "complete" || status === "waived";

const formatCategoryLabel = (
  category: string,
  bucket: CategoryAccumulator,
): string => {
  if (bucket.mandatory === 0) {
    return `${category}: no mandatory tasks`;
  }
  const coverageNote =
    `${bucket.satisfied}/${bucket.mandatory} mandatory complete`;
  if (bucket.outstanding === 0) {
    return `${category}: ${coverageNote}`;
  }
  return `${category}: ${coverageNote} (${bucket.outstanding} outstanding)`;
};

const formatStatusLabel = (status: ComplianceStatus): string =>
  statusLabels[status];

const formatStateLabel = (state: ComplianceState): string =>
  complianceLabels[state];

const computeInsights = (
  tasks: readonly ComplianceTask[],
): ComplianceInsights => {
  const categories = new Map<string, CategoryAccumulator>();
  const gaps: ComplianceGap[] = [];
  let mandatoryTotal = 0;
  let mandatorySatisfied = 0;

  for (const task of tasks) {
    const bucket = categories.get(task.category) ?? {
      category: task.category,
      total: 0,
      mandatory: 0,
      satisfied: 0,
      outstanding: 0,
    };
    bucket.total += 1;
    if (task.mandatory) {
      bucket.mandatory += 1;
      mandatoryTotal += 1;
      if (isSatisfied(task.status)) {
        bucket.satisfied += 1;
        mandatorySatisfied += 1;
      } else {
        bucket.outstanding += 1;
        gaps.push({
          id: task.id,
          label: task.label,
          category: task.category,
          owner: task.owner,
          status: task.status,
          mandatory: true,
        });
      }
    }
    categories.set(task.category, bucket);
  }

  const categorySummaries = Array.from(categories.values()).map((bucket) => {
    const coverage = bucket.mandatory === 0
      ? 100
      : Math.round((bucket.satisfied / bucket.mandatory) * 100);
    return {
      category: bucket.category,
      total: bucket.total,
      mandatory: bucket.mandatory,
      satisfied: bucket.satisfied,
      outstanding: bucket.outstanding,
      coverage,
      label: formatCategoryLabel(bucket.category, bucket),
    } satisfies CategorySummary;
  });

  categorySummaries.sort((left, right) =>
    left.category.localeCompare(right.category)
  );

  const sortedGaps = [...gaps].sort((left, right) => {
    const categoryCompare = left.category.localeCompare(right.category);
    if (categoryCompare !== 0) return categoryCompare;
    const labelCompare = left.label.localeCompare(right.label);
    if (labelCompare !== 0) return labelCompare;
    return left.id.localeCompare(right.id);
  });

  const coveragePercent = mandatoryTotal === 0
    ? 100
    : Math.round((mandatorySatisfied / mandatoryTotal) * 100);
  const status: ComplianceState = coveragePercent === 100
    ? "compliant"
    : coveragePercent >= 60
    ? "at_risk"
    : "non_compliant";

  return {
    coveragePercent,
    mandatoryTotal,
    mandatorySatisfied,
    gapList: sortedGaps,
    categories: categorySummaries,
    status,
  };
};

const cloneOverrideMap = (value: unknown): TaskOverrideMap => {
  if (!value || typeof value !== "object") return {};
  const result: TaskOverrideMap = {};
  for (const [key, task] of Object.entries(value as TaskOverrideMap)) {
    if (!task || typeof task !== "object") continue;
    result[key] = cloneTask(task as ComplianceTask);
  }
  return result;
};

const mergeTasks = (
  defaults: readonly ComplianceTask[],
  overrides: TaskOverrideMap,
): ComplianceTask[] => {
  const merged = defaults.map((task) => {
    const override = overrides[task.id];
    return override ? cloneTask(override) : cloneTask(task);
  });

  for (const [id, override] of Object.entries(overrides)) {
    if (!merged.some((task) => task.id === id)) {
      merged.push(cloneTask(override));
    }
  }

  merged.sort(compareTasks);
  return merged;
};

const tasksEqual = (left: ComplianceTask, right: ComplianceTask): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.category === right.category &&
  left.mandatory === right.mandatory &&
  left.status === right.status &&
  left.owner === right.owner &&
  left.evidence === right.evidence;

const hasOwn = (
  value: TaskProgressEvent | undefined,
  key: keyof TaskProgressEvent,
): boolean =>
  value !== undefined && Object.prototype.hasOwnProperty.call(value, key);

const resolveTaskId = (event: TaskProgressEvent | undefined): string | null => {
  if (!event) return null;
  const candidates = [event.id, event.taskId, event.reference];
  for (const candidate of candidates) {
    const id = sanitizeTaskId(candidate);
    if (id) return id;
  }
  return null;
};

const updateComplianceTask = handler(
  (
    event: TaskProgressEvent | undefined,
    context: {
      defaults: Cell<ComplianceTask[]>;
      overrides: Cell<TaskOverrideMap>;
      history: Cell<string[]>;
    },
  ) => {
    const id = resolveTaskId(event);
    if (!id) return;

    const baseList = context.defaults.get();
    if (!Array.isArray(baseList) || baseList.length === 0) return;
    const defaults = baseList.map(cloneTask);
    const overrides = cloneOverrideMap(context.overrides.get());
    const current = mergeTasks(defaults, overrides);

    const index = current.findIndex((task) => task.id === id);
    if (index === -1) return;

    const previous = { ...current[index] };
    const statusValue = sanitizeStatus(
      event?.status ?? event?.state,
      previous.status,
    );

    const ownerProvided = hasOwn(event, "owner");
    const nextOwner = ownerProvided
      ? sanitizeOwnerInput(event?.owner)
      : previous.owner;

    const evidenceProvided = hasOwn(event, "evidence") || hasOwn(event, "note");
    const nextEvidence = evidenceProvided
      ? sanitizeEvidence(
        hasOwn(event, "evidence") ? event?.evidence : event?.note,
      )
      : previous.evidence;

    let didChange = false;
    const nextTask: ComplianceTask = { ...previous };

    if (statusValue !== previous.status) {
      nextTask.status = statusValue;
      didChange = true;
    }

    if (ownerProvided && nextOwner !== previous.owner) {
      nextTask.owner = nextOwner;
      didChange = true;
    }

    if (evidenceProvided && nextEvidence !== previous.evidence) {
      nextTask.evidence = nextEvidence;
      didChange = true;
    }

    if (!didChange) return;

    current[index] = nextTask;
    current.sort(compareTasks);

    const baseMap = new Map(defaults.map((task) => [task.id, task]));
    const baseTask = baseMap.get(id);
    const nextOverrides: TaskOverrideMap = { ...overrides };
    if (baseTask && tasksEqual(baseTask, nextTask)) {
      delete nextOverrides[id];
    } else {
      nextOverrides[id] = cloneTask(nextTask);
    }
    context.overrides.set(nextOverrides);

    const historyEntry = buildHistoryEntry(nextTask, {
      statusChanged: nextTask.status !== previous.status,
      ownerChanged: nextTask.owner !== previous.owner,
      evidenceChanged: nextTask.evidence !== previous.evidence,
    });
    const history = context.history.get();
    const nextHistory = Array.isArray(history)
      ? [...history, historyEntry]
      : [historyEntry];
    context.history.set(nextHistory);
  },
);

const buildHistoryEntry = (
  task: ComplianceTask,
  flags: {
    statusChanged: boolean;
    ownerChanged: boolean;
    evidenceChanged: boolean;
  },
): string => {
  const segments: string[] = [];
  if (flags.statusChanged) {
    segments.push(`status ${formatStatusLabel(task.status)}`);
  }
  if (flags.ownerChanged) {
    segments.push(task.owner ? `owner ${task.owner}` : "owner cleared");
  }
  if (flags.evidenceChanged) {
    segments.push(task.evidence ? "evidence recorded" : "evidence cleared");
  }
  const detail = segments.length > 0 ? segments.join(" | ") : "updated";
  return `${task.label}: ${detail}`;
};

const liftMergeTasks = lift((input: {
  defaults: ComplianceTask[];
  overrides: TaskOverrideMap;
}) => mergeTasks(input.defaults, input.overrides));

const liftCoveragePercent = lift((snapshot: ComplianceInsights) =>
  snapshot.coveragePercent
);

const liftGapCount = lift((snapshot: ComplianceInsights) =>
  snapshot.gapList.length
);

const liftGapWord = lift((count: number) => (count === 1 ? "gap" : "gaps"));

const liftComplianceState = lift((snapshot: ComplianceInsights) =>
  formatStateLabel(snapshot.status)
);

const liftMandatorySummary = lift((snapshot: ComplianceInsights) => ({
  total: snapshot.mandatoryTotal,
  satisfied: snapshot.mandatorySatisfied,
}));

const liftAuditTrail = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

const liftSanitizeTaskList = lift(sanitizeTaskList);
const liftComputeInsights = lift(computeInsights);
const liftCloneTasks = lift(cloneTasks);

export const complianceChecklist = pattern<ComplianceChecklistArgs>(
  ({ tasks }) => {
    const canonicalDefaults = liftSanitizeTaskList(tasks);
    const overrideStore = cell<TaskOverrideMap>({});
    const auditStore = cell<string[]>([]);

    const currentTasks = liftMergeTasks({
      defaults: canonicalDefaults,
      overrides: overrideStore,
    });

    const insights = liftComputeInsights(currentTasks);

    const tasksView = liftCloneTasks(currentTasks);
    const categorySummaries = insights.categories;
    const gapDetails = insights.gapList;

    const coveragePercent = liftCoveragePercent(insights);
    const gapCount = liftGapCount(insights);
    const gapWord = liftGapWord(gapCount);
    const complianceState = liftComplianceState(insights);

    const statusLabel =
      str`${coveragePercent}% coverage (${complianceState}) with ${gapCount} ${gapWord}`;

    const mandatorySummary = liftMandatorySummary(insights);

    const auditTrail = liftAuditTrail(auditStore);

    return {
      tasks: tasksView,
      categories: categorySummaries,
      coveragePercent,
      gapCount,
      complianceState,
      statusLabel,
      gapTasks: gapDetails,
      mandatorySummary,
      auditTrail,
      updateTask: updateComplianceTask({
        defaults: canonicalDefaults,
        overrides: overrideStore,
        history: auditStore,
      }),
    };
  },
);

export type {
  CategorySummary,
  ChecklistTaskInput,
  ComplianceChecklistArgs,
  ComplianceGap,
  ComplianceInsights,
  ComplianceState,
  ComplianceStatus,
  ComplianceTask,
  TaskProgressEvent,
};

export default complianceChecklist;
