import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ToggleStoryInput {}
export interface ToggleStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToggleStoryInput, ToggleStoryOutput>(() => {
  const pressed = new Writable(false);
  const disabled = new Writable(false);
  const variant = new Writable<"default" | "outline">("default");
  const size = new Writable<"default" | "sm" | "lg">("default");
  const status = computed(() => (pressed.get() ? "Pressed" : "Not pressed"));

  return {
    [NAME]: "cf-toggle Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <cf-toggle
            $pressed={pressed}
            disabled={disabled}
            variant={variant}
            size={size}
          >
            Bold
          </cf-toggle>
          <span style={{ fontSize: "13px", color: "#64748b" }}>{status}</span>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="variant"
            description="Visual style"
            defaultValue="default"
            value={variant as any}
            items={[
              { label: "default", value: "default" },
              { label: "outline", value: "outline" },
            ]}
          />
          <SelectControl
            label="size"
            description="Toggle size"
            defaultValue="default"
            value={size as any}
            items={[
              { label: "default", value: "default" },
              { label: "sm", value: "sm" },
              { label: "lg", value: "lg" },
            ]}
          />
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
