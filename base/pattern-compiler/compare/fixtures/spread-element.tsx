/// <cts-enable />
import { lift, pattern } from "commonfabric";

interface Item {
  title: string;
  done?: boolean;
  note?: string;
}

interface Extra {
  tag: string;
  done: boolean;
}

/** Each element with `done` replaced: a member behind the spread. */
const markedOf = lift(({ list }: { list: Item[] }): Item[] =>
  list.map((item) => ({ ...item, done: true }))
);

/** Each element as a copy: the spread alone. */
const copiesOf = lift(({ list }: { list: Item[] }): Item[] =>
  list.map((item) => ({ ...item }))
);

/** Each element over a default: a member before the spread. */
const beforeOf = lift(({ list }: { list: Item[] }): Item[] =>
  list.map((item) => ({ done: true, note: "none", ...item }))
);

/** A member before the spread and one behind it. */
const bothOf = lift(({ list }: { list: Item[] }): Item[] =>
  list.map((item) => ({ note: "replaced", ...item, done: true }))
);

/** A record that is no element, spread beside a member of each element. */
const withExtraOf = lift((
  { list, extra }: { list: Item[]; extra: Extra },
): (Extra & { title: string })[] =>
  list.map((item) => ({ ...extra, title: item.title }))
);

/** One element, spread outside any callback. */
const firstOf = lift(({ list }: { list: Item[] }): Item => ({
  ...list[0],
  done: true,
}));

// An object literal with a spread. `items` is an array of records that a
// test gives as references to documents, and `rows` is an array of plain
// values held in place. The bodies of the `lift` functions above spread an
// element in JavaScript, over each of the two arrays, over the result of a
// `filter` and over the result of a `map`.
export default pattern<
  { items: Item[]; rows: Item[]; extra: Extra },
  {
    ofReferences: Item[];
    ofPlain: Item[];
    ofFilter: Item[];
    ofMap: Item[];
    copies: Item[];
    before: Item[];
    both: Item[];
    withExtra: (Extra & { title: string })[];
    first: Item;
  }
>(({ items, rows, extra }) => ({
  ofReferences: markedOf({ list: items }),
  ofPlain: markedOf({ list: rows }),
  ofFilter: markedOf({ list: items.filter((item) => !item.done) }),
  ofMap: markedOf({
    list: items.map((item) => ({ title: item.title, note: "mapped" })),
  }),
  copies: copiesOf({ list: items }),
  before: beforeOf({ list: items }),
  both: bothOf({ list: items }),
  withExtra: withExtraOf({ list: items, extra }),
  first: firstOf({ list: items }),
}));
