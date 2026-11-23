/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  rank: number;
}

// A `map` over a sort by a key of an array of references, whose rows are
// records: a card for each item, in the order of the ranks. The number of
// items is a plain value of the result.
export default pattern<
  { items: Writable<Item[]> },
  { count: number; cards: { title: string }[] }
>(({ items }) => ({
  count: items.get().length,
  cards: items.sortBy((item) => item.rank).map((item) => ({
    title: item.title,
  })),
}));
