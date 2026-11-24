/// <cts-enable />
import {
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

// An event that names the item the acting session picked.
const pick = handler<{ title: string }, { target: Writable<string> }>(
  (event, { target }) => {
    target.set(event.title);
  },
);

interface Output {
  [UI]: VNode;
  pick: Stream<{ title: string }>;
}

// A `map` over an array of references whose body declares whether the
// acting session picked the row, a value of the scope `session`, and places
// a branch on that value: the branch reads the declaration, a value of
// another cone of the same element.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const target = new Writable.perSession<string>("");
  return {
    [UI]: (
      <div>
        {items.map((item) => {
          const picked = target.get() === item.title;
          return <div>{picked ? <b>picked</b> : <i>{item.title}</i>}</div>;
        })}
      </div>
    ),
    pick: pick({ target }),
  };
});
