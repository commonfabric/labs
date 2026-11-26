/// <cts-enable />
import {
  type Confidential,
  handler,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: Confidential<string, ["alice"]>;
}

interface Input {
  // The clause is on the array itself: its length and its slots.
  items: Confidential<Item[], ["carol"]>;
}

// Closes over the index and a cell of the pattern.
const pickAt = handler<
  unknown,
  { at: number; chosen: Writable<number> }
>((_, { at, chosen }) => {
  chosen.set(at);
});

// Closes over a cell of the pattern alone: nothing of the element, of the
// index, or of the list.
const clear = handler<unknown, { cleared: Writable<number> }>(
  (_, { cleared }) => {
    cleared.set(1);
  },
);

export default pattern<Input>(({ items }) => {
  const chosen = Writable.of(0);
  const cleared = Writable.of(0);
  return {
    [UI]: (
      <ul>
        {items.map((item, index) => (
          <li onClick={pickAt({ at: index, chosen })}>
            <b onClick={clear({ cleared })}>{item.title}</b>
          </li>
        ))}
      </ul>
    ),
    // One node reads the index and nothing of the element.
    numbered: items.map((_item, index) => index + 1),
    chosen,
    cleared,
  };
});
