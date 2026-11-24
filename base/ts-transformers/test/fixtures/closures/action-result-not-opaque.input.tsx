/**
 * action() results used as event handlers in JSX. action() is an
 * opaque origin but handler results are typically used directly
 * (no property access), so opaque classification doesn't affect them.
 */

import { action, pattern, UI, Writable } from "commonfabric";

interface State {
  label: string;
}

// FIXTURE: action-result-not-opaque
// Verifies: action() results used as JSX event handlers are not marked asOpaque in the output
//   action(() => count.set(...)) → handler(false, { count: { asCell } }, (_, { count }) => ...)({ count })
// Context: action() is an opaque origin, but handler results are used directly (no property access)
export default pattern<State>(({ label }) => {
  const count = new Writable(0);

  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const decrement = action(() => {
    count.set(count.get() - 1);
  });

  return {
    [UI]: (
      <div>
        <span>{label}: {count}</span>
        <cf-button onClick={increment}>+</cf-button>
        <cf-button onClick={decrement}>-</cf-button>
      </div>
    ),
    count,
  };
});
