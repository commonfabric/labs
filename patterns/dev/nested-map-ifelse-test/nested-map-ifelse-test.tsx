// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * CT-1158 TEST: Nested map with ifElse null handling
 *
 * This pattern demonstrates various map + ifElse combinations working correctly.
 * The fix ensures cell references are preserved even when ifElse returns null.
 *
 * TEST CASES:
 * 1. Basic List - simple map over items
 * 2. Category List - nested map with ifElse filtering by category
 * 3. Single Map + ifElse null - conditional rendering with null fallback
 * 4. Single Map + ifElse empty span - conditional rendering with empty element
 *
 * Use "Run Test Sequence" to verify all cases handle state changes correctly.
 */
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commonfabric";

interface Item {
  title: string;
  done: boolean | Default<false>;
  category: string | Default<"Uncategorized">;
}

interface Input {
  items:
    | Item[]
    | Default<[
      { title: "Milk"; done: false; category: "Dairy" },
      { title: "Bread"; done: false; category: "Bakery" },
      { title: "Cheese"; done: true; category: "Dairy" },
    ]>;
  log: string[] | Default<[]>;
}

// Handler to run the exact repro sequence (moved to module scope)
const runRepro = handler<unknown, { items: Cell<Item[]>; log: Cell<string[]> }>(
  (_event, { items: itemsList, log: logList }) => {
    const logMsg = (msg: string) => {
      logList.push(`${new Date().toISOString().slice(11, 19)} - ${msg}`);
    };

    logMsg("Starting repro sequence...");

    // Step 1: Log initial state
    const initial = itemsList.get();
    logMsg(
      `Initial items: ${
        initial.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );

    // Step 2: Check Milk (index 0)
    logMsg("Setting items[0].done = true (checking Milk)");
    itemsList.key(0).key("done").set(true);

    // Log state after check
    const afterCheck = itemsList.get();
    logMsg(
      `After check: ${
        afterCheck.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );

    // Step 3: Remove Milk (index 0)
    logMsg("Removing items[0] (Milk)");
    const current = itemsList.get();
    itemsList.set(current.toSpliced(0, 1));

    // Log final state
    const final = itemsList.get();
    logMsg(
      `Final items: ${
        final.map((i) => `${i.title}(done=${i.done})`).join(", ")
      }`,
    );
    logMsg("Test complete - all lists should show Bread and Cheese");
  },
);

// Handler to reset items (moved to module scope)
const resetItems = handler<
  unknown,
  { items: Cell<Item[]>; log: Cell<string[]> }
>(
  (_event, { items: itemsList, log: logList }) => {
    itemsList.set([
      { title: "Milk", done: false, category: "Dairy" },
      { title: "Bread", done: false, category: "Bakery" },
      { title: "Cheese", done: true, category: "Dairy" },
    ]);
    logList.set(["Reset to initial state"]);
  },
);

export default pattern<Input>(({ items, log }) => {
  // Categories from items
  const categories = computed(() => {
    const cats = new Set<string>();
    for (const item of items) {
      cats.add(item.category || "Uncategorized");
    }
    return Array.from(cats).sort();
  });

  return {
    [NAME]: "Nested Map + ifElse Test",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui" }}>
        <h2>Nested Map + ifElse Test</h2>

        <div style={{ marginBottom: "20px", display: "flex", gap: "10px" }}>
          <cf-button onClick={runRepro({ items, log })}>
            Run Test Sequence
          </cf-button>
          <cf-button onClick={resetItems({ items, log })}>
            Reset
          </cf-button>
        </div>

        {/* Row 1: Basic List vs Category List */}
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Test 1: Basic List - simple items.map */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "1px solid #e0e0e0",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0" }}>
              1. Basic List
            </h3>
            <div
              style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}
            >
              Simple map over items
            </div>
            {items.map((item, idx) => (
              <div style={{ margin: "4px 0" }}>
                <cf-checkbox $checked={item.done}>
                  [{idx}] {item.title} ({item.category})
                </cf-checkbox>
              </div>
            ))}
          </div>

          {/* Test 2: Category List - nested map with ifElse null */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "1px solid #e0e0e0",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0" }}>
              2. Category List
            </h3>
            <div
              style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}
            >
              Nested map with ifElse filtering by category
            </div>
            {categories.map((category) => (
              <div style={{ marginBottom: "8px" }}>
                <strong>{category}:</strong>
                {items.map((item, idx) =>
                  ifElse(
                    computed(() =>
                      (item.category || "Uncategorized") === category
                    ),
                    <div style={{ marginLeft: "16px" }}>
                      <cf-checkbox $checked={item.done}>
                        [{idx}] {item.title}
                      </cf-checkbox>
                    </div>,
                    null,
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Row 2: Single map tests with ifElse */}
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Test 3: Single map + ifElse null */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "1px solid #e0e0e0",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0" }}>
              3. Filtered (ifElse null)
            </h3>
            <div
              style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}
            >
              Shows only done items using null fallback
            </div>
            {items.map((item, idx) =>
              ifElse(
                computed(() => item.done),
                <div style={{ margin: "4px 0" }}>
                  <cf-checkbox $checked={item.done}>
                    [{idx}] {item.title} (done)
                  </cf-checkbox>
                </div>,
                null,
              )
            )}
            <div style={{ fontSize: "11px", color: "#999", marginTop: "8px" }}>
              (Shows only checked items)
            </div>
          </div>

          {/* Test 4: Single map + ifElse empty span */}
          <div
            style={{
              flex: 1,
              padding: "12px",
              border: "1px solid #e0e0e0",
              borderRadius: "8px",
            }}
          >
            <h3 style={{ margin: "0 0 12px 0" }}>
              4. Filtered (ifElse span)
            </h3>
            <div
              style={{ fontSize: "11px", color: "#666", marginBottom: "8px" }}
            >
              Shows only done items using empty span fallback
            </div>
            {items.map((item, idx) =>
              ifElse(
                computed(() => item.done),
                <div style={{ margin: "4px 0" }}>
                  <cf-checkbox $checked={item.done}>
                    [{idx}] {item.title} (done)
                  </cf-checkbox>
                </div>,
                <span style={{ display: "none" }} />,
              )
            )}
            <div style={{ fontSize: "11px", color: "#999", marginTop: "8px" }}>
              (Shows only checked items)
            </div>
          </div>
        </div>

        {/* Log output */}
        <div
          style={{
            padding: "12px",
            background: "#f5f5f5",
            borderRadius: "8px",
            fontFamily: "monospace",
            fontSize: "12px",
          }}
        >
          <strong>Log:</strong>
          {log.map((entry) => <div>{entry}</div>)}
        </div>

        <div
          style={{
            marginTop: "20px",
            padding: "12px",
            background: "#e8f5e9",
            borderRadius: "8px",
          }}
        >
          <strong>Expected after "Run Test Sequence":</strong>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
            <li>
              <strong>Test 1:</strong> Shows Bread, Cheese
            </li>
            <li>
              <strong>Test 2:</strong> Shows Bread (Bakery) and Cheese (Dairy)
            </li>
            <li>
              <strong>Test 3:</strong> Shows Cheese (the only done item)
            </li>
            <li>
              <strong>Test 4:</strong> Shows Cheese (the only done item)
            </li>
          </ul>
        </div>
      </div>
    ),
    items,
    log,
  };
});
