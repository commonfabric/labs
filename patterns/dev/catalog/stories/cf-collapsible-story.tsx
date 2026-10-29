import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface CollapsibleStoryInput {}
export interface CollapsibleStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CollapsibleStoryInput, CollapsibleStoryOutput>(() => {
  return {
    [NAME]: "cf-collapsible Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "400px",
        }}
      >
        <cf-vstack gap="2">
          <cf-collapsible>
            <cf-button
              slot="trigger"
              variant="ghost"
              style="width: 100%; text-align: left;"
            >
              Click to expand
            </cf-button>
            <div style="padding: 12px; font-size: 13px; color: #666;">
              Hidden content revealed on expand. Animated height transition.
            </div>
          </cf-collapsible>
          <cf-collapsible open>
            <cf-button
              slot="trigger"
              variant="ghost"
              style="width: 100%; text-align: left;"
            >
              Already open
            </cf-button>
            <div style="padding: 12px; font-size: 13px; color: #666;">
              This section starts open.
            </div>
          </cf-collapsible>
        </cf-vstack>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: open (boolean). Animated height
        transition.
      </div>
    ),
  };
});
