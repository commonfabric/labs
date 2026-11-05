import { Cell, pattern, UI } from "commonfabric";

interface State {
  selectedValue: Cell<string>;
  changeCount: Cell<number>;
}

// FIXTURE: handler-event-param
// Verifies: inline handler with a named event parameter generates event + capture schemas
//   onct-change={(event) => ...} → handler(event schema with detail.value, capture schema, (event, { state }) => ...)({ state })
// Context: Typed cf-select event; event param is not destructured, used as event.detail.value
export default pattern<State>((state) => {
  return {
    [UI]: (
      <cf-select
        $value={state.selectedValue}
        items={[
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ]}
        oncf-change={(event) => {
          state.selectedValue.set(event.detail.value);
          state.changeCount.set(state.changeCount.get() + 1);
        }}
      />
    ),
  };
});
