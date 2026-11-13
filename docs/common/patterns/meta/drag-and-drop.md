# Drag and Drop

Enable drag-and-drop interactions between cells using `cf-drag-source` and `cf-drop-zone` components.

## Components

### cf-drag-source

Wraps content that can be dragged. The dragged cell is passed to any drop zone that accepts it.

What a drop passes is the cell `$cell` resolves to when the press begins. Inside a `.map()` over a list of inline entries, that is the entry the row showed at that moment, even when a reorder has since moved another entry into the row. `equals()` matches it to that entry in the list's `.get()`.

| Attribute | Type | Description |
|-----------|------|-------------|
| `$cell` | `Cell` | The cell being dragged (required) |
| `type` | `string` | Type identifier for filtering which drop zones accept this source |
| `disabled` | `boolean` | Disable dragging |

### cf-drop-zone

Marks a region where items can be dropped. Provides visual feedback (dashed outline) when a valid drag is over it.

| Attribute | Type | Description |
|-----------|------|-------------|
| `accept` | `string` | Comma-separated types to accept (empty = accept all) |

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `oncf-drop` | `{ detail: { sourceCell: Writable<T>, type?: string } }` | Fired when a valid drop occurs, once the dragged cell has resolved (a round trip to the worker after the release) |
| `oncf-drag-enter` | `{ detail: { sourceCell: Cell, type?: string } }` | Fired when drag enters the zone |
| `oncf-drag-leave` | `{ detail: {} }` | Fired when drag leaves the zone |

## Example

```tsx
import {
  Default,
  equals,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

interface DragDropDemoInput {
  availableItems: Item[] | Default<[{ title: "Item A" }, { title: "Item B" }, { title: "Item C" }]>;
  droppedItems: Writable<Item[]>;
}

interface DragDropDemoOutput {
  availableItems: Item[];
  droppedItems: Writable<Item[]>;
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

export default pattern<DragDropDemoInput, DragDropDemoOutput>(
  ({ availableItems, droppedItems }) => {
    return {
      [NAME]: "Drag Drop Demo",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
          {/* Drag Sources */}
          <div style={{ flex: 1 }}>
            <h3 style={{ marginTop: 0 }}>Available Items</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {availableItems.map((item) => (
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
            </div>
          </div>

          {/* Drop Zone */}
          <cf-drop-zone
            accept="item"
            oncf-drop={(e: { detail: { sourceCell: Writable<Item> } }) => {
              droppedItems.push(e.detail.sourceCell);
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: "200px",
                minHeight: "200px",
                border: "2px dashed #ccc",
                borderRadius: "8px",
                padding: "1rem",
              }}
            >
              <h3 style={{ marginTop: 0 }}>Drop Zone</h3>
              {droppedItems.get().length === 0 ? (
                <p style={{ color: "#999" }}>Drop items here</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
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
                        x
                      </cf-button>
                    </div>
                  ))}
                </div>
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
```

## Best Practices

1. **Use `equals()` for Cell identity** - When finding items in arrays, use `equals(cellA, cellB)` instead of `===`. This is critical for multi-tab scenarios where the same logical cell may have different object references.

2. **Get fresh array data** - Always call `.get()` on the array before searching/modifying. Don't rely on stale references.

3. **Use type filtering** - Set `type` on drag sources and `accept` on drop zones to control which items can be dropped where.

4. **Handle missing items gracefully** - Check if `findIndex` returns `-1` before modifying arrays. Another tab may have already removed the item.
