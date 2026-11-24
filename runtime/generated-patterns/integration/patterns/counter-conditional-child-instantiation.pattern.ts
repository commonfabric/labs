import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  pattern,
  str,
} from "commonfabric";

const sanitizeCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const resolveAmount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.trunc(value);
};

const normalizeEnabled = (flag: boolean | undefined): boolean => flag === true;

const formatActiveStatus = (flag: boolean): string => flag ? "active" : "idle";

const formatChildStatus = (active: boolean): string =>
  active ? "present" : "absent";

const checkChildGuard = (state: {
  active: boolean;
  seed: number;
  snapshot: ChildCounterState | undefined;
}): boolean => state.active;

const adjustParent = handler(
  (
    event: { amount?: number } | number | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event === "number"
      ? resolveAmount(event)
      : resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

const toggleEnabled = handler(
  (_event: unknown, context: { enabled: Cell<boolean> }) => {
    const current = context.enabled.get() === true;
    context.enabled.set(!current);
  },
);

const adjustChild = handler(
  (
    event: { amount?: number },
    context: { value: Cell<number> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

interface ChildCounterState {
  value: number;
  current: number;
  label: string;
  increment: { amount?: number };
}

const _conditionalChild = pattern<
  { value: Default<number, 0> },
  ChildCounterState
>(
  ({ value }) => {
    const current = computed(() => sanitizeCount(value));
    const label = str`Child value ${current}`;
    return {
      value,
      current,
      label,
      increment: adjustChild({ value }),
    };
  },
);

interface ConditionalChildArgs {
  value: Default<number, 0>;
  enabled: Default<boolean, false>;
}

export const counterWithConditionalChildInstantiation = pattern<
  ConditionalChildArgs
>(
  ({ value, enabled }) => {
    const safeValue = computed(() => sanitizeCount(value));
    const isActive = computed(() => normalizeEnabled(enabled));
    const activeStatus = computed(() => formatActiveStatus(isActive));
    const childSlot = cell<ChildCounterState | undefined>(undefined);
    const childGuard = computed(() =>
      checkChildGuard({
        active: isActive,
        seed: safeValue,
        snapshot: childSlot.get(),
      })
    );
    const childStatus = computed(() => formatChildStatus(isActive));
    const label =
      str`Parent ${safeValue} (${activeStatus}) child ${childStatus}`;

    return {
      value,
      enabled,
      current: safeValue,
      isActive,
      label,
      childStatus,
      child: childSlot,
      toggle: toggleEnabled({ enabled }),
      increment: adjustParent({ value }),
      effects: { childGuard },
    };
  },
);

export default counterWithConditionalChildInstantiation;
