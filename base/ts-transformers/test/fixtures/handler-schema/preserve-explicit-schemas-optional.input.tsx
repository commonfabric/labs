import { handler } from "commonfabric";
import "commonfabric/schema";

// Schema without required fields - properties are optional
const eventSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
} as const;

const stateSchema = {
  type: "object",
  properties: {
    log: { type: "array", items: { type: "string" } },
  },
} as const;

const logHandler = handler(eventSchema, stateSchema, (event, state) => {
  // Use optional chaining and nullish coalescing since properties may be undefined
  state.log?.push(event.message ?? "no message");
});

// FIXTURE: preserve-explicit-schemas-optional
// Verifies: explicit schemas without "required" arrays are preserved as-is (optional properties)
//   handler(eventSchema, stateSchema, fn) → handler(eventSchema, stateSchema, fn) (no transformation)
// Context: schemas omit "required" making all properties optional; transformer must not add required
export { logHandler };
