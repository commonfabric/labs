import {
  Cell,
  cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

type LoadingState = {
  status: "loading";
  attempts: number;
  note: string;
};

type ReadyState = {
  status: "ready";
  attempts: number;
  note: string;
  value: number;
  history: number[];
};

type CounterUnionState = LoadingState | ReadyState;

interface ComplexUnionArgs {
  state: Default<
    CounterUnionState,
    { status: "loading"; attempts: 0; note: "booting" }
  >;
  initialValue: Default<number, 0>;
}

const READY_NOTE = "ready";

const normalizeUnionState = (
  value: CounterUnionState | undefined,
): CounterUnionState => {
  if (!value) {
    return {
      status: "loading" as const,
      attempts: 0,
      note: "booting",
    } satisfies LoadingState;
  }
  if (value.status === "loading") {
    return {
      status: "loading" as const,
      attempts: value.attempts,
      note: value.note,
    } satisfies LoadingState;
  }
  return {
    status: "ready" as const,
    attempts: value.attempts,
    note: value.note,
    value: value.value,
    history: Array.isArray(value.history) ? value.history : [value.value],
  } satisfies ReadyState;
};

const extractReadyValue = (current: CounterUnionState): number =>
  current.status === "ready" ? current.value : 0;

const extractHistoryView = (current: CounterUnionState): number[] =>
  current.status === "ready" ? current.history : [];

const extractAttemptCount = (current: CounterUnionState): number =>
  current.attempts;

const countHistory = (items: number[] | undefined): number =>
  Array.isArray(items) ? items.length : 0;

const pushTransition = (
  logCell: Cell<string[]>,
  entry: string,
) => {
  const current = logCell.get();
  const history = Array.isArray(current) ? current : [];
  logCell.set([...history, entry]);
};

const startLoading = handler(
  (
    event: { note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      history: Cell<string[]>;
    },
  ) => {
    const nextNote = typeof event?.note === "string" ? event.note : "booting";
    const current = context.state.get();
    const attempts = current?.status === "loading"
      ? current.attempts + 1
      : (current?.attempts ?? 0) + 1;
    context.state.set({
      status: "loading",
      attempts,
      note: nextNote,
    });
    pushTransition(
      context.history,
      `loading:${attempts}:${nextNote}`,
    );
  },
);

const completeLoading = handler(
  (
    event: { value?: number; note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      initialValue: Cell<number>;
      history: Cell<string[]>;
      readyNote: Cell<string>;
    },
  ) => {
    const fallback = context.initialValue.get();
    const base = typeof event?.value === "number"
      ? event.value
      : typeof fallback === "number"
      ? fallback
      : 0;
    const readyLabel = typeof event?.note === "string"
      ? event.note
      : context.readyNote.get();
    const attempts = context.state.get()?.attempts ?? 0;
    const readyState: ReadyState = {
      status: "ready",
      attempts,
      note: readyLabel ?? "ready",
      value: base,
      history: [base],
    };
    context.state.set(readyState);
    pushTransition(
      context.history,
      `ready:${readyState.value}:${readyLabel}`,
    );
  },
);

const incrementReady = handler(
  (
    event: { amount?: number; note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      history: Cell<string[]>;
    },
  ) => {
    const current = context.state.get();
    if (!current || current.status !== "ready") {
      return;
    }
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const note = typeof event?.note === "string" ? event.note : current.note;
    const nextValue = current.value + amount;
    const nextHistory = [...current.history, nextValue];
    const nextState: ReadyState = {
      status: "ready",
      attempts: current.attempts,
      note,
      value: nextValue,
      history: nextHistory,
    };
    context.state.set(nextState);
    pushTransition(
      context.history,
      `increment:${nextValue}:${note}`,
    );
  },
);

export const counterWithComplexUnionState = pattern<ComplexUnionArgs>(
  ({ state, initialValue }) => {
    const defaultReadyNote = cell(READY_NOTE);
    const unionState = computed(() => normalizeUnionState(state));

    const transitions = cell<string[]>([]);

    const mode = unionState.status;
    const readyValue = computed(() => extractReadyValue(unionState));
    const historyView = computed(() => extractHistoryView(unionState));
    const attemptCount = computed(() => extractAttemptCount(unionState));
    const historyCount = computed(() => countHistory(historyView));
    const summary =
      str`mode:${mode} value:${readyValue} attempts:${attemptCount} history:${historyCount}`;

    return {
      state: unionState,
      mode,
      readyValue,
      historyView,
      attemptCount,
      summary,
      transitions,
      load: completeLoading({
        state,
        initialValue,
        history: transitions,
        readyNote: defaultReadyNote,
      }),
      increment: incrementReady({ state, history: transitions }),
      reset: startLoading({ state, history: transitions }),
    };
  },
);

export default counterWithComplexUnionState;
