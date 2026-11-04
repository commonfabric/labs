import { Cell, pattern, action } from "commonfabric";

interface State {
  count: Cell<number>;
}

// FIXTURE: action-basic
// Verifies: action() callback is extracted into a handler with captured state
//   action(() => count.set(...)) → handler(eventSchema, captureSchema, (_, { count }) => count.set(...))({ count })
export default pattern<State>(({ count }) => {
  return {
    inc: action(() => count.set(count.get() + 1)),
  };
});
