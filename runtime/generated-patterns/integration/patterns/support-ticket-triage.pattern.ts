import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type Priority = "low" | "medium" | "high" | "urgent";

interface TicketInput {
  id?: string;
  subject?: string;
  queue?: string;
  priority?: string;
  hoursRemaining?: number;
  assignedTo?: string | null;
}

interface TicketRecord {
  id: string;
  subject: string;
  queue: string;
  priority: Priority;
  hoursRemaining: number;
  assignedTo: string | null;
}

interface QueueSummary {
  queue: string;
  label: string;
  openCount: number;
  assignedCount: number;
  unassignedCount: number;
  criticalCount: number;
  countdowns: number[];
  nearestHours: number;
}

interface SupportTicketArgs {
  tickets: Default<TicketInput[], typeof defaultTickets>;
}

interface TriageEvent {
  id?: string;
  action?: "assign" | "escalate";
  assignee?: string | null;
  priority?: string;
  reduceBy?: number;
  escalate?: boolean;
}

const priorityOrder: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const priorityTargets: Record<Priority, number> = {
  urgent: 2,
  high: 4,
  medium: 12,
  low: 24,
};

const defaultTickets: TicketRecord[] = [
  {
    id: "billing-portal-login",
    subject: "Portal login fails",
    queue: "billing",
    priority: "medium",
    hoursRemaining: 12,
    assignedTo: "Jordan Lee",
  },
  {
    id: "billing-refund-delay",
    subject: "Refund delayed",
    queue: "billing",
    priority: "low",
    hoursRemaining: 24,
    assignedTo: null,
  },
  {
    id: "tech-sync-failure",
    subject: "Background sync failure",
    queue: "technical",
    priority: "high",
    hoursRemaining: 4,
    assignedTo: "Taylor Fox",
  },
  {
    id: "tech-mobile-crash",
    subject: "Mobile app crash on load",
    queue: "technical",
    priority: "medium",
    hoursRemaining: 10,
    assignedTo: null,
  },
];

const criticalRank = priorityOrder["high"];

const triageTicket = handler(
  (
    event: TriageEvent | undefined,
    context: {
      store: Cell<TicketRecord[]>;
      baseTickets: Cell<TicketRecord[]>;
      history: Cell<string[]>;
      escalations: Cell<number>;
    },
  ) => {
    const ticketId = normalizeLookupId(event?.id);
    if (!ticketId) return;

    const storedRecords = context.store.get();
    const baseRecords = context.baseTickets.get();
    const current = Array.isArray(storedRecords) && storedRecords.length > 0
      ? storedRecords.map(cloneTicket)
      : Array.isArray(baseRecords)
      ? baseRecords.map(cloneTicket)
      : [];
    if (current.length === 0) return;

    const index = current.findIndex((entry) => entry.id === ticketId);
    if (index === -1) return;

    const ticket = cloneTicket(current[index]);
    const queueLabel = formatQueueLabel(ticket.queue);
    const messages: string[] = [];
    let didChange = false;

    const hasAssignee = event !== undefined && "assignee" in event;
    const shouldAssign = event?.action === "assign" || hasAssignee;

    if (shouldAssign) {
      const assignee = normalizeAssignee(event?.assignee, ticket.assignedTo);
      if (assignee !== ticket.assignedTo) {
        ticket.assignedTo = assignee;
        didChange = true;
        if (assignee) {
          messages.push(
            `Assigned ${assignee} to ${queueLabel} ticket ${ticket.id}`,
          );
        } else {
          messages.push(
            `Unassigned ${queueLabel} ticket ${ticket.id}`,
          );
        }
      }
    }

    const shouldEscalate = event?.action === "escalate" ||
      event?.escalate === true;
    if (shouldEscalate) {
      const eventPriority = resolvePriority(event?.priority);
      const desiredPriority = selectDesiredPriority(
        ticket.priority,
        eventPriority,
      );
      if (desiredPriority !== ticket.priority) {
        ticket.priority = desiredPriority;
        const baseHours = Math.max(1, Math.round(ticket.hoursRemaining));
        const target = priorityTargets[desiredPriority];
        const reduceBy = typeof event?.reduceBy === "number"
          ? Math.max(0, Math.round(event.reduceBy))
          : 0;
        const limited = Math.min(baseHours, target);
        const updated = Math.max(1, limited - reduceBy);
        ticket.hoursRemaining = updated;
        didChange = true;
        const priorityLabel = formatPriorityLabel(desiredPriority);
        const messageParts = [
          "Escalated",
          `${queueLabel} ticket ${ticket.id}`,
          `to ${priorityLabel} (${updated}h SLA)`,
        ];
        messages.push(messageParts.join(" "));
        const currentEscalations = context.escalations.get();
        const nextEscalations = typeof currentEscalations === "number"
          ? currentEscalations + 1
          : 1;
        context.escalations.set(nextEscalations);
      }
    }

    if (!didChange) return;

    current[index] = ticket;
    current.sort(sortTickets);
    context.store.set(current.map(cloneTicket));

    if (messages.length > 0) {
      const history = context.history.get();
      const nextHistory = Array.isArray(history)
        ? [...history, ...messages]
        : [...messages];
      context.history.set(nextHistory);
    }
  },
);

