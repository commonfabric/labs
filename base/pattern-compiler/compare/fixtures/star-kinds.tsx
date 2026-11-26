/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

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

const Story = pattern<{ label: string }>(({ label }) => {
  const presses = Writable.of(0);
  return {
    [UI]: <a onClick={bump({ count: presses })}>{label}</a>,
    presses,
  };
});

// The positions of an array at which value code places the stream of a
// binding (ruling Z43). The callback of each of the first two lists
// writes the one stream of `inc` at every element, over records, which a
// test gives as references to cells, and over plain values in place.
// `more` is written after two entries of the third list, a text and a
// collection. `pick` is bound per key, and the fourth list holds two
// collections among the children of one node. One element of
// `sections`, an array of plain values written in place, holds the
// stream of a binding of `Story` inside its value. The last list is over
// the result of another per-element construct, whose elements hold the
// stream of a binding of that construct's body.
export default pattern<{ items: Item[]; tags: string[] }>(
  ({ items, tags }) => {
    const count = Writable.of(0);
    const chosen = Writable.of("");
    const inc = bump({ count });
    const more = bump({ count });
    const one = Story({ label: "one" });
    const two = Story({ label: "two" });
    const sections = [{ label: "one", node: one }, { label: "two", node: two }];
    const rows = tags.map((tag) => ({
      tag,
      pick: pick({ title: tag, chosen }),
    }));
    return {
      [UI]: (
        <div>
          <ul>{items.map((item) => <li onClick={inc}>{item.title}</li>)}</ul>
          <ol>{tags.map((tag) => <li onClick={inc}>{tag}</li>)}</ol>
          <nav>
            first
            {items.map((item) => <b>{item.title}</b>)}
            <b onClick={more}>more</b>
          </nav>
          <menu>
            {items.map((item) => (
              <li onClick={pick({ title: item.title, chosen })}>
                {item.title}
              </li>
            ))}
            {tags.map((tag) => (
              <li onClick={pick({ title: tag, chosen })}>{tag}</li>
            ))}
          </menu>
          <section>{sections.map((entry) => <div>{entry.node}</div>)}</section>
          <p>{rows.map((row) => <i onClick={row.pick}>{row.tag}</i>)}</p>
        </div>
      ),
      count,
      chosen,
      first: one.presses,
      second: two.presses,
    };
  },
);
