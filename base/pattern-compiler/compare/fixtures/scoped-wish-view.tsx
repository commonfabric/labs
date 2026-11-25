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

// A rendered tree that passes the result of a `wish` of the scope `user` on
// by reference, as an attribute bound to a cell, beside the rows of a `map`
// over an array of references, whose rows read nothing of a user.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const profile = wish<Writable<{ name?: string }>>({ query: "#profile" });
  return {
    [UI]: (
      <div>
        <cf-profile-badge $profile={profile.result} />
        {items.map((item) => <b>{item.title}</b>)}
      </div>
    ),
    rename: rename({ items }),
  };
});
