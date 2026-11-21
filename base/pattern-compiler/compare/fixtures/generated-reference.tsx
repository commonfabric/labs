/// <cts-enable />
import { handler, lift, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
  stars: number;
}

// The handler of a row stores its element.
const pick = handler<
  unknown,
  { item: Item; picked: Writable<Item | null> }
>((_, { item, picked }) => {
  picked.set(item);
});

const Row = pattern<{ item: Item }>(({ item }) => ({ title: item.title }));

// A plain array generated from scratch, with no declared key.
const listed = lift((input: { titles: string[]; bonus: number }): Item[] =>
  input.titles.map((title) => ({ title, stars: title.length + input.bonus }))
);

// Ruling Z53: an element of a plain array generated from scratch has a
// reference by key with the address of the output as its collection,
// also where the array declares no key. `rows` is over the array, and
// the handler of a row stores the reference, which `pickedTitle` reads.
// The key is of the whole value, so the reference reads nothing once
// `bonus` changes the element. `made` gives each element to an instance
// called through `asInstance()`.
export default pattern<{ titles: string[]; bonus: number }>(
  ({ titles, bonus }) => {
    const items = listed({ titles, bonus });
    const picked = Writable.of<Item | null>(null);
    return {
      picked,
      pickedTitle: picked.title,
      rows: items.map((item) => ({
        title: item.title,
        pick: pick({ item, picked }),
      })),
      made: items.map((item) => Row.asInstance()({ item })),
    };
  },
);
