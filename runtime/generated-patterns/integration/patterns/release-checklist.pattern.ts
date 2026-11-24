import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

type ReleaseTaskStatus = "pending" | "in_progress" | "blocked" | "done";

interface ReleaseTask {
  id: string;
  label: string;
  required: boolean;
  status: ReleaseTaskStatus;
  owner: string | null;
  note: string | null;
}

interface ReleaseChecklistArgs {
  tasks: Default<ReleaseTask[], typeof defaultTasks>;
}

interface TaskProgressEvent {
  id?: string;
  status?: string;
  owner?: string | null;
  note?: string | null;
}

interface ReleaseChecklistStats {
  total: number;
  requiredTotal: number;
  completedRequired: number;
  completedTotal: number;
  blocked: string[];
  pendingRequired: string[];
  ready: boolean;
}

const statusValues: ReleaseTaskStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "done",
];

const statusSet = new Set<ReleaseTaskStatus>(statusValues);

const defaultTasks: ReleaseTask[] = [
  {
    id: "qa-signoff",
    label: "QA Sign-off",
    required: true,
    status: "pending",
    owner: "Jordan Patel",
    note: null,
  },
  {
    id: "documentation",
    label: "Documentation Updated",
    required: true,
    status: "pending",
    owner: "Avery Fox",
    note: null,
  },
  {
    id: "ops-runbook",
    label: "Operations Runbook",
    required: true,
    status: "pending",
    owner: "Taylor Young",
    note: null,
  },
  {
    id: "marketing-review",
    label: "Marketing Review",
    required: false,
    status: "pending",
    owner: null,
    note: null,
  },
];

const cloneTask = (task: ReleaseTask): ReleaseTask => ({
  id: task.id,
  label: task.label,
  required: task.required,
  status: task.status,
  owner: task.owner ?? null,
  note: task.note ?? null,
});

const cloneTasks = (entries: readonly ReleaseTask[]): ReleaseTask[] =>
  entries.map((entry) => cloneTask(entry));

const taskEquals = (left: ReleaseTask, right: ReleaseTask): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.required === right.required &&
  left.status === right.status &&
  (left.owner ?? null) === right.owner &&
  (left.note ?? null) === right.note;

const listsEqual = (
  current: unknown,
  sanitized: ReleaseTask[],
): current is ReleaseTask[] => {
  if (!Array.isArray(current) || current.length !== sanitized.length) {
    return false;
  }
  for (let index = 0; index < sanitized.length; index++) {
    if (!taskEquals(current[index] as ReleaseTask, sanitized[index])) {
      return false;
    }
  }
  return true;
};

const toOptionalString = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toStatus = (value: unknown): ReleaseTaskStatus | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return statusSet.has(normalized as ReleaseTaskStatus)
    ? normalized as ReleaseTaskStatus
    : null;
};

