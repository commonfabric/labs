/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  rank: number;
}

// A sort by a key over an array of references, and a `map` over the result:
// the titles of the items in the order of their ranks, and beside them the
// first title of each item, from a `map` over the array itself, sorted by
// that row's own text, which is a sort over the result of another
// per-element construct. The number of items is a plain value of the
// result.
export default pattern<
  { items: Writable<Item[]> },
  { count: number; titles: string[]; initials: string[] }
>(({ items }) => {
  const ordered = items.sortBy((item) => item.rank);
  const rows = items.map((item) => ({
    initial: item.title,
    weight: item.rank,
  }));
  const light = rows.sortBy((row) => -row.weight);
  return {
    count: items.get().length,
    titles: ordered.map((item) => item.title),
    initials: light.map((row) => row.initial),
  };
});
