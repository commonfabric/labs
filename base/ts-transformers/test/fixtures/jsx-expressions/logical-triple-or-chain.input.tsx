import { cell, pattern, UI } from "commonfabric";

// Tests triple || chain: a || b || c
// Should produce nested unless calls
// FIXTURE: logical-triple-or-chain
// Verifies: triple || chain (a || b || c) is transformed to nested unless() calls
//   primary.get().length || secondary.get().length || "no content" → unless(unless(...), "no content")
export default pattern((_state) => {
  const primary = cell("");
  const secondary = cell("");
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* Triple || chain - first truthy wins */}
        <span>{primary.get().length || secondary.get().length || "no content"}</span>

        {/* Triple || with mixed types */}
        <span>{items.get()[0]?.length || items.get()[1]?.length || 0}</span>
      </div>
    ),
  };
});
