/// <cts-enable />
import { type Cell, handler, pattern, type Stream } from "commonfabric";

interface Item {
  text: string;
  shown: boolean;
}

const add = handler<
  { text: string; shown?: boolean },
  { items: Cell<Item[]> }
>(
  (event, { items }) => {
    items.push({ text: event.text, shown: event.shown ?? true });
  },
);

// Windows of a collection: the last three and the first two of an array of
// references, the last three of the result of a `filter` over it, and the
// last two of the result of a `map` over it. A window holds the elements
// of its source, passed through, so `latest` holds a link to each of the
// three newest items.
export default pattern<
  { items: Cell<Item[]> },
  {
    latest: Item[];
    oldest: Item[];
    latestShown: Item[];
    texts: string[];
    lastTexts: string[];
    add: Stream<{ text: string; shown?: boolean }>;
  }
>(({ items }) => {
  const shown = items.filter((item) => item.shown);
  const latest = items.last(3);
  return {
    latest,
    oldest: items.first(2),
    latestShown: shown.last(3),
    texts: latest.map((item) => item.text),
    lastTexts: items.map((item) => item.text).last(2),
    add: add({ items }),
  };
});
