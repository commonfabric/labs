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

// FIXTURE: map-handler-reference-with-type-arg-no-name
// Verifies: .map() transform works with type arg on pattern but no export name
//   .map(fn) → .mapWithPattern(pattern(...), {state: {count: ...}})
// Context: Same as map-handler-reference but exercises the <State> type-arg-no-name path
export default pattern<State>((state) => {
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
