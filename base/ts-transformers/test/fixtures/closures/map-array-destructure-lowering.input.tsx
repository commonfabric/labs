import { pattern, UI } from "commonfabric";

type Row = [left: string, right: string];

interface State {
  rows: Row[];
}

// FIXTURE: map-array-destructure-lowering
// Verifies: array destructuring in .map() callback is lowered to index-based key access
//   .map(([left, right]) => ...) → .mapWithPattern(pattern(...), {})
//   [left, right] → key("element", "0"), key("element", "1")
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.rows.map(([left, right]) => (
          <span>
            {left}:{right}
          </span>
        ))}
      </div>
    ),
  };
});
