import { type Cell, cell, Default, handler, lift, pattern } from "commonfabric";

interface Item {
  id?: string;
}

const action = handler(
  (_event, context: { items: Cell<Item[]>; sequence: Cell<number> }) => {
    // Minimal repro: Removing either of these removes the conflict
    context.items.set([]);
    context.sequence.set(context.sequence.get() + 1);
  },
);

// Module-scope lift definition
const liftMapItems = lift((item: Item[]) => item.map((_) => ({})));

export const conflictRepro = pattern<{ items: Default<Item[], []> }>(
  ({ items }) => {
    const sequence = cell(0);

    // Minimal repro: Removing the lift and the map removes the conflict
    liftMapItems(items);

    return {
      action: action({
        items,
        sequence,
      }),
    };
  },
);

export default conflictRepro;
