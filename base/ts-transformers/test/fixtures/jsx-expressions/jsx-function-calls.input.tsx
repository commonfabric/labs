import { pattern, UI } from "commonfabric";

interface State {
  a: number;
  b: number;
  price: number;
  text: string;
  values: number[];
  name: string;
  float: string;
}

// FIXTURE: jsx-function-calls
// Verifies: function/method calls with reactive args in JSX are wrapped in a lift-applied computation
//   Math.max(state.a, state.b)     → lift(({state}) => Math.max(state.a, state.b))({ a, b })
//   state.name.toUpperCase()       → lift(...)({ name })
//   parseInt(state.float)          → lift(...)({ float })
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Math Functions</h3>
        <p>Max: {Math.max(state.a, state.b)}</p>
        <p>Min: {Math.min(state.a, 10)}</p>
        <p>Abs: {Math.abs(state.a - state.b)}</p>
        <p>Round: {Math.round(state.price)}</p>
        <p>Floor: {Math.floor(state.price)}</p>
        <p>Ceiling: {Math.ceil(state.price)}</p>
        <p>Square root: {Math.sqrt(state.a)}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {state.name.toUpperCase()}</p>
        <p>Lowercase: {state.name.toLowerCase()}</p>
        <p>Substring: {state.text.substring(0, 5)}</p>
        <p>Replace: {state.text.replace("old", "new")}</p>
        <p>Includes: {state.text.includes("test") ? "Yes" : "No"}</p>
        <p>Starts with: {state.name.startsWith("A") ? "Yes" : "No"}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {state.price.toFixed(2)}</p>
        <p>To Precision: {state.price.toPrecision(4)}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {parseInt(state.float)}</p>
        <p>Parse Float: {parseFloat(state.float)}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {state.values.reduce((a, b) => a + b, 0)}</p>
        <p>Max value: {
          // deno-lint-ignore cf-spread/no-spread-arguments -- the fixture covers a spread argument
          Math.max(...state.values)
        }</p>
        <p>Joined: {state.values.join(", ")}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {Math.pow(state.a, 2)}</p>
        <p>Nested calls: {Math.round(Math.sqrt(state.a))}</p>
        <p>Chained calls: {state.name.trim().toUpperCase()}</p>
        <p>With expressions: {Math.max(state.a + 1, state.b * 2)}</p>
      </div>
    ),
  };
});
