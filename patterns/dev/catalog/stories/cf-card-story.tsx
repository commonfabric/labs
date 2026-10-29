import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface CardStoryInput {}
export interface CardStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CardStoryInput, CardStoryOutput>(() => {
  return {
    [NAME]: "cf-card Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <cf-card>
          <cf-vstack gap="1">
            <cf-heading level={5}>Basic Card</cf-heading>
            <span style="color: var(--cf-colors-gray-600);">
              A simple card with text content. Cards provide built-in padding.
            </span>
          </cf-vstack>
        </cf-card>

        <cf-card>
          <cf-hstack gap="3" align="center">
            <span style="font-size: 2rem;">🎨</span>
            <cf-vstack gap="0" style="flex: 1;">
              <span style="font-weight: 600;">Card with Icon</span>
              <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                Horizontal layout with icon and text
              </span>
            </cf-vstack>
            <cf-button color="neutral" variant="outline">Action</cf-button>
          </cf-hstack>
        </cf-card>

        <cf-card>
          <cf-vstack gap="2">
            <cf-heading level={5}>Card with Nested Elements</cf-heading>
            <cf-hstack gap="2">
              <cf-button color="primary" variant="solid">Save</cf-button>
              <cf-button color="neutral" variant="outline">Cancel</cf-button>
            </cf-hstack>
            <cf-input placeholder="Input inside a card" />
          </cf-vstack>
        </cf-card>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. This story shows cf-card layout variations.
      </div>
    ),
  };
});
