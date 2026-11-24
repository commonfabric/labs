import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type ChangeStatus = "blocked" | "unblocked";

const slotCatalog = [
  "09:00-10:00",
  "10:00-11:00",
  "11:00-12:00",
  "13:00-14:00",
  "14:00-15:00",
  "15:00-16:00",
  "16:00-17:00",
] as const;

type SlotId = (typeof slotCatalog)[number];

type SlotInput = string | { start?: string; end?: string };

type ParticipantInput = Partial<ParticipantAvailability> & {
  slots?: SlotInput[];
};

interface ParticipantAvailability {
  name: string;
  slots: SlotId[];
}

interface AvailabilityChange {
  slot: SlotId;
  status: ChangeStatus;
}

interface ModifyAvailabilityEvent {
  slot?: SlotInput;
  action?: "block" | "unblock" | "toggle";
}

interface CalendarAvailabilityArgs {
  participants: Default<
    ParticipantInput[],
    typeof defaultParticipants
  >;
  blocked: Default<SlotInput[], []>;
}

const slotOrder = new Map<string, number>(
  slotCatalog.map((slot, index) => [slot, index]),
);

const slotSet = new Set<string>(slotCatalog);
const emptySlotFallback: readonly SlotId[] = [] as const;

const defaultParticipants: ParticipantAvailability[] = [
  {
    name: "Alex Rivera",
    slots: ["09:00-10:00", "13:00-14:00", "15:00-16:00"],
  },
  {
    name: "Blair Chen",
    slots: ["10:00-11:00", "13:00-14:00", "15:00-16:00"],
  },
  {
    name: "Casey Morgan",
    slots: ["13:00-14:00", "15:00-16:00", "16:00-17:00"],
  },
];

const parseSlotString = (value: string): SlotId | null => {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/,
  );
  if (!match) return null;
  const startHour = Number(match[1]);
  const endHour = Number(match[3]);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
    return null;
  }
  const start = `${String(startHour).padStart(2, "0")}:${match[2]}`;
  const end = `${String(endHour).padStart(2, "0")}:${match[4]}`;
  const candidate = `${start}-${end}`;
  return slotSet.has(candidate) ? candidate as SlotId : null;
};

const normalizeSlot = (input: SlotInput | undefined): SlotId | null => {
  if (typeof input === "string") {
    return parseSlotString(input);
  }
  if (input && typeof input === "object") {
    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    return parseSlotString(`${start}-${end}`);
  }
  return null;
};

const sanitizeSlotList = (
  value: unknown,
  fallback: readonly SlotId[],
): SlotId[] => {
  const entries = Array.isArray(value) ? value : [];
  const sanitized: SlotId[] = [];
  for (const entry of entries) {
    const slot = normalizeSlot(entry as SlotInput);
    if (!slot || sanitized.includes(slot)) continue;
    sanitized.push(slot);
  }
  if (sanitized.length === 0) {
    return [...fallback];
  }
  sanitized.sort((left, right) => {
    const leftIndex = slotOrder.get(left) ?? slotCatalog.length;
    const rightIndex = slotOrder.get(right) ?? slotCatalog.length;
    return leftIndex - rightIndex;
  });
  return sanitized;
};

const sanitizeName = (
  value: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof value !== "string") {
    return fallback || `Participant ${index + 1}`;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback || `Participant ${index + 1}`;
  }
  return trimmed.slice(0, 48);
};

const cloneDefaults = (): ParticipantAvailability[] => {
  return defaultParticipants.map((entry) => ({
    name: entry.name,
    slots: [...entry.slots],
  }));
};

const sanitizeParticipants = (
  value: readonly ParticipantInput[] | undefined,
): ParticipantAvailability[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneDefaults();
  }
  const sanitized: ParticipantAvailability[] = [];
  let index = 0;
  for (const entry of value) {
    const fallback = defaultParticipants[index] ?? defaultParticipants[0];
    const name = sanitizeName(
      entry?.name,
      fallback?.name ?? `Participant ${index + 1}`,
      index,
    );
    const fallbackSlots = fallback ? fallback.slots : slotCatalog;
    const slots = sanitizeSlotList(entry?.slots, fallbackSlots);
    sanitized.push({ name, slots });
    index += 1;
  }
  return sanitized.length > 0 ? sanitized : cloneDefaults();
};

const sanitizeBlocked = (value: unknown): SlotId[] => {
  return sanitizeSlotList(value, emptySlotFallback);
};

