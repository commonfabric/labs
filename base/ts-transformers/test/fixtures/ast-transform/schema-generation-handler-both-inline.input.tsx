import { handler } from "commonfabric";

interface IncrementEvent {
  amount: number;
}

interface CounterState {
  count: number;
}

// FIXTURE: schema-generation-handler-both-inline
// Verifies: handler() with both params typed inline generates event and state schemas
//   handler((event: IncrementEvent, state: CounterState) => ...) → handler(eventSchema, stateSchema, fn)
// Context: Types come from inline parameter annotations, not generic type args
// Both parameters typed inline (no generic type arguments)
export const incrementer = handler(
  (event: IncrementEvent, state: CounterState) => {
    state.count += event.amount;
  },
);
