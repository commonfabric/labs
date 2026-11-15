/// <cts-enable />
import {
  type Cell,
  handler,
  pattern,
  spaceOf,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

interface Input {
  items: Item[];
}

// Bound once per element. It asks which space the element's handle names,
// which resolves the reference and reads nothing through it, and writes
// that to a state cell of the pattern.
const locate = handler<
  unknown,
  { item: Cell<Item>; where: Writable<string> }
>((_, { item, where }) => {
  where.set(spaceOf(item) ?? "");
});

export default pattern<Input>(({ items }) => {
  const where = Writable.of("");
  return {
    [UI]: (
      <ul>
        {items.map((item) => <li onClick={locate({ item, where })}>x</li>)}
      </ul>
    ),
    where,
  };
});
