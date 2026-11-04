import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type MilestoneStatus = "planned" | "in_progress" | "completed";

interface JourneyMilestone {
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  dayOffset: number;
  durationDays: number;
}

interface JourneyTimelineEntry {
  id: string;
  title: string;
  status: MilestoneStatus;
  startDay: number;
  endDay: number;
  durationDays: number;
}

interface JourneyMapArgs {
  milestones: Default<JourneyMilestone[], typeof defaultMilestones>;
  anchorDay: Default<number, 0>;
}

interface JourneyUpdateEvent {
  id?: string;
  title?: string;
  description?: string;
  status?: MilestoneStatus | string;
  dayOffset?: number;
  durationDays?: number;
}

interface JourneyUpdateResult {
  list: JourneyMilestone[];
  updated: JourneyMilestone;
  index: number;
}

type StatusCounts = Record<MilestoneStatus, number>;

interface SummaryComputationInput {
  meta: { count: number; start: number; end: number };
  progress: number;
}

const defaultMilestones: JourneyMilestone[] = [
  {
    id: "discover",
    title: "Discovery",
    description: "User becomes aware of the product.",
    status: "completed",
    dayOffset: 0,
    durationDays: 1,
  },
  {
    id: "activate",
    title: "Activation",
    description: "User signs up and begins onboarding.",
    status: "in_progress",
    dayOffset: 1,
    durationDays: 2,
  },
  {
    id: "adopt",
    title: "Adoption",
    description: "User adopts core features into workflow.",
    status: "planned",
    dayOffset: 3,
    durationDays: 3,
  },
];

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const titleFromId = (id: string): string => {
  const normalized = id.replace(/[-_]+/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
};

const sanitizeId = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return fallback;
  const cleaned = trimmed.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return cleaned.length > 0 ? cleaned : fallback;
};

const parseStatus = (value: unknown): MilestoneStatus | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (
    normalized === "planned" || normalized === "in_progress" ||
    normalized === "completed"
  ) {
    return normalized as MilestoneStatus;
  }
  return null;
};

const sanitizeStatus = (value: unknown): MilestoneStatus => {
  return parseStatus(value) ?? "planned";
};

const sanitizeOptionalStatus = (
  value: unknown,
): MilestoneStatus | undefined => {
  return parseStatus(value) ?? undefined;
};

const sanitizeDayOffset = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rounded = Math.floor(value);
  return rounded < 0 ? 0 : rounded;
};

const sanitizeOptionalDayOffset = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return sanitizeDayOffset(value);
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const rounded = Math.max(1, Math.floor(value));
  return rounded;
};

const sanitizeOptionalDuration = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return sanitizeDuration(value);
};

const sanitizeOptionalTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeOptionalDescription = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value.trim();
};

const ensureUniqueId = (
  candidate: string,
  existing: readonly JourneyMilestone[],
): string => {
  if (!existing.some((entry) => entry.id === candidate)) {
    return candidate;
  }
  let index = 2;
  while (existing.some((entry) => entry.id === `${candidate}-${index}`)) {
    index += 1;
  }
  return `${candidate}-${index}`;
};

const sanitizeMilestone = (
  input: unknown,
  fallbackIndex: number,
): JourneyMilestone => {
  const record = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
  const fallbackId = `milestone-${fallbackIndex}`;
  const id = sanitizeId(record["id"], fallbackId);
  const title = sanitizeText(record["title"], titleFromId(id));
  const description = sanitizeText(
    record["description"],
    "Milestone description",
  );
  const status = sanitizeStatus(record["status"]);
  const dayOffset = sanitizeDayOffset(record["dayOffset"]);
  const durationDays = sanitizeDuration(record["durationDays"]);
  return { id, title, description, status, dayOffset, durationDays };
};

const sanitizeMilestoneList = (
  input: unknown,
): JourneyMilestone[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return structuredClone(defaultMilestones);
  }
  const sanitized: JourneyMilestone[] = [];
  let index = 1;
  for (const entry of input) {
    const cleaned = sanitizeMilestone(entry, index);
    const uniqueId = ensureUniqueId(cleaned.id, sanitized);
    sanitized.push(
      uniqueId === cleaned.id ? cleaned : { ...cleaned, id: uniqueId },
    );
    index += 1;
  }
  sanitized.sort((left, right) => {
    if (left.dayOffset === right.dayOffset) {
      return left.id.localeCompare(right.id);
    }
    return left.dayOffset - right.dayOffset;
  });
  return sanitized;
};

const buildTimeline = (
  entries: readonly JourneyMilestone[],
  anchorDay: number,
): JourneyTimelineEntry[] => {
  const result: JourneyTimelineEntry[] = [];
  const base = Math.max(0, Math.floor(anchorDay));
  let cursor = base;
  for (const entry of entries) {
    const plannedStart = base + entry.dayOffset;
    const start = plannedStart > cursor ? plannedStart : cursor;
    const duration = Math.max(1, entry.durationDays);
    const end = start + duration;
    result.push({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      startDay: start,
      endDay: end,
      durationDays: duration,
    });
    cursor = end;
  }
  return result;
};

