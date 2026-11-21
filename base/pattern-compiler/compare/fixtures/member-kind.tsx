/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

// A stream at a member written after a spread in an array value, which
// is stored flat (ruling Z43). `after` is written after two entries of
// `rows`, a member and a spread, and `tail` after one entry of `words`. The spread of `rows` is over records, which a test gives as
// references to cells, and that of `words` over plain values in place.
// The executor's tests run this fixture. It is not compared with today's
// runtime.
export default pattern<{ items: Item[]; tags: string[] }>(
  ({ items, tags }) => {
    const count = Writable.of(0);
    const after = bump({ count });
    const tail = bump({ count });
    return {
      rows: [
        { title: "first" },
        ...items.map((item) => ({ title: item.title })),
        { pick: after },
      ],
      words: [...tags.map((tag) => ({ tag })), { pick: tail }],
      count,
    };
  },
);
