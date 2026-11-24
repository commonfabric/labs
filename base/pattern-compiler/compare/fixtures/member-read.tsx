/// <cts-enable />
import { computed, pattern } from "commonfabric";

interface Item {
  key: string;
  title: string;
}

interface Place {
  replies: number;
}

// A `map` over an array of plain values in place whose row reads one
// member of a record by its element's key. `Stored`: the record is an input
// of the pattern, so the member is the chosen child of a `pick` over the
// stored record. `Computed`: the record is a member of a value a `computed`
// derives from every element, read by a static path and then by the key.
export const Stored = pattern<
  { items: Item[]; places: Record<string, Place> },
  { rows: { title: string; replies: number }[] }
>(({ items, places }) => ({
  rows: items.map((item) => ({
    title: item.title,
    replies: places[item.key]?.replies ?? 0,
  })),
}));

export const Computed = pattern<
  { items: Item[] },
  { count: number; rows: { title: string; replies: number }[] }
>(({ items }) => {
  const facts = computed(() => {
    const places: Record<string, Place> = {};
    for (const item of items) places[item.key] = { replies: item.title.length };
    return { count: items.length, places };
  });
  return {
    count: facts.count,
    rows: items.map((item) => ({
      title: item.title,
      replies: facts.places[item.key]?.replies ?? 0,
    })),
  };
});
