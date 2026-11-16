/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

const rename = handler<{ to: string }, { label: Writable<string> }>(
  (event, { label }) => {
    label.set(event.to);
  },
);

interface Input {
  start: number;
  items: string[];
}

// Ruling Z3. `label` and `draft` have a constant first value: it is the
// default of the cell's schema, and nothing is written when the cell is
// created. `count` has a first value that is not a constant: a cone
// computes it, and it is written once, when the cell is first created.
// `at` is the same in an element body, from the index.
export default pattern<Input>(({ start, items }) => {
  const label = Writable.of("none");
  const draft = Writable.of({ text: "", tags: ["new"] });
  const count = Writable.of(start);
  const rows = items.map((item, index) => {
    const at = Writable.of(index);
    return { item, at };
  });
  return {
    label,
    draft,
    count,
    rows,
    bump: bump({ count }),
    rename: rename({ label }),
  };
});
