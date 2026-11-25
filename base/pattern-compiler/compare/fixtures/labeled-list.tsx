/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
}

// A list that holds the items it is given, so that a pattern given the
// list's `items` reaches the array through a link and each item through
// another.
export default pattern<{ items: Item[] }, { items: Item[] }>(({ items }) => ({
  items,
}));
