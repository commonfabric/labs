import { handler, Writable } from "commonfabric";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: Writable<number>;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value.set(state.value.get() + event.increment);
});

// FIXTURE: simple-handler-writable
// Verifies: Writable<T> is treated identically to Cell<T> and generates asCell in the schema
//   Writable<number> → { type: "number", asCell: true }
//   handler<CounterEvent, CounterState>(fn) → handler(eventSchema, contextSchema, fn)
export { myHandler };
