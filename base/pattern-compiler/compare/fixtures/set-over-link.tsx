/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
  stars: number;
}

// Stores a reference in the cell: `first` is a record that the body reads
// from the argument and passes on unchanged.
const pick = handler<
  unknown,
  { first: Item; picked: Writable<Item> }
>((_, { first, picked }) => {
  picked.set(first);
});

// Writes a member below the cell, which holds the reference at that
// time.
const star = handler<unknown, { picked: Writable<Item> }>((_, { picked }) => {
  picked.key("stars").set(9);
});

// Writes a plain value to the cell, which holds the reference at that
// time.
const replace = handler<unknown, { picked: Writable<Item> }>(
  (_, { picked }) => {
    picked.set({ title: "plain", stars: 0 });
  },
);

// What a `set` does on a cell that holds a link. `pick` stores a link to
// `first` in `picked`. `star` then writes a member below the cell, and
// `replace` a plain value to the cell itself. `firstTitle` and
// `firstStars` show whether a write landed in the record that the link
// names, and `pickedTitle` and `pickedStars` what the cell reads as.
export default pattern<{ first: Item }>(({ first }) => {
  const picked = Writable.of<Item>({ title: "none", stars: 0 });
  return {
    firstTitle: first.title,
    firstStars: first.stars,
    pickedTitle: computed(() => picked.get().title),
    pickedStars: computed(() => picked.get().stars),
    pick: pick({ first, picked }),
    star: star({ picked }),
    replace: replace({ picked }),
  };
});
