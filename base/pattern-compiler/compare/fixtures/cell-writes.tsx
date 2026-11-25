/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

interface Owned {
  count: number;
  selected: Item;
}

interface Data {
  test: string;
}

interface Holder {
  ref: Data;
}

interface Kept {
  current: Item;
}

const put = handler<{ value: number }, { target: Writable<number> }>(
  (event, { target }) => {
    target.set(event.value);
  },
);

const bump = handler<unknown, { target: Writable<number> }>(
  (_, { target }) => {
    target.set(target.get() + 1);
  },
);

const point = handler<
  unknown,
  { selected: Writable<Item>; other: Writable<Item> }
>((_, { selected, other }) => {
  selected.set(other);
});

const rename = handler<{ title: string }, { selected: Writable<Item> }>(
  (event, { selected }) => {
    selected.key("title").set(event.title);
  },
);

const renameIn = handler<{ title: string }, { owner: Writable<Owned> }>(
  (event, { owner }) => {
    owner.key("selected").key("title").set(event.title);
  },
);

const putIn = handler<{ value: number }, { owner: Writable<Owned> }>(
  (event, { owner }) => {
    owner.key("count").set(event.value);
  },
);

const replace = handler<unknown, { chain: Writable<Data> }>(
  (_, { chain }) => {
    chain.set({ test: "replaced" });
  },
);

const replaceIn = handler<unknown, { holder: Writable<Holder> }>(
  (_, { holder }) => {
    holder.key("ref").set({ test: "replaced" });
  },
);

const keepValue = handler<
  unknown,
  { selected: Writable<Item>; kept: Writable<Kept> }
>((_, { selected, kept }) => {
  kept.set({ current: selected.get() });
});

const keepResolved = handler<
  unknown,
  { selected: Writable<Item>; kept: Writable<Kept> }
>((_, { selected, kept }) => {
  kept.set({ current: selected.resolveAsCell() });
});

const keepCell = handler<
  unknown,
  { selected: Writable<Item>; kept: Writable<Kept> }
>((_, { selected, kept }) => {
  kept.set({ current: selected });
});

// `Writer`: the handlers write cells that are inputs of the pattern, each
// of which another document holds: a value, a reference to another cell,
// and a member below the cell. `putIn` and `renameIn` reach a cell through
// the result of another pattern, by key. `replace` and `replaceIn` write
// a record at the top of a chain of links, the second through a holder by
// key. `keepValue`, `keepResolved` and `keepCell` store what `selected`
// is into another cell: the value it reads, the cell its links lead to, and
// the cell itself.
export const Writer = pattern<{
  target: Writable<number>;
  selected: Writable<Item>;
  other: Writable<Item>;
  owner: Writable<Owned>;
  chain: Writable<Data>;
  holder: Writable<Holder>;
  kept: Writable<Kept>;
}>(({ target, selected, other, owner, chain, holder, kept }) => ({
  put: put({ target }),
  bump: bump({ target }),
  point: point({ selected, other }),
  rename: rename({ selected }),
  putIn: putIn({ owner }),
  renameIn: renameIn({ owner }),
  replace: replace({ chain }),
  replaceIn: replaceIn({ holder }),
  keepValue: keepValue({ selected, kept }),
  keepResolved: keepResolved({ selected, kept }),
  keepCell: keepCell({ selected, kept }),
}));

// `Selector`: its state cell `selected`, which it returns, holds a plain
// link to the item `selectFirst` or `selectSecond` chose, and its handlers
// store what `selected` is into another cell.
export const Selector = pattern<{
  first: Writable<Item>;
  second: Writable<Item>;
  kept: Writable<Kept>;
}>(({ first, second, kept }) => {
  const selected = Writable.of<Item>({ title: "none" });
  return {
    selectFirst: point({ selected, other: first }),
    selectSecond: point({ selected, other: second }),
    keepValue: keepValue({ selected, kept }),
    keepResolved: keepResolved({ selected, kept }),
    keepCell: keepCell({ selected, kept }),
    selected,
    shown: computed(() => selected.get().title),
  };
});

// `Reader`: value code that returns what its input `selected` reads, as a
// member of a record it makes.
export const Reader = pattern<{ selected: Writable<Item> }>(
  ({ selected }) => ({
    snapshot: computed(() => ({ current: selected.get() })),
  }),
);

// `Owner`: returns the state cells it makes, and values it derives from
// them, which follow a write of the cells that another pattern makes.
export const Owner = pattern<
  { label: string },
  {
    count: Writable<number>;
    selected: Writable<Item>;
    doubled: number;
    shown: string;
  }
>(({ label }) => {
  const count = Writable.of(1);
  const selected = Writable.of<Item>({ title: "none" });
  return {
    count,
    selected,
    doubled: computed(() => count.get() * 2),
    shown: computed(() => `${label}: ${selected.get().title}`),
  };
});