const applyJourneyUpdate = (
  list: JourneyMilestone[],
  event: JourneyUpdateEvent | undefined,
): JourneyUpdateResult => {
  const entries = [...list];
  if (!event) {
    const fallback = entries[entries.length - 1] ?? entries[0] ??
      structuredClone(defaultMilestones[0]);
    return { list: entries, updated: fallback, index: entries.length - 1 };
  }
  const fallbackId = `milestone-${entries.length + 1}`;
  const candidateId = sanitizeId(event.id, fallbackId);
  let id = candidateId;
  const existingIndex = entries.findIndex((entry) => entry.id === id);
  if (existingIndex === -1) {
    id = ensureUniqueId(id, entries);
  }

  const nextStatus = sanitizeOptionalStatus(event.status);
  const nextOffset = sanitizeOptionalDayOffset(
    Object.hasOwn(event, "dayOffset") ? event.dayOffset : undefined,
  );
  const nextDuration = sanitizeOptionalDuration(
    Object.hasOwn(event, "durationDays") ? event.durationDays : undefined,
  );
  const nextTitle = sanitizeOptionalTitle(
    Object.hasOwn(event, "title") ? event.title : undefined,
  );
  const nextDescription = sanitizeOptionalDescription(
    Object.hasOwn(event, "description") ? event.description : undefined,
  );

  if (existingIndex >= 0) {
    const current = entries[existingIndex];
    const updated: JourneyMilestone = {
      ...current,
      title: nextTitle ?? current.title,
      description: nextDescription ?? current.description,
      status: nextStatus ?? current.status,
      dayOffset: nextOffset ?? current.dayOffset,
      durationDays: nextDuration ?? current.durationDays,
    };
    entries[existingIndex] = updated;
  } else {
    const previous = entries[entries.length - 1];
    const defaultOffset = previous
      ? previous.dayOffset + previous.durationDays
      : 0;
    const newEntry: JourneyMilestone = {
      id,
      title: nextTitle ?? titleFromId(id),
      description: nextDescription ?? "",
      status: nextStatus ?? "planned",
      dayOffset: nextOffset ?? defaultOffset,
      durationDays: nextDuration ?? 1,
    };
    entries.push(newEntry);
  }

  entries.sort((left, right) => {
    if (left.dayOffset === right.dayOffset) {
      return left.id.localeCompare(right.id);
    }
    return left.dayOffset - right.dayOffset;
  });

  const index = entries.findIndex((entry) => entry.id === id);
  const updated = entries[index];
  return { list: entries, updated, index };
};

const sanitizeAnchor = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

// Module-scope lift definitions
const liftSanitizeMilestoneList = lift(sanitizeMilestoneList);
const liftAnchorView = lift((value: number | undefined) =>
  sanitizeAnchor(value)
);

const liftTimeline = lift(
  (
    input: { entries: JourneyMilestone[]; anchor: number },
  ): JourneyTimelineEntry[] => {
    return buildTimeline(input.entries, input.anchor);
  },
);

const liftStatusCounts = lift(
  (entries: JourneyTimelineEntry[]): StatusCounts => {
    const counts: StatusCounts = {
      planned: 0,
      in_progress: 0,
      completed: 0,
    };
    for (const entry of entries) {
      counts[entry.status] += 1;
    }
    return counts;
  },
);

const liftProgress = lift((counts: StatusCounts) => {
  const total = counts.planned + counts.in_progress + counts.completed;
  if (total === 0) return 0;
  return Math.round((counts.completed / total) * 100);
});

const liftSummaryMeta = lift((entries: JourneyTimelineEntry[]) => {
  if (entries.length === 0) {
    return { count: 0, start: 0, end: 0 };
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  return { count: entries.length, start: first.startDay, end: last.endDay };
});

const liftSummaryLabel = lift((input: SummaryComputationInput) => {
  if (input.meta.count === 0) {
    return "No milestones scheduled";
  }
  const { count, start, end } = input.meta;
  const span = `${count} milestones from day ${start}`;
  const completion = ` (${input.progress}% complete)`;
  return `${span} to day ${end}${completion}`;
});

const liftChangeLogView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

const updateJourney = handler(
  (
    event: JourneyUpdateEvent | undefined,
    context: {
      milestones: Cell<JourneyMilestone[]>;
      changeLog: Cell<string[]>;
      sequence: Cell<number>;
      anchor: Cell<number>;
    },
  ) => {
    const current = sanitizeMilestoneList(context.milestones.get());
    const result = applyJourneyUpdate(current, event);
    context.milestones.set(result.list);

    const anchorValue = sanitizeAnchor(context.anchor.get());
    const timelineEntries = buildTimeline(result.list, anchorValue);
    const entry = timelineEntries[result.index] ?? timelineEntries[0];

    const existingLog = context.changeLog.get();
    const log = Array.isArray(existingLog) ? existingLog : [];
    const label = `${entry.title}:${entry.startDay}-${entry.endDay}:` +
      `${entry.status}`;
    context.changeLog.set([...log, label]);

    const sequenceValue = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequenceValue);
  },
);

export const userJourneyMap = pattern<JourneyMapArgs>(
  ({ milestones, anchorDay }) => {
    const changeLog = cell<string[]>([]);
    const sequence = cell<number>(0);

    const milestonesView = liftSanitizeMilestoneList(milestones);
    const anchorView = liftAnchorView(anchorDay);

    const timeline = liftTimeline({
      entries: milestonesView,
      anchor: anchorView,
    });

    const statusCounts = liftStatusCounts(timeline);

    const progress = liftProgress(statusCounts);

    const summaryMeta = liftSummaryMeta(timeline);

    const summaryLabel = liftSummaryLabel({ meta: summaryMeta, progress });

    const changeLogView = liftChangeLogView(changeLog);

    return {
      anchorDay: anchorView,
      milestones: milestonesView,
      timeline,
      statusCounts,
      progress,
      label: str`Journey timeline: ${summaryLabel}`,
      changeLog: changeLogView,
      updateMilestone: updateJourney({
        milestones,
        changeLog,
        sequence,
        anchor: anchorDay,
      }),
    };
  },
);

export default userJourneyMap;
