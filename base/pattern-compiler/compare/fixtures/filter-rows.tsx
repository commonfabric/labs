/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  shown: boolean;
}

interface Output {
  shown: Item[];
  titled: Item[];
}

// `shown` is a `filter` over `items`, an array of references or of plain
// values in place as the test gives it, whose predicate reads the title as
// well, and `titled` a `filter` over the result of `shown`, another
// per-element construct, whose elements are those of `items`.
export default pattern<{ items: Item[] }, Output>(({ items }) => {
  const shown = items.filter((item) => item.shown && item.title !== "");
  const titled = shown.filter((item) => item.title !== "skip");
  return { shown, titled };
});
