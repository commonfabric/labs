import { Default, handler, NAME, pattern, UI, Writable } from "commonfabric";

interface Item {
  text: string | Default<"">;
}

interface InputSchema {
  title: string | Default<"untitled">;
  items: Item[] | Default<[]>;
}

type InputEventType = {
  detail: {
    message: string;
  };
};

interface ListState {
  items: Writable<Item[]>;
}

const addItem = handler<InputEventType, ListState>(
  (event: InputEventType, state: ListState) => {
    state.items.push({ text: event.detail.message });
  },
);

const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});

const updateItem = handler<
  { detail: { value: string } },
  { items: Writable<Item[]>; index: number }
>(({ detail: { value } }, { items, index }) => {
  const itemsCopy = items.get().slice();
  if (index >= 0 && index < itemsCopy.length) {
    itemsCopy[index] = { text: value };
    items.set(itemsCopy);
  }
});

export default pattern<InputSchema>(({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "600px" }}>
        <h3>{title}</h3>
        <p>Editable Array with Remove</p>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          {items.map((item, index) => (
            <div
              key={index}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <cf-button
                variant="destructive"
                size="sm"
                onClick={removeItem({ items, item })}
              >
                Remove
              </cf-button>
              <div style={{ flex: 1 }}>
                <cf-input
                  value={item.text}
                  oncf-change={updateItem({ items, index })}
                  placeholder="Enter text..."
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: "1rem" }}>
          <cf-message-input
            name="Send"
            placeholder="Type a message..."
            appearance="rounded"
            oncf-send={addItem({ items })}
          />
        </div>
      </div>
    ),
    title,
    items,
    addItem: addItem({ items }),
    updateItem,
  };
});
