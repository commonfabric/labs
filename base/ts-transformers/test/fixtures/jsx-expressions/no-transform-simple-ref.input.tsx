import { NAME, Reactive, pattern } from "commonfabric";
const count: Reactive<number> = {} as any;
const _element = <div>{count}</div>;

// FIXTURE: no-transform-simple-ref
// Verifies: a bare Reactive in JSX ({count}) is NOT wrapped in a lift-applied computation -- passed through as-is
//   <div>{count}</div> → <div>{count}</div>  (unchanged)
// Context: Negative test -- simple ref interpolation needs no transformation
export default pattern((_state) => {
  return {
    [NAME]: "test",
  };
});