// Module-scope lift definitions
const liftSanitizeTickets = lift(sanitizeTickets);

const liftNormalizedTickets = lift((input: {
  stored: TicketRecord[];
  base: TicketRecord[];
}) => {
  const stored = Array.isArray(input.stored) ? input.stored : [];
  if (stored.length > 0) {
    const cloned = stored.map(cloneTicket);
    cloned.sort(sortTickets);
    return cloned;
  }
  const base = Array.isArray(input.base) ? input.base : [];
  const cloned = base.map(cloneTicket);
  cloned.sort(sortTickets);
  return cloned;
});

const liftTicketsView = lift((entries: TicketRecord[]) =>
  entries.map(cloneTicket)
);

const liftBuildQueueSummaries = lift(buildQueueSummaries);

const liftQueueSummariesView = lift((summaries: QueueSummary[]) =>
  summaries.map((summary) => ({
    ...summary,
    countdowns: [...summary.countdowns],
  }))
);

const liftQueueAlerts = lift((summaries: QueueSummary[]) => {
  return summaries.map((summary) => {
    const base = `${summary.label}: ${summary.nearestHours}h SLA`;
    if (summary.criticalCount > 0) {
      return `${base} (${summary.criticalCount} critical)`;
    }
    return `${base} (stable)`;
  });
});

const liftQueueAlertsView = lift((alerts: string[]) => [...alerts]);

const liftTotalOpen = lift((summaries: QueueSummary[]) =>
  summaries.reduce((sum, summary) => sum + summary.openCount, 0)
);

const liftTotalUnassigned = lift((summaries: QueueSummary[]) =>
  summaries.reduce((sum, summary) => sum + summary.unassignedCount, 0)
);

const liftSummaryLabel = lift((summaries: QueueSummary[]) => {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return "No open tickets";
  }
  const segments = summaries.map((summary) => {
    const base = `${summary.label} next SLA ${summary.nearestHours}h`;
    if (summary.criticalCount > 0) {
      return `${base} (${summary.criticalCount} critical)`;
    }
    return `${base} (stable)`;
  });
  return segments.join(" | ");
});

const liftEscalationCount = lift((value: number | undefined) =>
  typeof value === "number" && value > 0 ? value : 0
);

const liftHistoryView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? [...entries] : []
);

export const supportTicketTriagePattern = pattern<SupportTicketArgs>(
  ({ tickets }) => {
    const sanitizedTickets = liftSanitizeTickets(tickets);

    const ticketStore = cell<TicketRecord[]>([]);
    const history = cell<string[]>([]);
    const escalations = cell(0);

    const normalizedTickets = liftNormalizedTickets({
      stored: ticketStore,
      base: sanitizedTickets,
    });

    const ticketsView = liftTicketsView(normalizedTickets);

    const queueSummaries = liftBuildQueueSummaries(normalizedTickets);
    const queueSummariesView = liftQueueSummariesView(queueSummaries);

    const queueAlerts = liftQueueAlerts(queueSummaries);

    const queueAlertsView = liftQueueAlertsView(queueAlerts);

    const totalOpen = liftTotalOpen(queueSummaries);

    const totalUnassigned = liftTotalUnassigned(queueSummaries);

    const summaryLabel = liftSummaryLabel(queueSummaries);

    const escalationCount = liftEscalationCount(escalations);

    const escalationSummary = str`Escalations applied: ${escalationCount}`;
    const backlogSummary =
      str`${totalOpen} open / ${totalUnassigned} unassigned`;

    const historyView = liftHistoryView(history);

    const controls = {
      triage: triageTicket({
        store: ticketStore,
        baseTickets: sanitizedTickets,
        history,
        escalations,
      }),
    };

    return {
      tickets: ticketsView,
      queueSummaries: queueSummariesView,
      queueAlerts: queueAlertsView,
      summaryLabel,
      backlogSummary,
      escalationSummary,
      escalationCount,
      history: historyView,
      controls,
    };
  },
);

function sanitizeTickets(value: unknown): TicketRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultTickets.map(cloneTicket);
  }
  const inputs = value as (TicketInput | undefined)[];
  const used = new Set<string>();
  const sanitized: TicketRecord[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const fallback = defaultTickets[index % defaultTickets.length];
    sanitized.push(sanitizeTicketEntry(inputs[index], fallback, used));
  }
  if (sanitized.length === 0) {
    return defaultTickets.map(cloneTicket);
  }
  sanitized.sort(sortTickets);
  return sanitized;
}

