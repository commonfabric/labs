// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { Cell, Default, handler, NAME, pattern, UI } from "commonfabric";

interface SubItem {
  label: string;
  count: number | Default<0>;
}

interface Item {
  name: string;
  value: number | Default<0>;
  subItems: SubItem[] | Default<[]>;
}

export interface Input {
  title: string | Default<"Render Test">;
  globalCounter: number | Default<0>;
  items: Item[] | Default<[]>;
}

// Root level: increment global counter
const incrementGlobal = handler<unknown, { globalCounter: Cell<number> }>(
  (_event, { globalCounter }) => {
    globalCounter.set(globalCounter.get() + 1);
  },
);

// Root level: add new item
const addItem = handler<unknown, { items: Cell<Item[]> }>(
  (_event, { items }) => {
    const current = items.get();
    items.set([
      ...current,
      { name: `Item ${current.length + 1}`, value: 0, subItems: [] },
    ]);
  },
);

// Item level: increment item value
const incrementItem = handler<unknown, { item: Cell<Item> }>(
  (_event, { item }) => {
    const current = item.get();
    item.set({ ...current, value: current.value + 1 });
  },
);

// Item level: add sub-item
const addSubItem = handler<unknown, { item: Cell<Item> }>(
  (_event, { item }) => {
    const current = item.get();
    item.set({
      ...current,
      subItems: [
        ...current.subItems,
        { label: `Sub ${current.subItems.length + 1}`, count: 0 },
      ],
    });
  },
);

// Item level: remove item from list
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_event, { items, item }) => {
  const current = items.get();
  const index = current.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(current.toSpliced(index, 1));
  }
});

// Sub-item level: increment sub-item count
const incrementSubItem = handler<unknown, { subItem: Cell<SubItem> }>(
  (_event, { subItem }) => {
    const current = subItem.get();
    subItem.set({ ...current, count: current.count + 1 });
  },
);

export default pattern<Input, Input>(({ title, globalCounter, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <div style={{ padding: "16px", fontFamily: "sans-serif" }}>
        <h1>{title}</h1>

        {/* Root level mutation */}
        <div
          style={{
            marginBottom: "16px",
            padding: "8px",
            border: "1px solid #ccc",
          }}
        >
          <strong>Global Counter: {globalCounter}</strong>
          <button
            type="button"
            style={{ marginLeft: "8px" }}
            onClick={incrementGlobal({ globalCounter })}
          >
            +1 Global
          </button>
        </div>

        {/* Root level: add items */}
        <div style={{ marginBottom: "16px" }}>
          <button
            type="button"
            onClick={addItem({ items })}
          >
            Add Item
          </button>
        </div>

        {/* Item level */}
        <div>
          {items.map((item) => (
            <div
              style={{
                marginBottom: "12px",
                padding: "12px",
                border: "1px solid #999",
                backgroundColor: "#f9f9f9",
              }}
            >
              <div style={{ marginBottom: "8px" }}>
                <strong>{item.name}</strong> - Value: {item.value}
                <button
                  type="button"
                  style={{ marginLeft: "8px" }}
                  onClick={incrementItem({ item })}
                >
                  +1 Item
                </button>
                <button
                  type="button"
                  style={{ marginLeft: "4px" }}
                  onClick={addSubItem({ item })}
                >
                  Add Sub
                </button>
                <button
                  type="button"
                  style={{ marginLeft: "4px", color: "red" }}
                  onClick={removeItem({ items, item })}
                >
                  Remove
                </button>
              </div>

              {/* Sub-item level */}
              <div style={{ marginLeft: "20px" }}>
                {item.subItems.map((subItem) => (
                  <div style={{ marginBottom: "4px" }}>
                    <span>{subItem.label}: {subItem.count}</span>
                    <button
                      type="button"
                      style={{ marginLeft: "8px" }}
                      onClick={incrementSubItem({ subItem })}
                    >
                      +1 Sub
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    title,
    globalCounter,
    items,
  };
});
