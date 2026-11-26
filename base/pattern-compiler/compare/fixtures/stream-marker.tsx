/// <cts-enable />
import { handler, pattern, type Stream, UI, Writable } from "commonfabric";

interface Item {
  title: string;
}

interface Input {
  items: Item[];
  tags: string[];
  shown: boolean;
  outside: Stream<{ by: number }>;
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

// Rulings Z11 and Z43: value code places the stream of a binding with
// the marker of `host.stream`, and the runtime replaces the marker by
// the link to the stream when it stores the value. `inc` is one stream
// at a member of the result, below a conditional, and after a
// collection. `pick` is bound once per element key in three bodies: over
// records, which a test gives as references to cells, over plain values
// stored in place, and over the result of a `filter`. `outside` is a
// stream the pattern is given, which it passes on as any input.
export default pattern<Input>(({ items, tags, shown, outside }) => {
  const chosen = Writable.of("");
  const count = Writable.of(0);
  const inc = bump({ count });
  return {
    [UI]: (
      <div>
        {shown ? <b onClick={inc}>+</b> : null}
        <ul>
          {items.map((item) => (
            <li onClick={pick({ title: item.title, chosen })}>{item.title}</li>
          ))}
          <li onClick={inc}>more</li>
        </ul>
        <ol>
          {tags.map((tag) => (
            <li onClick={pick({ title: tag, chosen })}>{tag}</li>
          ))}
        </ol>
        <p>
          {tags.filter((tag) => tag !== "skip").map((tag) => (
            <i onClick={pick({ title: tag, chosen })}>{tag}</i>
          ))}
        </p>
        <u onClick={outside}>out</u>
      </div>
    ),
    chosen,
    count,
    inc,
    outside,
  };
});
