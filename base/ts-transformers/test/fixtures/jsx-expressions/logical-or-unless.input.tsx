import { cell, pattern, UI } from "commonfabric";

// FIXTURE: logical-or-unless
// Verifies: || with JSX fallback on right side is transformed to unless()
//   items.get().length || <span>List is empty</span> → unless(lift(...)(...length), <span>List is empty</span>)
export default pattern((_state) => {
  const items = cell<string[]>([]);

  return {
    [UI]: (
      <div>
        {/* Pattern: falsy check || fallback */}
        {items.get().length || <span>List is empty</span>}
      </div>
    ),
  };
});
