/**
 * A small pattern for assert-diagnostics fixtures to instantiate, so the
 * assertions read pattern output through reactive proxies rather than through
 * `cell(...).get()`.
 */

import { Cell, Default, handler, pattern } from "commonfabric";

export interface Item {
  name: string;
  quantity: number;
}

export interface Input {
  items: Default<Item[], []>;
}

export interface Output {
  items: Item[];
  addItem: ReturnType<typeof addItemHandler>;
}

const addItemHandler = handler<Item, { items: Cell<Item[]> }>(
  (event, { items }) => {
    items.push({ name: event.name, quantity: event.quantity });
  },
);

export default pattern<Input, Output>(({ items }) => {
  return {
    items,
    addItem: addItemHandler({ items }),
  };
});
