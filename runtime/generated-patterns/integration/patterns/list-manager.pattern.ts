import {
  Cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface Item {
  label: string;
  count: number;
}

interface ListManagerArgs {
  items: Default<Item[], []>;
}

// Module-scope lift definitions
const liftSize = lift((collection: Item[]) => collection.length);

const addItem = handler(
  (
    event: { label?: string; count?: number } | undefined,
    context: { items: Cell<Item[]> },
  ) => {
    const label = event?.label ?? "untitled";
    const count = typeof event?.count === "number" ? event.count : 0;
    context.items.push({ label, count });
  },
);

const incrementItem = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: { items: Cell<Item[]> },
  ) => {
    const index = event?.index ?? 0;
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target: Cell<Item> = context.items.key(index);
    const countCell = target.key("count");
    const current = countCell.get() ?? 0;
    countCell.set(current + amount);
  },
);

export const listManager = pattern<ListManagerArgs>(
  ({ items }) => {
    const size = liftSize(items);
    const names = computed(() => items.map((item) => item.label));

    return {
      summary: str`Items: ${size}`,
      items,
      names,
      controls: {
        add: addItem({ items }),
        increment: incrementItem({ items }),
      },
    };
  },
);

export default listManager;
