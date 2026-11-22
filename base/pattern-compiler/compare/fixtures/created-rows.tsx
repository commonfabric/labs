/// <cts-enable />
/**
 * A `lift` that writes a document for each row of its result: `rowsOf`
 * reads each item through its handle and writes, with
 * `Writable.for(item).set(...)`, a row addressed by the item. The output
 * `rows` holds a reference to each row. `noted` is derived from `other`
 * alone, in the same transaction, and no row holds anything of it.
 */
import {
  type Default,
  lift,
  pattern,
  type ReadonlyCell,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

interface Row {
  title: string;
}

interface State {
  items: Writable<Item[]>;
  other: string;
}

const rowsOf = lift(
  ({ rows }: { rows: ReadonlyCell<Item>[] | Default<[]> }): Row[] => {
    const made: unknown[] = [];
    for (const row of Array.from(rows)) {
      const value = row.get();
      if (value) {
        made.push(
          Writable.for<Row>(row).set({ title: value.title.toUpperCase() }),
        );
      }
    }
    return made as Row[];
  },
);

const shout = lift(({ text }: { text: string }): string => text.toUpperCase());

export default pattern<State>(({ items, other }) => {
  return {
    rows: rowsOf({ rows: items }),
    noted: shout({ text: other }),
  };
});
