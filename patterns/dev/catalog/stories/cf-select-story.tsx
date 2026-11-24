import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface SelectStoryInput {}
export interface SelectStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SelectStoryInput, SelectStoryOutput>(() => {
  const value = new Writable("apple");
  const disabled = new Writable(false);

  return {
    [NAME]: "cf-select Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div style={{ padding: "2rem 0", maxWidth: "300px" }}>
          <cf-select
            $value={value}
            disabled={disabled}
            items={[
              { label: "Apple", value: "apple" },
              { label: "Banana", value: "banana" },
              { label: "Cherry", value: "cherry" },
              { label: "Dragon Fruit", value: "dragonfruit" },
            ]}
            style="width: 100%;"
          />
          <div
            style={{ fontSize: "0.875rem", color: "#6b7280", marginTop: "8px" }}
          >
            Selected: "{value}"
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="disabled"
            description="Disables interaction"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
