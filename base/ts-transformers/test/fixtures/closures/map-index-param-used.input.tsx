import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  offset: number;
}

// FIXTURE: map-index-param-used
// Verifies: .map() on reactive array is transformed when index param is used with a capture
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {offset: ...}}))
//   index + state.offset → lift(...)(...) combining index and captured state
// Context: Both index parameter and state.offset are used in an expression
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Uses both index parameter and captures state.offset */}
        {state.items.map((item, index) => (
          <div>
            Item #{index + state.offset}: {item.name}
          </div>
        ))}
      </div>
    ),
  };
});
