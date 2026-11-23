/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Row {
  label: string;
  retitle: Stream<{ title: string }>;
}

// Bound once for each row: it gives the item of its row another title.
const retitle = handler<
  { title: string },
  { item: Writable<Item>; events: Writable<number> }
>((event, { item, events }) => {
  item.key("title").set(event.title);
  events.set(events.get() + 1);
});

// An event that names an item by its position and says whether it is done.
const finish = handler<
  { at: number; done: boolean },
  { items: Writable<Item[]>; events: Writable<number> }
>((event, { items, events }) => {
  items.key(event.at).key("done").set(event.done);
  events.set(events.get() + 1);
});

interface Output {
  rows: Row[];
  events: number;
  finish: Stream<{ at: number; done: boolean }>;
}

// The list of `serving-list-handlers.tsx` over the items that are not done:
// a `map` over a `filter` over an array that the type declares as
// references, which a test gives as an array of references. The body of an
// element of the `map` reads the position of its element and binds a
// handler.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const events = Writable.of(0);
  const rows = items.filter((item) => !item.done).map((item, index) => ({
    label: index + " " + item.title,
    retitle: retitle({ item, events }),
  }));
  return { rows, events, finish: finish({ items, events }) };
});
