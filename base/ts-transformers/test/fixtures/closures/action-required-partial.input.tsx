import { Cell, pattern, action } from "commonfabric";

interface BaseState {
  a?: Cell<string>;
  b: Cell<number>;
}

// Required<BaseState> should make 'a' required in the schema
type ReqState = Required<BaseState>;

// FIXTURE: action-required-partial
// Verifies: Required<BaseState> makes originally-optional properties required in capture schemas
//   action(() => a.set("hello")) → handler(false, { a: { type: "string", asCell, required } }, ...)({ a })
// Context: BaseState.a is optional, but Required<> forces it to required in both input and capture schemas
export default pattern<ReqState>(({ a, b }) => {
  return {
    setA: action(() => a.set("hello")),
    setB: action(() => b.set(42)),
  };
});
