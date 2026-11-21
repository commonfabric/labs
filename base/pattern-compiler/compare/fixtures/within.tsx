/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
}

interface Input {
  items: Item[];
  tags: string[];
  note: string;
}

// Ruling Z10: each callback declares `fixed`, whose cone reads neither
// the element nor the index. `Cone.within` names the body's collection
// for it, so it has an instance per element key all the same. `rows` is
// over records, which a test gives as references to cells, `marks` over
// plain values stored in place, and `loud` over the result of another
// per-element construct.
export default pattern<Input>(({ items, tags, note }) => {
  const rows = items.map((item) => {
    const fixed = note + "?";
    return item.title + fixed;
  });
  const marks = tags.map((tag) => {
    const fixed = note + "?";
    return tag + fixed;
  });
  const loud = tags.filter((tag) => tag !== "skip").map((tag) => {
    const fixed = note + "?";
    return tag + fixed;
  });
  return { rows, marks, loud };
});
