import { cell, pattern, UI } from "commonfabric";

// FIXTURE: logical-complex-expressions
// Verifies: nested && and mixed || && with JSX are transformed to when() with lift-applied predicates
//   a && b && <JSX>     → when(lift(...)({ a, b }), <JSX>)
//   (a || b) && <JSX>   → when(lift(...)({ a, b }), <JSX>)
export default pattern((_state) => {
  const items = cell<string[]>([]);
  const isEnabled = cell(false);
  const count = cell(0);

  return {
    [UI]: (
      <div>
        {/* Nested && - both conditions reference opaque refs */}
        {items.get().length > 0 && isEnabled.get() && <div>Enabled with items</div>}

        {/* Mixed || and && */}
        {(count.get() > 10 || items.get().length > 5) && <div>Threshold met</div>}
      </div>
    ),
  };
});
