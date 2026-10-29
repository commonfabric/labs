import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ButtonStoryInput {}
export interface ButtonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ButtonStoryInput, ButtonStoryOutput>(() => {
  const variant = new Writable<"solid" | "outline" | "ghost">("solid");
  const color = new Writable<"neutral" | "primary" | "accent" | "danger">(
    "primary",
  );
  const disabled = new Writable(false);
  const label = new Writable("Click me");
  const size = new Writable<"xs" | "sm" | "md" | "lg" | "xl" | "icon">("md");
  const clickCount = new Writable(0);

  const handleClick = action(() => {
    clickCount.increment(1);
  });

  return {
    [NAME]: "cf-button Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
            padding: "2rem 0",
          }}
        >
          <cf-button
            variant={variant}
            color={color}
            disabled={disabled}
            size={size}
            onClick={handleClick}
          >
            {label}
          </cf-button>
          <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
            Clicked {clickCount} times
          </span>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="color"
            description="Color intent of the button"
            defaultValue="primary"
            value={color}
            items={[
              { label: "Neutral", value: "neutral" },
              { label: "Primary", value: "primary" },
              { label: "Accent", value: "accent" },
              { label: "Danger", value: "danger" },
            ]}
          />
          <SelectControl
            label="variant"
            description="Visual style of the button"
            defaultValue="solid"
            value={variant}
            items={[
              { label: "Solid", value: "solid" },
              { label: "Outline", value: "outline" },
              { label: "Ghost", value: "ghost" },
            ]}
          />
          <SelectControl
            label="size"
            description="Size of the button"
            defaultValue="md"
            value={size}
            items={[
              { label: "Extra Small", value: "xs" },
              { label: "Small", value: "sm" },
              { label: "Medium", value: "md" },
              { label: "Large", value: "lg" },
              { label: "Extra Large", value: "xl" },
              { label: "Icon", value: "icon" },
            ]}
          />
          <TextControl
            label="children"
            description="Button label text"
            defaultValue="Click me"
            value={label}
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
