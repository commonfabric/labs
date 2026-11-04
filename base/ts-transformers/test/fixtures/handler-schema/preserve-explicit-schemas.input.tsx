import { handler } from "commonfabric";
import "commonfabric/schema";

const eventSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
} as const;

const stateSchema = {
  type: "object",
  properties: {
    log: { type: "array", items: { type: "string" } },
  },
  required: ["log"],
} as const;

const logHandler = handler(eventSchema, stateSchema, (event, state) => {
  state.log.push(event.message);
});

// FIXTURE: preserve-explicit-schemas
// Verifies: handler with user-provided schema literals passes them through unchanged (no type-based generation)
//   handler(eventSchema, stateSchema, fn) → handler(eventSchema, stateSchema, fn) (no transformation)
// Context: schemas are pre-defined as const objects; transformer must not replace them
export { logHandler };
