import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HStackStoryInput {}
export interface HStackStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HStackStoryInput, HStackStoryOutput>(() => {
  const gap = new Writable<"0" | "1" | "2" | "3" | "4" | "6" | "8">("2");
  const wrap = new Writable(false);
  const reverse = new Writable(false);

  return {
    [NAME]: "cf-hstack Story",
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
          <cf-hstack
            gap={gap}
            wrap={wrap}
            reverse={reverse}
            style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px;"
          >
            <div style="background: #e0e7ff; padding: 8px 16px; border-radius: 4px;">
              Item 1
            </div>
            <div style="background: #dbeafe; padding: 8px 16px; border-radius: 4px;">
              Item 2
            </div>
            <div style="background: #cffafe; padding: 8px 16px; border-radius: 4px;">
              Item 3
            </div>
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
            Alignment
          </div>
          <cf-vstack gap="2">
            <cf-hstack
              gap="2"
              align="start"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; min-height: 60px;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                align=start
              </span>
              <div style="background: #fde68a; padding: 4px 12px; border-radius: 4px; height: 40px;">
                Tall
              </div>
              <div style="background: #fde68a; padding: 4px 12px; border-radius: 4px;">
                Short
              </div>
            </cf-hstack>
            <cf-hstack
              gap="2"
              align="center"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; min-height: 60px;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                align=center
              </span>
              <div style="background: #bbf7d0; padding: 4px 12px; border-radius: 4px; height: 40px;">
                Tall
              </div>
              <div style="background: #bbf7d0; padding: 4px 12px; border-radius: 4px;">
                Short
              </div>
            </cf-hstack>
            <cf-hstack
              gap="2"
              align="end"
              style="border: 1px dashed #cbd5e1; padding: 8px; border-radius: 4px; min-height: 60px;"
            >
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                align=end
              </span>
              <div style="background: #bfdbfe; padding: 4px 12px; border-radius: 4px; height: 40px;">
                Tall
              </div>
              <div style="background: #bfdbfe; padding: 4px 12px; border-radius: 4px;">
                Short
              </div>
            </cf-hstack>
          </cf-vstack>
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
            label="wrap"
            description="Wrap items to next line"
            defaultValue="false"
            checked={wrap}
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
