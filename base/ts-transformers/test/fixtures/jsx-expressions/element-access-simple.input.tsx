import { pattern, UI } from "commonfabric";

interface State {
  items: string[];
  index: number;
  matrix: number[][];
  row: number;
  col: number;
}

// FIXTURE: element-access-simple
// Verifies: dynamic element access on reactive arrays is wrapped in a lift-applied computation
//   state.items[state.index]            → lift(({state}) => state.items[state.index])({ items, index })
//   state.items[state.items.length - 1] → lift(...)({ items })
//   state.matrix[state.row]![state.col] → lift(...)({ matrix, row, col })
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {state.items[state.index]}</p>

        {/* Computed index */}
        <p>Last: {state.items[state.items.length - 1]}</p>

        {/* Double indexing */}
        <p>Matrix: {state.matrix[state.row]![state.col]}</p>
      </div>
    ),
  };
});
