import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface HeadingStoryInput {}
export interface HeadingStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HeadingStoryInput, HeadingStoryOutput>(() => {
  return {
    [NAME]: "cf-heading Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <cf-heading level={1}>Heading Level 1</cf-heading>
        <cf-heading level={2}>Heading Level 2</cf-heading>
        <cf-heading level={3}>Heading Level 3</cf-heading>
        <cf-heading level={4}>Heading Level 4</cf-heading>
        <cf-heading level={5}>Heading Level 5</cf-heading>
        <cf-heading level={6}>Heading Level 6</cf-heading>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Levels 1-6.
      </div>
    ),
  };
});
