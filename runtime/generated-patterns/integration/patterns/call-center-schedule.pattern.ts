import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface SlotInput {
  id?: string;
  label?: string;
  requiredAgents?: number;
}

interface SlotDefinition {
  id: string;
  label: string;
  requiredAgents: number;
}

interface AgentInput {
  id?: string;
  name?: string;
}

interface AgentDefinition {
  id: string;
  name: string;
}

interface AssignmentInput {
  slot?: string;
  agent?: string;
}

interface AssignmentRecord {
  slot: string;
  agent: string;
}

interface SlotCoverage {
  slot: string;
  label: string;
  required: number;
  assigned: string[];
  assignedCount: number;
  remaining: number;
  hasGap: boolean;
}

interface ScheduleEvent {
  slot?: string;
  agent?: string;
  action?: "assign" | "unschedule";
}

interface LatestChange {
  sequence: number;
  slot: string;
  label: string;
  action: "assign" | "unschedule";
  agentId: string;
  agentName: string;
  gapCount: number;
  remaining: number;
}

interface CallCenterScheduleArgs {
  slots: Default<SlotInput[], typeof defaultSlots>;
  agents: Default<AgentInput[], typeof defaultAgents>;
  assignments: Default<AssignmentInput[], typeof defaultAssignments>;
}

const defaultSlots: SlotDefinition[] = [
  { id: "08:00-10:00", label: "Morning Block", requiredAgents: 1 },
  { id: "10:00-12:00", label: "Midday Block", requiredAgents: 1 },
  { id: "12:00-14:00", label: "Lunch Block", requiredAgents: 1 },
  { id: "14:00-16:00", label: "Afternoon Block", requiredAgents: 1 },
];

const defaultAgents: AgentDefinition[] = [
  { id: "alex-rivera", name: "Alex Rivera" },
  { id: "blair-chen", name: "Blair Chen" },
  { id: "casey-james", name: "Casey James" },
  { id: "drew-patel", name: "Drew Patel" },
];

const defaultAssignments: AssignmentRecord[] = [
  { slot: "08:00-10:00", agent: "alex-rivera" },
  { slot: "12:00-14:00", agent: "blair-chen" },
  { slot: "14:00-16:00", agent: "casey-james" },
];

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const normalizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizeSlotId = (
  value: unknown,
  fallback: string,
): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
};

const normalizeRequired = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
  return fallback;
};

const ensureUnique = (value: string, used: Set<string>): string => {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeSlots = (value: unknown): SlotDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultSlots);
  }
  const used = new Set<string>();
  const sanitized: SlotDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as SlotInput | undefined;
    const fallback = defaultSlots[index] ?? defaultSlots[0];
    const label = normalizeLabel(entry?.label, fallback.label);
    const idCandidate = entry?.id ?? label;
    const slotId = normalizeSlotId(idCandidate, fallback.id ?? label);
    if (!slotId) continue;
    const required = normalizeRequired(
      entry?.requiredAgents,
      fallback.requiredAgents,
    );
    const uniqueId = ensureUnique(slotId, used);
    sanitized.push({ id: uniqueId, label, requiredAgents: required });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultSlots);
  }
  return sanitized;
};

const normalizeAgentName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeAgents = (value: unknown): AgentDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultAgents);
  }
  const used = new Set<string>();
  const sanitized: AgentDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as AgentInput | undefined;
    const fallback = defaultAgents[index] ?? defaultAgents[0];
    const name = normalizeAgentName(entry?.name, fallback.name);
    const rawId = typeof entry?.id === "string" ? entry.id.trim() : "";
    const id = ensureUnique(
      slugify(rawId.length > 0 ? rawId : name),
      used,
    );
    sanitized.push({ id, name });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultAgents);
  }
  return sanitized;
};

const resolveSlotId = (
  slots: readonly SlotDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = slots.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byLabel = slots.find((entry) =>
    entry.label.toLowerCase() === normalized
  );
  return byLabel?.id ?? null;
};

const resolveAgentId = (
  agents: readonly AgentDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = agents.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byName = agents.find((entry) =>
    entry.name.toLowerCase() === normalized
  );
  return byName?.id ?? null;
};

const produceAssignments = (
  entries: readonly AssignmentInput[] | undefined,
  slots: readonly SlotDefinition[],
  agents: readonly AgentDefinition[],
): AssignmentRecord[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const order = new Map<string, number>();
  slots.forEach((slot, index) => order.set(slot.id, index));
  const agentOrder = new Map<string, number>();
  agents.forEach((agent, index) => agentOrder.set(agent.id, index));
  const seen = new Set<string>();
  const sanitized: AssignmentRecord[] = [];
  for (const entry of entries) {
    const slotId = resolveSlotId(slots, entry?.slot);
    const agentId = resolveAgentId(agents, entry?.agent);
    if (!slotId || !agentId) continue;
    const key = `${slotId}::${agentId}`;
    if (seen.has(key)) continue;
    sanitized.push({ slot: slotId, agent: agentId });
    seen.add(key);
  }
  sanitized.sort((left, right) => {
    const slotDiff = (order.get(left.slot) ?? 0) - (order.get(right.slot) ?? 0);
    if (slotDiff !== 0) return slotDiff;
    return (agentOrder.get(left.agent) ?? 0) -
      (agentOrder.get(right.agent) ?? 0);
  });
  return sanitized;
};

