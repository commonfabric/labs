/// <cts-enable />
import { handler, pattern, type Stream, UI, Writable } from "commonfabric";

interface Item {
  id: string;
  title: string;
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

// Bound once for each row: it gives the item of its row another title.
const retitle = handler<
  { title: string },
  { item: Writable<Item>; events: Writable<number> }
>((event, { item, events }) => {
  item.key("title").set(event.title);
  events.set(events.get() + 1);
});

interface Output {
  events: number;
  rename: Stream<{ at: number; title: string }>;
  add: Stream<{ id: string; title: string }>;
}

// The list of `serving-list.tsx` as most patterns hold one: the `map`
// stands among the children of a view node and at no path of the result
// that the plan names, and the body of each element binds a handler. A
// test gives the array as an array of references.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const events = Writable.of(0);
  return {
    [UI]: (
      <ul>
        <li>first</li>
        {items.map((item) => (
          <li onClick={retitle({ item, events })}>{item.title + "!"}</li>
        ))}
      </ul>
    ),
    events,
    rename: rename({ items, events }),
    add: add({ items, events }),
  };
});
