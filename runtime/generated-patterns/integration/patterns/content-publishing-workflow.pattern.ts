import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

type DraftPriority = "high" | "medium" | "low";

type DraftStage =
  | "ideation"
  | "drafting"
  | "review"
  | "ready"
  | "scheduled"
  | "published";

interface DraftSeed {
  id?: string;
  title?: string;
  summary?: string;
  priority?: string;
  stage?: string;
  scheduledDate?: string;
  assignedEditor?: string;
}

interface DraftEntry extends DraftSeed {
  id: string;
  title: string;
  summary: string;
  priority: DraftPriority;
  stage: DraftStage;
  scheduledDate: string;
  assignedEditor: string;
}

interface ContentPublishingWorkflowArgs {
  drafts: Default<DraftSeed[], typeof defaultDrafts>;
}

interface AddDraftEvent {
  id?: string;
  title?: string;
  summary?: string;
  priority?: string;
  stage?: string;
  scheduledDate?: string;
  assignedEditor?: string;
}

interface AdvanceStageEvent {
  id?: string;
  stage?: string;
}

interface UpdateScheduleEvent {
  id?: string;
  scheduledDate?: string;
}

interface UpdatePriorityEvent {
  id?: string;
  priority?: string;
}

const defaultDrafts: DraftEntry[] = [
  {
    id: "draft-launch-announcement",
    title: "Launch Announcement",
    summary: "Feature launch hero article.",
    priority: "high",
    stage: "review",
    scheduledDate: "2024-07-02",
    assignedEditor: "Noah",
  },
  {
    id: "draft-customer-story",
    title: "Finch Story",
    summary: "Spotlight on Finch pilot results.",
    priority: "medium",
    stage: "ready",
    scheduledDate: "2024-07-04",
    assignedEditor: "Ravi",
  },
  {
    id: "draft-quarterly-recap",
    title: "Quarterly Recap",
    summary: "Q2 product summary newsletter.",
    priority: "medium",
    stage: "drafting",
    scheduledDate: "2024-07-06",
    assignedEditor: "Amelia",
  },
];

const stageOrder: readonly DraftStage[] = [
  "ideation",
  "drafting",
  "review",
  "ready",
  "scheduled",
  "published",
];

const priorityRank: Record<DraftPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const stageRank: Record<DraftStage, number> = {
  ideation: 0,
  drafting: 1,
  review: 2,
  ready: 3,
  scheduled: 4,
  published: 5,
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length > 0) return normalized;
  }
  return fallback;
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  const base = sanitizeText(value, fallback);
  if (base.length === 0) return fallback;
  return base[0].toUpperCase() + base.slice(1);
};

const sanitizeSummary = (value: unknown, fallback: string): string => {
  return sanitizeText(value, fallback);
};

const sanitizeEditor = (value: unknown, fallback: string): string => {
  const base = sanitizeText(value, fallback);
  return base.length === 0 ? fallback : base;
};

const sanitizePriority = (
  value: unknown,
  fallback: DraftPriority,
): DraftPriority => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "high" || lower === "medium" || lower === "low") {
      return lower as DraftPriority;
    }
  }
  return fallback;
};

const sanitizeStage = (
  value: unknown,
  fallback: DraftStage,
): DraftStage => {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (stageOrder.includes(lower as DraftStage)) {
      return lower as DraftStage;
    }
  }
  return fallback;
};

const sanitizeDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\//g, "-");
    if (datePattern.test(trimmed)) {
      return trimmed;
    }
  }
  if (datePattern.test(fallback)) {
    return fallback;
  }
  return "2024-07-31";
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let id = `${candidate}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${candidate}-${index}`;
  }
  used.add(id);
  return id;
};

const sanitizeDraft = (
  seed: DraftSeed | undefined,
  fallback: DraftSeed,
  index: number,
  used: Set<string>,
): DraftEntry => {
  const fallbackId = typeof fallback.id === "string" && fallback.id.length > 0
    ? fallback.id
    : `draft-${index + 1}`;
  const id = ensureUniqueId(
    sanitizeIdentifier(seed?.id, fallbackId),
    used,
  );
  const fallbackTitle = typeof fallback.title === "string" &&
      fallback.title.length > 0
    ? fallback.title
    : `Draft ${index + 1}`;
  const title = sanitizeTitle(seed?.title, fallbackTitle);
  const summary = sanitizeSummary(
    seed?.summary,
    typeof fallback.summary === "string"
      ? fallback.summary
      : "Workflow draft placeholder.",
  );
  const fallbackPriority = sanitizePriority(
    fallback.priority,
    "medium",
  );
  const priority = sanitizePriority(seed?.priority, fallbackPriority);
  const fallbackStage = sanitizeStage(fallback.stage, "drafting");
  const stage = sanitizeStage(seed?.stage, fallbackStage);
  const fallbackDate = sanitizeDate(
    fallback.scheduledDate,
    `2024-07-${String(index + 1).padStart(2, "0")}`,
  );
  const scheduledDate = sanitizeDate(seed?.scheduledDate, fallbackDate);
  const assignedEditor = sanitizeEditor(
    seed?.assignedEditor,
    sanitizeEditor(fallback.assignedEditor, "Unassigned"),
  );
  return {
    id,
    title,
    summary,
    priority,
    stage,
    scheduledDate,
    assignedEditor,
  };
};