const buildCoverageEntries = (
  slots: readonly SlotDefinition[],
  assignments: readonly AssignmentRecord[],
  agents: readonly AgentDefinition[],
): SlotCoverage[] => {
  const agentNames = new Map<string, string>();
  for (const agent of agents) {
    agentNames.set(agent.id, agent.name);
  }
  const slotMap = new Map<string, SlotCoverage>();
  for (const slot of slots) {
    slotMap.set(slot.id, {
      slot: slot.id,
      label: slot.label,
      required: slot.requiredAgents,
      assigned: [],
      assignedCount: 0,
      remaining: slot.requiredAgents,
      hasGap: slot.requiredAgents > 0,
    });
  }
  for (const record of assignments) {
    const coverage = slotMap.get(record.slot);
    if (!coverage) continue;
    const name = agentNames.get(record.agent) ?? record.agent;
    coverage.assigned.push(name);
  }
  const coverageList: SlotCoverage[] = [];
  for (const slot of slots) {
    const coverage = slotMap.get(slot.id);
    if (!coverage) continue;
    coverage.assignedCount = coverage.assigned.length;
    const remaining = slot.requiredAgents - coverage.assignedCount;
    coverage.remaining = remaining > 0 ? remaining : 0;
    coverage.hasGap = coverage.remaining > 0;
    coverageList.push({ ...coverage, assigned: [...coverage.assigned] });
  }
  return coverageList;
};

const updateSchedule = handler(
  (
    event: ScheduleEvent | undefined,
    context: {
      assignments: Cell<AssignmentRecord[]>;
      baseSchedule: Cell<AssignmentRecord[]>;
      slots: Cell<SlotDefinition[]>;
      agents: Cell<AgentDefinition[]>;
      history: Cell<string[]>;
      latestChange: Cell<LatestChange | null>;
      sequence: Cell<number>;
    },
  ) => {
    const slots = context.slots.get() ?? [];
    const agents = context.agents.get() ?? [];
    if (slots.length === 0 || agents.length === 0) return;

    const slotId = resolveSlotId(slots, event?.slot);
    if (!slotId) return;

    const action = event?.action === "unschedule" ? "unschedule" : "assign";

    const storedRecords = context.assignments.get();
    const baseRecords = context.baseSchedule.get();
    const current = Array.isArray(storedRecords) && storedRecords.length > 0
      ? [...storedRecords]
      : Array.isArray(baseRecords)
      ? [...baseRecords]
      : [];
    const slotOrder = new Map<string, number>();
    slots.forEach((slot, index) => slotOrder.set(slot.id, index));
    const agentOrder = new Map<string, number>();
    agents.forEach((agent, index) => agentOrder.set(agent.id, index));

    let agentId = resolveAgentId(agents, event?.agent);

    if (action === "assign") {
      if (!agentId) return;
      if (
        current.some((entry) =>
          entry.slot === slotId && entry.agent === agentId
        )
      ) {
        return;
      }
      current.push({ slot: slotId, agent: agentId });
    } else {
      if (agentId) {
        const index = current.findIndex((entry) =>
          entry.slot === slotId && entry.agent === agentId
        );
        if (index === -1) return;
        current.splice(index, 1);
      } else {
        const index = current.findIndex((entry) => entry.slot === slotId);
        if (index === -1) return;
        const removed = current.splice(index, 1)[0];
        agentId = removed.agent;
      }
    }

    current.sort((left, right) => {
      const slotDiff = (slotOrder.get(left.slot) ?? 0) -
        (slotOrder.get(right.slot) ?? 0);
      if (slotDiff !== 0) return slotDiff;
      return (agentOrder.get(left.agent) ?? 0) -
        (agentOrder.get(right.agent) ?? 0);
    });

    const normalized = current.map((entry) => ({
      slot: entry.slot,
      agent: entry.agent,
    }));
    context.assignments.set(normalized);

    const coverage = buildCoverageEntries(slots, normalized, agents);
    const gapCount = coverage.reduce(
      (count, entry) => count + (entry.hasGap ? 1 : 0),
      0,
    );
    const coverageEntry = coverage.find((entry) => entry.slot === slotId);
    const slotLabel = coverageEntry?.label ?? slotId;
    const remaining = coverageEntry?.remaining ?? 0;

    const agentName = agentId
      ? agents.find((entry) => entry.id === agentId)?.name ?? agentId
      : "";
    const historyValue = context.history.get();
    const history = Array.isArray(historyValue) ? historyValue : [];
    const message = action === "assign"
      ? `Assigned ${agentName} to ${slotLabel}`
      : `Removed ${agentName} from ${slotLabel}`;
    context.history.set([...history, message]);

    const sequenceValue = context.sequence.get();
    const nextSequence = typeof sequenceValue === "number"
      ? sequenceValue + 1
      : 1;
    context.sequence.set(nextSequence);

    if (agentId) {
      context.latestChange.set({
        sequence: nextSequence,
        slot: slotId,
        label: slotLabel,
        action,
        agentId,
        agentName,
        gapCount,
        remaining,
      });
    }
  },
);

