import {
  type Cell,
  computed,
  Default,
  handler,
  ifElse,
  pattern,
  str,
} from "commonfabric";

interface ConditionalIfElseArgs {
  value: Default<number, 0>;
  visible: Default<boolean, false>;
}

interface BranchNode {
  kind: "enabled" | "disabled";
  tree: {
    header: string;
    variant: "primary" | "muted";
    description: string;
  };
}

const sanitizeValue = (count: number | undefined): number =>
  typeof count === "number" ? count : 0;

const normalizeVisible = (flag: boolean | undefined): boolean => flag === true;

const extractBranchKind = (node: BranchNode): "enabled" | "disabled" =>
  node.kind;

const extractBranchHeader = (node: BranchNode): string => node.tree.header;

const extractBranchVariant = (node: BranchNode): "primary" | "muted" =>
  node.tree.variant;

const extractBranchDescription = (node: BranchNode): string =>
  node.tree.description;

const toggleVisibility = handler(
  (_event: unknown, context: { visible: Cell<boolean> }) => {
    const current = context.visible.get() ?? false;
    context.visible.set(!current);
  },
);

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

export const counterWithConditionalUiBranch = pattern<ConditionalIfElseArgs>(
  ({ value, visible }) => {
    const safeValue = computed(() => sanitizeValue(value));
    const isVisible = computed(() => normalizeVisible(visible));

    const branchTree = ifElse<boolean, BranchNode, BranchNode>(
      isVisible,
      {
        kind: "enabled" as const,
        tree: {
          header: "Enabled Panel",
          variant: "primary" as const,
          description: "Counter is interactive",
        },
      },
      {
        kind: "disabled" as const,
        tree: {
          header: "Disabled Panel",
          variant: "muted" as const,
          description: "Counter is hidden",
        },
      },
    );

    const branchKind = computed(() => extractBranchKind(branchTree));
    const branchHeader = computed(() => extractBranchHeader(branchTree));
    const branchVariant = computed(() => extractBranchVariant(branchTree));
    const branchDescription = computed(() =>
      extractBranchDescription(branchTree)
    );

    const label = str`${branchHeader} ${safeValue}`;
    const status = str`${branchKind} (${branchVariant})`;

    return {
      value,
      visible,
      safeValue,
      isVisible,
      branchKind,
      branchHeader,
      branchVariant,
      branchDescription,
      label,
      status,
      view: branchTree,
      toggle: toggleVisibility({ visible }),
      increment: adjustValue({ value }),
    };
  },
);

export default counterWithConditionalUiBranch;
