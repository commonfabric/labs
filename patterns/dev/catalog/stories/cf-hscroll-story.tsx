import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HScrollStoryInput {}
export interface HScrollStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HScrollStoryInput, HScrollStoryOutput>(() => {
  const showScrollbar = new Writable(true);
  const fadeEdges = new Writable(false);

  return {
    [NAME]: "cf-hscroll Story",
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
            Horizontal Scrollable Area
          </div>
          <cf-hscroll
            show-scrollbar={showScrollbar}
            fade-edges={fadeEdges}
            style="border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px;"
          >
            <cf-hstack gap="2">
              <cf-card style="min-width: 150px;">
                <span>Card 1</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 2</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 3</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 4</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 5</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 6</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 7</span>
              </cf-card>
              <cf-card style="min-width: 150px;">
                <span>Card 8</span>
              </cf-card>
            </cf-hstack>
          </cf-hscroll>
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
            Image Gallery Style
          </div>
          <cf-hscroll
            fade-edges
            style="border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px;"
          >
            <cf-hstack gap="2">
              <div style="min-width: 120px; height: 80px; background: #fef3c7; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🌅
              </div>
              <div style="min-width: 120px; height: 80px; background: #dbeafe; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🏔️
              </div>
              <div style="min-width: 120px; height: 80px; background: #dcfce7; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🌿
              </div>
              <div style="min-width: 120px; height: 80px; background: #fce7f3; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🌸
              </div>
              <div style="min-width: 120px; height: 80px; background: #ede9fe; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🦋
              </div>
              <div style="min-width: 120px; height: 80px; background: #ffedd5; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                🍂
              </div>
            </cf-hstack>
          </cf-hscroll>
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
