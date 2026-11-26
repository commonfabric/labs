// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: $checked on computed results
 *
 * Section A binds $checked on rows mapped from the `items` input, so checking
 * a box writes the item in `items`. Section B binds it on rows mapped from a
 * computed filter of `items`. Checking a box there raises no error, but the
 * write lands in the computed result's own row rather than in `items`, so the
 * matching box in section A does not change. A later change to `items` reruns
 * the filter and replaces the row.
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

        {/* Section A: rows mapped from the input write through to it */}
        <div
          style={{
            border: "2px solid green",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "green" }}>A: Direct Cell Map</h3>
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

        {/* Section B: rows mapped from a computed result write to that result */}
        <div
          style={{
            border: "2px solid orange",
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ color: "orange" }}>B: Computed Map</h3>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            $checked on activeItems.map() - computed result. Checking a box here
            does not change items.
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
{`Section A: Checkboxes toggle and write items
Section B: Checkboxes toggle without an error, but items does not change`}
          </pre>
        </div>
      </div>
    ),
    items,
  };
});
