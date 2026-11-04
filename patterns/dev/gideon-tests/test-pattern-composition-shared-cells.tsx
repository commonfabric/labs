// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: Pattern Composition with Shared Cell References
 *
 * CLAIM: "Both patterns receive the same `items` cell reference... Changes in
 * one view automatically update the other (they share the same cell)"
 * SOURCE: docs/common/PATTERNS.md, patterns.md folk wisdom
 *
 * WHAT THIS TESTS:
 * Two sub-patterns (BasicList and CategoryList) both receive the same `items`
 * cell. When you modify data through one pattern's UI, we verify whether the
 * other pattern's UI updates automatically.
 *
 * EXPECTED BEHAVIOR IF CLAIM IS TRUE:
 * 1. Adding an item via BasicList's input updates CategoryList instantly
 * 2. Toggling done state in either view updates the other view
 * 3. Removing an item from either view removes it from both
 * 4. The cell reference is truly shared, not copied
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Note the items shown in both "Basic List" and "Category List" sections
 * 2. Add a new item using "Basic List" input with category
 * 3. Verify it appears immediately in BOTH views
 * 4. Check an item as done in "Basic List"
 * 5. Verify it shows as done (strikethrough) in "Category List"
 * 6. Remove an item from "Category List" using x button
 * 7. Verify it disappears from "Basic List" too
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface ShoppingItem {
  title: string;
  done: boolean | Default<false>;
  category: string | Default<"Uncategorized">;
}

// Handlers at module scope
const removeItem = handler<
  unknown,
  {
    items: Writable<Array<Writable<ShoppingItem>>>;
    item: Writable<ShoppingItem>;
  }
>(
  (_event, { items: itemsList, item }) => {
    const current = itemsList.get();
    const index = current.findIndex((el) => el.equals(item));
    if (index >= 0) {
      itemsList.set(current.toSpliced(index, 1));
    }
  },
);

const addItem = handler<
  { detail: { message: string } },
  { items: Writable<ShoppingItem[]> }
>(
  ({ detail }, { items: itemsList }) => {
    const input = detail?.message?.trim();
    if (input) {
      const [title, category = "Uncategorized"] = input.split(":");
      itemsList.push({
        title: title.trim(),
        done: false,
        category: category.trim(),
      });
    }
  },
);

// Sub-pattern 1: Basic list view
interface BasicListInput {
  items: Writable<ShoppingItem[]>;
}

const BasicList = pattern<BasicListInput>(({ items }) => {
  return {
    [NAME]: "Basic Shopping List",
    [UI]: (
      <div
        style={{
          padding: "12px",
          border: "2px solid #4caf50",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#2e7d32" }}>
          Basic List View
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {items.map((item) => (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <cf-checkbox $checked={item.done}>
                <span
                  style={computed(
                    () => (item.done ? { textDecoration: "line-through" } : {}),
                  )}
                >
                  {item.title} ({item.category})
                </span>
              </cf-checkbox>
              <cf-button onClick={removeItem({ items, item })}>x</cf-button>
            </div>
          ))}
        </div>

        <cf-message-input
          placeholder="Add item (e.g., Apples:Produce)..."
          oncf-send={addItem({ items })}
        />
      </div>
    ),
    items,
  };
});

// Sub-pattern 2: Categorized view
interface CategoryListInput {
  items: Writable<ShoppingItem[]>;
}

const CategoryList = pattern<CategoryListInput>(({ items }) => {
  // Compute unique sorted categories from items
  const categories = computed(() => {
    const cats = new Set<string>();
    for (const item of items.get()) {
      cats.add(item.category || "Uncategorized");
    }
    return Array.from(cats).sort();
  });

  return {
    [NAME]: "Shopping List by Category",
    [UI]: (
      <div
        style={{
          padding: "12px",
          border: "2px solid #2196f3",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", color: "#1565c0" }}>
          Category List View
        </h3>
        {categories.map((category) => (
          <div style={{ marginBottom: "12px" }}>
            <h4 style={{ margin: "0 0 8px 0", color: "#666" }}>{category}</h4>
            {items.map((item) =>
              ifElse(
                computed(() => (item.category || "Uncategorized") === category),
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginLeft: "16px",
                  }}
                >
                  <cf-checkbox $checked={item.done}>
                    <span
                      style={computed(() => (item.done
                        ? { textDecoration: "line-through" }
                        : {})
                      )}
                    >
                      {item.title}
                    </span>
                  </cf-checkbox>
                  <cf-button onClick={removeItem({ items, item })}>x</cf-button>
                </div>,
                null,
              )
            )}
          </div>
        ))}
      </div>
    ),
    items,
  };
});

// Main pattern: Compose both views with shared cell
interface ComposedInput {
  items:
    | ShoppingItem[]
    | Default<[
      { title: "Milk"; done: false; category: "Dairy" },
      { title: "Bread"; done: false; category: "Bakery" },
      { title: "Cheese"; done: true; category: "Dairy" },
    ]>;
}

export default pattern<ComposedInput>(({ items }) => {
  // Create both sub-patterns with the SAME items cell
  const basicView = BasicList({ items });
  const categoryView = CategoryList({ items });

  return {
    [NAME]: "Test: Pattern Composition with Shared Cells",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
        <h2>Pattern Composition Test</h2>

        <div
          style={{
            marginBottom: "20px",
            padding: "12px",
            backgroundColor: "#fff3e0",
            borderRadius: "8px",
          }}
        >
          <p>
            <strong>Test Instructions:</strong>
          </p>
          <ol style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li>Add an item in Basic List using format "Title:Category"</li>
            <li>Watch it appear in BOTH views instantly</li>
            <li>Toggle done state in one view, see it update in the other</li>
            <li>
              Remove an item from either view, watch it disappear from both
            </li>
          </ol>
          <p style={{ margin: "8px 0 0 0" }}>
            <em>If all work correctly → Claim VERIFIED</em>
          </p>
        </div>

        <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 300px" }}>{basicView}</div>
          <div style={{ flex: "1 1 300px" }}>{categoryView}</div>
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "12px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 8px 0" }}>Technical Details</h3>
          <p style={{ margin: 0, fontSize: "14px", fontFamily: "monospace" }}>
            Both patterns receive: <code>items</code> (same Cell reference)
          </p>
        </div>
      </div>
    ),
    items,
  };
});
