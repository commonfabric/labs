/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  shown: boolean;
}

interface Output {
  marked: { title: string; shown: boolean }[];
}

// A `filter` over the result of a `map` over `items`, an array of
// references or of plain values in place as the test gives it, whose
// elements are the records the `map` returns.
export default pattern<{ items: Item[] }, Output>(({ items }) => {
  const marked = items
    .map((item) => ({ title: item.title + "!", shown: item.shown }))
    .filter((row) => row.shown && row.title !== "!");
  return { marked };
});
