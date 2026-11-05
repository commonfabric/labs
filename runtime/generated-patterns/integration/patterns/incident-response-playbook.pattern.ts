import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type StepStatus = "pending" | "in_progress" | "blocked" | "complete";

interface IncidentStepSeed {
  id?: string;
  title?: string;
  owner?: string;
  status?: StepStatus;
  expectedMinutes?: number;
  elapsedMinutes?: number;
}

interface IncidentStep {
  id: string;
  title: string;
  owner: string;
  status: StepStatus;
  expectedMinutes: number;
  elapsedMinutes: number;
}

interface IncidentResponsePlaybookArgs {
  steps: Default<IncidentStepSeed[], []>;
}

interface IncidentStatusSummary {
  pending: number;
  inProgress: number;
  blocked: number;
  done: number;
}

interface StepBlueprint {
  id: string;
  title: string;
  owner: string;
  expectedMinutes: number;
}

const DEFAULT_BLUEPRINTS: readonly StepBlueprint[] = [
  {
    id: "triage",
    title: "Triage incident",
    owner: "incident-commander",
    expectedMinutes: 15,
  },
  {
    id: "contain",
    title: "Contain impact",
    owner: "operations",
    expectedMinutes: 30,
  },
  {
    id: "recover",
    title: "Recover services",
    owner: "platform",
    expectedMinutes: 45,
  },
];

const STALL_MULTIPLIER = 1.5;
const MIN_BLOCKED_MINUTES = 10;
const MAX_EXPECTED_MINUTES = 240;
const MAX_ELAPSED_MINUTES = 1440;

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeTitle = (
  value: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (fallback.length > 0) {
    return fallback;
  }
  return `Incident step ${index + 1}`;
};

const sanitizeOwner = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeStatus = (value: unknown): StepStatus => {
  if (value === "in_progress" || value === "blocked" || value === "complete") {
    return value;
  }
  return "pending";
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const sanitizeExpectedMinutes = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return clampNumber(rounded, 5, MAX_EXPECTED_MINUTES);
};

const sanitizeElapsedMinutes = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return clampNumber(rounded, 0, MAX_ELAPSED_MINUTES);
};

const sanitizeMinutesDelta = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 0;
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

const sanitizeStep = (
  seed: IncidentStepSeed | undefined,
  index: number,
  blueprint: StepBlueprint,
  used: Set<string>,
): IncidentStep => {
  const baseId = sanitizeIdentifier(seed?.id, blueprint.id);
  const id = ensureUniqueId(baseId, used);
  const title = sanitizeTitle(seed?.title, blueprint.title, index);
  const owner = sanitizeOwner(seed?.owner, blueprint.owner);
  const expected = sanitizeExpectedMinutes(
    seed?.expectedMinutes,
    blueprint.expectedMinutes,
  );
  const status = sanitizeStatus(seed?.status);
  const baseElapsed = status === "pending" ? 0 : blueprint.expectedMinutes;
  const elapsed = sanitizeElapsedMinutes(seed?.elapsedMinutes, baseElapsed);
  return {
    id,
    title,
    owner,
    status,
    expectedMinutes: expected,
    elapsedMinutes: status === "pending" ? 0 : elapsed,
  };
};

const sanitizeState = (
  entries: readonly IncidentStepSeed[] | undefined,
): IncidentStep[] => {
  const seeds = Array.isArray(entries) ? entries : [];
  const count = Math.max(seeds.length, DEFAULT_BLUEPRINTS.length);
  const used = new Set<string>();
  const steps: IncidentStep[] = [];
  for (let index = 0; index < count; index += 1) {
    const blueprint = DEFAULT_BLUEPRINTS[index] ?? {
      id: `step-${index + 1}`,
      title: "Follow-up",
      owner: "unassigned",
      expectedMinutes: 20,
    };
    const step = sanitizeStep(seeds[index], index, blueprint, used);
    steps.push(step);
  }
  return steps;
};

const computeSummary = (
  steps: readonly IncidentStep[],
): IncidentStatusSummary => {
  const summary: IncidentStatusSummary = {
    pending: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
  };
  for (const step of steps) {
    switch (step.status) {
      case "in_progress":
        summary.inProgress += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "complete":
        summary.done += 1;
        break;
      default:
        summary.pending += 1;
        break;
    }
  }
  return summary;
};