const sanitizeDraftList = (
  value: readonly DraftSeed[] | undefined,
): DraftEntry[] => {
  const seeds = Array.isArray(value) && value.length > 0
    ? value
    : defaultDrafts;
  const used = new Set<string>();
  const drafts: DraftEntry[] = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const fallback = defaultDrafts[index % defaultDrafts.length];
    drafts.push(sanitizeDraft(seeds[index], fallback, index, used));
  }
  return drafts;
};

const compareSchedule = (a: string, b: string): number => {
  if (a === b) return 0;
  const [aYear, aMonth, aDay] = a.split("-").map((segment) => Number(segment));
  const [bYear, bMonth, bDay] = b.split("-").map((segment) => Number(segment));
  if (aYear !== bYear) return aYear - bYear;
  if (aMonth !== bMonth) return aMonth - bMonth;
  return aDay - bDay;
};

const buildQueue = (entries: readonly DraftEntry[]): DraftEntry[] => {
  return entries
    .filter((entry) =>
      entry.stage !== "scheduled" && entry.stage !== "published"
    )
    .map((entry) => ({ ...entry }))
    .sort((a, b) => {
      const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      const scheduleDiff = compareSchedule(a.scheduledDate, b.scheduledDate);
      if (scheduleDiff !== 0) return scheduleDiff;
      const stageDiff = stageRank[a.stage] - stageRank[b.stage];
      if (stageDiff !== 0) return stageDiff;
      return a.title.localeCompare(b.title);
    });
};

const sortDrafts = (entries: readonly DraftEntry[]): DraftEntry[] => {
  return entries.slice().sort((a, b) => {
    const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const scheduleDiff = compareSchedule(a.scheduledDate, b.scheduledDate);
    if (scheduleDiff !== 0) return scheduleDiff;
    const stageDiff = stageRank[a.stage] - stageRank[b.stage];
    if (stageDiff !== 0) return stageDiff;
    return a.title.localeCompare(b.title);
  });
};

const buildStageTotals = (
  entries: readonly DraftEntry[],
): Record<DraftStage, number> => {
  const totals: Record<DraftStage, number> = {
    ideation: 0,
    drafting: 0,
    review: 0,
    ready: 0,
    scheduled: 0,
    published: 0,
  };
  for (const entry of entries) {
    totals[entry.stage] += 1;
  }
  return totals;
};

const formatQueuePreview = (entries: readonly DraftEntry[]): string => {
  if (entries.length === 0) {
    return "No drafts awaiting scheduling";
  }
  const preview = entries.slice(0, 3).map((entry) =>
    `${entry.title} (${entry.priority} @ ${entry.scheduledDate})`
  );
  return preview.join(" | ");
};

const appendHistory = (
  history: readonly string[],
  entry: string,
): string[] => {
  const next = [...history, entry];
  return next.length > 6 ? next.slice(next.length - 6) : next;
};

const stageActionLabel = (stage: DraftStage): string => {
  switch (stage) {
    case "ideation":
      return "ideation";
    case "drafting":
      return "drafting";
    case "review":
      return "review";
    case "ready":
      return "ready for scheduling";
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
  }
};

const suggestSchedule = (sequence: number): string => {
  const day = ((sequence - 1) % 27) + 1;
  return `2024-07-${day.toString().padStart(2, "0")}`;
};

type WorkflowContext = {
  drafts: Cell<DraftSeed[]>;
  draftsView: Cell<DraftEntry[]>;
  sequence: Cell<number>;
  activityLog: Cell<string[]>;
};

const getSanitizedDrafts = (context: WorkflowContext): DraftEntry[] => {
  return sanitizeDraftList(context.drafts.get());
};

const liftCountEntries = (entries: readonly DraftEntry[]): number =>
  entries.length;

const liftCountScheduled = (entries: readonly DraftEntry[]): number =>
  entries.filter((entry) => entry.stage === "scheduled").length;

const liftExtractNextDraft = (
  entries: readonly DraftEntry[],
): DraftEntry | null => (entries.length > 0 ? entries[0] : null);

const liftBuildPriorityScheduleOrder = (
  entries: readonly DraftEntry[],
): {
  id: string;
  title: string;
  priority: DraftPriority;
  scheduledDate: string;
}[] =>
  sortDrafts(entries).map((entry) => ({
    id: entry.id,
    title: entry.title,
    priority: entry.priority,
    scheduledDate: entry.scheduledDate,
  }));

