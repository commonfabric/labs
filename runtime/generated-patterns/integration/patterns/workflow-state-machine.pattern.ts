import { type Cell, cell, Default, handler, lift, pattern } from "commonfabric";

type WorkflowStage =
  | "draft"
  | "in_review"
  | "approved"
  | "scheduled"
  | "published"
  | "archived";

interface WorkflowArgs {
  stage: Default<WorkflowStage, "draft">;
}

interface TransitionEvent {
  target?: string;
  note?: string;
}

type TransitionResult = "accepted" | "rejected";

interface TransitionRecord {
  id: number;
  from: WorkflowStage;
  to: WorkflowStage;
  result: TransitionResult;
  note: string;
  reason: string;
}

const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;

const ALLOWED_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  draft: ["in_review"],
  in_review: ["draft", "approved"],
  approved: ["scheduled", "draft"],
  scheduled: ["published", "draft"],
  published: ["archived"],
  archived: [],
};

const isStage = (value: unknown): value is WorkflowStage => {
  if (typeof value !== "string") {
    return false;
  }
  return WORKFLOW_STAGES.includes(value as WorkflowStage);
};

const sanitizeStage = (value: unknown): WorkflowStage => {
  if (isStage(value)) {
    return value;
  }
  return "draft";
};

const sanitizeNote = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeSequence = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  return 0;
};

const recordTransition = (
  history: Cell<TransitionRecord[]>,
  sequence: Cell<number>,
  entry: Omit<TransitionRecord, "id">,
) => {
  const existing = history.get();
  const current = Array.isArray(existing) ? existing : [];
  const baseId = sanitizeSequence(sequence.get());
  const next: TransitionRecord = { ...entry, id: baseId };
  history.set([...current, next]);
  sequence.set(baseId + 1);
};

// Module-scope lift definitions
const liftNormalizedStage = lift((value: WorkflowStage | undefined) =>
  sanitizeStage(value)
);

const liftHistoryView = lift((entries: TransitionRecord[] | undefined) =>
  Array.isArray(entries) ? entries.slice() : []
);

const liftAttemptCount = lift((entries: TransitionRecord[]) => entries.length);

const liftAcceptedCount = lift((entries: TransitionRecord[]) =>
  entries.reduce(
    (count, entry) => count + (entry.result === "accepted" ? 1 : 0),
    0,
  )
);

const liftRejectedCount = lift((entries: TransitionRecord[]) =>
  entries.reduce(
    (count, entry) => count + (entry.result === "rejected" ? 1 : 0),
    0,
  )
);

const liftStageIndex = lift((current: WorkflowStage) =>
  WORKFLOW_STAGES.indexOf(current)
);

const liftAvailableTransitions = lift((current: WorkflowStage) => {
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  return [...allowed];
});

const liftStageMetadata = lift((current: WorkflowStage) =>
  WORKFLOW_STAGES.map((stageName) => ({
    stage: stageName,
    isCurrent: stageName === current,
    isReachable: (ALLOWED_TRANSITIONS[current] ?? [])
      .includes(stageName),
  }))
);

const liftLastTransitionStatus = lift((entries: TransitionRecord[]) => {
  const entry = entries.at(-1);
  if (!entry) {
    return "none";
  }
  return `${entry.result}:${entry.from}->${entry.to}`;
});

const attemptStageTransition = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      stage: Cell<WorkflowStage>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = sanitizeStage(context.stage.get());
    const rawTarget = event?.target;
    const target = isStage(rawTarget) ? rawTarget : undefined;

    if (!target) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: current,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->invalid`,
        ),
        reason: "invalid-target",
      });
      return;
    }

    if (target === current) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: current,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->${target}`,
        ),
        reason: "no-op",
      });
      return;
    }

    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      recordTransition(context.history, context.sequence, {
        from: current,
        to: target,
        result: "rejected",
        note: sanitizeNote(
          event?.note,
          `reject:${current}->${target}`,
        ),
        reason: "not-allowed",
      });
      return;
    }

    context.stage.set(target);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: target,
      result: "accepted",
      note: sanitizeNote(
        event?.note,
        `accept:${current}->${target}`,
      ),
      reason: "transition",
    });
  },
);

export const workflowStateMachine = pattern<WorkflowArgs>(
  ({ stage }) => {
    const transitions = cell<TransitionRecord[]>([]);
    const sequence = cell(0);

    const normalizedStage = liftNormalizedStage(stage);

    const historyView = liftHistoryView(transitions);

    const attemptCount = liftAttemptCount(historyView);

    const acceptedCount = liftAcceptedCount(historyView);

    const rejectedCount = liftRejectedCount(historyView);

    const stageIndex = liftStageIndex(normalizedStage);

    const availableTransitions = liftAvailableTransitions(normalizedStage);

    const availableLabel = availableTransitions.length === 0
      ? "none"
      : availableTransitions.join(",");

    const stageMetadata = liftStageMetadata(normalizedStage);

    const lastTransitionStatus = liftLastTransitionStatus(historyView);

    const summary = `stage:${normalizedStage} attempts:${attemptCount}` +
      ` accepted:${acceptedCount} rejected:${rejectedCount}`;

    return {
      stage: normalizedStage,
      stageIndex,
      availableTransitions,
      availableLabel,
      stageMetadata,
      history: historyView,
      attemptCount,
      acceptedCount,
      rejectedCount,
      lastTransitionStatus,
      summary,
      transition: attemptStageTransition({
        stage,
        history: transitions,
        sequence,
      }),
    };
  },
);

export default workflowStateMachine;