const liftBaseSchedule = lift(
  (input: {
    entries: AssignmentInput[] | undefined;
    slotList: SlotDefinition[];
    agentList: AgentDefinition[];
  }) => {
    const sanitized = produceAssignments(
      input.entries,
      input.slotList,
      input.agentList,
    );
    if (sanitized.length > 0) {
      return sanitized;
    }
    const fallback = produceAssignments(
      defaultAssignments,
      input.slotList,
      input.agentList,
    );
    if (fallback.length > 0) {
      return fallback;
    }
    if (input.slotList.length > 0 && input.agentList.length > 0) {
      const generated: AssignmentRecord[] = [];
      for (let index = 0; index < input.slotList.length; index++) {
        const agent = input.agentList[index % input.agentList.length];
        if (!agent) break;
        generated.push({
          slot: input.slotList[index].id,
          agent: agent.id,
        });
      }
      return generated;
    }
    return [];
  },
);

const liftSchedule = lift(
  (input: { stored: AssignmentRecord[]; base: AssignmentRecord[] }) => {
    const stored = Array.isArray(input.stored) ? input.stored : [];
    if (stored.length > 0) {
      return stored.map((entry) => ({ ...entry }));
    }
    const base = Array.isArray(input.base) ? input.base : [];
    return base.map((entry) => ({ ...entry }));
  },
);

const liftCoverage = lift(
  (input: {
    slotList: SlotDefinition[];
    records: AssignmentRecord[];
    agentList: AgentDefinition[];
  }) => buildCoverageEntries(input.slotList, input.records, input.agentList),
);

const liftGapLabels = lift((entries: SlotCoverage[]) =>
  entries.filter((entry) => entry.hasGap).map((entry) => entry.label)
);

const liftGapIds = lift((entries: SlotCoverage[]) =>
  entries.filter((entry) => entry.hasGap).map((entry) => entry.slot)
);

const liftTotalSlots = lift((entries: SlotDefinition[]) => entries.length);

const liftCoveredSlots = lift(
  (entries: SlotCoverage[]) => entries.filter((entry) => !entry.hasGap).length,
);

const liftGapCount = lift(
  (entries: SlotCoverage[]) => entries.filter((entry) => entry.hasGap).length,
);

const liftGapSummary = lift((labels: string[]) => {
  if (!Array.isArray(labels) || labels.length === 0) {
    return "All slots covered";
  }
  return `Coverage gaps: ${labels.join(", ")}`;
});

const liftRemainingAgents = lift((entries: SlotCoverage[]) =>
  entries.reduce((sum, entry) => sum + entry.remaining, 0)
);

const liftHistoryView = lift((entries: string[] | undefined) => {
  return Array.isArray(entries) ? [...entries] : [];
});

const liftLatestChangeView = lift(
  (entry: LatestChange | null | undefined) => {
    return entry ? { ...entry } : null;
  },
);

const liftSanitizeSlots = lift(sanitizeSlots);
const liftSanitizeAgents = lift(sanitizeAgents);

export const callCenterSchedulePattern = pattern<CallCenterScheduleArgs>(
  ({ slots, agents, assignments }) => {
    const slotsList = liftSanitizeSlots(slots);
    const agentsList = liftSanitizeAgents(agents);

    const baseSchedule = liftBaseSchedule({
      entries: assignments,
      slotList: slotsList,
      agentList: agentsList,
    });

    const assignmentStore = cell<AssignmentRecord[]>([]);

    const schedule = liftSchedule({
      stored: assignmentStore,
      base: baseSchedule,
    });

    const coverage = liftCoverage({
      slotList: slotsList,
      records: schedule,
      agentList: agentsList,
    });

    const gapLabels = liftGapLabels(coverage);

    const gapIds = liftGapIds(coverage);

    const totalSlots = liftTotalSlots(slotsList);
    const coveredSlots = liftCoveredSlots(coverage);
    const gapCount = liftGapCount(coverage);

    const coverageStatus =
      str`${coveredSlots}/${totalSlots} slots covered; open gaps ${gapCount}`;

    const gapSummary = liftGapSummary(gapLabels);

    const remainingAgents = liftRemainingAgents(coverage);

    const history = cell<string[]>([]);
    const latestChange = cell<LatestChange | null>(null);
    const sequence = cell(0);
    const historyView = liftHistoryView(history);
    const latestChangeView = liftLatestChangeView(latestChange);

    const controls = {
      updateShift: updateSchedule({
        assignments: assignmentStore,
        baseSchedule,
        slots: slotsList,
        agents: agentsList,
        history,
        latestChange,
        sequence,
      }),
    };

    return {
      slots: slotsList,
      agents: agentsList,
      assignments: schedule,
      coverage,
      coverageGaps: gapIds,
      gapSummary,
      coverageStatus,
      remainingCoverage: remainingAgents,
      history: historyView,
      latestChange: latestChangeView,
      controls,
    };
  },
);

export default callCenterSchedulePattern;