function sanitizeTicketEntry(
  entry: TicketInput | undefined,
  fallback: TicketRecord,
  used: Set<string>,
): TicketRecord {
  const subject = normalizeSubject(entry?.subject, fallback.subject);
  const queue = normalizeQueue(entry?.queue, fallback.queue);
  const priority = normalizePriority(entry?.priority, fallback.priority);
  const idSource = typeof entry?.id === "string" && entry.id.trim().length > 0
    ? entry.id
    : `${queue}-${subject}`;
  const baseId = slugify(idSource);
  const candidateId = baseId.length > 0
    ? baseId
    : slugify(`${queue}-${fallback.id}`);
  const id = ensureUnique(candidateId, used);
  const assignedTo = normalizeAssignee(entry?.assignedTo, fallback.assignedTo);
  const hoursRemaining = normalizeHours(
    entry?.hoursRemaining,
    fallback.hoursRemaining,
    priority,
  );
  return {
    id,
    subject,
    queue,
    priority,
    hoursRemaining,
    assignedTo,
  };
}

function buildQueueSummaries(records: TicketRecord[]): QueueSummary[] {
  const bucketMap = new Map<string, QueueSummary>();
  for (const record of records) {
    const key = record.queue;
    const bucket = bucketMap.get(key) ?? {
      queue: key,
      label: formatQueueLabel(key),
      openCount: 0,
      assignedCount: 0,
      unassignedCount: 0,
      criticalCount: 0,
      countdowns: [],
      nearestHours: 0,
    };
    bucket.openCount += 1;
    if (record.assignedTo && record.assignedTo.length > 0) {
      bucket.assignedCount += 1;
    }
    const hours = Math.max(1, Math.round(record.hoursRemaining));
    bucket.countdowns.push(hours);
    if (priorityOrder[record.priority] <= criticalRank) {
      bucket.criticalCount += 1;
    }
    bucketMap.set(key, bucket);
  }
  const summaries: QueueSummary[] = [];
  for (const bucket of bucketMap.values()) {
    bucket.countdowns.sort((left, right) => left - right);
    bucket.nearestHours = bucket.countdowns[0] ?? 0;
    bucket.unassignedCount = bucket.openCount - bucket.assignedCount;
    summaries.push({
      ...bucket,
      countdowns: [...bucket.countdowns],
    });
  }
  summaries.sort((left, right) => left.queue.localeCompare(right.queue));
  return summaries;
}

function sortTickets(left: TicketRecord, right: TicketRecord): number {
  const queueDiff = left.queue.localeCompare(right.queue);
  if (queueDiff !== 0) return queueDiff;
  const priorityDiff = priorityOrder[left.priority] -
    priorityOrder[right.priority];
  if (priorityDiff !== 0) return priorityDiff;
  const hourDiff = left.hoursRemaining - right.hoursRemaining;
  if (hourDiff !== 0) return hourDiff;
  return left.id.localeCompare(right.id);
}

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return {
    id: ticket.id,
    subject: ticket.subject,
    queue: ticket.queue,
    priority: ticket.priority,
    hoursRemaining: ticket.hoursRemaining,
    assignedTo: ticket.assignedTo ?? null,
  };
}

function normalizeSubject(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
}

function normalizeQueue(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      return trimmed.replace(/[^a-z0-9-]+/g, "-");
    }
  }
  return fallback;
}

function normalizePriority(value: unknown, fallback: Priority): Priority {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (isPriority(lowered)) {
      return lowered;
    }
  }
  return fallback;
}

function normalizeAssignee(
  value: unknown,
  fallback: string | null,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
    return null;
  }
  if (value === null) return null;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
}

function normalizeHours(
  value: unknown,
  fallback: number,
  priority: Priority,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return Math.max(1, Math.round(fallback));
  }
  return priorityTargets[priority];
}

function normalizeLookupId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function ensureUnique(value: string, used: Set<string>): string {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPriority(value: string): value is Priority {
  return value === "low" || value === "medium" || value === "high" ||
    value === "urgent";
}

function resolvePriority(value: string | undefined): Priority | null {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (isPriority(lowered)) return lowered;
  }
  return null;
}

function selectDesiredPriority(
  current: Priority,
  desired: Priority | null,
): Priority {
  if (desired && priorityOrder[desired] < priorityOrder[current]) {
    return desired;
  }
  return escalatePriority(current);
}

function escalatePriority(priority: Priority): Priority {
  switch (priority) {
    case "low":
      return "medium";
    case "medium":
      return "high";
    case "high":
      return "urgent";
    default:
      return "urgent";
  }
}

function formatQueueLabel(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPriorityLabel(priority: Priority): string {
  return priority[0].toUpperCase() + priority.slice(1);
}

export default supportTicketTriagePattern;
