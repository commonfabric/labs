import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  pattern,
  str,
} from "commonfabric";

interface ConditionalBranchArgs {
  value: Default<number, 0>;
  enabled: Cell<Default<boolean, false>>;
}

const sanitizeCount = (count: number | undefined): number =>
  typeof count === "number" ? count : 0;

const sanitizeEnabled = (flag: boolean | undefined): boolean => flag === true;

const extractStatus = (choice: { status: string }): string => choice.status;

const toggleFlag = handler(
  (_event: unknown, context: { enabled: Cell<boolean> }) => {
    const current = context.enabled.get() ?? false;
    context.enabled.set(!current);
  },
);

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithConditionalBranch = pattern<ConditionalBranchArgs>(
  ({ value, enabled }) => {
    const safeValue = computed(() => sanitizeCount(value));
    const active = computed(() => sanitizeEnabled(enabled.get()));
    const branchChoice = ifElse(enabled, { status: "Enabled" }, {
      status: "Disabled",
    });
    const branch = computed(() => extractStatus(branchChoice));
    const label = str`${branch} ${safeValue}`;

    return {
      value,
      enabled,
      active,
      current: safeValue,
      branch,
      label,
      toggle: toggleFlag({ enabled }),
      increment: adjustValue({ value }),
    };
  },
);

export default counterWithConditionalBranch;
