import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HGroupStoryInput {}
export interface HGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HGroupStoryInput, HGroupStoryOutput>(() => {
  const gap = new Writable<"sm" | "md" | "lg">("md");
  const wrap = new Writable(false);

  return {
    [NAME]: "cf-hgroup Story",
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
          <cf-hgroup gap={gap} wrap={wrap}>
            <cf-card>
              <span>Card A</span>
            </cf-card>
            <cf-card>
              <span>Card B</span>
            </cf-card>
            <cf-card>
              <span>Card C</span>
            </cf-card>
          </cf-hgroup>
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
            Gap Sizes
          </div>
          <cf-vstack gap="2">
            <cf-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=sm
              </span>
              <cf-hgroup gap="sm">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-hgroup>
            </cf-vstack>
            <cf-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=md
              </span>
              <cf-hgroup gap="md">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-hgroup>
            </cf-vstack>
            <cf-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=lg
              </span>
              <cf-hgroup gap="lg">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-hgroup>
            </cf-vstack>
          </cf-vstack>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="gap"
            description="Space between grouped items"
            defaultValue="md"
            value={gap}
            items={[
              { label: "Small", value: "sm" },
              { label: "Medium", value: "md" },
              { label: "Large", value: "lg" },
            ]}
          />
          <SwitchControl
            label="wrap"
            description="Wrap items to next line"
            defaultValue="false"
            checked={wrap}
          />
        </>
      </Controls>
    ),
  };
});
