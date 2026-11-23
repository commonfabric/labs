/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

// Pushes onto `items`, then reads `joined`, which follows from `items`,
// records what it read, and throws where the event says so.
const stage = handler<
  { text: string; fail?: boolean },
  {
    items: Writable<string[]>;
    joined: Writable<string>;
    seen: Writable<string[]>;
  }
>((event, { items, joined, seen }) => {
  items.push(event.text);
  seen.push(joined.get());
  if (event.fail) throw new Error("the handler fails");
});

// Records what `count`, `joined` and `loud` hold, writes nothing they
// follow from, and throws where the event says so.
const look = handler<
  { fail?: boolean },
  {
    count: number;
    joined: Writable<string>;
    loud: string;
    seen: Writable<string[]>;
  }
>((event, { count, joined, loud, seen }) => {
  seen.push(`${count} ${joined.get()} ${loud}`);
  if (event.fail) throw new Error("the handler fails");
});

// A handler that reads a derived value behind its own write (ES §1.6):
// the input `items` is an array of plain values in place with no
// per-element construct over it, `count` is computed from it, the cone
// `_join` writes `joined` from it, `total` reads `count`, and `loud` reads
// `joined`.
export default pattern<{ items: Writable<string[]> }>(({ items }) => {
  const seen = Writable.of<string[]>([]);
  const joined = Writable.of("");
  const count = computed(() => items.get().length);
  const total = computed(() => `${count} in all`);
  const _join = computed(() => {
    joined.set(items.get().join(","));
  });
  const loud = computed(() => joined.get().toUpperCase());
  return {
    items,
    count,
    total,
    joined,
    loud,
    seen,
    stage: stage({ items, joined, seen }),
    look: look({ count, joined, loud, seen }),
  };
});
