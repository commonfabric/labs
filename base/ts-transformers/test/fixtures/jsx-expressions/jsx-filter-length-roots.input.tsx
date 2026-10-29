import { pattern, UI } from "commonfabric";

// FIXTURE: jsx-filter-length-roots
// Verifies: structural filter-length wrappers use the shared post-closure path
//   instead of rewriting the filter callback itself to filterWithPattern().
//   items.filter(fn).length
//   items.filter(fn).length > 0
//   items.filter(fn).length > 0 ? "Yes" : "No"
// Context: all three shapes should lower without leaking callback locals.
export default pattern<{ items: number[]; threshold: number }>((state) => ({
  [UI]: (
    <div>
      <p>{state.items.filter((x) => x > state.threshold).length}</p>
      <p>{state.items.filter((x) => x > state.threshold).length > 0}</p>
      <p>
        {state.items.filter((x) => x > state.threshold).length > 0
          ? "Yes"
          : "No"}
      </p>
    </div>
  ),
}));
