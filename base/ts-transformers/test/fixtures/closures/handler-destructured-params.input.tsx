import { Cell, pattern, UI } from "commonfabric";

interface State {
  selectedValue: Cell<string>;
  lastItems: Cell<string>;
}

// FIXTURE: handler-destructured-params
// Verifies: destructured event parameter in inline handler is preserved and schema-typed
//   onct-change={({ detail: { value, items } }) => ...} → handler(event schema with detail.value + detail.items, capture schema, ({ detail: { value, items } }, { state }) => ...)({ state })
// Context: Destructured event params retain structure; event schema reflects the destructured shape
export default pattern<State>((state) => {
  return {
    [UI]: (
      <cf-select
        $value={state.selectedValue}
        items={[
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ]}
        oncf-change={({ detail: { value, items } }) => {
          state.selectedValue.set(value);
          state.lastItems.set(items.map(i => i.label).join(", "));
        }}
      />
    ),
  };
});
