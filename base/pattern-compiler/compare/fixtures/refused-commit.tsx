/// <cts-enable />
import {
  handler,
  lift,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

interface Item {
  title: string;
}

interface Input {
  secret: string;
  last: Writable<string>;
  items: Writable<Item[]>;
}

// Writes into the input `last` a text that holds the input `secret`: the
// write carries the label of `secret` into a cell the pattern does not own.
const keep = handler<
  { text: string },
  { secret: string; last: Writable<string> }
>((event, { secret, last }) => {
  last.set(event.text + secret);
});

// Appends to what `last` holds: the write depends on the value the handler
// read there.
const append = handler<{ text: string }, { last: Writable<string> }>(
  (event, { last }) => {
    last.set(last.get() + event.text);
  },
);

// Adds an item whose title holds what `last` holds, and appends to `last`:
// a row of the result follows from each item.
const add = handler<
  { text: string },
  { last: Writable<string>; items: Writable<Item[]> }
>((event, { last, items }) => {
  items.push({ title: last.get() + event.text });
  last.set(last.get() + event.text);
});

const shout = lift(({ text }: { text: string }): string => text.toUpperCase());

interface Output {
  shown: string;
  rows: { label: string }[];
  keep: Stream<{ text: string }>;
  append: Stream<{ text: string }>;
  add: Stream<{ text: string }>;
}

// Derivations over cells that handlers write, for a commit of a handler
// that the storage refuses: `shown` is derived from `last`, and `rows` is a
// `map` over the array of references `items`.
export default pattern<Input, Output>(({ secret, last, items }) => ({
  shown: shout({ text: last }),
  rows: items.map((item) => ({ label: item.title + "!" })),
  keep: keep({ secret, last }),
  append: append({ last }),
  add: add({ last, items }),
}));
