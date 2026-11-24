import { cell, pattern, UI } from "commonfabric";

// Tests nullish coalescing (??) interaction with && and ||
// ?? should NOT be transformed to when/unless (different semantics)
// FIXTURE: logical-nullish-coalescing
// Verifies: ?? operator combined with && and || is correctly handled in a lift-applied computation
//   (config.get().timeout ?? 30) || "disabled" → lift(...)({ config })
//   (config.get().retries ?? 3) > 0 && "text"  → lift(...)({ config })
// Context: ?? has different semantics from || and must not be transformed to unless
export default pattern((_state) => {
  const config = cell<{ timeout: number | null; retries: number | undefined }>({
    timeout: null,
    retries: undefined,
  });
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* ?? followed by || - different semantics */}
        <span>Timeout: {(config.get().timeout ?? 30) || "disabled"}</span>

        {/* ?? followed by && */}
        <span>{(config.get().retries ?? 3) > 0 && "Will retry"}</span>

        {/* Mixed: ?? with && and || */}
        <span>
          {items.get().length > 0 && (items.get()[0] ?? "empty") || "no items"}
        </span>
      </div>
    ),
  };
});
