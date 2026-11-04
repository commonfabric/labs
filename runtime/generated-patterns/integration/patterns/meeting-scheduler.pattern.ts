import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type VoteValue = "yes" | "maybe" | "no";

interface ParticipantInput {
  id?: string;
  name?: string;
}

interface ParticipantDefinition {
  id: string;
  name: string;
}

interface SlotInput {
  id?: string;
  label?: string;
}

interface SlotDefinition {
  id: string;
  label: string;
}

type VoteRecord = Record<string, Record<string, VoteValue>>;

interface VoteEvent {
  participant?: string;
  slot?: string;
  vote?: string;
}

interface ProposeSlotEvent {
  id?: string;
  label?: string;
}

interface VoteChange {
  participantId: string;
  participantName: string;
  slotId: string;
  slotLabel: string;
  vote: VoteValue;
  yesCount: number;
  maybeCount: number;
  noCount: number;
}

interface SlotUpdate {
  slotId: string;
  label: string;
  mode: "added";
}

interface SlotVoteSummary {
  slotId: string;
  slotLabel: string;
  yes: number;
  maybe: number;
  no: number;
  pending: string[];
}

interface ConsensusSnapshot {
  slotId: string | null;
  slotLabel: string;
  yes: number;
  maybe: number;
  no: number;
  outstanding: number;
  outstandingNames: string[];
  status: "locked" | "pending";
  participantCount: number;
}

interface MeetingSchedulerArgs {
  participants: Default<
    ParticipantInput[],
    typeof defaultParticipants
  >;
  slots: Default<SlotInput[], typeof defaultSlots>;
}

const defaultParticipants: ParticipantDefinition[] = [
  { id: "alex-rivera", name: "Alex Rivera" },
  { id: "blair-chen", name: "Blair Chen" },
  { id: "casey-morgan", name: "Casey Morgan" },
];

const defaultSlots: SlotDefinition[] = [
  { id: "tuesday-0900", label: "Tuesday 09:00" },
  { id: "tuesday-1400", label: "Tuesday 14:00" },
  { id: "wednesday-1000", label: "Wednesday 10:00" },
];

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const ensureUnique = (value: string, used: Set<string>): string => {
  let candidate = value;
  if (candidate.length === 0) {
    candidate = "slot";
  }
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const normalizeParticipantName = (
  value: unknown,
  fallback: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeParticipants = (
  value: unknown,
): ParticipantDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultParticipants);
  }
  const used = new Set<string>();
  const sanitized: ParticipantDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as ParticipantInput | string | undefined;
    const fallback = defaultParticipants[index] ?? defaultParticipants[0];
    const name = typeof entry === "string"
      ? normalizeParticipantName(entry, fallback.name)
      : normalizeParticipantName(entry?.name, fallback.name);
    const baseIdSource = typeof entry === "string"
      ? entry
      : typeof entry?.id === "string" && entry.id.trim().length > 0
      ? entry.id
      : name;
    const baseId = slugify(baseIdSource);
    const id = ensureUnique(
      baseId.length > 0 ? baseId : slugify(fallback.id),
      used,
    );
    sanitized.push({ id, name });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultParticipants);
  }
  return sanitized;
};

const normalizeSlotLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeSlots = (value: unknown): SlotDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultSlots);
  }
  const used = new Set<string>();
  const sanitized: SlotDefinition[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as SlotInput | string | undefined;
    const fallback = defaultSlots[index] ?? defaultSlots[0];
    const label = typeof entry === "string"
      ? normalizeSlotLabel(entry, fallback.label)
      : normalizeSlotLabel(entry?.label, fallback.label);
    if (label.length === 0) {
      continue;
    }
    const baseIdSource = typeof entry === "string"
      ? entry
      : typeof entry?.id === "string" && entry.id.trim().length > 0
      ? entry.id
      : label;
    const baseId = slugify(baseIdSource);
    const id = ensureUnique(
      baseId.length > 0 ? baseId : slugify(fallback.id),
      used,
    );
    sanitized.push({ id, label });
  }
  if (sanitized.length === 0) {
    return structuredClone(defaultSlots);
  }
  return sanitized;
};

