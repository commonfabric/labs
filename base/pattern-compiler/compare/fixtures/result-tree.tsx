/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

interface Facts {
  count: number;
  titles: string;
}

// The facts of every item, from one walk over all of them through the
// handle of the array.
const factsOf = (items: Writable<Item[]>): Facts => {
  const count = items.get().length;
  let titles = "";
  for (let index = 0; index < count; index++) {
    titles += items.key(index).key("title").get();
  }
  return { count, titles };
};

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("title").set(event.title);
});

interface Output {
  [UI]: VNode;
  count: number;
  titles: string;
  rename: Stream<{ at: number; title: string }>;
}

// A result that holds a tree over the rows of a `map` over `items`, an
// array of references, beside values a body forms from every item through
// the handle of the array: a change of the items gives the result another
// count and other titles, and leaves the tree as it was but for its rows.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const facts = computed(() => factsOf(items));
  return {
    [UI]: (
      <div>
        <header>
          <h1>Items</h1>
          <p>Each item, in the order they were added.</p>
        </header>
        <ul>
          {items.map((item) => (
            <li>
              <b>{item.title}</b>
            </li>
          ))}
        </ul>
        <footer>
          <span>One row for each item.</span>
          <span>Rename one by its position.</span>
        </footer>
      </div>
    ),
    count: facts.count,
    titles: facts.titles,
    rename: rename({ items }),
  };
});
