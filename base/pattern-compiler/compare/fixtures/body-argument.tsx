/// <cts-enable />
import { lift, pattern, type ReadonlyCell } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

interface Board {
  kind: string;
  rows: Record<string, Item>;
}

// What a function body is handed. `Whole`: a `lift` over an array of plain
// values in place, which reads every member as a value. `One`: a `lift`
// that declares a record as a cell, reads one scalar of it as a value and
// one member of its rows through the handle, by a name it is handed.
const countOpen = lift(({ items }: { items: Item[] }) =>
  items.filter((item) => !item.done).length
);

export const Whole = pattern<{ items: Item[] }, { open: number }>(
  ({ items }) => {
    return { open: countOpen({ items }) };
  },
);

const titleOf = lift((
  { board, name }: { board: ReadonlyCell<Board>; name: string },
): string =>
  board.key("kind").get() === "board"
    ? board.key("rows").key(name).key("title").get() ?? ""
    : ""
);

export const One = pattern<{ board: Board; name: string }, { title: string }>(
  ({ board, name }) => {
    return { title: titleOf({ board, name }) };
  },
);
