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
  items: Item[];
  note: Confidential<string, ["bob"]>;
}

// Bound once per element: it reads the element and an input, and writes a
// state cell of the pattern.
const choose = handler<
  unknown,
  { item: Item; note: string; chosen: Writable<string> }
>((_, { item, note, chosen }) => {
  chosen.set(item.title + note);
});

// Bound in a pattern compiled in at a tag: it writes a state cell of that
// pattern, which each instance of the tag has one of.
const mark = handler<
  unknown,
  { item: Item; picked: Writable<string> }
>((_, { item, picked }) => {
  picked.set(item.title + "!");
});

export const Row = pattern<{ item: Item }>(({ item }) => {
  const picked = Writable.of("");
  return { [UI]: <li onClick={mark({ item, picked })}>{picked}</li> };
});

export default pattern<Input>(({ items, note }) => {
  const chosen = Writable.of("");
  return {
    [UI]: (
      <div>
        <h1>{chosen}</h1>
        <ul>
          <li>first</li>
          {items.map((item) => (
            <li onClick={choose({ item, note, chosen })}>x</li>
          ))}
        </ul>
        <ol>{items.map((item) => <Row item={item} />)}</ol>
      </div>
    ),
    chosen,
  };
});