const computeSharedAvailability = (
  participants: readonly ParticipantAvailability[],
  blocked: readonly SlotId[],
): SlotId[] => {
  if (participants.length === 0) {
    return [];
  }
  const shared = new Set<SlotId>(participants[0]?.slots ?? []);
  for (let index = 1; index < participants.length; index += 1) {
    const entry = participants[index];
    const slots = new Set<SlotId>(entry?.slots ?? []);
    for (const slot of [...shared]) {
      if (!slots.has(slot)) {
        shared.delete(slot);
      }
    }
  }
  const blockedSet = new Set<SlotId>(blocked);
  const result: SlotId[] = [];
  for (const slot of slotCatalog) {
    if (shared.has(slot) && !blockedSet.has(slot)) {
      result.push(slot);
    }
  }
  return result;
};

const recordHistoryEntry = (
  history: Cell<string[]>,
  entry: string,
): void => {
  const current = history.get();
  const list = Array.isArray(current) ? [...current] : [];
  list.push(entry);
  history.set(list.slice(-12));
};

const liftSharedAvailability = lift(
  (
    input: { participants: ParticipantAvailability[]; blocked: SlotId[] },
  ): SlotId[] => {
    return computeSharedAvailability(input.participants, input.blocked);
  },
);

const liftSharedLabel = lift((slots: readonly SlotId[]) => {
  if (!Array.isArray(slots) || slots.length === 0) {
    return "none";
  }
  return slots.join(", ");
});

const liftNextAvailableSlot = lift((slots: readonly SlotId[]) => {
  return Array.isArray(slots) && slots.length > 0 ? slots[0] : "none";
});

const liftFreeSlotCount = lift((slots: readonly SlotId[]) => {
  return Array.isArray(slots) ? slots.length : 0;
});

const liftHistoryView = lift((entries: string[] | undefined) => {
  return Array.isArray(entries) ? [...entries] : [];
});

const liftLatestChangeView = lift(
  (entry: AvailabilityChange | null | undefined) => {
    return entry ? { ...entry } : null;
  },
);

const liftSanitizeParticipants = lift(sanitizeParticipants);
const liftSanitizeBlocked = lift(sanitizeBlocked);

const modifySharedAvailability = handler(
  (
    event: ModifyAvailabilityEvent | undefined,
    context: {
      blocked: Cell<SlotInput[]>;
      history: Cell<string[]>;
      latestChange: Cell<AvailabilityChange | null>;
    },
  ) => {
    const slot = normalizeSlot(event?.slot);
    if (!slot) {
      return;
    }
    const action = event?.action ?? "block";
    const existing = sanitizeBlocked(context.blocked.get());
    const blockedSet = new Set<SlotId>(existing);
    let status: ChangeStatus | null = null;
    if (action === "block") {
      if (!blockedSet.has(slot)) {
        blockedSet.add(slot);
        status = "blocked";
      }
    } else if (action === "unblock") {
      if (blockedSet.delete(slot)) {
        status = "unblocked";
      }
    } else {
      if (blockedSet.has(slot)) {
        blockedSet.delete(slot);
        status = "unblocked";
      } else {
        blockedSet.add(slot);
        status = "blocked";
      }
    }
    if (!status) {
      return;
    }
    const next = slotCatalog.filter((value) => blockedSet.has(value));
    context.blocked.set([...next]);
    recordHistoryEntry(context.history, `${status} ${slot}`);
    const change: AvailabilityChange = { slot, status };
    context.latestChange.set(change);
  },
);

/**
 * Pattern computing shared availability windows across participants while
 * reacting to block edits in real time for offline scheduling flows.
 */
export const calendarAvailabilityPattern = pattern<CalendarAvailabilityArgs>(
  ({ participants, blocked }) => {
    const history = cell<string[]>([]);
    const latestChange = cell<AvailabilityChange | null>(null);

    const participantsView = liftSanitizeParticipants(participants);
    const blockedView = liftSanitizeBlocked(blocked);
    const sharedAvailability = liftSharedAvailability({
      participants: participantsView,
      blocked: blockedView,
    });

    const sharedLabel = liftSharedLabel(sharedAvailability);

    const nextAvailableSlot = liftNextAvailableSlot(sharedAvailability);

    const freeSlotCount = liftFreeSlotCount(sharedAvailability);

    const historyView = liftHistoryView(history);

    const latestChangeView = liftLatestChangeView(latestChange);

    const sharedSummary = str`Shared slots: ${sharedLabel}`;
    const nextSlotSummary = str`Next slot: ${nextAvailableSlot}`;

    const updateAvailability = modifySharedAvailability({
      blocked,
      history,
      latestChange,
    });

    return {
      participants,
      participantsView,
      blocked,
      blockedView,
      sharedAvailability,
      sharedLabel,
      sharedSummary,
      nextAvailableSlot,
      nextSlotSummary,
      freeSlotCount,
      actionHistory: historyView,
      latestChange: latestChangeView,
      controls: {
        updateAvailability,
      },
    };
  },
);

export default calendarAvailabilityPattern;
