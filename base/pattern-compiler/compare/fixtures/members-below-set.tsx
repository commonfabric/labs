/// <cts-enable />
import { handler, lift, pattern, Writable } from "commonfabric";

interface Row {
  id: string;
  tags: string[];
}

interface Board {
  title: string;
  rows: Row[];
}

// A `lift` whose argument is an object built of an input, and that reads
// members of each element of an array below it: the members are `value`
// entries of `Body.reads` at `*`, beside an `enumeration` entry at the
// array.
const summaryOf = lift(({ board }: { board: Board }): string[] =>
  board.rows.map((row) => `${row.id}:${row.tags.length}`)
);

const publish = handler<{ board: Board }, { board: Writable<Board> }>(
  (event, { board }) => {
    board.set(event.board);
  },
);

// The handler writes the board through a handle, so the rows are records
// of their own that the array holds references to.
export default pattern<{ board: Board }>(({ board }) => ({
  summary: summaryOf({ board }),
  publish: publish({ board }),
}));
