import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ToggleGroupStoryInput {}
export interface ToggleGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToggleGroupStoryInput, ToggleGroupStoryOutput>(() => {
  return {
    [NAME]: "cf-toggle-group Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "560px",
        }}
      >
        <cf-vstack gap="4">
          <cf-toggle-group type="single" value="Bold" aria-label="Text style">
            <cf-toggle>Bold</cf-toggle>
            <cf-toggle>Italic</cf-toggle>
            <cf-toggle>Underline</cf-toggle>
          </cf-toggle-group>
          <cf-toggle-group
            type="multiple"
            value="Bold,Italic"
            aria-label="Formatting"
          >
            <cf-toggle>Bold</cf-toggle>
            <cf-toggle>Italic</cf-toggle>
            <cf-toggle>Underline</cf-toggle>
          </cf-toggle-group>
        </cf-vstack>
      </div>
    ),
    controls: (
      <cf-text variant="body-compact" tone="muted">
        Toggle groups support single and multiple selection.
      </cf-text>
    ),
  };
});
