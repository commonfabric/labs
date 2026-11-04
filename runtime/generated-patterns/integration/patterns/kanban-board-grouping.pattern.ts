import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const columnOrder = [
  "backlog",
  "inProgress",
  "review",
  "done",
] as const;

type ColumnKey = (typeof columnOrder)[number];

interface KanbanTaskInput {
  id?: string;
  title?: string;
  column?: string;
  points?: number;
}

interface KanbanTask extends KanbanTaskInput {
  id: string;
  title: string;
  column: ColumnKey;
  points: number;
}

interface KanbanBoardArgs {
  tasks: Default<KanbanTaskInput[], typeof defaultTasks>;
  wipLimits: Default<Record<ColumnKey, number>, typeof defaultWipLimits>;
}

interface MoveTaskEvent {
  id?: string;
  taskId?: string;
  to?: string;
  column?: string;
}

interface LimitUpdateEvent {
  column?: string;
  limit?: number;
  value?: number;
}

interface ColumnSummary {
  key: ColumnKey;
  title: string;
  limit: number;
  count: number;
  overloaded: boolean;
  items: KanbanTask[];
}

interface MoveRecord {
  taskId: string;
  from: ColumnKey;
  to: ColumnKey;
}

const defaultTasks: KanbanTask[] = [
  {
    id: "task-plan-roadmap",
    title: "Plan roadmap",
    column: "backlog",
    points: 3,
  },
  {
    id: "task-sketch-wireframes",
    title: "Sketch wireframes",
    column: "inProgress",
    points: 5,
  },
  {
    id: "task-review-copy",
    title: "Review copy",
    column: "review",
    points: 2,
  },
  {
    id: "task-release-update",
    title: "Release update",
    column: "done",
    points: 1,
  },
  {
    id: "task-write-tests",
    title: "Write tests",
    column: "inProgress",
    points: 3,
  },
];

const defaultWipLimits: Record<ColumnKey, number> = {
  backlog: 4,
  inProgress: 2,
  review: 2,
  done: 6,
};

const columnTitles: Record<ColumnKey, string> = {
  backlog: "Backlog",
  inProgress: "In Progress",
  review: "Review",
  done: "Done",
};

const columnSlugMap: Record<string, ColumnKey> = {
  backlog: "backlog",
  "in-progress": "inProgress",
  inprogress: "inProgress",
  review: "review",
  done: "done",
};

const slugify = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
};

