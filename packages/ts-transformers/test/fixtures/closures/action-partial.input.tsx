import { Cell, pattern, action } from "commonfabric";

interface BaseState {
  a: Cell<string>;
  b: Cell<number>;
}

// Partial<BaseState> should make both 'a' and 'b' optional in the schema
type PartState = Partial<BaseState>;

// FIXTURE: action-partial
// Verifies: Partial<BaseState> produces optional capture schemas in handlers
//   action(() => console.log(a)) → handler(false, { a: { type: ["string", "undefined"], asCell: ["readonly"] } }, ...)({ a })
// Context: Partial<> makes properties optional; capture schemas reflect this
//   with `undefined` in the property's type list
export default pattern<PartState>(({ a, b }) => {
  return {
    readA: action(() => console.log(a)),
    readB: action(() => console.log(b)),
  };
});
