import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface LabelStoryInput {}
export interface LabelStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<LabelStoryInput, LabelStoryOutput>(() => {
  return {
    [NAME]: "cf-label Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          maxWidth: "320px",
        }}
      >
        <cf-vstack gap="1">
          <cf-label for="default-input">Default label</cf-label>
          <cf-input id="default-input" placeholder="Labeled input" />
        </cf-vstack>
        <cf-vstack gap="1">
          <cf-label for="required-input" required>Required label</cf-label>
          <cf-input id="required-input" placeholder="Required field" />
        </cf-vstack>
        <cf-vstack gap="1">
          <cf-label for="disabled-input" disabled>Disabled label</cf-label>
          <cf-input id="disabled-input" disabled placeholder="Disabled field" />
        </cf-vstack>
        <cf-text variant="caption" tone="muted" block>
          Use cf-text for captions, helper copy, metadata, and other generic
          text.
        </cf-text>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: for, required, disabled.
      </div>
    ),
  };
});
