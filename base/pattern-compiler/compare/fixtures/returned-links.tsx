/// <cts-enable />
import { lift, pattern } from "commonfabric";

// Bodies that return a value they read through a link, unchanged or inside
// a container they build, and bodies that return a new value made from one
// (ES §2.4, "A value passed on unchanged is stored as a reference"). The
// argument holds `items`, an array of references to documents of their own;
// `rows`, an array of plain values in place; and `holder`, a record whose
// member `item` is a link to a document. The Topics board's `mentionsOf`
// returns the elements of an array of references it declares `unknown[]`,
// as `elementOf` and `kept` do here.

interface Item {
  title: string;
}

/** (a) An element of an array of references, declared `unknown`. */
const elementOf = lift(({ items }: { items: unknown[] }): unknown => items[0]);

/** (a) An element of an array of references, declared by its type. */
const typedElementOf = lift(({ items }: { items: Item[] }): Item => items[0]);

/** (b) The array of references itself. */
const arrayOf = lift(({ items }: { items: unknown[] }): unknown[] => items);

/** (c) A member reached through a link at a static path. */
const memberOf = lift(({ holder }: { holder: { item: Item } }): Item =>
  holder.item
);

/** (d) An element of an array of plain values in place. */
const rowOf = lift(({ rows }: { rows: Item[] }): Item => rows[0]);

/** (e) An element of an array of references inside a record the body builds. */
const pickedOf = lift((
  { items }: { items: Item[] },
): { picked: Item } => ({ picked: items[0] }));

/** (e) The elements of an array of references a `filter` keeps. */
const keptOf = lift(({ items }: { items: unknown[] }): unknown[] =>
  items.filter((item) => item !== undefined && item !== null)
);

/** A new value made from an element: a spread of it. */
const spreadOf = lift(({ items }: { items: Item[] }): Item => ({
  ...items[0],
}));

/** A new value made from an element: a member changed. */
const renamedOf = lift(({ items }: { items: Item[] }): Item => ({
  title: `${items[0].title}!`,
}));

/** A value the body only read members of and did not return. */
const titleOf = lift(({ items }: { items: Item[] }): string => items[0].title);

interface Output {
  element: unknown;
  typedElement: Item;
  array: unknown[];
  member: Item;
  row: Item;
  picked: { picked: Item };
  kept: unknown[];
  spread: Item;
  renamed: Item;
  title: string;
}

interface Input {
  items: Item[];
  rows: Item[];
  holder: { item: Item };
}

export default pattern<Input, Output>(({ items, rows, holder }) => ({
  element: elementOf({ items }),
  typedElement: typedElementOf({ items }),
  array: arrayOf({ items }),
  member: memberOf({ holder }),
  row: rowOf({ rows }),
  picked: pickedOf({ items }),
  kept: keptOf({ items }),
  spread: spreadOf({ items }),
  renamed: renamedOf({ items }),
  title: titleOf({ items }),
}));
