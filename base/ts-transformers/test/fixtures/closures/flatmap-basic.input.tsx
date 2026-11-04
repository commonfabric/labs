import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  tags: string[];
}

interface State {
  items: Item[];
}

// FIXTURE: flatmap-basic
// Verifies: .flatMap() on a reactive array is transformed
//   .flatMap(fn) → .flatMapWithPattern(pattern(...), {})
// Context: flatMap renders each item as JSX. No captured outer variables.
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.flatMap((item) => (
          <div>Item #{item.id}</div>
        ))}
      </div>
    ),
  };
});
