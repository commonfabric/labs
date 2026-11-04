import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Counter from "../counter/counter.tsx";

interface Item {
  title: string;
  [UI]?: JSX.Element;
}

interface DragDropDemoInput {
  availableItems: Item[] | Default<[]>;
  droppedItems: Item[] | Default<[]>;
}

export interface DragDropDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  availableItems: Item[];
  droppedItems: Item[];
}

// Handler to remove an item from the dropped list
const removeItem = handler<
  unknown,
  { droppedItems: Writable<Item[]>; item: Writable<Item> }
>((_, { droppedItems, item }) => {
  const current = droppedItems.get();
  const index = current.findIndex((el) => equals(item, el));
  if (index >= 0) {
    droppedItems.set(current.toSpliced(index, 1));
  }
});

// Handler for dropping an item into the drop zone
const dropItem = handler<
  { detail: { sourceCell: Writable<Item> } },
  { droppedItems: Writable<Item[]> }
>((e, props) => {
  if (!props) {
    console.warn("[drag-drop-demo] dropItem: props is undefined");
    return;
  }
  const sourceItem = e.detail?.sourceCell?.get() as Item;
  if (sourceItem) {
    props.droppedItems.push(sourceItem);
  }
});

export default pattern<DragDropDemoInput, DragDropDemoOutput>(
  ({ availableItems, droppedItems }) => {
    const counter = Counter({ value: 5 });

    // Compute the items list
    const items = computed(() => {
      const defaultItems: Item[] = [
        { title: "Item A", [UI]: <div>Hello World!!!</div> },
        { title: "Counter", [UI]: counter[UI] }, // TODO(seefeld): fix this, title is indeed missing
        { title: "Item C" },
      ];

      return availableItems.length > 0 ? availableItems : defaultItems;
    });

    // Check if dropped items is empty
    const isEmpty = computed(() => droppedItems.length === 0);

    return {
      [NAME]: "Drag Drop Demo",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ marginTop: 0 }}>Available Items</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {items.map((item) => (
                <cf-drag-source $cell={item} type="item">
                  <div
                    style={{
                      padding: "0.75rem",
                      background: "#f0f0f0",
                      borderRadius: "4px",
                      cursor: "grab",
                      border: "1px solid #ddd",
                    }}
                  >
                    {item.title}
                  </div>
                </cf-drag-source>
              ))}
              <cf-cell-link $cell={counter} />
            </div>
          </div>

          <cf-drop-zone
            accept="item,cell-link"
            oncf-drop={dropItem({ droppedItems })}
          >
            <div
              style={{
                flex: 1,
                minWidth: "300px",
                minHeight: "300px",
                border: "2px dashed #ccc",
                borderRadius: "8px",
                padding: "1rem",
                background: "#fafafa",
              }}
            >
              <h3 style={{ marginTop: 0 }}>Drop Zone</h3>
              {ifElse(
                isEmpty,
                <p style={{ color: "#999", fontStyle: "italic" }}>
                  Drop items here
                </p>,
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  {droppedItems.map((item) => (
                    <div
                      style={{
                        padding: "0.5rem",
                        background: "#e8f5e9",
                        borderRadius: "4px",
                        border: "1px solid #81c784",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span>{item.title}</span>
                      <cf-button onClick={removeItem({ droppedItems, item })}>
                        ×
                      </cf-button>
                    </div>
                  ))}
                </div>,
              )}
            </div>
          </cf-drop-zone>
        </div>
      ),
      availableItems,
      droppedItems,
    };
  },
);
