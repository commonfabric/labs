import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface RadioStoryInput {}
export interface RadioStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<RadioStoryInput, RadioStoryOutput>(() => {
  const orientation = new Writable<"vertical" | "horizontal">("vertical");
  const disabled = new Writable(false);
  const selected = new Writable("banana");

  const fruitItems = [
    { label: "Apple", value: "apple" },
    { label: "Banana", value: "banana" },
    { label: "Cherry", value: "cherry" },
  ];

  return {
    [NAME]: "cf-radio Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Radio Group
          </div>
          <cf-radio-group
            name="fruit"
            items={fruitItems}
            $value={selected}
            orientation={orientation}
            disabled={disabled}
          />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="orientation"
            description="Layout direction"
            defaultValue="vertical"
            value={orientation}
            items={[
              { label: "Vertical", value: "vertical" },
              { label: "Horizontal", value: "horizontal" },
            ]}
          />
          <SwitchControl
            label="disabled"
            description="Disables all radio buttons"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