const findStalledSteps = (steps: readonly IncidentStep[]): string[] => {
  const stalled: string[] = [];
  for (const step of steps) {
    if (step.status === "blocked") {
      if (step.elapsedMinutes >= MIN_BLOCKED_MINUTES) {
        stalled.push(step.id);
      }
      continue;
    }
    if (step.status !== "in_progress") continue;
    const limit = Math.max(
      Math.round(step.expectedMinutes * STALL_MULTIPLIER),
      step.expectedMinutes + 5,
    );
    if (step.elapsedMinutes >= limit) {
      stalled.push(step.id);
    }
  }
  return stalled;
};

const toHistory = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      result.push(entry);
    }
  }
  return result;
};

const beginIncidentStep = handler(
  (
    event: { stepId?: string } | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
    },
  ) => {
    const current = sanitizeState(context.steps.get());
    const requested = sanitizeIdentifier(
      event?.stepId,
      context.active.get() ?? current[0]?.id ?? "",
    );
    if (requested.length === 0) return;
    let found = false;
    const next: IncidentStep[] = [];
    for (const step of current) {
      if (step.id !== requested) {
        next.push(step);
        continue;
      }
      found = true;
      next.push({
        ...step,
        status: "in_progress",
        elapsedMinutes: 0,
      });
    }
    if (!found) return;
    context.steps.set(next as IncidentStepSeed[]);
    context.active.set(requested);
    const history = toHistory(context.history.get());
    const entry = `Started ${requested}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const noteElapsedTime = handler(
  (
    event: { stepId?: string; minutes?: number } | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
      clock: Cell<number>;
    },
  ) => {
    const minutes = sanitizeMinutesDelta(event?.minutes);
    if (minutes === 0) return;
    const baseline = sanitizeState(context.steps.get());
    const fallback = context.active.get() ?? baseline[0]?.id ?? "";
    const targetId = sanitizeIdentifier(event?.stepId, fallback);
    if (targetId.length === 0) return;
    let applied = false;
    const next: IncidentStep[] = [];
    for (const step of baseline) {
      if (step.id !== targetId) {
        next.push(step);
        continue;
      }
      applied = true;
      const elapsed = step.elapsedMinutes + minutes;
      next.push({
        ...step,
        elapsedMinutes: clampNumber(elapsed, 0, MAX_ELAPSED_MINUTES),
      });
    }
    if (!applied) return;
    context.steps.set(next as IncidentStepSeed[]);
    const clockRaw = context.clock.get();
    const clock = typeof clockRaw === "number" && Number.isFinite(clockRaw)
      ? clockRaw
      : 0;
    context.clock.set(clock + minutes);
    const history = toHistory(context.history.get());
    const entry = `Logged ${minutes}m on ${targetId}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const updateStepStatus = handler(
  (
    event:
      | { stepId?: string; status?: StepStatus; minutes?: number }
      | undefined,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
    },
  ) => {
    const baseline = sanitizeState(context.steps.get());
    const fallback = context.active.get() ?? baseline[0]?.id ?? "";
    const targetId = sanitizeIdentifier(event?.stepId, fallback);
    if (targetId.length === 0) return;
    const status = sanitizeStatus(event?.status);
    const delta = sanitizeMinutesDelta(event?.minutes);
    let found = false;
    const next: IncidentStep[] = [];
    for (const step of baseline) {
      if (step.id !== targetId) {
        next.push(step);
        continue;
      }
      found = true;
      const updatedElapsed = step.elapsedMinutes + delta;
      next.push({
        ...step,
        status,
        elapsedMinutes: status === "pending" ? 0 : updatedElapsed,
      });
    }
    if (!found) return;
    context.steps.set(next as IncidentStepSeed[]);
    if (status === "complete" && context.active.get() === targetId) {
      context.active.set(null);
    } else if (status === "in_progress") {
      context.active.set(targetId);
    }
    const history = toHistory(context.history.get());
    const entry = `Marked ${targetId} as ${status}`;
    const updates = [...history, entry];
    context.history.set(updates);
  },
);

