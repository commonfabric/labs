// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: JSX is Automatically Reactive
 *
 * CLAIM: Within JSX, reactivity is automatic - you don't need computed()
 * SOURCE: folk_wisdom/reactivity.md, CELLS_AND_REACTIVITY.md
 *
 * WHAT THIS TESTS:
 * This pattern demonstrates that reactive values update automatically in JSX
 * without needing to wrap them in computed(). We test:
 * 1. Direct cell references update automatically
 * 2. Property access (user.name) updates automatically
 * 3. Inline expressions (count * 2) update automatically
 * 4. Array operations (items.length) update automatically
 * 5. Conditional expressions (ternary) work with reactive values
 *
 * EXPECTED BEHAVIOR:
 * When you click "Update All Values", all displayed values should update
 * immediately without any computed() wrappers.
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Load the pattern
 * 2. Observe initial values: Count=0, User="Alice", Items=3
 * 3. Click "Update All Values"
 * 4. Verify all values update: Count=1, User="Bob", Items=4, Status="Active"
 * 5. Click multiple times to verify continuous updates
 */
import { Default, handler, NAME, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
}

interface User {
  name: string;
  age: number;
}

interface TestInput {
  count: number | Default<0>;
  user: User | Default<{ name: "Alice"; age: 30 }>;
  items:
    | Item[]
    | Default<[{ title: "Item 1" }, { title: "Item 2" }, { title: "Item 3" }]>;
}

const updateAllValues = handler<
  unknown,
  { count: Writable<number>; user: Writable<User>; items: Writable<Item[]> }
>((_args, { count, user, items }) => {
  // Increment count
  count.set(count.get() + 1);

  // Toggle user name
  const currentUser = user.get();
  user.update({
    name: currentUser.name === "Alice" ? "Bob" : "Alice",
  });

  // Add or remove an item
  const currentItems = items.get();
  if (currentItems.length < 5) {
    items.set([...currentItems, { title: `Item ${currentItems.length + 1}` }]);
  } else {
    items.set(currentItems.slice(0, 3));
  }
});

export default pattern<TestInput>(({ count, user, items }) => {
  return {
    [NAME]: "Test: JSX Automatic Reactivity",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
        <h2>JSX Automatic Reactivity Test</h2>

        <div
          style={{
            marginBottom: "20px",
            padding: "15px",
            backgroundColor: "#f0f0f0",
            borderRadius: "5px",
          }}
        >
          <h3>
            All values below use NO computed() - just direct references in JSX
          </h3>
        </div>

        <div style={{ display: "grid", gap: "15px", marginBottom: "20px" }}>
          {/* 1. Direct cell reference */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#e3f2fd",
              borderRadius: "5px",
            }}
          >
            <strong>Direct cell reference:</strong> Count = {count}
          </div>

          {/* 2. Property access */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#f3e5f5",
              borderRadius: "5px",
            }}
          >
            <strong>Property access:</strong> User name = {user.name}
          </div>

          {/* 3. Inline expression */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#e8f5e9",
              borderRadius: "5px",
            }}
          >
            <strong>Inline expression:</strong> Count x 2 = {count * 2}
          </div>

          {/* 4. Array operations */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#fff3e0",
              borderRadius: "5px",
            }}
          >
            <strong>Array operations:</strong> Item count = {items.length}
          </div>

          {/* 5. Nested property access */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#e1bee7",
              borderRadius: "5px",
            }}
          >
            <strong>Nested property:</strong> Age = {user.age}
          </div>

          {/* 6. Array mapping (reactive) */}
          <div
            style={{
              padding: "10px",
              backgroundColor: "#b2dfdb",
              borderRadius: "5px",
            }}
          >
            <strong>Array mapping:</strong>
            <ul style={{ margin: "5px 0 0 0", paddingLeft: "20px" }}>
              {items.map((item, i) => <li key={i}>{item.title}</li>)}
            </ul>
          </div>
        </div>

        <cf-button onClick={updateAllValues({ count, user, items })}>
          Update All Values
        </cf-button>

        <div
          style={{
            marginTop: "20px",
            padding: "15px",
            backgroundColor: "#fffde7",
            borderRadius: "5px",
          }}
        >
          <h4>What to observe:</h4>
          <ul>
            <li>Click the button and watch ALL values update simultaneously</li>
            <li>
              No computed() wrappers are needed for any of these reactive
              updates
            </li>
            <li>This demonstrates that JSX has built-in reactivity</li>
          </ul>
        </div>
      </div>
    ),
    count,
    user,
    items,
  };
});
