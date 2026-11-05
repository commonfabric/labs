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
interface SwitchStoryInput {}
export interface SwitchStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SwitchStoryInput, SwitchStoryOutput>(() => {
  const checked = new Writable(false);
  const disabled = new Writable(false);
  const statusText = computed(() => (checked.get() ? "On" : "Off"));

  return {
    [NAME]: "cf-switch Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "2rem 0",
          }}
        >
          <cf-switch $checked={checked} disabled={disabled} />
          <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
            {statusText}
          </span>
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
