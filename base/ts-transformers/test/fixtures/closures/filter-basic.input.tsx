import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
  active: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: filter-basic
// Verifies: .filter() + .map() chain on reactive arrays are both transformed
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: No captured outer variables — params objects are empty {}. Basic
//   filter-then-map chain where filter checks a boolean field and map renders.
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items
          .filter((item) => item.active)
          .map((item) => (
            <div>Item #{item.id}: {item.name}</div>
          ))}
      </div>
    ),
  };
});
