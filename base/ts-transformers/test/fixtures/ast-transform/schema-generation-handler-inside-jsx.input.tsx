import { handler } from "commonfabric";

interface ClickEvent {
  x: number;
  y: number;
}

interface AppState {
  clicks: number;
  lastPosition: { x: number; y: number };
}

// FIXTURE: schema-generation-handler-inside-jsx
// Verifies: handler() inside a JSX expression still gets schemas injected
//   handler((event: ClickEvent, state: AppState) => ...) → handler(eventSchema, stateSchema, fn)
// Context: handler() appears as a JSX child expression, not a standalone statement
export const result = (
  <div>
    {handler((event: ClickEvent, state: AppState) => ({
      clicks: state.clicks + 1,
      lastPosition: { x: event.x, y: event.y },
    }))}
  </div>
);
