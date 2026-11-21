/**
 * A text of everything a list holds, and a handler that appends a record.
 * The appended record is a document of its own, which the list holds a
 * link to: the read of the list's value goes through the list's own array
 * and through that link. The label of `all` holds what both hold.
 */
import {
  computed,
  type Confidential,
  handler,
  pattern,
  Writable,
} from "commonfabric";

interface Item {
  note: Confidential<string, readonly ["item-note"]>;
  amount: number;
}

interface State {
  items: Writable<Item[]>;
}

const append = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ note: "appended", amount: 3 });
  },
);

export default pattern<State>(({ items }) => ({
  all: computed(() => JSON.stringify(items.get())),
  append: append({ items }),
}));