const toLabel = (id: string, label: unknown): string => {
  if (typeof label === "string") {
    const trimmed = label.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return id
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeTask = (value: unknown): ReleaseTask | null => {
  if (typeof value !== "object" || value === null) return null;
  const input = value as {
    id?: unknown;
    label?: unknown;
    required?: unknown;
    status?: unknown;
    owner?: unknown;
    note?: unknown;
  };
  const rawId = typeof input.id === "string" ? input.id.trim() : "";
  if (rawId.length === 0) return null;
  const id = rawId;
  const label = toLabel(id, input.label);
  const required = typeof input.required === "boolean" ? input.required : true;
  const status = toStatus(input.status) ?? "pending";
  const owner = toOptionalString(input.owner);
  const note = toOptionalString(input.note);
  return { id, label, required, status, owner, note };
};

const compareTasks = (left: ReleaseTask, right: ReleaseTask): number => {
  if (left.required !== right.required) {
    return left.required ? -1 : 1;
  }
  const byLabel = left.label.localeCompare(right.label);
  if (byLabel !== 0) return byLabel;
  return left.id.localeCompare(right.id);
};

const sanitizeTaskList = (value: unknown): ReleaseTask[] => {
  if (!Array.isArray(value)) {
    return cloneTasks(defaultTasks);
  }
  const seen = new Set<string>();
  const sanitized: ReleaseTask[] = [];
  for (const entry of value) {
    const task = sanitizeTask(entry);
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

const ensureTaskList = (source: Cell<ReleaseTask[]>): ReleaseTask[] => {
  const current = source.get();
  const sanitized = sanitizeTaskList(current);
  if (!listsEqual(current, sanitized)) {
    source.set(sanitized);
    return sanitized;
  }
  return Array.isArray(current) ? current : sanitized;
};

const analyzeTasks = (tasks: ReleaseTask[]): ReleaseChecklistStats => {
  const blocked: string[] = [];
  const pendingRequired: string[] = [];
  let requiredTotal = 0;
  let completedRequired = 0;
  let completedTotal = 0;

  for (const task of tasks) {
    if (task.status === "blocked") {
      blocked.push(task.label);
    }
    if (task.status === "done") {
      completedTotal++;
    }
    if (task.required) {
      requiredTotal++;
      if (task.status === "done") {
        completedRequired++;
      } else {
        pendingRequired.push(task.label);
      }
    }
  }

  const ready = blocked.length === 0 && pendingRequired.length === 0;

  return {
    total: tasks.length,
    requiredTotal,
    completedRequired,
    completedTotal,
    blocked,
    pendingRequired,
    ready,
  };
};

const describeGating = (stats: ReleaseChecklistStats): string => {
  if (stats.ready) {
    return "All checks complete";
  }
  const segments: string[] = [];
  if (stats.blocked.length > 0) {
    segments.push(`Blocked: ${stats.blocked.join(", ")}`);
  }
  if (stats.pendingRequired.length > 0) {
    segments.push(`Pending: ${stats.pendingRequired.join(", ")}`);
  }
  return segments.join(" | ") || "Pending";
};

const updateTaskProgress = handler(
  (
    event: TaskProgressEvent | undefined,
    context: { tasks: Cell<ReleaseTask[]> },
  ) => {
    const id = typeof event?.id === "string" ? event.id.trim() : "";
    if (id.length === 0) return;

    const tasks = ensureTaskList(context.tasks);
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return;

    const status = toStatus(event?.status) ?? undefined;
    const ownerValue = event?.owner;
    const noteValue = event?.note;
    const owner = ownerValue === undefined
      ? undefined
      : toOptionalString(ownerValue);
    const note = noteValue === undefined
      ? undefined
      : toOptionalString(noteValue);

    const next = tasks.slice();
    const current = next[index];
    next[index] = {
      id: current.id,
      label: current.label,
      required: current.required,
      status: status ?? current.status,
      owner: owner === undefined ? current.owner : owner,
      note: note === undefined ? current.note : note,
    };

    context.tasks.set(next);
  },
);

// Module-scope lift definitions
const liftSanitizeTaskList = lift(sanitizeTaskList);
const liftAnalyzeTasks = lift(analyzeTasks);
const liftReadyFlag = lift((info: ReleaseChecklistStats) => info.ready);
const liftStatus = lift((info: ReleaseChecklistStats) => {
  if (info.ready) return "ready";
  if (info.blocked.length > 0) return "blocked";
  return "pending";
});
const liftStatusCaps = lift((value: string) => value.toUpperCase());
const liftRequiredTotal = lift((info: ReleaseChecklistStats) =>
  info.requiredTotal
);
const liftCompletedRequired = lift((info: ReleaseChecklistStats) =>
  info.completedRequired
);
const liftCompletedTotal = lift((info: ReleaseChecklistStats) =>
  info.completedTotal
);
const liftTotalTasks = lift((info: ReleaseChecklistStats) => info.total);
const liftBlockedCount = lift((info: ReleaseChecklistStats) =>
  info.blocked.length
);
const liftRemainingRequired = lift((info: ReleaseChecklistStats) =>
  info.pendingRequired
);
const liftBlockedTasks = lift((info: ReleaseChecklistStats) => info.blocked);
const liftDescribeGating = lift(describeGating);

export const releaseChecklist = pattern<ReleaseChecklistArgs>(
  ({ tasks }) => {
    const sanitizedTasks = liftSanitizeTaskList(tasks);
    const stats = liftAnalyzeTasks(sanitizedTasks);
    const readyFlag = liftReadyFlag(stats);
    const status = liftStatus(stats);
    const statusCaps = liftStatusCaps(status);
    const requiredTotal = liftRequiredTotal(stats);
    const completedRequired = liftCompletedRequired(stats);
    const completedTotal = liftCompletedTotal(stats);
    const totalTasks = liftTotalTasks(stats);
    const blockedCount = liftBlockedCount(stats);
    const remainingRequired = liftRemainingRequired(stats);
    const blockedTasks = liftBlockedTasks(stats);
    const gatingNote = liftDescribeGating(stats);

    const summary =
      str`${completedRequired}/${requiredTotal} required complete`;
    const headline =
      str`${statusCaps} • ${completedTotal}/${totalTasks} tasks done`;

    return {
      tasks: sanitizedTasks,
      ready: readyFlag,
      status,
      headline,
      summary,
      gatingNote,
      requiredTotal,
      completedRequired,
      completedTotal,
      blockedCount,
      remainingRequired,
      blocked: blockedTasks,
      updateTask: updateTaskProgress({ tasks }),
    };
  },
);

export type { ReleaseTask };

export default releaseChecklist;
