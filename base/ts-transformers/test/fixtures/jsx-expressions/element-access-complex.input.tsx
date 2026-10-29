import { ifElse, pattern, UI } from "commonfabric";

interface State {
  matrix: number[][];
  row: number;
  col: number;
  items: string[];
  arr: number[];
  a: number;
  b: number;
  indices: number[];
  nested: {
    arrays: string[][];
    index: number;
  };
  users: Array<{ name: string; scores: number[] }>;
  selectedUser: number;
  selectedScore: number;
}

// FIXTURE: element-access-complex
// Verifies: complex element-access patterns (nested, computed, chained, conditional) are wrapped in a lift-applied computation
//   state.matrix[state.row]![state.col]         → lift(...)({ matrix, row, col })
//   state.arr[state.a + state.b]                → lift(...)({ arr, a, b })
//   state.users[state.selectedUser]!.scores[..] → lift(...)({ users, selectedUser, selectedScore })
// Context: Covers nested indexing, computed indices, chained access, conditions, operators
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {state.matrix[state.row]![state.col]}</p>

        {/* Triple nested access */}
        <p>Deep nested: {state.nested.arrays[state.nested.index]![state.row]}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>
          First and last: {state.items[0]} and{" "}
          {state.items[state.items.length - 1]}
        </p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {state.arr[0]! + state.arr[state.arr.length - 1]!}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {state.arr[state.a + state.b]}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {state.items[state.row % state.items.length]}</p>

        {/* Complex index expression */}
        <p>Complex: {state.arr[Math.min(state.a * 2, state.arr.length - 1)]}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>
          User score:{" "}
          {state.users[state.selectedUser]!.scores[state.selectedScore]!}
        </p>

        {/* Using one array element as index for another */}
        <p>Indirect: {state.items[state.indices[0]!]}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {state.arr[state.arr[0]!]}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {state.nested.arrays[state.nested.index]!.length}</p>

        {/* Element access followed by property access */}
        <p>User name length: {state.users[state.selectedUser]!.name.length}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>
          Conditional:{" "}
          {state.arr[state.a]! > 10 ? state.items[state.b]! : state.items[0]!}
        </p>

        {/* Element access in boolean expression */}
        <p>
          Has value: {ifElse(
            state.matrix[state.row]![state.col]! > 0,
            "positive",
            "non-positive",
          )}
        </p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {state.arr[state.a]! * state.arr[state.b]!}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {state.items[0]! + " - " + state.items[state.indices[0]!]!}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {state.arr[0]! + state.arr[1]! + state.arr[2]!}</p>
      </div>
    ),
  };
});
