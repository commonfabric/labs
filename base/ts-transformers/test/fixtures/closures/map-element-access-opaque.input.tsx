import { pattern, UI } from "commonfabric";

interface State {
  sortedTags: string[];
  tagCounts: Record<string, number>;
}

// FIXTURE: map-element-access-opaque
// Verifies: .map() on reactive array is transformed when callback uses bracket access on a captured opaque object
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {tagCounts: ...}}))
//   state.tagCounts[tag] → lift(...)(...) with opaque schema for dynamic key access
// Context: Captures state.tagCounts for bracket-notation element access inside map
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.sortedTags.map((tag) => (
          <span>
            {tag}: {state.tagCounts[tag]}
          </span>
        ))}
      </div>
    ),
  };
});
