import { pattern, UI } from "commonfabric";

// FIXTURE: pattern-with-cells
// Verifies: pattern input property access is transformed to .key() and arithmetic to a lift-applied computation
//   cell.value       → cell.key("value")
//   cell.value + 1   → lift(({cell}) => cell.value + 1)({ value: asOpaque })
//   cell.value * 2   → lift(({cell}) => cell.value * 2)({ value: asOpaque })
export default pattern<{ value: number }>((cell) => {
  return {
    [UI]: (
      <div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {cell.value + 1}</p>
        <p>Double: {cell.value * 2}</p>
      </div>
    ),
    value: cell.value,
  };
});