const normalizeVoteValue = (value: unknown): VoteValue | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "yes" || trimmed === "maybe" || trimmed === "no") {
    return trimmed;
  }
  return null;
};

const resolveParticipantId = (
  participants: readonly ParticipantDefinition[],
  value: unknown,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const byId = participants.find((entry) => entry.id === trimmed);
  if (byId) return byId.id;
  const normalized = trimmed.toLowerCase();
  const byName = participants.find((entry) =>
    entry.name.toLowerCase() === normalized
  );
  return byName?.id ?? null;
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

const normalizeVoteState = (
  value: unknown,
  slots: readonly SlotDefinition[],
  participants: readonly ParticipantDefinition[],
): VoteRecord => {
  const participantIds = new Set(participants.map((entry) => entry.id));
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const sanitized: VoteRecord = {};
  for (const slot of slots) {
    const raw = source[slot.id];
    const slotVotes: Record<string, VoteValue> = {};
    if (raw && typeof raw === "object") {
      const entries = raw as Record<string, unknown>;
      for (const [participantId, voteValue] of Object.entries(entries)) {
        if (!participantIds.has(participantId)) continue;
        const vote = normalizeVoteValue(voteValue);
        if (!vote) continue;
        slotVotes[participantId] = vote;
      }
    }
    sanitized[slot.id] = slotVotes;
  }
  return sanitized;
};

const recordHistoryEntry = (history: Cell<string[]>, entry: string): void => {
  const current = history.get();
  const list = Array.isArray(current) ? [...current, entry] : [entry];
  history.set(list.slice(-12));
};

const countVoteType = (
  votes: Record<string, VoteValue>,
  kind: VoteValue,
): number => {
  let total = 0;
  for (const value of Object.values(votes)) {
    if (value === kind) total += 1;
  }
  return total;
};

const buildVoteTallies = (
  slots: readonly SlotDefinition[],
  participants: readonly ParticipantDefinition[],
  votes: VoteRecord,
): SlotVoteSummary[] => {
  const summaries: SlotVoteSummary[] = [];
  for (const slot of slots) {
    const slotVotes = votes[slot.id] ?? {};
    const yes = countVoteType(slotVotes, "yes");
    const maybe = countVoteType(slotVotes, "maybe");
    const no = countVoteType(slotVotes, "no");
    const pending: string[] = [];
    for (const participant of participants) {
      if (!slotVotes[participant.id]) {
        pending.push(participant.name);
      }
    }
    summaries.push({
      slotId: slot.id,
      slotLabel: slot.label,
      yes,
      maybe,
      no,
      pending,
    });
  }
  return summaries;
};

const computeConsensus = (
  tallies: readonly SlotVoteSummary[],
  participants: readonly ParticipantDefinition[],
): ConsensusSnapshot => {
  if (!Array.isArray(tallies) || tallies.length === 0) {
    const names = participants.map((entry) => entry.name);
    return {
      slotId: null,
      slotLabel: "No slots proposed",
      yes: 0,
      maybe: 0,
      no: 0,
      outstanding: names.length,
      outstandingNames: names,
      status: "pending",
      participantCount: names.length,
    };
  }
  let best = tallies[0];
  for (let index = 1; index < tallies.length; index++) {
    const candidate = tallies[index];
    if (candidate.yes > best.yes) {
      best = candidate;
      continue;
    }
    if (candidate.yes === best.yes) {
      if (candidate.maybe > best.maybe) {
        best = candidate;
        continue;
      }
      if (
        candidate.maybe === best.maybe &&
        candidate.slotLabel.localeCompare(best.slotLabel) < 0
      ) {
        best = candidate;
      }
    }
  }
  const outstanding = best.pending.length;
  const status = outstanding === 0 && best.yes >= best.no
    ? "locked"
    : "pending";
  return {
    slotId: best.slotId,
    slotLabel: best.slotLabel,
    yes: best.yes,
    maybe: best.maybe,
    no: best.no,
    outstanding,
    outstandingNames: [...best.pending],
    status,
    participantCount: participants.length,
  };
};

const castVote = handler(
  (
    event: VoteEvent | undefined,
    context: {
      participants: Cell<ParticipantInput[]>;
      slots: Cell<SlotInput[]>;
      votes: Cell<VoteRecord>;
      history: Cell<string[]>;
      latestVote: Cell<VoteChange | null>;
    },
  ) => {
    const participantList = sanitizeParticipants(context.participants.get());
    const slotList = sanitizeSlots(context.slots.get());
    if (participantList.length === 0 || slotList.length === 0) {
      return;
    }
    const vote = normalizeVoteValue(event?.vote);
    if (!vote) return;
    const participantId = resolveParticipantId(
      participantList,
      event?.participant,
    );
    if (!participantId) return;
    const slotId = resolveSlotId(slotList, event?.slot);
    if (!slotId) return;

    const participant = participantList.find((entry) =>
      entry.id === participantId
    );
    const slot = slotList.find((entry) => entry.id === slotId);
    if (!participant || !slot) return;

    const sanitizedState = normalizeVoteState(
      context.votes.get(),
      slotList,
      participantList,
    );
    const slotVotes = { ...sanitizedState[slotId] };
    if (slotVotes[participantId] === vote) {
      return;
    }
    slotVotes[participantId] = vote;
    const nextState: VoteRecord = { ...sanitizedState, [slotId]: slotVotes };
    context.votes.set(nextState);

    const yesCount = countVoteType(slotVotes, "yes");
    const maybeCount = countVoteType(slotVotes, "maybe");
    const noCount = countVoteType(slotVotes, "no");

    recordHistoryEntry(
      context.history,
      `${participant.name} voted ${vote} for ${slot.label}`,
    );

    const change: VoteChange = {
      participantId,
      participantName: participant.name,
      slotId,
      slotLabel: slot.label,
      vote,
      yesCount,
      maybeCount,
      noCount,
    };
    context.latestVote.set(change);
  },
);

const proposeSlot = handler(
  (
    event: ProposeSlotEvent | undefined,
    context: {
      participants: Cell<ParticipantInput[]>;
      slots: Cell<SlotInput[]>;
      votes: Cell<VoteRecord>;
      history: Cell<string[]>;
      latestSlotUpdate: Cell<SlotUpdate | null>;
    },
  ) => {
    const slotList = sanitizeSlots(context.slots.get());
    const label = normalizeSlotLabel(event?.label ?? event?.id, "");
    if (label.length === 0) {
      return;
    }
    const baseIdSource =
      typeof event?.id === "string" && event.id.trim().length > 0
        ? event.id
        : label;
    const baseId = slugify(baseIdSource);
    const exists = slotList.some((entry) =>
      entry.id === baseId || entry.label.toLowerCase() === label.toLowerCase()
    );
    if (exists) {
      return;
    }
    const used = new Set(slotList.map((entry) => entry.id));
    const slotId = ensureUnique(
      baseId.length > 0 ? baseId : slugify(label),
      used,
    );
    const nextSlots = [...slotList, { id: slotId, label }];
    context.slots.set(nextSlots.map((entry) => ({ ...entry })));

    const participants = sanitizeParticipants(context.participants.get());
    const votes = normalizeVoteState(
      context.votes.get(),
      nextSlots,
      participants,
    );
    context.votes.set(votes);

    recordHistoryEntry(context.history, `Proposed slot ${label}`);
    context.latestSlotUpdate.set({ slotId, label, mode: "added" });
  },
);

// Module-scope lift definitions
const liftSanitizeParticipants = lift(sanitizeParticipants);
const liftSanitizeSlots = lift(sanitizeSlots);

const liftVoteState = lift(
  (
    input: {
      state: VoteRecord | undefined;
      slots: SlotDefinition[];
      participants: ParticipantDefinition[];
    },
  ) => normalizeVoteState(input.state, input.slots, input.participants),
);

const liftSlotTallies = lift(
  (
    input: {
      slots: SlotDefinition[];
      participants: ParticipantDefinition[];
      votes: VoteRecord;
    },
  ) => buildVoteTallies(input.slots, input.participants, input.votes),
);

const liftConsensus = lift(
  (
    input: {
      tallies: SlotVoteSummary[];
      participants: ParticipantDefinition[];
    },
  ) => computeConsensus(input.tallies, input.participants),
);

const liftConsensusLabel = lift((entry: ConsensusSnapshot) => entry.slotLabel);
const liftConsensusYes = lift((entry: ConsensusSnapshot) => entry.yes);

const liftOutstandingNames = lift(
  (entry: ConsensusSnapshot) =>
    entry.outstandingNames.length > 0
      ? entry.outstandingNames.join(", ")
      : "none",
);

const liftOutstandingCount = lift(
  (entry: ConsensusSnapshot) => entry.outstanding,
);

const liftHistoryView = lift((entries: string[] | undefined) => {
  return Array.isArray(entries) ? [...entries] : [];
});

const liftLatestVoteView = lift((entry: VoteChange | null | undefined) => {
  return entry ? { ...entry } : null;
});

const liftLatestSlotUpdateView = lift(
  (entry: SlotUpdate | null | undefined) => {
    return entry ? { ...entry } : null;
  },
);

/**
 * Meeting scheduler that tracks proposed slots, records participant votes, and
 * surfaces consensus snapshots for offline planning.
 */
export const meetingSchedulerPattern = pattern<MeetingSchedulerArgs>(
  ({ participants, slots }) => {
    const votes = cell<VoteRecord>({});
    const history = cell<string[]>([]);
    const latestVote = cell<VoteChange | null>(null);
    const latestSlotUpdate = cell<SlotUpdate | null>(null);

    const participantList = liftSanitizeParticipants(participants);
    const slotList = liftSanitizeSlots(slots);

    const voteState = liftVoteState({
      state: votes,
      slots: slotList,
      participants: participantList,
    });

    const slotTallies = liftSlotTallies({
      slots: slotList,
      participants: participantList,
      votes: voteState,
    });

    const consensus = liftConsensus({
      tallies: slotTallies,
      participants: participantList,
    });

    const consensusLabel = liftConsensusLabel(consensus);
    const consensusYes = liftConsensusYes(consensus);
    const outstandingNames = liftOutstandingNames(consensus);
    const outstandingCount = liftOutstandingCount(consensus);

    const historyView = liftHistoryView(history);
    const latestVoteView = liftLatestVoteView(latestVote);
    const latestSlotUpdateView = liftLatestSlotUpdateView(latestSlotUpdate);

    const consensusSummary =
      str`Consensus slot: ${consensusLabel} (${consensusYes} yes)`;
    const outstandingSummary =
      str`Outstanding voters: ${outstandingCount} (${outstandingNames})`;

    return {
      participants: participantList,
      slots: slotList,
      votes: voteState,
      slotTallies,
      consensus,
      consensusSummary,
      outstandingSummary,
      history: historyView,
      latestVote: latestVoteView,
      latestSlotUpdate: latestSlotUpdateView,
      controls: {
        castVote: castVote({
          participants,
          slots,
          votes,
          history,
          latestVote,
        }),
        proposeSlot: proposeSlot({
          participants,
          slots,
          votes,
          history,
          latestSlotUpdate,
        }),
      },
    };
  },
);

export default meetingSchedulerPattern;
