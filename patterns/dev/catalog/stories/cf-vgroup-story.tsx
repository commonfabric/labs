import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SelectControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VGroupStoryInput {}
export interface VGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VGroupStoryInput, VGroupStoryOutput>(() => {
  const gap = new Writable<"sm" | "md" | "lg">("md");

  return {
    [NAME]: "cf-vgroup Story",
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
          <cf-vgroup gap={gap}>
            <cf-card>
              <span>First card in group</span>
            </cf-card>
            <cf-card>
              <span>Second card in group</span>
            </cf-card>
            <cf-card>
              <span>Third card in group</span>
            </cf-card>
          </cf-vgroup>
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
          <cf-hstack gap="4">
            <cf-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=sm
              </span>
              <cf-vgroup gap="sm">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-vgroup>
            </cf-vstack>
            <cf-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=md
              </span>
              <cf-vgroup gap="md">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-vgroup>
            </cf-vstack>
            <cf-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                gap=lg
              </span>
              <cf-vgroup gap="lg">
                <cf-card>
                  <span>A</span>
                </cf-card>
                <cf-card>
                  <span>B</span>
                </cf-card>
                <cf-card>
                  <span>C</span>
                </cf-card>
              </cf-vgroup>
            </cf-vstack>
          </cf-hstack>
        </div>
      </div>
    ),
    controls: (
      <Controls>
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
      </Controls>
    ),
  };
});
