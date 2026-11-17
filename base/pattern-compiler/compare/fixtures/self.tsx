/// <cts-enable />
import { handler, pattern, SELF, Writable } from "commonfabric";

interface Item {
  title: string;
}

// A body that is handed the reference and stores it.
const keep = handler<
  unknown,
  { self: Writable<{ title: string }>; kept: Writable<unknown> }
>((_, { self, kept }) => {
  kept.set(self);
});

// Ruling Z17: the name a pattern binds to `[SELF]` is a reference to the
// result cell of the instance. Value code places it in a value, in the
// pattern's body and in an element body, over `items` and over `tags`,
// which holds plain values in place. Ruling Z28: a handler captures it,
// in the pattern's body and in each of the two element bodies, and the
// state entry of its binding names the result of the instance.
export default pattern<{ title: string; items: Item[]; tags: string[] }>(
  ({ title, items, tags, [SELF]: self }) => {
    const kept = Writable.of<unknown>(null);
    return {
      title,
      other: self,
      rows: items.map((item) => ({
        title: item.title,
        owner: self,
        keep: keep({ self, kept }),
      })),
      words: tags.map((tag) => ({
        tag,
        owner: self,
        keep: keep({ self, kept }),
      })),
      kept,
      keep: keep({ self, kept }),
    };
  },
);
