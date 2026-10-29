import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VScrollStoryInput {}
export interface VScrollStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VScrollStoryInput, VScrollStoryOutput>(() => {
  const showScrollbar = new Writable(true);
  const fadeEdges = new Writable(false);

  return {
    [NAME]: "cf-vscroll Story",
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
            Vertical Scrollable Area
          </div>
          <cf-vscroll
            show-scrollbar={showScrollbar}
            fade-edges={fadeEdges}
            style="border: 1px solid #e2e8f0; border-radius: 4px; height: 200px;"
          >
            <cf-vstack gap="2" style="padding: 8px;">
              <cf-card>
                <span>Item 1</span>
              </cf-card>
              <cf-card>
                <span>Item 2</span>
              </cf-card>
              <cf-card>
                <span>Item 3</span>
              </cf-card>
              <cf-card>
                <span>Item 4</span>
              </cf-card>
              <cf-card>
                <span>Item 5</span>
              </cf-card>
              <cf-card>
                <span>Item 6</span>
              </cf-card>
              <cf-card>
                <span>Item 7</span>
              </cf-card>
              <cf-card>
                <span>Item 8</span>
              </cf-card>
              <cf-card>
                <span>Item 9</span>
              </cf-card>
              <cf-card>
                <span>Item 10</span>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
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
            With max-height
          </div>
          <cf-vscroll style="border: 1px solid #e2e8f0; border-radius: 4px; max-height: 150px;">
            <cf-vstack gap="1" style="padding: 8px;">
              <div style="background: #f0fdf4; padding: 8px 12px; border-radius: 4px;">
                Row A
              </div>
              <div style="background: #ecfdf5; padding: 8px 12px; border-radius: 4px;">
                Row B
              </div>
              <div style="background: #d1fae5; padding: 8px 12px; border-radius: 4px;">
                Row C
              </div>
              <div style="background: #a7f3d0; padding: 8px 12px; border-radius: 4px;">
                Row D
              </div>
              <div style="background: #6ee7b7; padding: 8px 12px; border-radius: 4px;">
                Row E
              </div>
              <div style="background: #34d399; padding: 8px 12px; border-radius: 4px;">
                Row F
              </div>
            </cf-vstack>
          </cf-vscroll>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="show-scrollbar"
            description="Show the scrollbar"
            defaultValue="true"
            checked={showScrollbar}
          />
          <SwitchControl
            label="fade-edges"
            description="Fade content at scroll edges"
            defaultValue="false"
            checked={fadeEdges}
          />
        </>
      </Controls>
    ),
  };
});
