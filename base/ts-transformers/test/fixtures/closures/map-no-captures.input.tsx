import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  price: number;
}

interface State {
  items: Item[];
}

// FIXTURE: map-no-captures
// Verifies: .map() on reactive array is transformed even with no captured outer variables
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: Callback only references its own parameter (item); captures object is empty
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* No captures - just uses the callback parameter */}
        {state.items.map((item) => (
          <div>Item #{item.id}: ${item.price}</div>
        ))}
      </div>
    ),
  };
});
