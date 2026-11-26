// deno-lint-ignore-file
/// <cts-enable />
import { computed, handler, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
}

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

// A stream at a member written after a spread in an array value, and at
// a child written after two JSX spread children. Each is written in a
// `computed`, where today's runtime runs it: written in the pattern's
// body, today's transformer refuses the spread in the array value, and
// today's JSX factory throws at the spread child. `items` and `tags`
// are arrays of plain values in place, which each `computed` reads
// whole, so no per-element construct of the plan is over them. The
// stream of `after` is in `rows` and in the tree, and that of `tail` in
// `words`. The file is left out of `deno lint`, which stops with an
// internal error at a JSX spread child.
export default pattern<{ items: Item[]; tags: string[] }>(
  ({ items, tags }) => {
    const count = Writable.of(0);
    const after = bump({ count });
    const tail = bump({ count });
    return {
      rows: computed(() => [
        { title: "first" },
        ...items.map((item) => ({ title: item.title })),
        { pick: after },
      ]),
      words: computed(() => [...tags.map((tag) => ({ tag })), { pick: tail }]),
      count,
      [UI]: computed(() => (
        <ul>
          <li>first</li>
          {...tags}
          {...items.map((item) => <li>{item.title}</li>)}
          <cf-button onClick={after}>after</cf-button>
        </ul>
      )),
    };
  },
);
