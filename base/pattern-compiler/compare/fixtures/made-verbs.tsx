/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

// The Topics board's topics reduced to their verbs: the handler `add` makes
// an instance of `Item`, as the board's `addTopic` makes a topic, and adds
// it to the list, an array of references, and returns the item and its
// title, as `addTopic` returns the topic and its number. Each item has a
// title of its argument and a verb of its own that renames it, and the
// board maps the list to the titles.

interface ItemResult {
  title: string;
  rename: Stream<{ title: string }>;
}

const rename = handler<{ title: string }, { title: Writable<string> }>(
  (event, { title }) => {
    title.set(event.title);
  },
);

const Item = pattern<{ title: Writable<string> }, ItemResult>(
  ({ title }) => ({ title, rename: rename({ title }) }),
);

const add = handler<
  { title: string },
  { items: Writable<ItemResult[]> },
  { item: ItemResult; title: string }
>((event, { items }) => {
  const item = Item({ title: event.title });
  items.push(item);
  return { item, title: event.title };
});

interface Output {
  items: ItemResult[];
  titles: string[];
  add: Stream<{ title: string }>;
}

export default pattern<{ items: Writable<ItemResult[]> }, Output>(
  ({ items }) => ({
    items,
    titles: items.map((item) => item.title),
    add: add({ items }),
  }),
);
