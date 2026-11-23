/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

interface Group {
  name: string;
  items: Item[];
}

// A grouping written in an element body: each group of an array of
// references has an index of its own items by tag, and its row holds the
// titles of the items tagged `even`. The number of groups stands beside
// the rows as a plain value.
export default pattern<
  { groups: Writable<Group[]> },
  { count: number; rows: { name: string; even: string[] }[] }
>(({ groups }) => {
  const rows = groups.map((group) => {
    const byTag = group.items.groupBy((item) => item.tag);
    return {
      name: group.name,
      even: byTag.lookup("even").map((item) => item.title),
    };
  });
  return { count: groups.get().length, rows };
});
