/// <cts-enable />
import {
  type Default,
  lift,
  pattern,
  type ReadonlyCell,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  note: string;
}

interface Row {
  title: string;
}

// A `lift` over an array of references that reads the title of each member
// through its handle, under a type that names the title alone, and writes
// a row document addressed by the member.
const rowsOf = lift(
  (
    { sources }: {
      sources: ReadonlyCell<{ title: string }>[] | Default<[]>;
    },
  ): Row[] => {
    const made: unknown[] = [];
    for (const source of Array.from(sources)) {
      const title = source.get()?.title;
      if (typeof title === "string") {
        made.push(
          Writable.for<Row>(source).set({ title: title.toUpperCase() }),
        );
      }
    }
    return made as Row[];
  },
);

// A `lift` that is handed the result of `rowsOf` as a handle and reads the
// title of each row through it.
const titlesOf = lift(
  ({ rows }: { rows: ReadonlyCell<Row[]> }): string => {
    const count = rows.get()?.length ?? 0;
    const titles: string[] = [];
    for (let position = 0; position < count; position++) {
      titles.push(rows.key(position).key("title").get());
    }
    return titles.join(",");
  },
);

// The number of members of an array of references, a `lift` over that
// array, and a `lift` over the result of the first. A change of the note
// of a member is read by none of them.
export const Derived = pattern<
  { items: Writable<Item[]> },
  { count: number; rows: Row[]; titles: string }
>(({ items }) => {
  const rows = rowsOf({ sources: items });
  return {
    count: items.get().length,
    rows,
    titles: titlesOf({ rows }),
  };
});

// A `map` over an array of references beside the number of its members: a
// result that holds a plain value as well as the array of rows.
export const Counted = pattern<
  { items: Writable<Item[]> },
  { count: number; rows: Row[] }
>(({ items }) => ({
  count: items.get().length,
  rows: items.map((item) => ({ title: item.title + "!" })),
}));

// A `map` over an array of references whose rows are view nodes, among the
// children of a view node: the array of rows stands below a member of an
// array. A row holds a text computed from the title of its member.
export const Viewed = pattern<{ items: Writable<Item[]> }>(({ items }) => ({
  [UI]: (
    <div>
      <h1>Items</h1>
      <ul>
        {items.map((item) => (
          <li>
            <b>{item.title + "!"}</b>
          </li>
        ))}
      </ul>
    </div>
  ),
}));
