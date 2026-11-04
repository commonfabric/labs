import { Cell, handler, pattern } from "commonfabric";
import "commonfabric/schema";

interface State {
  value: Cell<number>;
  name?: Cell<string>;
}

const myHandler = handler((_, state: State) => {
  state.value.set(state.value.get() + 1);
});

// FIXTURE: handler-object-literal
// Verifies: handler gets schema from inline param type; handler invocations use state.key()
//   handler((_, state: State) => ...)          → handler(false, stateSchema, fn)
//   myHandler({ value: state.value, ... })     → myHandler({ value: state.key("value"), ... })
//   myHandler(state)                           → myHandler(state) (unchanged)
// Context: Pattern already has explicit schemas; only handler schema injection and property access transforms apply
export default pattern<State>((state) => {
  return {
    // Test case 1: Object literal with all properties from state
    onClick1: myHandler({ value: state.value, name: state.name }),

    // Test case 2: Object literal with all properties (explicitly listed)
    onClick2: myHandler({ value: state.value, name: state.name }),

    // Test case 3: Direct state passing (what we want to transform to)
    onClick3: myHandler(state),
  };
}, {
  type: "object",
  properties: {
    value: { type: "number", asCell: ["cell"] },
    name: { type: "string", asCell: ["cell"] },
  },
  required: ["value"],
});
