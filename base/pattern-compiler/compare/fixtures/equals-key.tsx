/// <cts-enable />
import { Default, equalsKey, lift, pattern, type ReadonlyCell } from "commonfabric";

interface Item {
  name: string;
}

// The distinct references of a list, found by the key of what `equals`
// compares (provisional decision P32).
const distinct = lift(
  ({ items }: { items: ReadonlyCell<Item>[] | Default<[]> }): number => {
    const seen = new Set<unknown>();
    for (const item of Array.from(items)) seen.add(equalsKey(item) ?? item);
    return seen.size;
  },
);

export default pattern<{ items: Item[] }>(({ items }) => ({
  count: distinct({ items }),
}));
