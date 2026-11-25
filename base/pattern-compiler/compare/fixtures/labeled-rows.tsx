/// <cts-enable />
import {
  type Confidential,
  handler,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface Item {
  name: Confidential<string, readonly ["person"]>;
  share: number;
}

// An event that adds an item whose name is a copy of `secret`, which is
// stored under the clause `person`, as a handler copies a profile's name.
const add = handler<
  unknown,
  { items: Writable<Item[]>; secret: Writable<string> }
>((_event, { items, secret }) => {
  items.push({ name: secret.get(), share: 1 });
});

// An event of one row, which counts a pick.
const pick = handler<unknown, { picks: Writable<number> }>(
  (_event, { picks }) => {
    picks.set(picks.get() + 1);
  },
);

interface Output {
  [UI]: VNode;
  add: Stream<unknown>;
}

// A rendered tree that holds the rows of a `map` over an array of plain
// values in place, each element's name under the clause `person`, which the
// argument's type declares there, and each row with a stream of its own.
// Each row reads its name and `badge`, an input the membership of the rows
// does not depend on.
export default pattern<
  { items: Writable<Item[]>; secret: Writable<string>; badge: string },
  Output
>(({ items, secret, badge }) => {
  const picks = Writable.of(0);
  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <cf-button onClick={pick({ picks })}>{item.name + badge}</cf-button>
        ))}
      </div>
    ),
    add: add({ items, secret }),
  };
});
