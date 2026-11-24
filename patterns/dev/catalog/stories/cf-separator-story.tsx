import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface SeparatorStoryInput {}
export interface SeparatorStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SeparatorStoryInput, SeparatorStoryOutput>(() => {
  return {
    [NAME]: "cf-separator Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "400px",
        }}
      >
        <div style={{ fontSize: "13px", marginBottom: "8px" }}>
          Content above
        </div>
        <cf-separator />
        <div style={{ fontSize: "13px", marginTop: "8px" }}>Content below</div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Simple horizontal divider.
      </div>
    ),
  };
});
