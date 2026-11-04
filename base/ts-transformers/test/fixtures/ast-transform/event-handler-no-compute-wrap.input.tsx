import { Cell, Default, handler, pattern, UI } from "commonfabric";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cf-button": any;
    }
  }
}

const handleClick = handler<unknown, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  },
);

// FIXTURE: event-handler-no-compute-wrap
// Verifies: handler invocations in JSX are NOT wrapped in a reactive compute
// wrapper (formerly derive, now lift-applied post-CT-1615), while
// expressions are.
//   count + 1 (in JSX <span>)                → __cfHelpers.lift<...>(({ count }) => count + 1)({ count })
//   handleClick({ count }) (onClick attr)    → left as-is (not wrapped)
//   handleClick({ count }) (inside .map())   → left as-is (not wrapped)
//   pattern<{ count: Default<number, 0> }>   → pattern(fn, inputSchema, outputSchema)
// Context: Negative test ensuring handler calls in event attributes and
// inside .map() are not wrapped as reactive compute.
export default pattern<{ count: Default<number, 0> }>(
  ({ count }) => {
    return {
      [UI]: (
        <div>
          {/* Regular JSX expression - should be wrapped in a lift-applied computation */}
          <span>Count: {count + 1}</span>

          {/* Event handler with Reactive - should NOT be wrapped in a lift-applied computation */}
          <cf-button onClick={handleClick({ count })}>
            Click me
          </cf-button>

          {/* Event handler inside map - should NOT be wrapped in a lift-applied computation */}
          {[1, 2, 3].map((n) => (
            <cf-button key={n} onClick={handleClick({ count })}>
              Button {n}
            </cf-button>
          ))}
        </div>
      ),
      count,
    };
  },
);
