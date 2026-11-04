import { cell, NAME, pattern, UI } from "commonfabric";

// FIXTURE: conditional-empty-check
// Verifies: !cell.get().length && <JSX> is transformed to when() with a lift-applied predicate
//   !items.get().length && <span> → when(lift(({items}) => !items.get().length)({items}), <span>)
// Context: Negated length check on a cell array used as conditional guard
export default pattern(() => {
  const items = cell<string[]>([]);
  return {
    [NAME]: "Conditional empty check",
    [UI]: (
      <div>
        {!items.get().length && <span>No items</span>}
      </div>
    ),
  };
});
