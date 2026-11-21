/// <cts-enable />
/**
 * The three cases of a `map` whose rows a read reaches through their
 * position. `sorted` is a `map` over the result of a `lift` that returns
 * the input's references in the order of their ranks, so what decided
 * which row stands at a position is every rank. `filed` is a `map` over
 * the input array of references, in the order of the array, which the
 * handler `rotate` changes. `plain` is a `map` over an array of plain
 * values in place. `nested` is a `map` over the same sorted references
 * whose rows hold a `map` over an array of plain values in place, the
 * item's tags.
 */
import {
  type Default,
  handler,
  lift,
  pattern,
  type ReadonlyCell,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  rank: number;
  tags: string[];
}

interface Note {
  text: string;
}

interface State {
  items: Writable<Item[]>;
  notes: Note[];
}

const byRank = lift(
  ({ rows }: { rows: ReadonlyCell<Item>[] | Default<[]> }): Item[] => {
    const read: { row: unknown; rank: number }[] = [];
    for (const row of Array.from(rows)) {
      const value = row.get();
      if (value) read.push({ row, rank: value.rank });
    }
    read.sort((a, b) => a.rank - b.rank);
    return read.map(({ row }) => row) as Item[];
  },
);

const shout = lift(({ title }: { title: string }): string =>
  title.toUpperCase()
);

const rotate = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    const [first, ...rest] = items.get();
    items.set([...rest, first]);
  },
);

export default pattern<State>(({ items, notes }) => {
  const ordered = byRank({ rows: items });
  return {
    sorted: ordered.map((item) => ({ text: shout({ title: item.title }) })),
    filed: items.map((item) => ({ text: shout({ title: item.title }) })),
    nested: ordered.map((item) => ({
      tags: item.tags.map((tag) => ({ text: shout({ title: tag }) })),
    })),
    plain: notes.map((note) => ({ text: shout({ title: note.text }) })),
    rotate: rotate({ items }),
  };
});
