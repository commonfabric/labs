/// <cts-enable />
import { type GroupIndex, pattern, type Writable } from "commonfabric";

interface Note {
  text: string;
}

interface Item {
  tag: string;
  note: Note;
}

interface Row {
  tag: string;
  text: string;
}

// A grouping over the result of another per-element construct: a `map`
// over an array of references gives a row for each item, with the item's
// tag and a text read through the item's reference to its note, and the
// rows are grouped by the tag. A bucket then holds rows, which are copies
// of what the bodies computed and no references to the items. The result
// keeps the index, and beside it the texts of the bucket of one tag that
// the argument names, and the number of items.
export default pattern<
  { items: Writable<Item[]>; pick: string },
  { count: number; byTag: GroupIndex<string, Row>; picked: string[] }
>(({ items, pick }) => {
  const rows = items.map((item) => ({ tag: item.tag, text: item.note.text }));
  const byTag = rows.groupBy((row) => row.tag);
  return {
    count: items.get().length,
    byTag,
    picked: byTag.lookup(pick).map((row) => row.text),
  };
});
