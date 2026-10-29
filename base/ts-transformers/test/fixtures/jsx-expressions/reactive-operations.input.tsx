import { cell, pattern, UI } from "commonfabric";

// FIXTURE: reactive-operations
// Verifies: arithmetic on cell-backed Reactives in JSX is wrapped in a lift-applied computation with asCell schema
//   {count}           → {count}  (bare ref, no transform)
//   {count.get() + 1} → lift(({count}) => count.get() + 1)({ count: asCell })
//   {price.get() * 1.1} → lift(...)({ price: asCell })
export default pattern((_state) => {
  const count = cell(10);
  const price = cell(10);

  return {
    [UI]: (
      <div>
        <p>Count: {count}</p>
        <p>Next: {count.get() + 1}</p>
        <p>Double: {count.get() * 2}</p>
        <p>Total: {price.get() * 1.1}</p>
      </div>
    ),
  };
});
