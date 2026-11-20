/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

const add = handler<{ title: string }, { items: Writable<Item[]> }>(
  (event, { items }) => {
    items.push({ title: event.title });
  },
);

const addIfNoted = handler<unknown, { note: string; items: Writable<Item[]> }>(
  (_, { note, items }) => {
    if (note === "n") items.push({ title: "noted" });
  },
);

// The number of members of an array of references, after an addition that
// the input `note` decides and one that it does not: each pushed record is
// a document of its own, and the list holds a link to it.
export default pattern<{ note: string }>(({ note }) => {
  const items = Writable.of<Item[]>([]);
  return {
    count: items.length,
    items,
    add: add({ items }),
    addIfNoted: addIfNoted({ note, items }),
  };
});
