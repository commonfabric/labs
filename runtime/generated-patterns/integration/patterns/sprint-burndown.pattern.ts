import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface BurndownEntry {
  day: number;
  remaining: number;
}

interface BurndownCurvePoint {
  day: number;
  actual: number | null;
  projected: number;
  ideal: number;
}

interface SprintSnapshotEvent {
  day?: number;
  completed?: number;
  remaining?: number;
  note?: string;
}

interface SprintBurndownArgs {
  totalScope: Default<number, 40>;
  sprintLength: Default<number, 10>;
  snapshots: Default<BurndownEntry[], []>;
}

interface LogMessageInput {
  day: number;
  burnedToday: number;
  totalBurned: number;
  remaining: number;
  note?: string;
}

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeScope = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 40;
  }
  return Math.max(0, roundToTwo(value));
};

const sanitizeSprintLength = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  const normalized = Math.max(1, Math.floor(value));
  return Math.min(normalized, 35);
};

const sanitizeCompleted = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, roundToTwo(value));
};

const sanitizeRemaining = (value: unknown, scope: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return scope;
  }
  const normalized = roundToTwo(value);
  if (normalized <= 0) return 0;
  if (normalized >= scope) return scope;
  return normalized;
};

const sanitizeDay = (
  value: unknown,
  sprintLength: number,
): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.floor(value));
  if (normalized > sprintLength) {
    return sprintLength;
  }
  return normalized;
};

const sanitizeSnapshots = (
  value: unknown,
  scope: number,
  sprintLength: number,
): BurndownEntry[] => {
  if (!Array.isArray(value)) {
    return [{ day: 0, remaining: scope }];
  }
  const map = new Map<number, BurndownEntry>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { day?: unknown; remaining?: unknown };
    const day = sanitizeDay(record.day, sprintLength);
    if (day === null) continue;
    const remaining = sanitizeRemaining(record.remaining, scope);
    map.set(day, { day, remaining });
  }
  map.set(0, { day: 0, remaining: scope });
  const result = Array.from(map.values());
  result.sort((left, right) => left.day - right.day);
  return result;
};

const upsertSnapshot = (
  history: readonly BurndownEntry[],
  entry: BurndownEntry,
): BurndownEntry[] => {
  const updated: BurndownEntry[] = [];
  let replaced = false;
  for (const item of history) {
    if (item.day === entry.day) {
      if (!replaced) {
        updated.push(entry);
        replaced = true;
      }
      continue;
    }
    updated.push(item);
  }
  if (!replaced) {
    updated.push(entry);
  }
  updated.sort((left, right) => left.day - right.day);
  return updated;
};

const findPreviousRemaining = (
  history: readonly BurndownEntry[],
  day: number,
  scope: number,
): number => {
  let previous = scope;
  for (const entry of history) {
    if (entry.day > day) break;
    previous = entry.remaining;
  }
  return previous;
};

const buildIdealLine = (
  scope: number,
  sprintLength: number,
): BurndownEntry[] => {
  if (sprintLength <= 0) {
    return [{ day: 0, remaining: scope }];
  }
  const length = Math.max(1, sprintLength);
  const result: BurndownEntry[] = [];
  for (let day = 0; day <= length; day++) {
    const ratio = day / length;
    const remaining = Math.max(0, roundToTwo(scope * (1 - ratio)));
    result.push({ day, remaining });
  }
  return result;
};

const buildBurndownCurve = (
  history: readonly BurndownEntry[],
  scope: number,
  sprintLength: number,
): BurndownCurvePoint[] => {
  const ideal = buildIdealLine(scope, sprintLength);
  const idealByDay = new Map<number, number>(
    ideal.map((entry) => [entry.day, entry.remaining] as const),
  );
  const dayToRemaining = new Map<number, number>();
  for (const entry of history) {
    dayToRemaining.set(entry.day, entry.remaining);
  }
  if (!dayToRemaining.has(0)) {
    dayToRemaining.set(0, scope);
  }
  const days = Array.from(dayToRemaining.keys()).sort((a, b) => a - b);
  const lastDay = days[days.length - 1] ?? 0;
  const lastRemaining = dayToRemaining.get(lastDay) ?? scope;
  const averageBurn = lastDay === 0
    ? 0
    : Math.max(0, roundToTwo((scope - lastRemaining) / lastDay));

  const points: BurndownCurvePoint[] = [];
  let projected = scope;
  for (let day = 0; day <= sprintLength; day++) {
    const actual = dayToRemaining.has(day) ? dayToRemaining.get(day)! : null;
    if (day === 0) {
      projected = scope;
    } else if (day <= lastDay) {
      if (actual !== null) {
        projected = actual;
      } else if (averageBurn > 0) {
        projected = Math.max(0, roundToTwo(projected - averageBurn));
      }
    } else if (averageBurn > 0) {
      projected = Math.max(0, roundToTwo(projected - averageBurn));
    }
    const idealRemaining = idealByDay.get(day) ??
      ideal[ideal.length - 1].remaining;
    points.push({ day, actual, projected, ideal: idealRemaining });
  }
  return points;
};

const appendLogEntry = (log: Cell<string[]>, entry: string) => {
  const previous = log.get();
  const list = Array.isArray(previous) ? previous.slice() : [];
  list.push(entry);
  const trimmed = list.length > 8 ? list.slice(-8) : list;
  log.set(trimmed);
};