const ensureUniqueId = (
  desired: string | undefined,
  fallback: string,
  used: Set<string>,
  index: number,
): string => {
  const base = slugify(desired) ?? slugify(fallback) ?? `task-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

const normalizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizePoints = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : 1;
  }
  return fallback > 0 ? Math.trunc(fallback) : 1;
};

const resolveColumn = (value: unknown): ColumnKey | null => {
  const slug = slugify(value);
  if (!slug) return null;
  return columnSlugMap[slug] ?? null;
};

const normalizeColumn = (
  value: unknown,
  fallback: ColumnKey,
): ColumnKey => resolveColumn(value) ?? fallback;

const normalizeLimit = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : 0;
  }
  return fallback >= 0 ? Math.trunc(fallback) : 0;
};

const sanitizeTaskList = (value: unknown): KanbanTask[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultTasks;
  const sanitized: KanbanTask[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = source[index] as KanbanTaskInput | undefined;
    const fallback = defaultTasks[index % defaultTasks.length];
    const id = ensureUniqueId(raw?.id, fallback.id, used, index);
    used.add(id);
    const title = normalizeTitle(raw?.title, fallback.title);
    const column = normalizeColumn(raw?.column, fallback.column);
    const points = normalizePoints(raw?.points, fallback.points);
    sanitized.push({ id, title, column, points });
  }
  return sanitized;
};

const sanitizeWipLimits = (
  value: unknown,
  fallback: Record<ColumnKey, number>,
): Record<ColumnKey, number> => {
  const sanitized: Record<ColumnKey, number> = { ...fallback };
  if (!value || typeof value !== "object") {
    return sanitized;
  }
  const raw = value as Record<string, unknown>;
  for (const column of columnOrder) {
    const slugKey = column === "inProgress" ? "in-progress" : column;
    const candidate = raw[column] ?? raw[slugKey];
    sanitized[column] = normalizeLimit(candidate, fallback[column]);
  }
  return sanitized;
};

const buildColumnSummaries = (
  input: {
    tasks: KanbanTask[];
    limits: Record<ColumnKey, number>;
  },
): ColumnSummary[] => {
  const groups: Record<ColumnKey, KanbanTask[]> = {
    backlog: [],
    inProgress: [],
    review: [],
    done: [],
  };
  for (const task of input.tasks) {
    const group = groups[task.column];
    group.push(task);
  }
  return columnOrder.map((key) => {
    const items = groups[key].map((task) => ({ ...task }));
    const count = items.length;
    const limit = input.limits[key];
    return {
      key,
      title: columnTitles[key],
      limit,
      count,
      overloaded: count > limit,
      items,
    };
  });
};

const describeStatus = (summaries: ColumnSummary[]): string => {
  const overloaded = summaries.filter((summary) => summary.overloaded);
  if (overloaded.length === 0) {
    return "All columns within limits";
  }
  const segments = overloaded.map((summary) =>
    `${summary.title} ${summary.count}/${summary.limit}`
  );
  return `Over capacity: ${segments.join(", ")}`;
};

const moveTaskHandler = handler(
  (
    event: MoveTaskEvent | undefined,
    context: {
      tasks: Cell<KanbanTaskInput[]>;
      history: Cell<MoveRecord[]>;
    },
  ) => {
    const current = sanitizeTaskList(context.tasks.get());
    const identifier = slugify(event?.id ?? event?.taskId);
    if (!identifier) return;
    const nextColumn = resolveColumn(event?.to ?? event?.column);
    if (!nextColumn) return;
    const index = current.findIndex((task) => task.id === identifier);
    if (index < 0) return;
    const existing = current[index];
    if (existing.column === nextColumn) return;

    const updated = current.slice();
    updated[index] = { ...existing, column: nextColumn };
    context.tasks.set(updated);

    const history = context.history.get();
    const entries = Array.isArray(history) ? history.slice() : [];
    entries.push({
      taskId: existing.id,
      from: existing.column,
      to: nextColumn,
    });
    context.history.set(entries);
  },
);

const updateLimitHandler = handler(
  (
    event: LimitUpdateEvent | undefined,
    context: { wipLimits: Cell<Record<ColumnKey, number>> },
  ) => {
    const column = resolveColumn(event?.column);
    if (!column) return;
    const current = sanitizeWipLimits(
      context.wipLimits.get(),
      defaultWipLimits,
    );
    const desired = event?.limit ?? event?.value;
    const nextLimit = normalizeLimit(desired, current[column]);
    if (nextLimit === current[column]) return;
    const updated = { ...current, [column]: nextLimit };
    context.wipLimits.set(updated);
  },
);

// Module-scope lift definitions
const liftSanitizeTaskList = lift(sanitizeTaskList);

const liftLimitView = lift(
  (value: Record<ColumnKey, number> | undefined) =>
    sanitizeWipLimits(value, defaultWipLimits),
);

const liftLimitSnapshot = lift((limits: Record<ColumnKey, number>) => ({
  backlog: limits.backlog,
  inProgress: limits.inProgress,
  review: limits.review,
  done: limits.done,
}));

const liftColumnSummaries = lift(buildColumnSummaries);

const liftOverloadedColumns = lift((summaries: ColumnSummary[]) =>
  summaries
    .filter((summary) => summary.overloaded)
    .map((summary) => summary.key)
);

const liftDescribeStatus = lift(describeStatus);

const liftHistoryView = lift((entries: MoveRecord[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

export const kanbanBoardGrouping = pattern<KanbanBoardArgs>(
  ({ tasks, wipLimits }) => {
    const moveHistory = cell<MoveRecord[]>([]);
    const normalizedTasks = liftSanitizeTaskList(tasks);
    const limitView = liftLimitView(wipLimits);
    const limitSnapshot = liftLimitSnapshot(limitView);
    const columnSummaries = liftColumnSummaries({
      tasks: normalizedTasks,
      limits: limitView,
    });
    const overloadedColumns = liftOverloadedColumns(columnSummaries);
    const statusText = liftDescribeStatus(columnSummaries);
    const status = str`${statusText}`;
    const historyView = liftHistoryView(moveHistory);

    return {
      tasks: normalizedTasks,
      columns: columnSummaries,
      limits: limitSnapshot,
      overloadedColumns,
      status,
      history: historyView,
      moveTask: moveTaskHandler({ tasks, history: moveHistory }),
      setLimit: updateLimitHandler({ wipLimits }),
    };
  },
);

export default kanbanBoardGrouping;
