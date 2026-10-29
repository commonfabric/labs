import { handler, pattern, UI } from "commonfabric";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cf-button": any;
    }
  }
}

interface State {
  count: number;
}

const existing = handler((_event, { state }: { state: State }) => {
  console.log(state.count);
});

// FIXTURE: handler-existing-reference
// Verifies: pre-declared handler() call site is NOT re-wrapped; only its schema is generated
//   existing({ state }) → existing({ state }) (call site unchanged)
//   handler(fn) at declaration → handler(false, captureSchema, fn) (schema injected at definition)
// Context: handler() declared outside the pattern; the transform adds schemas but does not re-extract
export default pattern<State>((state) => {
  return {
    [UI]: (
      <cf-button onClick={existing({ state })}>
        Existing
      </cf-button>
    ),
  };
});
