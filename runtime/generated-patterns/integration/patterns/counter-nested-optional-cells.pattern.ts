import {
  type Cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

interface OptionalBranch {
  counter?: number;
  history?: number[];
  label?: string;
}

interface OptionalNested {
  branch?: OptionalBranch;
}

interface NestedOptionalState {
  nested?: OptionalNested;
}

interface NestedOptionalArgs {
  state: Default<NestedOptionalState, {}>;
}

interface IncrementEvent {
  amount?: number;
  label?: string;
}

interface ClearEvent {
  target?: "branch" | "nested";
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getNested = (
  value: NestedOptionalState | undefined,
): OptionalNested | undefined => {
  const nested = value?.nested;
  return isRecord(nested) ? nested as OptionalNested : undefined;
};

const getBranch = (
  nested: OptionalNested | undefined,
): OptionalBranch | undefined => {
  if (!nested) return undefined;
  const branch = nested.branch;
  return isRecord(branch) ? branch as OptionalBranch : undefined;
};

const normalizeHistory = (history: unknown): number[] => {
  if (!Array.isArray(history)) return [];
  return history.filter((entry): entry is number => typeof entry === "number");
};

const updateNestedState = handler(
  (
    event: IncrementEvent | undefined,
    context: { state: Cell<NestedOptionalState> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;

    const currentState = context.state.get() ?? {};
    const nested = getNested(currentState);
    const branch = getBranch(nested);

    const baseCounter = typeof branch?.counter === "number"
      ? branch.counter
      : 0;
    const nextCounter = baseCounter + amount;
    const baseHistory = normalizeHistory(branch?.history);

    let nextLabel = typeof branch?.label === "string"
      ? branch.label
      : undefined;
    if (typeof event?.label === "string") {
      const trimmed = event.label.trim();
      nextLabel = trimmed.length > 0 ? trimmed : undefined;
    }

    const nextBranch: OptionalBranch = {
      counter: nextCounter,
      history: [...baseHistory, nextCounter],
    };
    if (nextLabel !== undefined) {
      nextBranch.label = nextLabel;
    }

    context.state.set({ nested: { branch: nextBranch } });
  },
);

const clearNestedState = handler(
  (
    event: ClearEvent | undefined,
    context: { state: Cell<NestedOptionalState> },
  ) => {
    if (event?.target === "nested") {
      context.state.set({});
      return;
    }

    const currentState = context.state.get() ?? {};
    const nested = getNested(currentState);
    if (nested) {
      context.state.set({ nested: {} });
    } else {
      context.state.set({ nested: {} });
    }
  },
);

export const counterWithNestedOptionalCells = pattern<NestedOptionalArgs>(
  ({ state }) => {
    const current = computed(() => {
      const counter = state.nested?.branch?.counter;
      return typeof counter === "number" ? counter : 0;
    });
    const history = computed(() => {
      return normalizeHistory(state.nested?.branch?.history);
    });
    const branchTitle = computed(() => {
      const label = state.nested?.branch?.label;
      if (typeof label === "string" && label.length > 0) {
        return label;
      }
      return "Unnamed branch";
    });
    const hasNested = computed(() => {
      const nested = state.nested;
      return isRecord(nested);
    });
    const hasBranch = computed(() => {
      const nested = state.nested;
      if (!isRecord(nested)) return false;
      return isRecord(nested.branch);
    });
    const nestedIndicator = computed(() => hasNested ? "yes" : "no");
    const branchIndicator = computed(() => hasBranch ? "yes" : "no");
    const status = computed(
      () =>
        `Count ${current} (nested:${nestedIndicator} branch:${branchIndicator})`,
    );
    const label = str`${branchTitle} ${current}`;

    return {
      state,
      current,
      history,
      branchTitle,
      label,
      status,
      hasNested,
      hasBranch,
      increment: updateNestedState({ state }),
      clear: clearNestedState({ state }),
    };
  },
);

export default counterWithNestedOptionalCells;
