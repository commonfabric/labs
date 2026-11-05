import { Cell, pattern, UI } from "commonfabric";

interface State {
  counter: Cell<number>;
}

// FIXTURE: handler-no-captures
// Verifies: inline handler with no captured outer variables still gets wrapped with empty captures
//   onClick={() => console.log("hi")) → handler(false, { properties: {} }, (_, __cf_handler_params) => ...)({})
// Context: No closed-over state; capture object is empty
export default pattern<State>((_state) => {
  return {
    [UI]: (
      <button type="button" onClick={() => console.log("hi")}>
        Log
      </button>
    ),
  };
});
