/// <cts-enable />
import {
  action,
  computed,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

interface RowInput {
  item: Item;
  removeItem: Stream<{ item: Item }>;
  pinItem: Stream<{ item: Item }>;
  noteItem: Stream<{ item: Item }>;
}

// A row whose buttons send the list the row's own item, as the row of
// `patterns/examples/todo-list` does.
const Row = pattern<RowInput, { [UI]: VNode }>(
  ({ item, removeItem, pinItem, noteItem }) => ({
    [UI]: (
      <div>
        <span>{item.title}</span>
        <button type="button" onClick={() => removeItem.send({ item })}>
          x
        </button>
        <button type="button" onClick={() => pinItem.send({ item })}>
          pin
        </button>
        <button type="button" onClick={() => noteItem.send({ item })}>
          note
        </button>
      </div>
    ),
  }),
);

interface ListInput {
  items: Writable<Item[]>;
  pinned: Writable<Item[]>;
}

// `Filtered`: the rows are a `map` over the result of a `computed` that
// filters the items, as the todo list's open items are. The list's actions
// remove the item an event names, pin it once, and note its title.
export const Filtered = pattern<ListInput>(({ items, pinned }) => {
  const addItem = action(({ title }: { title: string }) => {
    items.push({ title, done: false });
  });
  const removeItem = action(({ item }: { item: Item }) => {
    items.remove(item);
  });
  const pinItem = action(({ item }: { item: Item }) => {
    pinned.addUnique(item);
  });
  const last = Writable.of("");
  const noteItem = action(({ item }: { item: Item }) => {
    last.set(item.title);
  });
  const open = computed(() => items.get().filter((item) => !item.done));
  const rows = open.map((item) => (
    <Row
      item={item}
      removeItem={removeItem}
      pinItem={pinItem}
      noteItem={noteItem}
    />
  ));
  return {
    items,
    pinned,
    last,
    rows,
    addItem,
    removeItem,
    pinItem,
    noteItem,
  };
});

// `Direct`: the rows are a `map` over the items themselves.
export const Direct = pattern<ListInput>(({ items, pinned }) => {
  const addItem = action(({ title }: { title: string }) => {
    items.push({ title, done: false });
  });
  const removeItem = action(({ item }: { item: Item }) => {
    items.remove(item);
  });
  const pinItem = action(({ item }: { item: Item }) => {
    pinned.addUnique(item);
  });
  const last = Writable.of("");
  const noteItem = action(({ item }: { item: Item }) => {
    last.set(item.title);
  });
  const rows = items.map((item) => (
    <Row
      item={item}
      removeItem={removeItem}
      pinItem={pinItem}
      noteItem={noteItem}
    />
  ));
  return {
    items,
    pinned,
    last,
    rows,
    addItem,
    removeItem,
    pinItem,
    noteItem,
  };
});
