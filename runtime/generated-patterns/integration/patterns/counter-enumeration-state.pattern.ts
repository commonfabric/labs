import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type CounterState = "idle" | "running" | "paused" | "complete";

interface EnumerationArgs {
  state: Default<CounterState, "idle">;
  value: Default<number, 0>;
}

interface TransitionRecord {
  from: CounterState;
  to: CounterState;
  kind: "advance" | "retreat" | "reset" | "tick";
  note: string;
}

interface TransitionEvent {
  note?: string;
}

interface TickEvent {
  amount?: number;
  note?: string;
}

const STATE_SEQUENCE: readonly CounterState[] = [
  "idle",
  "running",
  "paused",
  "complete",
] as const;

const clampState = (input: unknown): CounterState => {
  if (input === "running" || input === "paused" || input === "complete") {
    return input;
  }
  return "idle";
};

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return fallback;
  }
  return input;
};

const toNote = (input: unknown, fallback: string): string => {
  return typeof input === "string" && input.length > 0 ? input : fallback;
};

const recordTransition = (
  history: Cell<TransitionRecord[]>,
  sequence: Cell<number>,
  record: TransitionRecord,
) => {
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  history.set([...list, record]);

  const currentId = toNumber(sequence.get(), 0);
  const nextId = currentId + 1;
  sequence.set(nextId);
};

const advanceState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    const index = STATE_SEQUENCE.indexOf(current);
    const next = index < STATE_SEQUENCE.length - 1
      ? STATE_SEQUENCE[index + 1]
      : current;
    if (next === current) {
      return;
    }
    context.state.set(next);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: next,
      kind: "advance",
      note: toNote(event?.note, `advance:${current}->${next}`),
    });
  },
);

const retreatState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    const index = STATE_SEQUENCE.indexOf(current);
    const next = index > 0 ? STATE_SEQUENCE[index - 1] : current;
    if (next === current) {
      return;
    }
    context.state.set(next);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: next,
      kind: "retreat",
      note: toNote(event?.note, `retreat:${current}->${next}`),
    });
  },
);

const resetState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      value: Cell<number>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    context.state.set("idle");
    context.value.set(0);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: "idle",
      kind: "reset",
      note: toNote(event?.note, `reset:${current}`),
    });
  },
);

const tickValue = handler(
  (
    event: TickEvent | undefined,
    context: {
      state: Cell<CounterState>;
      value: Cell<number>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    if (current !== "running") {
      return;
    }
    const amount = toNumber(event?.amount, 1);
    const currentValue = toNumber(context.value.get(), 0);
    const nextValue = currentValue + amount;
    context.value.set(nextValue);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: current,
      kind: "tick",
      note: toNote(event?.note, `tick:+${amount}=${nextValue}`),
    });
  },
);

const liftNormalizedState = lift(
  (input: CounterState | undefined) => clampState(input),
);
const liftNormalizedValue = lift((input: number | undefined) =>
  toNumber(input, 0)
);
const liftTransitionView = lift(
  (input: TransitionRecord[] | undefined) => Array.isArray(input) ? input : [],
);
const liftTransitionCount = lift((list: TransitionRecord[] | undefined) =>
  Array.isArray(list) ? list.length : 0
);
const liftStateIndex = lift((current: CounterState) =>
  STATE_SEQUENCE.indexOf(current)
);
const liftCanAdvance = lift((index: number) =>
  index < STATE_SEQUENCE.length - 1
);
const liftCanRetreat = lift((index: number) => index > 0);
const liftIsRunning = lift((current: CounterState) => current === "running");

export const counterWithEnumerationState = pattern<EnumerationArgs>(
  ({ state, value }) => {
    const transitions = cell<TransitionRecord[]>([]);
    const transitionSequence = cell(0);

    const normalizedState = liftNormalizedState(state);
    const normalizedValue = liftNormalizedValue(value);
    const transitionView = liftTransitionView(transitions);
    const transitionCount = liftTransitionCount(transitionView);

    const stateIndex = liftStateIndex(normalizedState);
    const canAdvance = liftCanAdvance(stateIndex);
    const canRetreat = liftCanRetreat(stateIndex);
    const isRunning = liftIsRunning(normalizedState);

    const phaseLabel =
      str`state:${normalizedState} index:${stateIndex} value:${normalizedValue}`;
    const summary = str`transitions:${transitionCount} running:${isRunning}`;

    return {
      state: normalizedState,
      value: normalizedValue,
      stateIndex,
      canAdvance,
      canRetreat,
      isRunning,
      phaseLabel,
      summary,
      transitions: transitionView,
      transitionCount,
      advance: advanceState({
        state,
        history: transitions,
        sequence: transitionSequence,
      }),
      retreat: retreatState({
        state,
        history: transitions,
        sequence: transitionSequence,
      }),
      reset: resetState({
        state,
        value,
        history: transitions,
        sequence: transitionSequence,
      }),
      tick: tickValue({
        state,
        value,
        history: transitions,
        sequence: transitionSequence,
      }),
    };
  },
);

export default counterWithEnumerationState;
