/// <cts-enable />
import { handler, lift, pattern, type Stream, Writable } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Row {
  label: string;
  done: boolean;
}

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("title").set(event.title);
});

// An event that names an item by its position and says whether it is done.
const finish = handler<
  { at: number; done: boolean },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("done").set(event.done);
});

type Events = {
  rename: Stream<{ at: number; title: string }>;
  finish: Stream<{ at: number; done: boolean }>;
};

// The items that are not done, each as the member of the array it is.
const openOf = lift((items: Item[]): Item[] =>
  items.filter((item) => !item.done)
);

// A `map` over the output of a `lift` that gives some of the items of an
// array of references, each as the reference it is.
export const OverLift = pattern<
  { items: Writable<Item[]> },
  { rows: Row[] } & Events
>(({ items }) => {
  const open = openOf(items);
  const rows = open.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows, rename: rename({ items }), finish: finish({ items }) };
});

// A `map` over a `filter` over an array of references.
export const OverFilter = pattern<
  { items: Writable<Item[]> },
  { rows: Row[] } & Events
>(({ items }) => {
  const rows = items.filter((item) => !item.done).map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows, rename: rename({ items }), finish: finish({ items }) };
});

// A `map` over a `sortBy` over an array of references.
export const OverSort = pattern<
  { items: Writable<Item[]> },
  { rows: Row[] } & Events
>(({ items }) => {
  const rows = items.sortBy((item) => item.title).map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows, rename: rename({ items }), finish: finish({ items }) };
});

// A `map` over the result of another `map` over an array of references.
export const OverMap = pattern<
  { items: Writable<Item[]> },
  { rows: Row[] } & Events
>(({ items }) => {
  const rows = items.map((item) => ({ title: item.title, done: item.done }))
    .map((row) => ({ label: row.title + "!", done: row.done }));
  return { rows, rename: rename({ items }), finish: finish({ items }) };
});
