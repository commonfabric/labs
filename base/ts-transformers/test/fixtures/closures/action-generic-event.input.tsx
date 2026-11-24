import { Cell, pattern, action } from "commonfabric";

interface MyEvent {
  data: string;
}

interface State {
  value: Cell<string>;
}

// FIXTURE: action-generic-event
// Verifies: action<MyEvent>(fn) with a type parameter generates a typed event schema
//   action<MyEvent>((e) => ...) → handler(MyEvent schema, captureSchema, (e, { value }) => ...)({ value })
// Context: Event type comes from a generic type parameter, not an inline annotation
export default pattern<State>(({ value }) => {
  return {
    // Test action<MyEvent>((e) => ...) variant (type parameter instead of inline annotation)
    update: action<MyEvent>((e) => value.set(e.data)),
  };
});
