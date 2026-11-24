/// <cts-enable />
import { type Cell, handler, pattern, type Stream } from "commonfabric";

interface Item {
  title: string;
}

const file = handler<
  { title: string; name: string },
  { items: Cell<Item[]>; names: Cell<Record<string, string>> }
>(
  (event, { items, names }) => {
    items.push({ title: event.title });
    names.key(event.name).set(event.title);
  },
);

// A handler that appends one member to an array of references and sets one
// member of a record, both inputs of the pattern.
export default pattern<
  { items: Cell<Item[]>; names: Cell<Record<string, string>> },
  { count: number; file: Stream<{ title: string; name: string }> }
>(({ items, names }) => ({
  count: items.length,
  file: file({ items, names }),
}));