const addDraft = handler(
  (event: AddDraftEvent | undefined, ctx: WorkflowContext) => {
    const current = getSanitizedDrafts(ctx);
    const used = new Set(current.map((draft) => draft.id));
    const nextIndex = Math.max(ctx.sequence.get() ?? 0, current.length) + 1;
    ctx.sequence.set(nextIndex);
    const fallback = defaultDrafts[(nextIndex - 1) % defaultDrafts.length];
    const id = ensureUniqueId(
      sanitizeIdentifier(event?.id, `draft-${nextIndex}`),
      used,
    );
    const title = sanitizeTitle(
      event?.title,
      fallback.title ?? `Draft ${nextIndex}`,
    );
    const summary = sanitizeSummary(
      event?.summary,
      fallback.summary ?? "Workflow intake submission.",
    );
    const priority = sanitizePriority(
      event?.priority,
      fallback.priority ?? "medium",
    );
    const stage = sanitizeStage(event?.stage, "drafting");
    const scheduledDate = sanitizeDate(
      event?.scheduledDate,
      fallback.scheduledDate ?? suggestSchedule(nextIndex),
    );
    const assignedEditor = sanitizeEditor(
      event?.assignedEditor,
      fallback.assignedEditor ?? "Unassigned",
    );
    const entry: DraftEntry = {
      id,
      title,
      summary,
      priority,
      stage,
      scheduledDate,
      assignedEditor,
    };
    ctx.drafts.set(sortDrafts([...current, entry]));
    const message =
      `${title} queued as ${priority} priority due ${scheduledDate}`;
    ctx.activityLog.set(appendHistory(ctx.activityLog.get(), message));
  },
);

const rescheduleDraft = handler(
  (event: UpdateScheduleEvent | undefined, ctx: WorkflowContext) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedDrafts(ctx);
    const index = current.findIndex((draft) => draft.id === id);
    if (index === -1) return;
    const draft = current[index];
    const scheduledDate = sanitizeDate(
      event?.scheduledDate,
      draft.scheduledDate,
    );
    if (scheduledDate === draft.scheduledDate) return;
    const next = current.slice();
    next[index] = { ...draft, scheduledDate };
    ctx.drafts.set(sortDrafts(next));
    const message = `${draft.title} rescheduled for ${scheduledDate}`;
    ctx.activityLog.set(appendHistory(ctx.activityLog.get(), message));
  },
);

const reprioritizeDraft = handler(
  (event: UpdatePriorityEvent | undefined, ctx: WorkflowContext) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedDrafts(ctx);
    const index = current.findIndex((draft) => draft.id === id);
    if (index === -1) return;
    const priority = sanitizePriority(
      event?.priority,
      current[index].priority,
    );
    if (priority === current[index].priority) return;
    const next = current.slice();
    next[index] = { ...current[index], priority };
    ctx.drafts.set(sortDrafts(next));
    const message = `${next[index].title} reprioritized to ${priority}`;
    ctx.activityLog.set(appendHistory(ctx.activityLog.get(), message));
  },
);

const advanceStage = handler(
  (event: AdvanceStageEvent | undefined, ctx: WorkflowContext) => {
    const id = sanitizeIdentifier(event?.id, "");
    if (id.length === 0) return;
    const current = getSanitizedDrafts(ctx);
    const index = current.findIndex((draft) => draft.id === id);
    if (index === -1) return;
    const draft = current[index];
    const requested = sanitizeStage(event?.stage, draft.stage);
    const nextStage = requested !== draft.stage
      ? requested
      : stageOrder[stageRank[draft.stage] + 1] ?? draft.stage;
    if (nextStage === draft.stage) return;
    const next = current.slice();
    next[index] = { ...draft, stage: nextStage };
    ctx.drafts.set(sortDrafts(next));
    const message = `${draft.title} moved to ${stageActionLabel(nextStage)}`;
    ctx.activityLog.set(appendHistory(ctx.activityLog.get(), message));
  },
);

export const contentPublishingWorkflow = pattern<ContentPublishingWorkflowArgs>(
  ({ drafts }) => {
    const sequence = cell(0);
    const activityLog = cell<string[]>(["Workflow initialized"]);

    const draftsView = computed(() => sanitizeDraftList(drafts));
    const queue = computed(() => buildQueue(draftsView));
    const queueCount = computed(() => liftCountEntries(queue));
    const scheduledCount = computed(() => liftCountScheduled(draftsView));
    const statusLine =
      str`${queueCount} drafts awaiting, ${scheduledCount} scheduled`;
    const queuePreview = computed(() => formatQueuePreview(queue));
    const nextDraft = computed(() => liftExtractNextDraft(queue));
    const stageTotals = computed(() => buildStageTotals(draftsView));
    const priorityScheduleOrder = computed(() =>
      liftBuildPriorityScheduleOrder(draftsView)
    );

    const context = {
      drafts,
      draftsView,
      sequence,
      activityLog,
    } as const;

    return {
      drafts,
      queue,
      nextDraft,
      stageTotals,
      statusLine,
      queuePreview,
      activityLog,
      priorityScheduleOrder,
      addDraft: addDraft(context as never),
      rescheduleDraft: rescheduleDraft(context as never),
      reprioritizeDraft: reprioritizeDraft(context as never),
      advanceStage: advanceStage(context as never),
    };
  },
);

export default contentPublishingWorkflow;
