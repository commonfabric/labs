/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

const add = handler<{ text: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.push(event.text);
  },
);

// Reads `count`, which a cone of the pattern computes from `items`.
const note = handler<unknown, { count: number; seen: Writable<number[]> }>(
  (_event, { count, seen }) => {
    seen.push(count);
  },
);

// Reads `joined`, a cell that the cone `_join` writes.
const copy = handler<
  unknown,
  { joined: Writable<string>; copied: Writable<string> }
>((_event, { joined, copied }) => {
  copied.set(joined.get());
});

// Writes `joined`, the cell that the cone `_join` writes, and reads
// nothing of it.
const overwrite = handler<unknown, { joined: Writable<string> }>(
  (_event, { joined }) => {
    joined.set("written by the handler");
  },
);

// Sends an event to the stream of `add`.
const relay = handler<
  { text: string },
  { to: Stream<{ text: string }> }
>((event, { to }) => {
  to.send({ text: event.text + "!" });
});

// Writes and then throws.
const fail = handler<unknown, { items: Writable<string[]> }>(
  (_event, { items }) => {
    items.push("lost");
    throw new Error("the handler fails");
  },
);

// The serving loop of `scheduler-and-serving-loop.md` §5 on one instance:
// `items` is an array of plain values in place, which the handlers push
// strings onto, and no per-element construct is over it. `count` reads
// the whole array, `_join` writes `joined` from it, and `total` reads
// `count`.
export default pattern<Record<string, never>>(() => {
  const items = Writable.of<string[]>([]);
  const seen = Writable.of<number[]>([]);
  const joined = Writable.of("");
  const copied = Writable.of("");
  const count = computed(() => items.get().length);
  const total = computed(() => `${count} in all`);
  const _join = computed(() => {
    joined.set(items.get().join(","));
  });
  const adding = add({ items });
  return {
    items,
    count,
    total,
    seen,
    copied,
    add: adding,
    note: note({ count, seen }),
    copy: copy({ joined, copied }),
    joined,
    overwrite: overwrite({ joined }),
    relay: relay({ to: adding }),
    fail: fail({ items }),
  };
});
