import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface AlternateInitialStateSeed {
  id?: string;
  label?: string;
  value?: number;
  step?: number;
}

interface AlternateInitialState {
  id: string;
  label: string;
  value: number;
  step: number;
}

interface SelectionLogEntry {
  id: string;
  value: number;
  step: number;
  reason: string;
  index: number;
}

interface AlternateInitialStatesArgs {
  states: Default<
    AlternateInitialStateSeed[],
    typeof defaultInitialStateSeeds
  >;
}

interface SelectInitialEvent {
  id?: string;
  reason?: string;
}

interface IncrementEvent {
  amount?: number;
}

const defaultInitialStateSeeds = [
  { id: "baseline", label: "Baseline", value: 0, step: 1 },
  { id: "boost", label: "Momentum Boost", value: 8, step: 3 },
] satisfies AlternateInitialStateSeed[];

const fallbackState = (): AlternateInitialState => ({
  id: "baseline",
  label: "Baseline",
  value: 0,
  step: 1,
});

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const toPositiveStep = (input: unknown, fallback: number): number => {
  const value = toFiniteNumber(input, fallback);
  if (value > 0) {
    return value;
  }
  return fallback > 0 ? fallback : 1;
};

const toStateId = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const toLabel = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeStateSeeds = (
  seeds: AlternateInitialStateSeed[] | undefined,
): AlternateInitialState[] => {
  if (!Array.isArray(seeds)) {
    return [fallbackState()];
  }

  const sanitized: AlternateInitialState[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    if (!seed || typeof seed !== "object") continue;
    const provisionalId = toStateId(
      (seed as { id?: unknown }).id,
      `state-${sanitized.length + 1}`,
    );
    if (seen.has(provisionalId)) continue;
    seen.add(provisionalId);

    const label = toLabel((seed as { label?: unknown }).label, provisionalId);
    const value = toFiniteNumber(
      (seed as { value?: unknown }).value,
      fallbackState().value,
    );
    const step = toPositiveStep(
      (seed as { step?: unknown }).step,
      fallbackState().step,
    );

    sanitized.push({ id: provisionalId, label, value, step });
  }

  if (sanitized.length === 0) {
    sanitized.push(fallbackState());
  }

  return sanitized;
};

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const stepSize = toPositiveStep(context.step.get(), 1);
    const amount = toFiniteNumber(event?.amount, stepSize);
    const current = toFiniteNumber(context.value.get(), 0);
    context.value.set(current + amount);
  },
);

const selectInitialState = handler(
  (
    event: SelectInitialEvent | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      activeId: Cell<string>;
      states: Cell<AlternateInitialState[]>;
      log: Cell<SelectionLogEntry[]>;
    },
  ) => {
    const available = context.states.get();
    const baseList = Array.isArray(available) && available.length > 0
      ? available
      : [fallbackState()];

    const requestedId = toStateId(event?.id, baseList[0].id);
    const target = baseList.find((entry) => entry.id === requestedId) ??
      baseList[0];

    context.activeId.set(target.id);
    context.value.set(target.value);
    context.step.set(target.step);

    const existing = context.log.get();
    const history = Array.isArray(existing) ? existing.slice() : [];
    const index = history.length + 1;
    const entry: SelectionLogEntry = {
      id: target.id,
      value: target.value,
      step: target.step,
      reason: toLabel(event?.reason, "selectInitial"),
      index,
    };
    history.push(entry);
    context.log.set(history);
  },
);

const liftSanitizeStateSeeds = lift(sanitizeStateSeeds);

const liftActiveState = lift(
  (
    input:
      | {
        states?: AlternateInitialState[];
        active?: Cell<string>;
      }
      | undefined,
  ): AlternateInitialState => {
    const candidate = Array.isArray(input?.states)
      ? input?.states?.slice() ?? []
      : [];
    const list = candidate.length > 0 ? candidate : [fallbackState()];
    const desiredId = toStateId(input?.active?.get(), list[0].id);
    return list.find((entry) => entry.id === desiredId) ?? list[0];
  },
);

export const counterWithAlternateInitialStates = pattern<
  AlternateInitialStatesArgs
>(({ states }) => {
  const sanitizedStates = liftSanitizeStateSeeds(states);

  const activeStateId = cell(fallbackState().id);
  const valueCell = cell(0);
  const stepCell = cell(1);
  const selectionLog = cell<SelectionLogEntry[]>([]);

  const activeState = liftActiveState({
    states: sanitizedStates,
    active: activeStateId,
  });

  const selectionCount = Array.isArray(selectionLog.get())
    ? selectionLog.get().length
    : 0;

  const label = str`State ${activeState.label}=${valueCell} (step ${stepCell})`;

  return {
    value: valueCell,
    step: stepCell,
    activeStateId,
    activeState,
    availableStates: sanitizedStates,
    label,
    selectionLog,
    selectionCount,
    increment: applyIncrement({ value: valueCell, step: stepCell }),
    selectInitial: selectInitialState({
      value: valueCell,
      step: stepCell,
      activeId: activeStateId,
      states: sanitizedStates,
      log: selectionLog,
    }),
  };
});

export default counterWithAlternateInitialStates;
