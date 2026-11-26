/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

const rename = handler<{ to: string }, { label: Writable<string> }>(
  (event, { label }) => {
    label.set(event.to);
  },
);

// A write below the root of a cell whose first value was an input.
const rename_seed = handler<{ to: string }, { kept: Writable<Seed> }>(
  (event, { kept }) => {
    kept.key("name").set(event.to);
  },
);

// The same for the cell of a row, whose first value was the element.
const finish = handler<unknown, { mine: Writable<Stop> }>((_, { mine }) => {
  mine.key("done").set(true);
});

interface Seed {
  name: string;
  tags: string[];
}

interface Stop {
  title: string;
  done: boolean;
}

interface Input {
  start: number;
  items: string[];
  seed: Seed;
  stops: Stop[];
}

// Ruling Z3. `label` and `draft` have a constant first value: it is the
// default of the cell's schema, and nothing is written when the cell is
// created. `count` has a first value that is not a constant: a cone
// computes it, and it is written once, when the cell is first created.
// `at` is the same in an element body, from the index. `kept` is given
// an input whole, and `mine` the element of its row: by ruling Z15 each
// holds the value and no reference, so a write to the cell never lands
// in the input.
export default pattern<Input>(({ start, items, seed, stops }) => {
  const label = Writable.of("none");
  const draft = Writable.of({ text: "", tags: ["new"] });
  const count = Writable.of(start);
  const rows = items.map((item, index) => {
    const at = Writable.of(index);
    return { item, at };
  });
  const kept = Writable.of(seed);
  const cards = stops.map((stop) => {
    const mine = Writable.of(stop);
    return { mine, finish: finish({ mine }) };
  });
  return {
    label,
    draft,
    count,
    rows,
    kept,
    cards,
    renameSeed: rename_seed({ kept }),
    bump: bump({ count }),
    rename: rename({ label }),
  };
});
