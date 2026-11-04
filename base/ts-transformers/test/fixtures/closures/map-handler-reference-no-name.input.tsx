import { pattern, UI, handler, Cell } from "commonfabric";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cf-button": any;
    }
  }
}

// Event handler defined at module scope
const handleClick = handler<unknown, { count: Cell<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  count: Cell<number>;
}

// FIXTURE: map-handler-reference-no-name
// Verifies: .map() transform works when pattern has inline type annotation instead of type arg
//   .map(fn) → .mapWithPattern(pattern(...), {state: {count: ...}})
// Context: pattern((state: State) => ...) form without <State> generic; handler not captured
export default pattern((state: State) => {
  return {
    [UI]: (
      <div>
        {/* Map callback references handler - should NOT capture it */}
        {state.items.map((item) => (
          <cf-button onClick={handleClick({ count: state.count })}>
            {item.name}
          </cf-button>
        ))}
      </div>
    ),
  };
});
