/// <cts-enable />
import { type Cell, pattern } from "commonfabric";

interface Item {
  title: string;
  n: number;
}

type ItemCell = Cell<Item>;

/** The cell of the stored item at `index` of `items`. */
const itemAt = (items: Cell<Item[]>, index: number): ItemCell => {
  const cell: ItemCell = items.key(index);
  return cell.resolveAsCell();
};

// A `map` over an array of references whose row holds the cell of its own
// item, which its body names by the position of the item in the array and
// does not read, beside a value it derives from the item.
export default pattern<
  { items: Cell<Item[]> },
  { rows: { item: ItemCell; big: boolean }[] }
>(({ items }) => ({
  rows: items.map((record, index) => ({
    item: itemAt(items, index),
    big: record.n > 1,
  })),
}));
