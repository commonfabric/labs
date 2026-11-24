/// <cts-enable />
import { type Cell, computed, equalsKey, pattern } from "commonfabric";

interface Item {
  title: string;
  n: number;
}

type ItemCell = Cell<Item>;

/** The cell of the stored item at `index` of `items`. */
const itemAt = (items: Cell<Item[]>, index: number): ItemCell => {
  const cell: ItemCell = items.key(index);
  return cell;
};

/** The key of the cell that `item` resolves to. */
const keyOf = (item: ItemCell): string | undefined =>
  equalsKey(item.resolveAsCell());

// A `map` over an array of references whose row holds the cell of its own
// item, and a `computed` over the result of that `map` that resolves the
// cell of each row: the body is handed each row's cell as a handle.
export default pattern<
  { items: Cell<Item[]> },
  { keys: (string | undefined)[]; big: number }
>(({ items }) => {
  const rows = items.map((record, index) => ({
    item: itemAt(items, index),
    big: record.n > 1,
  }));
  const keys = computed(() => {
    const found: (string | undefined)[] = [];
    for (const row of rows) found.push(keyOf(row.item));
    return found;
  });
  const big = computed(() => rows.filter((row) => row.big).length);
  return { keys, big };
});
