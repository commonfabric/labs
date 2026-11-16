/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Draft {
  text: string;
  tags: string[];
}

interface Item {
  title: string;
}

// A write below the root of a state cell: one member of a record.
const retitle = handler<{ text: string }, { draft: Writable<Draft> }>(
  (event, { draft }) => {
    draft.key("text").set(event.text);
  },
);

// A `push` onto a state cell whose first value is an array that is not
// empty.
const add = handler<{ tag: string }, { marks: Writable<string[]> }>(
  (event, { marks }) => {
    marks.push(event.tag);
  },
);

// Ruling Z14: each cell has a constant first value, which is the default
// of its schema, and no document until something writes it. A write below
// the root starts the document from the default, so the members the
// write did not name stay readable. `memo` is a cell of an element body:
// over `items`, over `words`, which holds plain values in place, and over
// the result of a `filter`.
export default pattern<{ items: Item[]; words: string[] }>(
  ({ items, words }) => {
    const draft = Writable.of<Draft>({ text: "", tags: ["new"] });
    const marks = Writable.of<string[]>(["first"]);
    return {
      draft,
      marks,
      rows: items.map((item) => {
        const memo = Writable.of<Draft>({ text: "", tags: ["row"] });
        return { title: item.title, memo, retitle: retitle({ draft: memo }) };
      }),
      labels: words.map((word) => {
        const memo = Writable.of<Draft>({ text: "", tags: ["label"] });
        return { word, memo, retitle: retitle({ draft: memo }) };
      }),
      kept: words.filter((word) => word !== "skip").map((word) => {
        const memo = Writable.of<Draft>({ text: "", tags: ["kept"] });
        return { word, memo, retitle: retitle({ draft: memo }) };
      }),
      retitle: retitle({ draft }),
      add: add({ marks }),
    };
  },
);
