import { handler } from "commonfabric";

interface IncrementEvent {
  amount: number;
}

// FIXTURE: schema-generation-handler-event-only
// Verifies: handler() with only event param typed generates event schema and false for state
//   handler((event: IncrementEvent, _state) => ...) → handler(eventSchema, false, fn)
// Context: Untyped state param gets `false` as its schema (unknown)
// Only event is typed, state should get unknown schema
export const incrementer = handler((event: IncrementEvent, _state) => {
  console.log("increment by", event.amount);
});
