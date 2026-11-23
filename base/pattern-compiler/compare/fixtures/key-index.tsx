/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

interface Tag {
  name: string;
}

// An index of an array of references in `key` mode: `keyBy` files each
// item under its tag, and a lookup gives the first item of a tag in the
// order of the array, or nothing. A `map` over a second array of
// references looks up the item of each tag. The number of tags stands
// beside the rows as a plain value.
export default pattern<
  { items: Writable<Item[]>; tags: Writable<Tag[]> },
  { count: number; rows: { name: string; first: string }[] }
>(({ items, tags }) => {
  const byTag = items.keyBy((item) => item.tag);
  const rows = tags.map((tag) => ({
    name: tag.name,
    first: byTag.lookup(tag.name)?.title ?? "",
  }));
  return { count: tags.get().length, rows };
});
