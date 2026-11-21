/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  value: string;
  count: number;
}

const put = handler<
  unknown,
  {
    items: Writable<Record<string, Item>>;
    logs: Writable<string[]>;
    item: Item;
  }
>((_, { items, logs, item }) => {
  items.key("k").set(item);
  logs.push(`wrote ${item.value}`);
});

// The binding gives its state an object whose members are all literals:
// the plan holds a state entry for each member and none for `item`, which
// the handler's body reads whole and one member of.
export default pattern<{ note: string }>(({ note }) => {
  const items = Writable.of<Record<string, Item>>({});
  const logs = Writable.of<string[]>([]);
  return {
    note,
    items,
    logs,
    put: put({ items, logs, item: { value: "a", count: 1 } }),
  };
});
