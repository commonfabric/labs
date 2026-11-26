/// <cts-enable />
import {
  computed,
  type Default,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

const letters = lift((x: { title: string }) => x.title.split(""));

// The innermost callee: a state cell and a handler that writes it.
const Leaf = pattern<{ title: string; step?: Default<number, 2> }>(
  ({ title, step }) => {
    const count = Writable.of(0);
    return {
      shown: computed(() => `${title}:${count.get() * step}`),
      count,
      bump: bump({ count }),
    };
  },
);

// A callee with a plain array generated from scratch and a `map` over
// it: the array has a document of its own, named by the output.
const Spelled = pattern<{ title: string }>(({ title }) => {
  const parts = letters({ title });
  return { parts: parts.map((part) => part + ".") };
});

// A callee that calls `Leaf` at two sites, one of which leaves the path
// `step` out and one of which writes a literal for it, and `Spelled` at
// one.
const Pair = pattern<{ title: string }>(({ title }) => {
  const left = Leaf({ title });
  const right = Leaf({ title: title + "'", step: 3 });
  const spelled = Spelled({ title });
  return {
    left,
    right,
    both: left.shown + "|" + right.shown,
    parts: spelled.parts,
  };
});

// Call sites two levels deep outside every element body, and call sites
// inside an element body: `rows` is over records, which a test gives as
// references to cells and as plain values in place; `tagged` is over
// plain values in place; `kept` is over the result of a `filter`; and
// `spelled` is over a plain array generated from scratch.
export default pattern<{ items: Item[]; words: string[]; lead: string }>(
  ({ items, words, lead }) => {
    const first = Pair({ title: lead });
    const second = Pair({ title: "fixed" });
    const spelling = letters({ title: lead });
    return {
      first,
      second,
      rows: items.map((item) => {
        const left = Leaf({ title: item.title });
        const right = Leaf({ title: item.title + "'", step: 3 });
        return { left, right, both: left.shown + "|" + right.shown };
      }),
      tagged: words.map((word) => Leaf({ title: word })),
      kept: items.filter((item) => item.title !== "skip").map((item) =>
        Leaf({ title: item.title, step: 5 })
      ),
      spelled: spelling.map((letter) => Leaf({ title: letter })),
    };
  },
);
