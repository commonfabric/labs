import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface TagsStoryInput {}
export interface TagsStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TagsStoryInput, TagsStoryOutput>(() => {
  return {
    [NAME]: "cf-tags Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "400px" }}>
        <div
          style={{
            fontSize: "14px",
            fontWeight: "600",
            marginBottom: "8px",
            color: "#2e3438",
          }}
        >
          Tags
        </div>
        <cf-tags tags={["TypeScript", "React", "Node.js", "Deno"]} />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Set readonly attribute to prevent editing.
      </div>
    ),
  };
});
