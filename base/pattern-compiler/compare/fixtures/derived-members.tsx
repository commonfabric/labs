/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

const add = handler<
  { title: string },
  { items: Writable<Item[]>; words: Writable<string[]> }
>(
  (event, { items, words }) => {
    items.push({ title: event.title, done: false });
    words.push(event.title);
  },
);

const addSecret = handler<
  unknown,
  { secret: string; items: Writable<Item[]>; words: Writable<string[]> }
>(
  (_, { secret, items, words }) => {
    items.push({ title: secret, done: false });
    words.push(secret);
  },
);

const addIfNoted = handler<
  unknown,
  { note: string; items: Writable<Item[]>; words: Writable<string[]> }
>(
  (_, { note, items, words }) => {
    if (note === "n") {
      items.push({ title: "noted", done: false });
      words.push("noted");
    }
  },
);

const dropFirstIfNoted = handler<
  unknown,
  { note: string; items: Writable<Item[]>; words: Writable<string[]> }
>(
  (_, { note, items, words }) => {
    if (note === "n") {
      items.remove(items.get()[0]);
      words.removeByValue(words.get()[0]);
    }
  },
);

// The results of `map`, `filter` and `flatMap` as kept outputs, over an
// array of references (`items`: each pushed record is a document of its
// own), over a list of plain values in place (`words`), and over the result
// of another per-element construct. `addIfNoted` and `dropFirstIfNoted`
// change the members of both lists where the input `note` holds one text,
// so which member stands at a position of each result depends on `note`.
// `addSecret` adds a member that holds the input `secret`.
export default pattern<{ note: string; secret: string }>(
  ({ note, secret }) => {
    const items = Writable.of<Item[]>([]);
    const words = Writable.of<string[]>([]);
    return {
      titles: items.map((item) => item.title),
      open: items.filter((item) => !item.done),
      twice: items.flatMap((item) => [item.title, item.title]),
      cards: items.map((item) => ({ name: item.title, kind: "card" })),
      shouted: words.map((word) => word.toUpperCase()),
      long: words.filter((word) => word.length > 1),
      doubled: words.flatMap((word) => [word, word]),
      openTitles: items.filter((item) => !item.done).map((item) =>
        item.title
      ),
      longShouted: words.filter((word) => word.length > 1).map((word) =>
        word.toUpperCase()
      ),
      shoutedTwice: words.map((word) => word.toUpperCase()).map((word) =>
        word + word
      ),
      add: add({ items, words }),
      addSecret: addSecret({ secret, items, words }),
      addIfNoted: addIfNoted({ note, items, words }),
      dropFirstIfNoted: dropFirstIfNoted({ note, items, words }),
    };
  },
);
