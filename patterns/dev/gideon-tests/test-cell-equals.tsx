// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: equals() vs Manual IDs
 *
 * WHAT THIS TESTS:
 * This pattern demonstrates that the framework tracks object identity internally,
 * and manual ID generation is unnecessary. Using equals() for item comparison
 * is the recommended approach.
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Click "Add Item" several times to add items to the list
 * 2. Click on different items to select them
 * 3. Verify that:
 *    - Only one item is highlighted at a time (green background)
 *    - The selected item title appears at the top
 *    - Clicking a selected item deselects it
 * 4. Click "Remove Selected" to remove the selected item
 * 5. Verify the item is removed and selection clears
 * 6. Select an item, then add a new item at the start
 * 7. Verify the selected item remains correctly highlighted
 *
 * WHAT CONFIRMS IT WORKS:
 * - Items can be selected/deselected by clicking
 * - Selection highlighting follows the correct item even after list changes
 * - Items can be removed using equals() to find them
 * - No manual ID generation is needed for any of this to work
 * - The pattern uses object references (cells) instead of string IDs
 */
import {
  computed,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
  description: string;
}

interface TestCellEqualsInput {
  items: Writable<Item[]>;
  selectedItem: Writable<Item | null>;
}

export interface TestCellEqualsOutput extends TestCellEqualsInput {}

// Handler to add a new item at the END of the list
// (Adding at end keeps indices stable for existing items)
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    const timestamp = new Date().toLocaleTimeString();
    const newItem: Item = {
      title: `Item ${timestamp}`,
      description: `Created at ${timestamp}`,
    };
    items.push(newItem);
  },
);

// Handler to select an item by index (or deselect if already selected)
// We use index because the workaround pre-computes items in a computed(),
// which gives us plain values instead of cell references.
const selectItem = handler<
  unknown,
  {
    selectedItem: Writable<Item | null>;
    items: Writable<Item[]>;
    index: number;
  }
>(
  (_, { selectedItem, items, index }) => {
    const current = selectedItem.get();
    const targetItem = items.get()[index];
    if (!targetItem) return;

    // Use equals() to check if this item is already selected
    // This tests the core claim: equals() can identify items
    // without needing manual IDs
    if (current && equals(current, targetItem)) {
      // Deselect if clicking the same item
      selectedItem.set(null);
    } else {
      // Select the clicked item
      selectedItem.set(targetItem);
    }
  },
);

// Handler to remove the selected item
const removeSelected = handler<
  unknown,
  { items: Writable<Item[]>; selectedItem: Writable<Item | null> }
>(
  (_, { items, selectedItem }) => {
    const selected = selectedItem.get();
    if (!selected) return;

    const current = items.get();
    // Use equals() to find the item in the array
    const index = current.findIndex((el) => equals(selected, el));
    if (index >= 0) {
      items.set(current.toSpliced(index, 1));
      selectedItem.set(null);
    }
  },
);

export default pattern<TestCellEqualsInput, TestCellEqualsOutput>(
  ({ items, selectedItem }) => {
    // Create computed values for display
    const hasSelection = computed(() => selectedItem.get() !== null);
    const selectedTitle = computed(() => {
      const selected = selectedItem.get();
      return selected ? selected.title : "";
    });

    // WORKAROUND: Pre-compute selection state outside the map callback
    // This avoids the "Cannot create cell link - space required" error
    // that occurs when closing over cells inside .map() callbacks
    const itemsWithSelection = computed(() => {
      const selected = selectedItem.get();
      return items.get().map((item, index) => ({
        item,
        index,
        isSelected: selected !== null && equals(selected, item),
      }));
    });

    return {
      [NAME]: "Test equals()",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <h2>equals() Test Pattern</h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            This pattern demonstrates using equals() for item identification
            instead of manual ID generation.
          </p>

          {/* Controls */}
          <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
            <cf-button onClick={addItem({ items })}>Add Item</cf-button>
            <cf-button onClick={removeSelected({ items, selectedItem })}>
              Remove Selected
            </cf-button>
          </div>

          {/* Selected item display */}
          {ifElse(
            hasSelection,
            <div
              style={{
                padding: "0.75rem",
                marginBottom: "1rem",
                background: "#e3f2fd",
                borderRadius: "4px",
                border: "1px solid #2196f3",
              }}
            >
              <strong>Selected:</strong> {selectedTitle}
            </div>,
            <div
              style={{
                padding: "0.75rem",
                marginBottom: "1rem",
                background: "#f5f5f5",
                borderRadius: "4px",
                fontStyle: "italic",
                color: "#999",
              }}
            >
              No item selected
            </div>,
          )}

          {/* Items list - using pre-computed selection state */}
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            {itemsWithSelection.map((entry) => (
              <div
                onClick={selectItem({
                  selectedItem,
                  items,
                  index: entry.index,
                })}
                style={{
                  padding: "0.75rem",
                  background: entry.isSelected ? "#c8e6c9" : "#f9f9f9",
                  borderRadius: "4px",
                  border: entry.isSelected
                    ? "2px solid #4caf50"
                    : "1px solid #ddd",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <div
                  style={{ fontWeight: entry.isSelected ? "bold" : "normal" }}
                >
                  {entry.item.title}
                </div>
                <div style={{ fontSize: "0.85rem", color: "#666" }}>
                  {entry.item.description}
                </div>
              </div>
            ))}
          </div>

          {/* Show count */}
          <div
            style={{
              marginTop: "1rem",
              padding: "0.5rem",
              background: "#fff3e0",
              borderRadius: "4px",
              fontSize: "0.9rem",
            }}
          >
            Total items: {computed(() => items.get().length)}
          </div>
        </div>
      ),
      items,
      selectedItem,
    };
  },
);
