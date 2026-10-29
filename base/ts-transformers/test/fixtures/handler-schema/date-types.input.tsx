import { handler, Cell } from "commonfabric";

interface TimedEvent {
  timestamp: Date;
}

interface TimedState {
  lastUpdate: Cell<Date>;
}

const timedHandler = handler<TimedEvent, TimedState>((event, state) => {
  state.lastUpdate.set(event.timestamp);
});

// FIXTURE: date-types
// Verifies: Date type maps to JSON Schema string with format "date-time"
//   Date → { type: "string", format: "date-time" }
//   Cell<Date> → { type: "string", format: "date-time", asCell: true }
export { timedHandler };
