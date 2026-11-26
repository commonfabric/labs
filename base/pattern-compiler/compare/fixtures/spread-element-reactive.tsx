/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  done?: boolean;
  note?: string;
}

interface Extra {
  tag: string;
  done: boolean;
}

// An object literal with a spread, written in the reactive tier, in the
// callback of a `map`. `items` is an array of records that a test gives as
// references to documents, and `rows` is an array of plain values held in
// place. Today's transformer refuses a spread of a reactive value outside
// a function body, so the executor's tests run this fixture and it is not
// compared with today's runtime; `spread-element.tsx` holds the same
// literals in function bodies.
export default pattern<
  { items: Item[]; rows: Item[]; extra: Extra },
  {
    ofReferences: Item[];
    ofPlain: Item[];
    ofFilter: Item[];
    before: Item[];
    withExtra: (Extra & { title: string })[];
  }
>(({ items, rows, extra }) => ({
  ofReferences: items.map((item) => ({ ...item, done: true })),
  ofPlain: rows.map((row) => ({ ...row, done: true })),
  ofFilter: items.filter((item) => !item.done).map((item) => ({
    ...item,
    done: true,
  })),
  before: items.map((item) => ({ done: true, ...item })),
  withExtra: items.map((item) => ({ ...extra, title: item.title })),
}));
