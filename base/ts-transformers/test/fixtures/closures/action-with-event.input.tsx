import { Cell, pattern, action } from "commonfabric";

interface MyEvent {
  data: string;
}

interface State {
  value: Cell<string>;
}

// FIXTURE: action-with-event
// Verifies: action() with an inline-annotated event parameter generates a typed event schema
//   action((e: MyEvent) => value.set(e.data)) → handler(MyEvent schema, captureSchema, (e, { value }) => ...)({ value })
// Context: Event type from inline annotation (e: MyEvent) rather than generic type parameter
export default pattern<State>(({ value }) => {
  return {
    update: action((e: MyEvent) => value.set(e.data)),
  };
});
