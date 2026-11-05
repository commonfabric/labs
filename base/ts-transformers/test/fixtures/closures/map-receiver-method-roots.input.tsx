import { pattern, UI } from "commonfabric";

const identity = <T,>(value: T) => value;

// FIXTURE: map-receiver-method-roots
// Verifies: receiver-method roots inside pattern-owned map callbacks lower reactively
//   item.toUpperCase()            → callback-local lift-applied computation
//   identity(item.toUpperCase())  → call-argument receiver-method root lowered reactively
export default pattern<{ items: string[] }>(({ items }) => ({
  [UI]: (
    <div>
      {items.map((item) => <span>{item.toUpperCase()}</span>)}
      {items.map((item) => <span>{identity(item.toUpperCase())}</span>)}
    </div>
  ),
}));
