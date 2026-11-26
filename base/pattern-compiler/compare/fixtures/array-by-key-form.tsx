/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Position {
  lat: number;
}

// `a:b` is a key field whose name holds a `:`, and whose value is a
// number in one element and a string in another.
interface Entry {
  "a:b": string | number;
  tag: string;
  stars: number;
  position: Position;
}

type Entries = ArrayByKey<Entry, "a:b" | "tag">;

const note = handler<{ text: string }, { noted: Writable<string> }>(
  (event, { noted }) => {
    noted.set(event.text);
  },
);

// The handler of a row stores its element in one cell and a member below
// the element in another.
const pick = handler<
  unknown,
  {
    entry: Entry;
    picked: Writable<Entry | null>;
    center: Writable<Position | null>;
  }
>((_, { entry, picked, center }) => {
  picked.set(entry);
  center.set(entry.position);
});

// A plain array generated from scratch: one computation returns the
// whole array each time, with `stars` raised by `bonus`.
const fetched = lift(
  (input: { seeds: Entry[]; bonus: number }): Entries =>
    input.seeds.map((seed) => ({ ...seed, stars: seed.stars + input.bonus })),
);

interface Input {
  seeds: Entry[];
  bonus: number;
  minStars: number;
  saved: Writable<Entries>;
}

// Rulings Z47, Z48 and Z51: the key of an element names its key fields
// in the order of their names and holds one salted hash of their values.
// `found` is a `map` over the result of a `filter` of a plain array
// generated from scratch, and `kept` the same over plain values in
// place. Each row has a state cell, and a handler that stores its element
// and a member below it, which `pickedTag` and `centerLat` read.
// `ArrayByKey` is no member of today's `commonfabric`, so the executor's
// tests run this fixture and it is not compared with today's runtime.
export default pattern<Input>(({ seeds, bonus, minStars, saved }) => {
  const entries = fetched({ seeds, bonus });
  const picked = Writable.of<Entry | null>(null);
  const center = Writable.of<Position | null>(null);
  return {
    picked,
    center,
    pickedTag: picked.tag,
    centerLat: center.lat,
    found: entries.filter((entry) => entry.stars >= minStars).map((entry) => {
      const noted = Writable.of("");
      return {
        tag: entry.tag,
        stars: entry.stars,
        noted,
        note: note({ noted }),
        pick: pick({ entry, picked, center }),
      };
    }),
    kept: saved.filter((entry) => entry.stars >= minStars).map((entry) => {
      const noted = Writable.of("");
      return {
        tag: entry.tag,
        stars: entry.stars,
        noted,
        note: note({ noted }),
        pick: pick({ entry, picked, center }),
      };
    }),
  };
});
