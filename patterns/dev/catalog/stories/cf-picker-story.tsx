import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface PickerStoryInput {}
export interface PickerStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

interface PickerCardInput {
  title: string;
  body: string;
  color: string;
}
export interface PickerCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

const PickerCard = pattern<PickerCardInput, PickerCardOutput>(
  ({ title, body, color }) => {
    return {
      [NAME]: "Picker Card",
      [UI]: (
        <div
          style={{
            padding: "16px",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            backgroundColor: "#ffffff",
            minHeight: "180px",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "96px",
              borderRadius: "6px",
              backgroundColor: color,
              marginBottom: "12px",
            }}
          >
          </div>
          <div
            style={{ fontWeight: "600", color: "#0f172a", marginBottom: "4px" }}
          >
            {title}
          </div>
          <div style={{ fontSize: "13px", color: "#475569" }}>{body}</div>
        </div>
      ),
    };
  },
);

export default pattern<PickerStoryInput, PickerStoryOutput>(() => {
  const selectedIndex = new Writable(0);
  const disabled = new Writable(false);

  const sunrise = PickerCard({
    title: "Sunrise",
    body: "A warm gradient card used for preview content.",
    color: "#fde68a",
  });
  const ocean = PickerCard({
    title: "Ocean",
    body: "Cards can be any renderable pattern output.",
    color: "#bfdbfe",
  });
  const forest = PickerCard({
    title: "Forest",
    body: "Use arrow keys or swipe to move between items.",
    color: "#bbf7d0",
  });
  const items = computed(() => [sunrise, ocean, forest]);

  const selectedLabel = computed(() => {
    const labels = ["Sunrise", "Ocean", "Forest"];
    return labels[selectedIndex.get()] ?? "Unknown";
  });

  return {
    [NAME]: "cf-picker Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "560px" }}>
        <cf-picker
          $items={items}
          $selectedIndex={selectedIndex}
          disabled={disabled}
          min-height="180px"
        />
        <div style={{ fontSize: "13px", color: "#64748b", marginTop: "10px" }}>
          Selected: {selectedLabel} (index {selectedIndex})
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="disabled"
            description="Disables navigation and keyboard input"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
