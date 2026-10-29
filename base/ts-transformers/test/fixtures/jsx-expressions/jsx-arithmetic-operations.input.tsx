import { pattern, UI } from "commonfabric";

interface State {
  count: number;
  price: number;
  discount: number;
  quantity: number;
}

// FIXTURE: jsx-arithmetic-operations
// Verifies: arithmetic expressions with reactive refs in JSX are wrapped in a lift-applied computation
//   {state.count + 1}                      → lift(({state}) => state.count + 1)({ count })
//   {state.price * state.quantity * 1.08}   → lift(...)({ price, quantity })
//   {state.count * state.count * state.count} → lift(...)({ count })
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {state.count + 1}</p>
        <p>Count - 1: {state.count - 1}</p>
        <p>Count * 2: {state.count * 2}</p>
        <p>Price / 2: {state.price / 2}</p>
        <p>Count % 3: {state.count % 3}</p>

        <h3>Complex Expressions</h3>
        <p>Discounted Price: {state.price - (state.price * state.discount)}</p>
        <p>Total: {state.price * state.quantity}</p>
        <p>With Tax (8%): {(state.price * state.quantity) * 1.08}</p>
        <p>
          Complex: {(state.count + state.quantity) * state.price -
            (state.price * state.discount)}
        </p>

        <h3>Multiple Same Ref</h3>
        <p>Count³: {state.count * state.count * state.count}</p>
        <p>Price Range: ${state.price - 10} - ${state.price + 10}</p>
      </div>
    ),
  };
});
