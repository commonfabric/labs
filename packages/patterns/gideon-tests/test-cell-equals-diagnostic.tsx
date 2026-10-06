// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * DIAGNOSTIC PATTERN: Understanding Cell.get() array access behavior
 *
 * This pattern helps us understand what happens when we:
 * 1. Call items.get()[index]
 * 2. Set selectedItem to that value
 * 3. Check if it creates links/aliases vs copies
 */
import {
  debugStr,
  Default,
  handler,
  NAME,
  pattern,
  toIndentedDebugString,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  value: number;
}

export interface DiagInput {
  items: Item[] | Default<[]>;
  selectedItem: Item | null | Default<null>;
  log: string[] | Default<[]>;
}

// Add item handler
const addItem = handler<
  unknown,
  { items: Writable<Item[]>; log: Writable<string[]> }
>(
  (_, { items, log }) => {
    const newItem: Item = {
      title: `Item-${Date.now()}`,
      value: Math.floor(Math.random() * 100),
    };
    items.push(newItem);
    log.push(`Added item: ${newItem.title}`);
  },
);

// Select item by index - logs what we're doing
const selectByIndex = handler<
  unknown,
  {
    items: Writable<Item[]>;
    selectedItem: Writable<Item | null>;
    log: Writable<string[]>;
    index: number;
  }
>(
  (_, { items, selectedItem, log, index }) => {
    const itemsArray = items.get();
    log.push(`items.get() returned array of length: ${itemsArray.length}`);

    const targetItem = itemsArray[index];
    log.push(debugStr`itemsArray[${index}] = $quote,long${targetItem}`);
    log.push(`typeof targetItem: ${typeof targetItem}`);
    log.push(`targetItem constructor: ${targetItem?.constructor?.name}`);

    // Check if it has special symbols
    const symbols = Object.getOwnPropertySymbols(targetItem || {});
    log.push(`Symbols on targetItem: ${symbols.length}`);

    // Now set it
    selectedItem.set(targetItem);
    log.push(`Called selectedItem.set(targetItem)`);

    // Read back
    const readBack = selectedItem.get();
    log.push(debugStr`selectedItem.get() = $quote,long${readBack}`);

    // Check items again
    const itemsAfter = items.get();
    log.push(debugStr`items after set: $quote,long${itemsAfter}`);
  },
);

// Clear selection
const clearSelection = handler<
  unknown,
  { selectedItem: Writable<Item | null>; log: Writable<string[]> }
>(
  (_, { selectedItem, log }) => {
    selectedItem.set(null);
    log.push("Cleared selection");
  },
);

// Clear log
const clearLog = handler<unknown, { log: Writable<string[]> }>(
  (_, { log }) => {
    log.set([]);
  },
);

export default pattern<DiagInput, DiagInput>(
  ({ items, selectedItem, log }) => {
    return {
      [NAME]: "Writable.equals Diagnostic",
      [UI]: (
        <div style={{ padding: "1rem", fontFamily: "monospace" }}>
          <h2>Writable.equals() Diagnostic</h2>

          <div
            style={{
              marginBottom: "1rem",
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <cf-button onClick={addItem({ items, log })}>Add Item</cf-button>
            <cf-button onClick={clearSelection({ selectedItem, log })}>
              Clear Selection
            </cf-button>
            <cf-button onClick={clearLog({ log })}>Clear Log</cf-button>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <strong>Items ({items.length}):</strong>
            <div
              style={{
                background: "#f5f5f5",
                padding: "0.5rem",
                marginTop: "0.25rem",
              }}
            >
              {items.map((item, index) => (
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                    marginBottom: "0.25rem",
                  }}
                >
                  <span>[{index}] {item.title}: {item.value}</span>
                  <cf-button
                    onClick={selectByIndex({ items, selectedItem, log, index })}
                  >
                    Select
                  </cf-button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <strong>Selected Item:</strong>
            <div
              style={{
                background: "#e3f2fd",
                padding: "0.5rem",
                marginTop: "0.25rem",
              }}
            >
              <pre>{toIndentedDebugString(selectedItem)}</pre>
            </div>
          </div>

          <div>
            <strong>Log:</strong>
            <div
              style={{
                background: "#fff3e0",
                padding: "0.5rem",
                marginTop: "0.25rem",
                maxHeight: "300px",
                overflow: "auto",
              }}
            >
              {log.map((entry) => (
                <div
                  style={{
                    borderBottom: "1px solid #ddd",
                    padding: "0.25rem 0",
                  }}
                >
                  {entry}
                </div>
              ))}
            </div>
          </div>
        </div>
      ),
      items,
      selectedItem,
      log,
    };
  },
);
