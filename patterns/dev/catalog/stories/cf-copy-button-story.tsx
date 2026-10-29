import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface CopyButtonStoryInput {}
export interface CopyButtonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CopyButtonStoryInput, CopyButtonStoryOutput>(() => {
  const variant = new Writable<"secondary" | "ghost" | "outline">("secondary");
  const iconOnly = new Writable(false);

  return {
    [NAME]: "cf-copy-button Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
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
            Copy Button
          </div>
          <cf-copy-button
            text="Hello, world!"
            variant={variant}
            icon-only={iconOnly}
          >
            Copy text
          </cf-copy-button>
        </div>
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Icon Only
          </div>
          <cf-copy-button
            text="Copied from icon button"
            variant="ghost"
            icon-only
          />
        </div>
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            With Code Block
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              backgroundColor: "#f3f4f6",
              padding: "12px",
              borderRadius: "6px",
            }}
          >
            <code
              style={{ flex: "1", fontSize: "13px", fontFamily: "monospace" }}
            >
              npm install @commonfabric/ui
            </code>
            <cf-copy-button
              text="npm install @commonfabric/ui"
              variant="ghost"
              icon-only
            />
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="variant"
            description="Button style variant"
            defaultValue="secondary"
            value={variant}
            items={[
              { label: "Secondary", value: "secondary" },
              { label: "Ghost", value: "ghost" },
              { label: "Outline", value: "outline" },
            ]}
          />
          <SwitchControl
            label="icon-only"
            description="Show only the copy icon"
            defaultValue="false"
            checked={iconOnly}
          />
        </>
      </Controls>
    ),
  };
});
