/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

interface Input {
  items: Item[];
  tags: string[];
}

// Ruling Z6: a `map` over a `filter` over a `map`, once over records and
// once over plain values. An element of the result of a per-element
// construct has the key of the upstream element it came from, so a change
// of one upstream element evaluates that element's cone instances down
// the chain and no other element's, and a move evaluates none.
export default pattern<Input>(({ items, tags }) => {
  const open = items
    .map((item) => ({ label: item.title + "!", done: item.done }))
    .filter((row) => !row.done)
    .map((row) => row.label + "?");
  const loud = tags
    .map((tag) => tag + "!")
    .filter((tag) => tag !== "skip!")
    .map((tag) => tag + "?");
  return { open, loud };
});
