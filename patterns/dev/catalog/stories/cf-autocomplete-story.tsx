import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface AutocompleteStoryInput {}
export interface AutocompleteStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<AutocompleteStoryInput, AutocompleteStoryOutput>(() => {
  const items = [
    { value: "apple", label: "Apple", group: "Fruits" },
    { value: "banana", label: "Banana", group: "Fruits" },
    { value: "cherry", label: "Cherry", group: "Fruits" },
    { value: "carrot", label: "Carrot", group: "Vegetables" },
    { value: "broccoli", label: "Broccoli", group: "Vegetables" },
    { value: "spinach", label: "Spinach", group: "Vegetables" },
  ];

  return {
    [NAME]: "cf-autocomplete Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "400px" }}>
        <div
          style={{
            fontSize: "14px",
            fontWeight: "600",
            marginBottom: "8px",
            color: "#2e3438",
          }}
        >
          Autocomplete with grouped items
        </div>
        <cf-autocomplete
          items={items}
          placeholder="Search fruits or vegetables..."
        />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Type to search grouped items.
      </div>
    ),
  };
});
