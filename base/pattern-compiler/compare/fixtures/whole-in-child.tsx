/**
 * A pattern compiled into another, which is given a list by reference,
 * binds a handler to it and shows a text of everything it holds. The
 * handler's binding observes which reference the argument holds, and the
 * text observes the list's value, through that reference: the label of the
 * text holds what the list holds.
 */
import {
  computed,
  type Confidential,
  handler,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  note: Confidential<string, readonly ["item-note"]>;
  amount: number;
}

interface State {
  items: Writable<Item[]>;
}

const clear = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.set([]);
  },
);

const Child = pattern<State>(({ items }) => ({
  [UI]: <pre>{computed(() => JSON.stringify(items.get()))}</pre>,
  clear: clear({ items }),
}));

export default pattern<State>(({ items }) => {
  const child = Child({ items });
  return { [UI]: <div>{child}</div>, items };
});
