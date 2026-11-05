// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: $checked on computed results
 *
 * Claim: $checked binding only works on direct Cell<T[]> maps,
 * not on computed results (which use read-only data URIs).
 *
 * Expected: ReadOnlyAddressError when using $checked on computed().map()
 */
import { computed, Default, NAME, pattern, UI } from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean | Default<false>;
  active: boolean | Default<true>;
}

interface Input {
  items:
    | Item[]
    | Default<[
      { id: "1"; title: "Task A"; done: false; active: true },
      { id: "2"; title: "Task B"; done: true; active: true },
      { id: "3"; title: "Task C"; done: false; active: false },
    ]>;
}

export default pattern<Input>(({ items }) => {
  // Computed: filter to only active items
  const activeItems = computed(() => items.filter((i) => i.active));

  // Count for display
  const activeCount = computed(() => activeItems.length);
  const totalCount = computed(() => items.length);

  return {
    [NAME]: "TEST: $checked on Computed",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "600px" }}>
        <h2>$checked on Computed Test</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Testing if $checked works on computed results vs direct Cell maps
        </p>

        <div
          style={{
            background: "#f0f0f0",
            padding: "0.5rem",
            marginBottom: "1rem",
            borderRadius: "4px",
          }}
        >
          Active: {activeCount} / Total: {totalCount}
        </div>

        {/* TEST A: Direct Cell map - should work */}
        <div
          style={{
            border: "2px solid green",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "green" }}>A: Direct Cell Map (should work)</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            $checked on items.map() - direct Cell access
          </p>
          {items.map((item) => (
            <div style={{ marginBottom: "0.25rem" }}>
              <cf-checkbox $checked={item.done}>
                {item.title} {item.active ? "" : "(inactive)"}
              </cf-checkbox>
            </div>
          ))}
        </div>

        {/* TEST B: Computed map - claimed to fail */}
        <div
          style={{
            border: "2px solid orange",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "orange" }}>B: Computed Map (claimed to fail)</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            $checked on activeItems.map() - computed result. Superstition says
            this should cause ReadOnlyAddressError.
          </p>
          {activeItems.map((item) => (
            <div style={{ marginBottom: "0.25rem" }}>
              <cf-checkbox $checked={item.done}>
                {item.title}
              </cf-checkbox>
            </div>
          ))}
        </div>

        {/* Expected results */}
        <div
          style={{
            border: "2px solid #333",
            padding: "1rem",
            borderRadius: "8px",
            background: "#f9f9f9",
          }}
        >
          <h3>Expected Results</h3>
          <pre style={{ fontSize: "0.75rem" }}>
{`Section A: Checkboxes should toggle (direct Cell)
Section B: Should FAIL with ReadOnlyAddressError (if superstition is true)
          OR work fine (if superstition is wrong)`}
          </pre>
        </div>
      </div>
    ),
    items,
  };
});
