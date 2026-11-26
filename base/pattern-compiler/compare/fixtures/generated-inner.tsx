/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  stars: number;
}

interface Group {
  name: string;
  titles: string[];
}

// The handler of a row stores its element, and tries to write a member
// of the element that the cell holds a reference to.
const pick = handler<
  unknown,
  { item: Item; picked: Writable<Item | null> }
>((_, { item, picked }) => {
  picked.set(item);
});

const edit = handler<unknown, { picked: Writable<Item> }>((_, { picked }) => {
  picked.key("stars").set(100);
});

// A plain array generated from scratch, with a declared key.
const listed = lift((
  input: { titles: string[]; bonus: number },
): ArrayByKey<Item, "title"> =>
  input.titles.map((title) => ({ title, stars: title.length + input.bonus }))
);

// Ruling Z56: an output inside an element body gives its elements a
// reference by key as one outside does. `items` is computed once per
// group, a plain array generated from scratch, and the handler of an
// inner row stores a reference to its element in `picked`, a cell
// outside the element body. `pickedStars` reads through the reference.
// `edit` writes through it, which the output refuses.
export default pattern<{ groups: Group[]; bonus: number }>(
  ({ groups, bonus }) => {
    const picked = Writable.of<Item | null>(null);
    return {
      picked,
      pickedStars: picked.stars,
      edit: edit({ picked }),
      groups: groups.map((group) => {
        const items = listed({ titles: group.titles, bonus });
        return {
          name: group.name,
          rows: items.map((item) => ({
            title: item.title,
            pick: pick({ item, picked }),
          })),
        };
      }),
    };
  },
);
