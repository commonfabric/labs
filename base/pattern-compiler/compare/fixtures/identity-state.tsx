/// <cts-enable />
/**
 * A handler whose binding state holds an output of the pattern that it
 * reads as a handle and not as a value: `add` appends to `items` a record
 * that holds a link to `summary`, and reads nothing of what `summary`
 * holds. What `summary` holds is derived from `secret`.
 */
import { handler, lift, pattern, Writable } from "commonfabric";

interface Entry {
  title: string;
  source: Writable<string>;
}

interface State {
  items: Writable<Entry[]>;
  secret: string;
}

const upper = lift(({ text }: { text: string }): string => text.toUpperCase());

const add = handler<
  unknown,
  { items: Writable<Entry[]>; summary: Writable<string> }
>((_, { items, summary }) => {
  items.push({ title: "added", source: summary });
});

export default pattern<State>(({ items, secret }) => {
  const summary = upper({ text: secret });
  return {
    items,
    summary,
    add: add({ items, summary }),
  };
});
