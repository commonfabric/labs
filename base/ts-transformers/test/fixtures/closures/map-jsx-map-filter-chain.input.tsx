import { pattern, UI } from "commonfabric";

interface Item {
  name: string;
  active: boolean;
}

// FIXTURE: map-jsx-map-filter-chain
// Verifies: chained .map().filter().map() on reactive array all transform
//   .map(fn)    → .mapWithPattern(pattern(...), {})
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: Three-step chain; no outer captures in any callback
export default pattern<{ list: Item[] }>(({ list }) => {
  return {
    [UI]: (
      <div>
        {list
          .map((item) => ({
            name: item.name,
            active: item.active,
          }))
          .filter((entry) => entry.active)
          .map((entry) => <span>{entry.name}</span>)}
      </div>
    ),
  };
});
