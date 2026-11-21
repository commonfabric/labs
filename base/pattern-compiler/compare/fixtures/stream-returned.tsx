/// <cts-enable />
import { handler, lift, pattern, type Stream, Writable } from "commonfabric";

interface Item {
  title: string;
}

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

const pick = handler<unknown, { title: string; chosen: Writable<string> }>(
  (_, { title, chosen }) => {
    chosen.set(title);
  },
);

// A function body that is handed the stream of a binding of the reactive
// tier and returns it inside a value.
const wrap = lift(({ send }: { send: Stream<unknown> }) => ({
  again: send,
}));

// Ruling Z20: a function body may return a stream into the result.
// `wrapped.again` holds the stream of `inc`, which the body of `wrap`
// returned. `rows` and `labels` do the same with the stream of
// a binding of an element body: over records, which a test gives as
// references to cells, and over plain values in place.
export default pattern<{ items: Item[]; tags: string[] }>(
  ({ items, tags }) => {
    const count = Writable.of(0);
    const chosen = Writable.of("");
    const inc = bump({ count });
    const wrapped = wrap({ send: inc });
    return {
      count,
      chosen,
      inc,
      wrapped,
      rows: items.map((item) =>
        wrap({ send: pick({ title: item.title, chosen }) })
      ),
      labels: tags.map((tag) => wrap({ send: pick({ title: tag, chosen }) })),
    };
  },
);
