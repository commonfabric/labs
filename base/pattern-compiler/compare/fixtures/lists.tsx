/// <cts-enable />
import { type ArrayByKey, pattern } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

// One `map` over a list, for the measurement of `compare/growth.ts`: a
// test gives `items` as an array of references or as an array of plain
// values in place, with no declared key.
export const Plain = pattern<{ items: Item[] }>(({ items }) => {
  const rows = items.map((item) => ({ label: `${item.title}:${item.done}` }));
  return { rows };
});

// The same over an array of plain values in place whose type declares
// the key field `id`.
export const Keyed = pattern<{ items: ArrayByKey<Item, "id"> }>(
  ({ items }) => {
    const rows = items.map((item) => ({
      label: `${item.title}:${item.done}`,
    }));
    return { rows };
  },
);

// A `map` over the result of a `filter`, which is the result of another
// per-element construct.
export const Chained = pattern<{ items: Item[] }>(({ items }) => {
  const open = items.filter((item) => !item.done);
  const rows = open.map((item) => ({ label: `${item.title}:${item.done}` }));
  return { rows };
});
