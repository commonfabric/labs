/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Mark {
  text: string;
}

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("title").set(event.title);
});

// An event that names a mark by its position and gives it another text.
const remark = handler<
  { at: number; text: string },
  { marks: Writable<Mark[]> }
>((event, { marks }) => {
  marks.key(event.at).key("text").set(event.text);
});

type Rename = Stream<{ at: number; title: string }>;

// A `map` over an array of references that stands among the children of a
// view node, whose element body holds a `computed` with a function body:
// the row of an element is computed by two entries, each with an instance
// for the element.
export const WithFunction = pattern<
  { items: Writable<Item[]> },
  { rename: Rename }
>(({ items }) => {
  return {
    [UI]: (
      <ul>
        {items.map((item) => (
          <li>
            {computed(() => {
              const loud = item.title.toUpperCase();
              return loud + "!";
            })}
          </li>
        ))}
      </ul>
    ),
    rename: rename({ items }),
  };
});

// A `map` over an array of references whose element body reads the
// position of its element.
export const WithIndex = pattern<
  { items: Writable<Item[]> },
  { rows: { label: string; done: boolean }[]; rename: Rename }
>(({ items }) => {
  const rows = items.map((item, index) => ({
    label: index + " " + item.title,
    done: item.done,
  }));
  return { rows, rename: rename({ items }) };
});

// A `map` over an array of references whose element body holds another
// `map`, over a second array of references: the row of an item holds a
// row for each mark, in place.
export const WithInner = pattern<
  { items: Writable<Item[]>; marks: Writable<Mark[]> },
  {
    rows: { label: string; marked: { label: string }[] }[];
    rename: Rename;
    remark: Stream<{ at: number; text: string }>;
  }
>(({ items, marks }) => {
  const rows = items.map((item) => ({
    label: item.title + "!",
    marked: marks.map((mark) => ({ label: item.title + mark.text })),
  }));
  return { rows, rename: rename({ items }), remark: remark({ marks }) };
});
