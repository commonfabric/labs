import { pattern, UI } from "commonfabric";

interface Item {
  id: string;
}

// FIXTURE: map-root-fallback-wrappers
// Verifies: top-level fallback receiver roots keep structural array-method lowering across wrapper forms
//   (items ?? []).map(fn)                             -> lift(...)(...).mapWithPattern(...)
//   ((items as Item[] | undefined) ?? []).map(fn)     -> cast-wrapped fallback still lowers
//   ((items satisfies Item[] | undefined) ?? []).map  -> satisfies-wrapped fallback still lowers
// Context: All three forms are direct JSX roots rather than nested property fallback receivers
export default pattern<{ items?: Item[] }>(({ items }) => {
  return {
    [UI]: (
      <div>
        {(items ?? []).map((item) => <span data-inline-id={item.id}>{item.id}</span>)}
        {((items as Item[] | undefined) ?? []).map((item) => (
          <span data-cast-id={item.id}>{item.id}</span>
        ))}
        {((items satisfies Item[] | undefined) ?? []).map((item) => (
          <span data-satisfies-id={item.id}>{item.id}</span>
        ))}
      </div>
    ),
  };
});
