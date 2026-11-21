/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

const toggle = handler<unknown, { open: Writable<boolean> }>((_, { open }) => {
  open.set(!open.get());
});

// A keystroke in the title of a row: a write of one member through the
// element of the row.
const rename = handler<{ text: string }, { item: Writable<Item> }>(
  (event, { item }) => {
    item.key("title").set(event.text);
  },
);

const loud = lift((input: { title: string }) => input.title.toUpperCase());

const Detail = pattern<{ item: Item }>(({ item }) => {
  const note = Writable.of("");
  return { title: item.title, note };
});

// For the measurement of `compare/rekey-cost.ts` (plan question 254):
// each row has a state cell, a handler binding with a stream, a `lift`
// in the body, and a child instance. `Plain` is over an array whose
// type declares no key: a test gives `items` as plain values in place,
// where a write of one member of an element gives the element another
// key, and as references, where it does not.
export const Plain = pattern<{ items: Item[] }>(({ items }) => {
  const rows = items.map((item) => {
    const open = Writable.of(false);
    return {
      loud: loud({ title: item.title }),
      open,
      toggle: toggle({ open }),
      rename: rename({ item }),
      detail: Detail.asInstance()({ item }),
    };
  });
  return { rows };
});

// The same over an array of plain values in place whose type declares
// the key field `id`: a write of `title` changes no key.
export const Keyed = pattern<{ items: ArrayByKey<Item, "id"> }>(
  ({ items }) => {
    const rows = items.map((item) => {
      const open = Writable.of(false);
      return {
        loud: loud({ title: item.title }),
        open,
        toggle: toggle({ open }),
        rename: rename({ item }),
        detail: Detail.asInstance()({ item }),
      };
    });
    return { rows };
  },
);
