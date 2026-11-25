/// <cts-enable />
import {
  handler,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("title").set(event.title);
});

interface Output {
  [UI]: VNode;
  rename: Stream<{ at: number; title: string }>;
}

// A rendered tree that places the view of the result of a `wish` of the
// scope `user`, `profile[UI]`, as a child, beside the rows of a `map` over
// an array of references, whose rows read nothing of a user.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const profile = wish<{ [UI]: VNode }>({ query: "#profile" });
  return {
    [UI]: (
      <div>
        <div>{profile[UI]}</div>
        {items.map((item) => <b>{item.title}</b>)}
      </div>
    ),
    rename: rename({ items }),
  };
});
