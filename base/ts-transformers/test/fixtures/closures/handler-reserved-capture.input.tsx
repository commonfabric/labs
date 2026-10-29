import { pattern, UI } from "commonfabric";

interface State {
  label: string;
}

// FIXTURE: handler-reserved-capture
// Verifies: captured variable named __cf_handler_event is renamed to avoid collision with the synthetic event param
//   onClick={() => __cf_handler_event) → handler(false, { __cf_handler_event: ... }, (__cf_handler_event_1, { __cf_handler_event }) => ...)
// Context: Edge case -- user variable collides with internal __cf_handler_event name; event param gets suffixed
export default pattern<State>((state) => {
  const __cf_handler_event = state.label;
  return {
    [UI]: (
      <button type="button" onClick={() => __cf_handler_event}>
        Echo
      </button>
    ),
  };
});
