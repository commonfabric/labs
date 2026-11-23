/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Row {
  label: string;
  done: boolean;
  retitle: Stream<{ title: string }>;
  touch: Stream<Record<string, never>>;
}

// Bound once for each row: it gives the item of its row another title.
const retitle = handler<
  { title: string },
  { item: Writable<Item>; events: Writable<number> }
>((event, { item, events }) => {
  item.key("title").set(event.title);
  events.set(events.get() + 1);
});

// Bound once for each row: it writes nothing that a row reads.
const touch = handler<
  Record<string, never>,
  { events: Writable<number> }
>((_, { events }) => {
  events.set(events.get() + 1);
});

// An event that adds an item at the end.
const add = handler<
  { id: string; title: string },
  { items: Writable<Item[]>; events: Writable<number> }
>((event, { items, events }) => {
  items.push({ id: event.id, title: event.title, done: false });
  events.set(events.get() + 1);
});

interface Output {
  rows: Row[];
  events: number;
  add: Stream<{ id: string; title: string }>;
}

// The list of `serving-list.tsx` with two handlers bound in the body of
// each element: a `map` over an array that the type declares as references,
// which a test gives as an array of references, where each row holds the
// streams of its own handlers.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const events = Writable.of(0);
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
    retitle: retitle({ item, events }),
    touch: touch({ events }),
  }));
  return { rows, events, add: add({ items, events }) };
});
