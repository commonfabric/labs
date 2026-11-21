/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

// A `filter` over the result of a `map`, whose cost per change
// `template-cost.ts` measures.
export default pattern<{ items: Item[] }>(({ items }) => {
  const loud = items.map((item) => item.title + "!").filter((title) =>
    title !== "skip!"
  );
  return { loud };
});
