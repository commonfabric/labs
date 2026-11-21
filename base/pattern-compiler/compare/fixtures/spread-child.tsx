// deno-lint-ignore-file
/// <cts-enable />
import { pattern, UI } from "commonfabric";

interface Item {
  title: string;
}

// Ruling Z39: a JSX spread child, and an array literal with a spread or
// a hole among the children of a view node, is each one child at its
// written position, and the literal is stored as one nested array
// value. `words` is an array of plain values in place. `items` is an
// array of records, which a test gives as references to cells, and the
// second child spreads the result of a `map` over it. Today's JSX
// factory flattens each of these where the tree is built, so the
// executor's tests run this fixture and it is not compared with today's
// runtime. The file is left out of `deno lint`, which stops with an
// internal error at a JSX spread child.
export default pattern<{ items: Item[]; words: string[] }>(
  ({ items, words }) => {
    return {
      [UI]: (
        <ul>
          <li>first</li>
          {...words}
          {...items.map((item) => <li>{item.title}</li>)}
          {...items}
          {["before", ...words, "after"]}
          {["left", , "right"]}
          <li>last</li>
        </ul>
      ),
    };
  },
);
