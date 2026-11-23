/// <cts-enable />
import { type GroupIndex, pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

// A reader of an index that another instance keeps: it looks up one key in
// the index it is handed and gives the titles of the bucket's members.
export const Reader = pattern<
  { index: GroupIndex<string, Item>; name: string },
  { name: string; titles: string[] }
>(({ index, name }) => ({
  name,
  titles: index.lookup(name).map((item) => item.title),
}));

// A grouping of an array of references that the pattern keeps in its
// result, beside the number of the members.
export default pattern<
  { items: Writable<Item[]> },
  { count: number; byTag: GroupIndex<string, Item> }
>(({ items }) => ({
  count: items.get().length,
  byTag: items.groupBy((item) => item.tag),
}));
