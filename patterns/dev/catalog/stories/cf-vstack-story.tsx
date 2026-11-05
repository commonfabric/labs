import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VStackStoryInput {}
export interface VStackStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VStackStoryInput, VStackStoryOutput>(() => {
  const gap = new Writable<"0" | "1" | "2" | "3" | "4" | "6" | "8">("2");
  const reverse = new Writable(false);

  return {
    [NAME]: "cf-vstack Story",
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
            Interactive
          </div>
          <cf-vstack
            gap={gap}
            reverse={reverse}
            style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px;"
          >
            <div style="background: #e0e7ff; padding: 8px 12px; border-radius: 4px; text-align: center;">
              Item 1
            </div>
            <div style="background: #dbeafe; padding: 8px 12px; border-radius: 4px; text-align: center;">
              Item 2
            </div>
            <div style="background: #cffafe; padding: 8px 12px; border-radius: 4px; text-align: center;">
              Item 3
            </div>
          </cf-vstack>
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
            Gap Comparison
          </div>
          <cf-hstack gap="4">
            <cf-vstack
              gap="0"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; flex: 1;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=0
              </span>
              <div style="background: #fde68a; padding: 4px 8px; border-radius: 4px;">
                A
              </div>
              <div style="background: #fde68a; padding: 4px 8px; border-radius: 4px;">
                B
              </div>
              <div style="background: #fde68a; padding: 4px 8px; border-radius: 4px;">
                C
              </div>
            </cf-vstack>
            <cf-vstack
              gap="2"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; flex: 1;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=2
              </span>
              <div style="background: #bbf7d0; padding: 4px 8px; border-radius: 4px;">
                A
              </div>
              <div style="background: #bbf7d0; padding: 4px 8px; border-radius: 4px;">
                B
              </div>
              <div style="background: #bbf7d0; padding: 4px 8px; border-radius: 4px;">
                C
              </div>
            </cf-vstack>
            <cf-vstack
              gap="4"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; flex: 1;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=4
              </span>
              <div style="background: #bfdbfe; padding: 4px 8px; border-radius: 4px;">
                A
              </div>
              <div style="background: #bfdbfe; padding: 4px 8px; border-radius: 4px;">
                B
              </div>
              <div style="background: #bfdbfe; padding: 4px 8px; border-radius: 4px;">
                C
              </div>
            </cf-vstack>
          </cf-hstack>
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
            Directional Padding
          </div>
          <cf-hstack gap="4">
            <cf-vstack
              gap="1"
              padding="4"
              style="border: 1px dashed #cbd5e1; border-radius: 4px; flex: 1; background: #f1f5f9;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-color-gray-500);">
                padding=4
              </span>
              <div style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px;">
                Uniform
              </div>
            </cf-vstack>
            <cf-vstack
              gap="1"
              padding="4"
              pt="1"
              style="border: 1px dashed #cbd5e1; border-radius: 4px; flex: 1; background: #f1f5f9;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-color-gray-500);">
                padding=4 pt=1
              </span>
              <div style="background: #bbf7d0; padding: 4px 8px; border-radius: 4px;">
                pt overrides top
              </div>
            </cf-vstack>
            <cf-vstack
              gap="1"
              px="6"
              py="2"
              style="border: 1px dashed #cbd5e1; border-radius: 4px; flex: 1; background: #f1f5f9;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-color-gray-500);">
                px=6 py=2
              </span>
              <div style="background: #bfdbfe; padding: 4px 8px; border-radius: 4px;">
                Axis padding
              </div>
            </cf-vstack>
          </cf-hstack>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="gap"
            description="Space between items (0-24 scale)"
            defaultValue="2"
            value={gap}
            items={[
              { label: "0", value: "0" },
              { label: "1", value: "1" },
              { label: "2", value: "2" },
              { label: "3", value: "3" },
              { label: "4", value: "4" },
              { label: "6", value: "6" },
              { label: "8", value: "8" },
            ]}
          />
          <SwitchControl
            label="reverse"
            description="Reverse item order"
            defaultValue="false"
            checked={reverse}
          />
        </>
      </Controls>
    ),
  };
});
