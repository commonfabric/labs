/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

// The elements of a `filter` as a write record reports them (provisional
// decision P31): `kept` over an array of plain values in place, `open`
// over `items`, which a test gives as an array of references, and `loud`
// over the result of a `map`.
export default pattern<{ tags: string[]; items: Item[] }>(
  ({ tags, items }) => {
    const kept = tags.filter((tag) => tag !== "skip");
    const open = items.filter((item) => !item.done);
    const loud = tags.map((tag) => tag + "!").filter((tag) => tag !== "skip!");
    return { kept, open, loud };
  },
);