const resetPlaybook = handler(
  (
    _event: unknown,
    context: {
      steps: Cell<IncidentStepSeed[]>;
      history: Cell<string[]>;
      active: Cell<string | null>;
      clock: Cell<number>;
    },
  ) => {
    const baseline = sanitizeState(context.steps.get());
    const resetSteps: IncidentStep[] = [];
    for (const step of baseline) {
      resetSteps.push({
        ...step,
        status: "pending",
        elapsedMinutes: 0,
      });
    }
    context.steps.set(resetSteps as IncidentStepSeed[]);
    context.history.set([]);
    context.active.set(null);
    context.clock.set(0);
  },
);

// Module-scope lift definitions
const liftSanitizeState = lift(sanitizeState);

const liftComputeSummary = lift((input: IncidentStep[]) =>
  computeSummary(input)
);

const liftPendingCount = lift((value: IncidentStatusSummary) => value.pending);
const liftInProgressCount = lift((value: IncidentStatusSummary) =>
  value.inProgress
);
const liftBlockedCount = lift((value: IncidentStatusSummary) => value.blocked);
const liftDoneCount = lift((value: IncidentStatusSummary) => value.done);

const liftFindStalledSteps = lift((input: IncidentStep[]) =>
  findStalledSteps(input)
);

const liftStalledCount = lift((value: string[]) => value.length);
const liftNeedsEscalation = lift((count: number) => count > 0);
const liftEscalationState = lift((flag: boolean) =>
  flag ? "required" : "clear"
);

const liftTimeline = lift((entries: string[] | undefined) =>
  toHistory(entries)
);

const liftActiveStepId = lift((value: string | null | undefined) =>
  typeof value === "string" && value.length > 0 ? value : ""
);

const liftClockMinutes = lift((value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0
);

export const incidentResponsePlaybook = pattern<IncidentResponsePlaybookArgs>(
  ({ steps }) => {
    const history = cell<string[]>([]);
    const activeStep = cell<string | null>(null);
    const clock = cell(0);

    const stepsView = liftSanitizeState(steps);

    const summary = liftComputeSummary(stepsView);

    const pendingCount = liftPendingCount(summary);
    const inProgressCount = liftInProgressCount(summary);
    const blockedCount = liftBlockedCount(summary);
    const doneCount = liftDoneCount(summary);

    const statusLabel =
      str`Pending ${pendingCount} | Active ${inProgressCount} | Blocked ${blockedCount} | Done ${doneCount}`;

    const stalledSteps = liftFindStalledSteps(stepsView);

    const stalledCount = liftStalledCount(stalledSteps);
    const needsEscalation = liftNeedsEscalation(stalledCount);
    const escalationState = liftEscalationState(needsEscalation);
    const escalationLabel =
      str`Escalation ${escalationState} (${stalledCount})`;

    const timeline = liftTimeline(history);

    const latestLogEntry = computed(() => {
      if (timeline.length === 0) {
        return "ready";
      }
      return timeline[timeline.length - 1];
    });

    const activeStepId = liftActiveStepId(activeStep);

    const activeStepTitle = computed(() => {
      const id = activeStep.get();
      if (!id) {
        return "idle";
      }
      const target = stepsView.find((step) => step.id === id);
      return target ? target.title : "idle";
    });

    const clockMinutes = liftClockMinutes(clock);

    return {
      steps: stepsView,
      summary,
      statusLabel,
      stalledSteps,
      stalledCount,
      needsEscalation,
      escalationLabel,
      timeline,
      latestLogEntry,
      activeStepId,
      activeStepTitle,
      clockMinutes,
      handlers: {
        start: beginIncidentStep({
          steps,
          history,
          active: activeStep,
        }),
        logElapsed: noteElapsedTime({
          steps,
          history,
          active: activeStep,
          clock,
        }),
        updateStatus: updateStepStatus({
          steps,
          history,
          active: activeStep,
        }),
        reset: resetPlaybook({
          steps,
          history,
          active: activeStep,
          clock,
        }),
      },
    };
  },
);

export type {
  IncidentResponsePlaybookArgs,
  IncidentStatusSummary,
  IncidentStep,
  IncidentStepSeed,
};

export default incidentResponsePlaybook;
