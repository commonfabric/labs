import { handler, Cell } from "commonfabric";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: Cell<number>;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value.set(state.value.get() + event.increment);
});

// FIXTURE: simple-handler
// Verifies: basic handler type parameters are transformed into event and context JSON schemas
//   handler<CounterEvent, CounterState>(fn) → handler(eventSchema, contextSchema, fn)
//   Cell<number> → { type: "number", asCell: true }
export { myHandler };
