/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

const add = handler<{ title: string }, { items: Writable<Item[]> }>(
  (event, { items }) => {
    items.push({ title: event.title });
  },
);

const note = handler<{ text: string }, { memo: Writable<string> }>(
  (event, { memo }) => {
    memo.set(event.text);
  },
);

const hide = handler<{ title: string }, { hidden: Writable<string> }>(
  (event, { hidden }) => {
    hidden.set(event.title);
  },
);

// Ruling Z18: the removal of an element deletes nothing that is stored
// under its key, and an element that returns under the same key reads
// what its state cells held. `memo` is a cell of an element body over
// the result of a `filter`, so a key leaves the collection of the body
// when `hidden` names it and returns when `hidden` names another, and
// also when it leaves and enters the source. The source of `rows` is an
// array of records that a handler pushed, which are references to cells,
// and that of `labels` an array of plain values in place.
export default pattern<{ words: string[] }>(({ words }) => {
  const items = Writable.of<Item[]>([]);
  const hidden = Writable.of("");
  return {
    items,
    hidden,
    rows: items.filter((item) => item.title !== hidden.get()).map((item) => {
      const memo = Writable.of("");
      return { title: item.title, memo, note: note({ memo }) };
    }),
    labels: words.filter((word) => word !== hidden.get()).map((word) => {
      const memo = Writable.of("");
      return { word, memo, note: note({ memo }) };
    }),
    add: add({ items }),
    hide: hide({ hidden }),
  };
});
