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
}

// An event that names an item by its position and gives it another title:
// a write of one member through the reference at that position.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]>; events: Writable<number> }
>((event, { items, events }) => {
  items.key(event.at).key("title").set(event.title);
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
  rename: Stream<{ at: number; title: string }>;
  add: Stream<{ id: string; title: string }>;
}

// The list of the serving tests and of `compare/serving-path.ts`: a `map`
// over an array that the type declares as references, which a test gives
// as an array of references, two handlers that write the array, and a
// state cell that counts the events handled.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const events = Writable.of(0);
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return {
    rows,
    events,
    rename: rename({ items, events }),
    add: add({ items, events }),
  };
});
