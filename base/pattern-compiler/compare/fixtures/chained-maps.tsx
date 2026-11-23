/// <cts-enable />
import { pattern, type Writable } from "commonfabric";

interface Note {
  text: string;
}

interface Item {
  tag: string;
  note: Note;
}

// Two `map`s in a chain. The first is over an array of references and
// gives a row for each item that holds the item's tag and a text reached
// through the item's reference to its note; the row holds each as a
// reference to where the item stores it. The second is over the result of
// the first and computes a text from the value that each of those
// references names. The number of items stands beside the two arrays, so
// that the result holds a plain value that no item's content decides.
export default pattern<
  { items: Writable<Item[]> },
  { count: number; tags: string[]; texts: string[] }
>(({ items }) => {
  const rows = items.map((item) => ({ tag: item.tag, text: item.note.text }));
  return {
    count: items.get().length,
    tags: rows.map((row) => row.tag + "!"),
    texts: rows.map((row) => row.text + "!"),
  };
});
