/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

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

// A `map` over an array that the type declares as references, whose rows
// the result keeps at one path.
export const Once = pattern<
  { items: Writable<Item[]> },
  { rows: Row[]; rename: Stream<{ at: number; title: string }> }
>(({ items }) => {
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows, rename: rename({ items }) };
});

// The same `map`, which the result keeps at two paths.
export const Twice = pattern<
  { items: Writable<Item[]> },
  { rows: Row[]; again: Row[]; rename: Stream<{ at: number; title: string }> }
>(({ items }) => {
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  return { rows, again: rows, rename: rename({ items }) };
});

// A `map` whose element body uses a value that another cone of the pattern
// computes: the row of an element depends on more than the documents the
// body read.
export const Shared = pattern<
  { items: Writable<Item[]>; mark: string },
  { rows: Row[]; rename: Stream<{ at: number; title: string }> }
>(({ items, mark }) => {
  const suffix = computed(() => mark + mark);
  const rows = items.map((item) => ({
    label: item.title + suffix,
    done: item.done,
  }));
  return { rows, rename: rename({ items }) };
});
