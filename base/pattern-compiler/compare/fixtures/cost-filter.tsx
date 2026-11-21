/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

// A `filter` whose cost per change `template-cost.ts` measures, over an
// array of plain values in place or an array of references, as the test
// gives `items`.
export default pattern<{ items: Item[] }>(({ items }) => {
  const open = items.filter((item) => !item.done);
  return { open };
});