const buildLogMessage = (input: LogMessageInput): string => {
  const summary =
    `Day ${input.day}: burned ${input.burnedToday} (total ${input.totalBurned})`;
  const remaining = ` remaining ${input.remaining}`;
  if (input.note && input.note.trim().length > 0) {
    return `${summary}${remaining} — ${input.note.trim()}`;
  }
  return `${summary}${remaining}`;
};

const logSprintProgress = handler(
  (
    event: SprintSnapshotEvent | undefined,
    context: {
      totalScope: Cell<number>;
      sprintLength: Cell<number>;
      snapshots: Cell<BurndownEntry[]>;
      log: Cell<string[]>;
    },
  ) => {
    const scope = sanitizeScope(context.totalScope.get());
    const length = sanitizeSprintLength(context.sprintLength.get());
    const history = sanitizeSnapshots(context.snapshots.get(), scope, length);

    const providedDay = sanitizeDay(event?.day, length);
    const lastRecorded = history[history.length - 1] ??
      { day: 0, remaining: scope };
    const candidateDay = providedDay ?? Math.min(lastRecorded.day + 1, length);

    const completed = sanitizeCompleted(event?.completed);
    const hasRemainingField = event ? Object.hasOwn(event, "remaining") : false;
    const explicitRemaining = hasRemainingField
      ? sanitizeRemaining(event?.remaining, scope)
      : null;

    const base = findPreviousRemaining(history, candidateDay, scope);
    const nextRemaining = explicitRemaining ?? Math.max(
      0,
      Math.min(scope, roundToTwo(base - completed)),
    );
    const updatedHistory = upsertSnapshot(history, {
      day: candidateDay,
      remaining: nextRemaining,
    });

    context.totalScope.set(scope);
    context.sprintLength.set(length);
    context.snapshots.set(updatedHistory);

    const burnedToday = roundToTwo(Math.max(0, base - nextRemaining));
    const totalBurned = roundToTwo(Math.max(0, scope - nextRemaining));
    const message = buildLogMessage({
      day: candidateDay,
      burnedToday,
      totalBurned,
      remaining: nextRemaining,
      note: typeof event?.note === "string" ? event?.note : undefined,
    });
    appendLogEntry(context.log, message);
  },
);

// Module-scope lift definitions
const liftScopeView = lift((value: number | undefined) => sanitizeScope(value));

const liftLengthView = lift((value: number | undefined) =>
  sanitizeSprintLength(value)
);

const liftHistoryView = lift((input: {
  list: BurndownEntry[];
  scope: number;
  length: number;
}) => sanitizeSnapshots(input.list, input.scope, input.length));

const liftLastDayView = lift((entries: BurndownEntry[]) => {
  const last = entries[entries.length - 1];
  return last ? last.day : 0;
});

const liftRemainingView = lift(
  (input: { history: BurndownEntry[]; scope: number }) => {
    const last = input.history[input.history.length - 1];
    return last ? last.remaining : input.scope;
  },
);

const liftBurnedView = lift((input: { scope: number; remaining: number }) => {
  return roundToTwo(Math.max(0, input.scope - input.remaining));
});

const liftCompletionView = lift((input: { burned: number; scope: number }) => {
  if (input.scope === 0) return 100;
  const ratio = (input.burned / input.scope) * 100;
  return Math.min(100, Math.max(0, Math.round(ratio)));
});

const liftIdealLine = lift((input: { scope: number; length: number }) =>
  buildIdealLine(input.scope, input.length)
);

const liftBurndownCurve = lift((input: {
  history: BurndownEntry[];
  scope: number;
  length: number;
}) => buildBurndownCurve(input.history, input.scope, input.length));

const liftActivityLogView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

export const sprintBurndown = pattern<SprintBurndownArgs>(
  ({ totalScope, sprintLength, snapshots }) => {
    const activityLog = cell<string[]>([]);

    const scopeView = liftScopeView(totalScope);

    const lengthView = liftLengthView(sprintLength);

    const historyView = liftHistoryView({
      list: snapshots,
      scope: scopeView,
      length: lengthView,
    });

    const lastDayView = liftLastDayView(historyView);

    const remainingView = liftRemainingView({
      history: historyView,
      scope: scopeView,
    });

    const burnedView = liftBurnedView({
      scope: scopeView,
      remaining: remainingView,
    });

    const completionView = liftCompletionView({
      burned: burnedView,
      scope: scopeView,
    });

    const idealLine = liftIdealLine({ scope: scopeView, length: lengthView });

    const burndownCurve = liftBurndownCurve({
      history: historyView,
      scope: scopeView,
      length: lengthView,
    });

    const activityLogView = liftActivityLogView(activityLog);

    const statusLabel =
      str`Day ${lastDayView}/${lengthView} — burned ${burnedView} (${completionView}%)`;

    return {
      totalScope: scopeView,
      sprintLength: lengthView,
      history: historyView,
      remaining: remainingView,
      burned: burnedView,
      completion: completionView,
      idealLine,
      burndownCurve,
      activityLog: activityLogView,
      statusLabel,
      logDay: logSprintProgress({
        totalScope,
        sprintLength,
        snapshots,
        log: activityLog,
      }),
    };
  },
);

export default sprintBurndown;
