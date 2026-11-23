/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

interface Tag {
  name: string;
}

interface Row {
  name: string;
  titles: string[];
}

// A grouping of an array of references by a field of each member, and a
// keyed join: a `map` over a second array of references whose body looks
// up the group of its own key.
export const Joined = pattern<
  { items: Writable<Item[]>; tags: Writable<Tag[]> },
  { rows: Row[] }
>(({ items, tags }) => {
  const byTag = items.groupBy((item) => item.tag);
  const rows = tags.map((tag) => ({
    name: tag.name,
    titles: byTag.lookup(tag.name).map((item) => item.title),
  }));
  return { rows };
});
